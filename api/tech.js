// ============================================================================
// Technician app API (consolidated router).
//
//   POST login   { phone, pin }            -> { token, technician }
//   GET  jobs                              -> today's jobs for the logged-in tech
//   GET  job     ?id=                      -> one job's full detail
//   POST status  { id, status, note }      -> on_the_way|arrived|in_progress|completed
//
// A tech only ever sees their OWN jobs — the tech id comes from the signed
// token, never from the request body. Status changes also flip the tech's
// availability so it reflects in the admin dashboard.
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { signToken, verifyToken, getBearer, applyCors } from './_lib/auth.js';
import { localDayStartUTC } from './_lib/time.js';
import { SLOTS, DAYS, normalizeSlots } from './_lib/availability.js';

// Status a technician is allowed to set, and how it maps to availability + the
// matching lifecycle timestamp on the booking.
const TECH_STATUS = {
  on_the_way:  { tech: 'on_job',    stamp: 'on_the_way_at' },
  arrived:     { tech: 'on_job',    stamp: 'arrived_at' },
  in_progress: { tech: 'on_job',    stamp: null },
  completed:   { tech: 'available', stamp: 'completed_at' },
};

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    if (action === 'login') return await login(req, res, body);
    // Dev bypass (only when TECH_DEV_BYPASS is set) — log in without a PIN
    // while the app is still being built. Remove the env var for production.
    if (action === 'dev_techs') return await devTechs(req, res);
    if (action === 'dev_login') return await devLogin(req, res, body);

    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'tech') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();
    switch (action) {
      case 'jobs':             return await jobs(req, res, db, auth);
      case 'job':              return await job(req, res, db, auth);
      case 'status':           return await status(req, res, db, auth, body);
      case 'availability':     return await getAvailability(req, res, db, auth);
      case 'availability_set': return await setAvailability(req, res, db, auth, body);
      default:                 return res.status(400).json({ error: `Unknown action "${action}"` });
    }
  } catch (err) {
    console.error('[tech]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

async function login(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const phone = (body.phone || '').toString().trim();
  const pin = (body.pin || '').toString().trim();
  if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN required' });

  const db = serviceClient();
  // Verify against the hashed PIN inside the DB; the hash never leaves Postgres.
  const { data, error } = await db.rpc('verify_technician_pin', { p_phone: phone, p_pin: pin });
  if (error) throw error;
  const tech = Array.isArray(data) ? data[0] : data;
  if (!tech) return res.status(401).json({ error: 'Incorrect phone or PIN' });

  const token = signToken({ kind: 'tech', tech_id: tech.id, business_id: tech.business_id });
  return res.status(200).json({
    token,
    technician: { id: tech.id, name: tech.name, status: tech.status },
  });
}

function devBypassOn() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.TECH_DEV_BYPASS || '').toLowerCase());
}

// List every technician (with business) so the dev login screen can pick one.
async function devTechs(req, res) {
  if (!devBypassOn()) return res.status(403).json({ error: 'Dev bypass disabled' });
  const db = serviceClient();
  const { data, error } = await db.from('technicians')
    .select('id, name, business_id, businesses ( slug, name )')
    .eq('active', true).order('name');
  if (error) throw error;
  return res.status(200).json({
    technicians: (data || []).map(t => ({
      id: t.id, name: t.name, business_id: t.business_id,
      business: t.businesses?.name || '', slug: t.businesses?.slug || '',
    })),
  });
}

// Issue a tech token for a chosen technician, no PIN required.
async function devLogin(req, res, body) {
  if (!devBypassOn()) return res.status(403).json({ error: 'Dev bypass disabled' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const db = serviceClient();
  const { data: tech, error } = await db.from('technicians')
    .select('id, name, status, business_id').eq('id', body.tech_id).single();
  if (error || !tech) return res.status(404).json({ error: 'Technician not found' });
  const token = signToken({ kind: 'tech', tech_id: tech.id, business_id: tech.business_id });
  return res.status(200).json({ token, technician: { id: tech.id, name: tech.name, status: tech.status } });
}

async function jobs(req, res, db, auth) {
  // Today's jobs for this tech, in their business timezone.
  const { data: biz } = await db.from('businesses').select('timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';

  const { data, error } = await db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes,
             address_line1, address_line2, city, state, postal_code, lat, lng,
             customer:customers ( name, phone ),
             service:services ( name )`)
    .eq('business_id', auth.business_id)
    .eq('technician_id', auth.tech_id)
    .gte('scheduled_at', localDayStartUTC(tz, 0).toISOString())
    .lt('scheduled_at', localDayStartUTC(tz, 1).toISOString())
    .order('scheduled_at', { ascending: true });
  if (error) throw error;

  return res.status(200).json({ jobs: (data || []).map(shapeJob) });
}

async function job(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data, error } = await db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes, price,
             address_line1, address_line2, city, state, postal_code, lat, lng,
             customer:customers ( name, phone, email ),
             service:services ( name ),
             line_items:booking_line_items ( name, quantity, unit_price, line_total, kind )`)
    .eq('id', id)
    .eq('business_id', auth.business_id)
    .eq('technician_id', auth.tech_id)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Job not found' });
  return res.status(200).json({ job: shapeJob(data, true) });
}

async function status(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  const next = (body.status || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const map = TECH_STATUS[next];
  if (!map) return res.status(400).json({ error: `Invalid status "${next}"` });

  // The job must belong to this tech.
  const { data: existing } = await db.from('bookings')
    .select('id').eq('id', id).eq('business_id', auth.business_id).eq('technician_id', auth.tech_id).single();
  if (!existing) return res.status(404).json({ error: 'Job not found' });

  const patch = { status: next };
  if (map.stamp) patch[map.stamp] = new Date().toISOString();

  const { error: e1 } = await db.from('bookings').update(patch).eq('id', id);
  if (e1) throw e1;

  await db.from('booking_status_events').insert({
    booking_id: id, business_id: auth.business_id, technician_id: auth.tech_id,
    status: next, note: body.note || 'Updated by technician',
  });

  // Reflect availability in the admin dashboard.
  await db.from('technicians').update({ status: map.tech }).eq('id', auth.tech_id);

  return res.status(200).json({ ok: true, status: next });
}

// ── Weekly availability (the tech edits their OWN) ──────────────────────────
// Return this tech's selected slots plus the fixed slot/day definitions so the
// app renders the picker without hardcoding them.
async function getAvailability(req, res, db, auth) {
  const { data, error } = await db.from('technician_availability')
    .select('day_of_week, slot_key')
    .eq('technician_id', auth.tech_id);
  if (error) throw error;
  return res.status(200).json({
    slots: SLOTS, days: DAYS,
    availability: (data || []).map(r => ({ day_of_week: r.day_of_week, slot_key: r.slot_key })),
  });
}

// Replace this tech's availability with the provided set (a full replace keeps
// the client simple and the state unambiguous). Only the five fixed slots on
// days 0–6 are accepted; anything else is rejected by normalizeSlots().
async function setAvailability(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let rows;
  try { rows = normalizeSlots(body.slots); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  await db.from('technician_availability').delete().eq('technician_id', auth.tech_id);
  if (rows.length) {
    const { error } = await db.from('technician_availability').insert(
      rows.map(r => ({ business_id: auth.business_id, technician_id: auth.tech_id, ...r }))
    );
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, count: rows.length });
}

function shapeJob(b, full = false) {
  const address = [b.address_line1, b.address_line2, b.city, b.state, b.postal_code].filter(Boolean).join(', ');
  const out = {
    id: b.id,
    status: b.status,
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    customer_name: b.customer?.name || 'Customer',
    customer_phone: b.customer?.phone || null,
    service: b.service?.name || null,
    address,
    customer_notes: b.customer_notes || null,
    maps_url: address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null,
  };
  if (full) {
    out.customer_email = b.customer?.email || null;
    out.notes = b.notes || null;
    out.price = b.price;
    out.line_items = b.line_items || [];
  }
  return out;
}
