// ============================================================================
// Admin dashboard API (consolidated router to stay under Vercel's function cap).
// Dispatch on ?action=... — every action except `login` requires a Bearer token.
//
//   POST login              { password }                  -> { token, role, scope, businesses }
//   GET  summary            ?business=slug                -> today's jobs + revenue + techs
//   GET  bookings           ?business=slug&range=&status= -> booking list
//   POST booking_update     { business, id, action, ... } -> confirm|cancel|reschedule|assign|status
//   GET  customers          ?business=slug&q=             -> customer list (search)
//   GET  technicians        ?business=slug                -> technician list
//   POST technician_update  { business, id, ... }         -> status|phone|email|pin|active
//
// Auth scope: owner (ADMIN_PASSWORD) sees all businesses; a secretary password
// (HANDY_ANDY_PASSWORD / DOMS_PASSWORD) is locked to one business.
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { signToken, verifyToken, getBearer, applyCors, safeEqual } from './_lib/auth.js';
import { localDayStartUTC, startOfWeekUTC, startOfMonthUTC } from './_lib/time.js';
import { SLOTS, DAYS, normalizeSlots } from './_lib/availability.js';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed'];

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    if (action === 'login') return await login(req, res, body);

    // Everything below requires a valid admin token.
    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();

    switch (action) {
      case 'summary':           return await summary(req, res, db, auth);
      case 'services':          return await services(req, res, db, auth);
      case 'bookings':          return await bookings(req, res, db, auth);
      case 'booking_create':    return await bookingCreate(req, res, db, auth, body);
      case 'booking_update':    return await bookingUpdate(req, res, db, auth, body);
      case 'customers':         return await customers(req, res, db, auth);
      case 'technicians':       return await technicians(req, res, db, auth);
      case 'technician_update': return await technicianUpdate(req, res, db, auth, body);
      case 'tech_availability':     return await techAvailability(req, res, db, auth);
      case 'tech_availability_set': return await techAvailabilitySet(req, res, db, auth, body);
      default:                  return res.status(400).json({ error: `Unknown action "${action}"` });
    }
  } catch (err) {
    console.error('[admin]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function login(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const password = (body.password || '').toString();

  // DEV BYPASS: if no admin passwords are configured at all (or ADMIN_DEV_BYPASS
  // is set), the dashboard opens as owner with NO password. Set ADMIN_PASSWORD
  // later and the gate turns back on automatically.
  const noPasswords = !process.env.ADMIN_PASSWORD && !process.env.HANDY_ANDY_PASSWORD && !process.env.DOMS_PASSWORD;
  const forceBypass = ['1', 'true', 'yes', 'on'].includes(String(process.env.ADMIN_DEV_BYPASS || '').toLowerCase());
  const bypass = noPasswords || forceBypass;

  // Resolve which role/scope this password unlocks.
  let role = null, scope = null;
  if (bypass) {
    role = 'owner'; scope = 'all';
  } else if (!password) {
    return res.status(400).json({ error: 'Password required' });
  } else if (process.env.ADMIN_PASSWORD && safeEqual(password, process.env.ADMIN_PASSWORD)) {
    role = 'owner'; scope = 'all';
  } else if (process.env.HANDY_ANDY_PASSWORD && safeEqual(password, process.env.HANDY_ANDY_PASSWORD)) {
    role = 'secretary'; scope = 'handy-andy';
  } else if (process.env.DOMS_PASSWORD && safeEqual(password, process.env.DOMS_PASSWORD)) {
    role = 'secretary'; scope = 'doms';
  }
  if (!role) return res.status(401).json({ error: 'Incorrect password' });

  const db = serviceClient();
  let q = db.from('businesses').select('id, slug, name, timezone, brand_navy, brand_orange').eq('active', true).order('name');
  if (scope !== 'all') q = q.eq('slug', scope);
  const { data: businesses, error } = await q;
  if (error) throw error;

  const token = signToken({ kind: 'admin', role, scope });
  return res.status(200).json({ token, role, scope, businesses: businesses || [] });
}

// Resolve the requested business and enforce the token's scope.
async function resolveBusiness(db, auth, slug) {
  if (!slug) { const e = new Error('business is required'); e.status = 400; throw e; }
  if (auth.scope !== 'all' && auth.scope !== slug) { const e = new Error('Forbidden for this business'); e.status = 403; throw e; }
  const { data, error } = await db.from('businesses').select('id, slug, name, timezone').eq('slug', slug).single();
  if (error || !data) { const e = new Error('Business not found'); e.status = 404; throw e; }
  return data;
}

function bail(res, err) { return res.status(err.status || 500).json({ error: err.message }); }

// ── Dashboard summary (one call bootstraps the home view) ────────────────────
async function summary(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const tz = biz.timezone || 'America/Denver';

  const todayStart = localDayStartUTC(tz, 0);
  const tomorrow = localDayStartUTC(tz, 1);
  const weekStart = startOfWeekUTC(tz);
  const monthStart = startOfMonthUTC(tz);

  // Today's jobs (joined).
  const { data: today, error: e1 } = await db.from('bookings')
    .select(bookingSelect())
    .eq('business_id', biz.id)
    .gte('scheduled_at', todayStart.toISOString())
    .lt('scheduled_at', tomorrow.toISOString())
    .order('scheduled_at', { ascending: true });
  if (e1) throw e1;

  // Revenue: pull this month's non-cancelled jobs once, bucket client-side.
  const { data: monthJobs, error: e2 } = await db.from('bookings')
    .select('price, scheduled_at, status')
    .eq('business_id', biz.id)
    .gte('scheduled_at', monthStart.toISOString())
    .in('status', ACTIVE_STATUSES);
  if (e2) throw e2;

  const sum = (rows) => Math.round(rows.reduce((n, r) => n + Number(r.price || 0), 0) * 100) / 100;
  const inRange = (since) => monthJobs.filter(r => r.scheduled_at && new Date(r.scheduled_at) >= since);
  const revenue = {
    today: sum(inRange(todayStart).filter(r => new Date(r.scheduled_at) < tomorrow)),
    week:  sum(inRange(weekStart)),
    month: sum(monthJobs),
  };

  // Technicians + live status.
  const { data: techs, error: e3 } = await db.from('technicians')
    .select('id, name, phone, status, active')
    .eq('business_id', biz.id).eq('active', true).order('name');
  if (e3) throw e3;

  return res.status(200).json({
    business: { id: biz.id, slug: biz.slug, name: biz.name, timezone: tz },
    today: (today || []).map(shapeBooking),
    revenue,
    technicians: techs || [],
    counts: {
      todayTotal: (today || []).length,
      unassigned: (today || []).filter(b => !b.technician_id && b.status !== 'cancelled').length,
    },
  });
}

// ── Bookings list ────────────────────────────────────────────────────────────
async function bookings(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const tz = biz.timezone || 'America/Denver';
  const range = (req.query.range || 'upcoming').toString();
  const status = (req.query.status || '').toString();

  let q = db.from('bookings').select(bookingSelect()).eq('business_id', biz.id);

  if (range === 'today') {
    q = q.gte('scheduled_at', localDayStartUTC(tz, 0).toISOString())
         .lt('scheduled_at', localDayStartUTC(tz, 1).toISOString());
  } else if (range === 'week') {
    q = q.gte('scheduled_at', startOfWeekUTC(tz).toISOString());
  } else if (range === 'upcoming') {
    q = q.gte('scheduled_at', localDayStartUTC(tz, 0).toISOString());
  } // 'all' = no date filter

  if (status) q = q.eq('status', status);

  const { data, error } = await q.order('scheduled_at', { ascending: true }).limit(500);
  if (error) throw error;
  return res.status(200).json({ bookings: (data || []).map(shapeBooking) });
}

// ── Services (for the New Booking form) ──────────────────────────────────────
async function services(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data, error } = await db.from('services')
    .select('id, name, base_price, duration_minutes')
    .eq('business_id', biz.id).eq('active', true).order('sort_order').order('name');
  if (error) throw error;
  return res.status(200).json({ services: data || [] });
}

// ── Create a manual / phone booking ──────────────────────────────────────────
async function bookingCreate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const c = body.customer || {};
  if (!c.name && !c.phone) return res.status(400).json({ error: 'Customer name or phone required' });

  // Reuse an existing customer (by phone, then email) or create one.
  let customer_id = c.id || null;
  if (!customer_id && c.phone) {
    const { data } = await db.from('customers').select('id').eq('business_id', biz.id).eq('phone', c.phone).maybeSingle();
    customer_id = data?.id || null;
  }
  if (!customer_id && c.email) {
    const { data } = await db.from('customers').select('id').eq('business_id', biz.id).eq('email', c.email).maybeSingle();
    customer_id = data?.id || null;
  }
  if (!customer_id) {
    const { data, error } = await db.from('customers').insert({
      business_id: biz.id, name: c.name || 'Customer', phone: c.phone || null, email: c.email || null,
      address_line1: c.address_line1 || null, city: c.city || null, state: c.state || null, postal_code: c.postal_code || null,
    }).select('id').single();
    if (error) throw error;
    customer_id = data.id;
  }

  const status = body.technician_id ? 'assigned' : 'confirmed';
  const { data: bRow, error: bErr } = await db.from('bookings').insert({
    business_id: biz.id, customer_id,
    technician_id: body.technician_id || null,
    service_id: body.service_id || null,
    status, source: 'manual',
    scheduled_at: body.scheduled_at || null,
    price: Number(body.price) || 0,
    notes: body.notes || null,
    customer_notes: body.customer_notes || null,
    address_line1: c.address_line1 || null, city: c.city || null, state: c.state || null, postal_code: c.postal_code || null,
  }).select('id').single();
  if (bErr) throw bErr;

  await db.from('booking_status_events').insert({
    booking_id: bRow.id, business_id: biz.id, technician_id: body.technician_id || null,
    status, note: `Created by ${auth.role} (dashboard)`,
  });
  return res.status(200).json({ ok: true, id: bRow.id });
}

// ── Booking update: confirm | cancel | reschedule | assign | status ──────────
async function bookingUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  // Confirm the booking belongs to this business before touching it.
  const { data: existing, error: e0 } = await db.from('bookings')
    .select('id, status, technician_id').eq('id', id).eq('business_id', biz.id).single();
  if (e0 || !existing) return res.status(404).json({ error: 'Booking not found' });

  const patch = {};
  let newStatus = null;
  const now = new Date().toISOString();

  switch (body.action) {
    case 'confirm':
      patch.status = newStatus = 'confirmed'; patch.confirmed_at = now; break;
    case 'cancel':
      patch.status = newStatus = 'cancelled'; patch.cancelled_at = now;
      if (body.reason) patch.cancellation_reason = body.reason; break;
    case 'reschedule':
      if (!body.scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
      patch.scheduled_at = body.scheduled_at;
      if (body.scheduled_end) patch.scheduled_end = body.scheduled_end; break;
    case 'assign':
      patch.technician_id = body.technician_id || null;
      if (body.technician_id && existing.status === 'confirmed') { patch.status = newStatus = 'assigned'; patch.assigned_at = now; }
      break;
    case 'status':
      if (!body.status) return res.status(400).json({ error: 'status required' });
      patch.status = newStatus = body.status; break;
    default:
      return res.status(400).json({ error: `Unknown booking action "${body.action}"` });
  }

  const { error: e1 } = await db.from('bookings').update(patch).eq('id', id).eq('business_id', biz.id);
  if (e1) throw e1;

  if (newStatus) {
    await db.from('booking_status_events').insert({
      booking_id: id, business_id: biz.id, technician_id: patch.technician_id ?? existing.technician_id,
      status: newStatus, note: `Set by ${auth.role} (dashboard)`,
    });
  }
  return res.status(200).json({ ok: true });
}

// ── Customers (search) ───────────────────────────────────────────────────────
async function customers(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const term = (req.query.q || '').toString().trim();

  let q = db.from('customers')
    .select('id, name, phone, email, address_line1, city, state, postal_code, created_at')
    .eq('business_id', biz.id);
  if (term) {
    const like = `%${term}%`;
    q = q.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like},address_line1.ilike.${like}`);
  }
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return res.status(200).json({ customers: data || [] });
}

// ── Technicians ──────────────────────────────────────────────────────────────
async function technicians(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data, error } = await db.from('technicians')
    .select('id, name, phone, email, status, active, pin_hash')
    .eq('business_id', biz.id).order('name');
  if (error) throw error;
  // Never leak the hash; just say whether a PIN is set.
  const techs = (data || []).map(({ pin_hash, ...t }) => ({ ...t, pin_set: !!pin_hash }));
  return res.status(200).json({ technicians: techs });
}

async function technicianUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const { data: existing } = await db.from('technicians').select('id').eq('id', id).eq('business_id', biz.id).single();
  if (!existing) return res.status(404).json({ error: 'Technician not found' });

  const patch = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.phone !== undefined) patch.phone = body.phone || null;
  if (body.email !== undefined) patch.email = body.email || null;
  if (body.active !== undefined) patch.active = !!body.active;
  if (Object.keys(patch).length) {
    const { error } = await db.from('technicians').update(patch).eq('id', id).eq('business_id', biz.id);
    if (error) throw error;
  }

  // PIN is hashed via a SECURITY DEFINER RPC so we never store it in plaintext.
  if (body.pin) {
    if (!/^\d{4}$/.test(String(body.pin))) return res.status(400).json({ error: 'PIN must be 4 digits' });
    const { error } = await db.rpc('set_technician_pin', { p_id: id, p_pin: String(body.pin) });
    if (error) throw error;
  }
  return res.status(200).json({ ok: true });
}

// ── Technician weekly availability ───────────────────────────────────────────
// Read one tech's selected slots (+ the fixed slot/day definitions). The tech
// must belong to the requested business (scope already enforced on it).
async function techAvailability(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const techId = (req.query.tech_id || '').toString();
  if (!techId) return res.status(400).json({ error: 'tech_id required' });
  const { data: tech } = await db.from('technicians').select('id').eq('id', techId).eq('business_id', biz.id).single();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  const { data, error } = await db.from('technician_availability')
    .select('day_of_week, slot_key').eq('technician_id', techId);
  if (error) throw error;
  return res.status(200).json({
    slots: SLOTS, days: DAYS,
    availability: (data || []).map(r => ({ day_of_week: r.day_of_week, slot_key: r.slot_key })),
  });
}

// Replace one tech's availability (full replace). Only the five fixed slots on
// days 0–6 are accepted; anything else is rejected by normalizeSlots().
async function techAvailabilitySet(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const techId = (body.tech_id || '').toString();
  if (!techId) return res.status(400).json({ error: 'tech_id required' });
  const { data: tech } = await db.from('technicians').select('id').eq('id', techId).eq('business_id', biz.id).single();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  let rows;
  try { rows = normalizeSlots(body.slots); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  await db.from('technician_availability').delete().eq('technician_id', techId);
  if (rows.length) {
    const { error } = await db.from('technician_availability').insert(
      rows.map(r => ({ business_id: biz.id, technician_id: techId, ...r }))
    );
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, count: rows.length });
}

// ── Shared shaping ───────────────────────────────────────────────────────────
function bookingSelect() {
  return `id, status, source, scheduled_at, scheduled_end, price, notes, customer_notes,
          review_rating, review_text, technician_id,
          address_line1, city, state, postal_code,
          customer:customers ( id, name, phone, email ),
          technician:technicians ( id, name, status ),
          service:services ( id, name )`;
}

function shapeBooking(b) {
  return {
    id: b.id,
    status: b.status,
    source: b.source,
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    price: b.price,
    notes: b.notes,
    customer_notes: b.customer_notes,
    review_rating: b.review_rating,
    review_text: b.review_text,
    technician_id: b.technician_id,
    address: [b.address_line1, b.city, b.state, b.postal_code].filter(Boolean).join(', '),
    customer: b.customer || null,
    technician: b.technician || null,
    service: b.service || null,
  };
}
