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
import { notificationsOn } from './_lib/notify.js';
import { localDayStartUTC, localDateStartUTC, startOfWeekUTC, startOfMonthUTC, addDaysStr } from './_lib/time.js';
import { SLOTS, DAYS, normalizeSlots, assertDate, dayOfWeekFor, computeExceptionRows } from './_lib/availability.js';
import { stripe, stripeConfigured, findCardOnFileByEmail, defaultPaymentMethod } from './_lib/stripe.js';
import { uploadImage, deleteImage } from './_lib/storage.js';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed'];

// ── SMS Helper ──────────────────────────────────────────────────────────────
// Normalize US/CA numbers to E.164 (+1XXXXXXXXXX), which Twilio requires.
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

async function sendSMS(phoneNumber, message) {
  if (!notificationsOn()) { console.log('[SMS] notifications disabled; not sent:', message); return; }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn('[SMS] Twilio not configured; message not sent:', message);
    return;
  }
  const to = toE164(phoneNumber);
  if (!to) { console.warn('[SMS] Unusable phone, not sent:', phoneNumber); return; }
  const formData = new URLSearchParams();
  formData.append('From', process.env.TWILIO_PHONE_NUMBER);
  formData.append('To', to);
  formData.append('Body', message);
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}` },
      body: formData,
    });
    if (!res.ok) { const t = await res.text().catch(()=> ''); throw new Error(`Twilio ${res.status}: ${t.slice(0,300)}`); }
    console.log('[SMS] Sent to', to.slice(-4));
  } catch (e) {
    console.error('[SMS]', e.message);
  }
}

// Display label for an internal note/photo authored from the dashboard.
function adminAuthorName(auth) { return auth.role === 'owner' ? 'Owner' : 'Office'; }

// Notify a technician by SMS that they've been assigned a job. Fire-and-forget;
// safe to call even if the tech has no phone (sendSMS no-ops). `scheduledAtISO`
// may be null (unscheduled job) — we fall back to a generic line.
async function notifyTechAssigned(db, biz, technicianId, scheduledAtISO) {
  if (!technicianId) return;
  const { data: tech } = await db.from('technicians')
    .select('phone').eq('id', technicianId).eq('business_id', biz.id).maybeSingle();
  if (!tech?.phone) return;
  const tz = biz.timezone || 'America/Denver';
  let whenTxt = 'a new job';
  if (scheduledAtISO) {
    try {
      whenTxt = new Date(scheduledAtISO).toLocaleString('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch { /* keep generic */ }
  }
  const msg = `You just got a job for ${whenTxt}. Please check your schedule for more information.`;
  sendSMS(tech.phone, msg).catch(console.error);
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    if (action === 'login') return await login(req, res, body);
    if (action === 'review') return await review(req, res, body);

    // Everything below requires a valid admin token.
    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();

    switch (action) {
      case 'summary':           return await summary(req, res, db, auth);
      case 'services':          return await services(req, res, db, auth);
      case 'service_options':   return await serviceOptions(req, res, db, auth);
      case 'seed_tv_options':   return await seedTvOptions(req, res, db, auth);
      case 'available_slots':   return await availableSlots(req, res, db, auth);
      case 'available_dates':   return await availableDates(req, res, db, auth);
      case 'calendar':          return await calendar(req, res, db, auth);
      case 'availability_overview': return await availabilityOverview(req, res, db, auth);
      case 'bookings':          return await bookings(req, res, db, auth);
      case 'booking_create':    return await bookingCreate(req, res, db, auth, body);
      case 'booking_update':    return await bookingUpdate(req, res, db, auth, body);
      case 'booking_payment':   return await bookingPayment(req, res, db, auth, body);
      case 'booking_photos':       return await bookingPhotos(req, res, db, auth);
      case 'booking_photo_add':    return await bookingPhotoAdd(req, res, db, auth, body);
      case 'booking_photo_delete': return await bookingPhotoDelete(req, res, db, auth, body);
      case 'booking_notes':        return await bookingNotes(req, res, db, auth);
      case 'booking_note_add':     return await bookingNoteAdd(req, res, db, auth, body);
      case 'booking_note_delete':  return await bookingNoteDelete(req, res, db, auth, body);
      case 'photo_gallery':        return await photoGallery(req, res, db, auth);
      case 'customers':         return await customers(req, res, db, auth);
      case 'customer_update':   return await customerUpdate(req, res, db, auth, body);
      case 'technicians':       return await technicians(req, res, db, auth);
      case 'technician_update': return await technicianUpdate(req, res, db, auth, body);
      case 'tech_availability':     return await techAvailability(req, res, db, auth);
      case 'tech_availability_set': return await techAvailabilitySet(req, res, db, auth, body);
      case 'tech_availability_exception_set': return await techAvailabilityExceptionSet(req, res, db, auth, body);
      case 'reviews':           return await reviews(req, res, db, auth);
      case 'estimates':         return await estimates(req, res, db, auth);
      case 'estimate_update':   return await estimateUpdate(req, res, db, auth, body);
      case 'estimate_send_sms': return await estimateSendSms(req, res, db, auth, body);
      case 'estimate_send_email': return await estimateSendEmail(req, res, db, auth, body);
      default:                  return res.status(400).json({ error: `Unknown action "${action}"` });
    }
  } catch (err) {
    console.error('[admin]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

// ── Auth ────────────────────────────────────────────────────────────────────
// Friendly first name shown in the dashboard greeting. Configurable per role via
// env vars; sensible defaults match the people running each business today.
function displayNameFor(scope) {
  if (scope === 'handy-andy') return process.env.HANDY_ANDY_SECRETARY_NAME || 'Heather';
  if (scope === 'doms')       return process.env.DOMS_SECRETARY_NAME || 'Joey';
  return process.env.ADMIN_NAME || 'Andrew';
}

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

  const name = displayNameFor(scope);
  const token = signToken({ kind: 'admin', role, scope, name });
  // Tell the dashboard which outbound channels are wired up so it can show or
  // hide the Send SMS / Send Email buttons instead of surfacing a dead click.
  const config = {
    email: !!process.env.RESEND_API_KEY,
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
  };
  return res.status(200).json({ token, role, scope, name, config, businesses: businesses || [] });
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

// Pull a missing-column name out of either error wording Supabase can surface:
//   PostgREST schema cache: Could not find the 'customer_zip' column of 'estimates' …
//   Raw Postgres (42703):   column estimates.customer_zip does not exist
// Used to gracefully degrade selects/inserts when a migration hasn't been applied.
function missingColumn(msg) {
  let m = /Could not find the '([^']+)' column/.exec(msg || '');
  if (m) return m[1];
  m = /column\s+(?:\w+\.)?["']?(\w+)["']?\s+does not exist/i.exec(msg || '');
  return m ? m[1] : null;
}

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

  // Last month's revenue (same active statuses) — baseline for the "pace" chip.
  const lastMonthStart = startOfMonthUTC(tz, new Date(monthStart.getTime() - 24 * 60 * 60 * 1000));
  const { data: lastMonthJobs } = await db.from('bookings')
    .select('price')
    .eq('business_id', biz.id)
    .gte('scheduled_at', lastMonthStart.toISOString())
    .lt('scheduled_at', monthStart.toISOString())
    .in('status', ACTIVE_STATUSES);
  revenue.lastMonth = sum(lastMonthJobs || []);

  // Run-rate projection for the current month (local calendar): month-to-date
  // revenue scaled by how much of the month has elapsed.
  const [ly, lm, ld] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  const daysInMonth = new Date(ly, lm, 0).getDate();
  revenue.projectedMonth = ld > 0 ? Math.round(revenue.month / ld * daysInMonth) : revenue.month;

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

// ── Calendar (week/day grid) ─────────────────────────────────────────────────
// Bookings within an explicit [from, to) window, plus the technicians and
// service areas the sidebar needs to render filters and avatars — one call
// bootstraps the whole calendar view.
async function calendar(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const from = (req.query.from || '').toString();
  const to = (req.query.to || '').toString();
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const { data: bk, error } = await db.from('bookings').select(bookingSelect())
    .eq('business_id', biz.id)
    .gte('scheduled_at', from).lt('scheduled_at', to)
    .order('scheduled_at', { ascending: true }).limit(2000);
  if (error) throw error;

  const { data: techs } = await db.from('technicians')
    .select('id, name, status, color, active').eq('business_id', biz.id).eq('active', true).order('name');
  const { data: areas } = await db.from('service_areas')
    .select('id, name, state').eq('business_id', biz.id).eq('active', true).order('name');

  return res.status(200).json({
    business: { id: biz.id, slug: biz.slug, name: biz.name, timezone: biz.timezone || 'America/Denver' },
    bookings: (bk || []).map(shapeBooking),
    technicians: techs || [],
    areas: areas || [],
  });
}

// All techs' weekly availability + upcoming exceptions for one business, so the
// calendar's "Availability" view can show who's free per day/slot.
async function availabilityOverview(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data: techs } = await db.from('technicians')
    .select('id, name, color').eq('business_id', biz.id).eq('active', true).order('name');
  const ids = (techs || []).map(t => t.id);

  const tz = biz.timezone || 'America/Denver';
  let availability = [], exceptions = [], bookings = [];
  if (ids.length) {
    const { data: av } = await db.from('technician_availability')
      .select('technician_id, day_of_week, slot_key').in('technician_id', ids);
    availability = av || [];
    const today = new Date().toISOString().slice(0, 10);
    const { data: ex } = await db.from('technician_availability_exceptions')
      .select('technician_id, exception_date, slot_key, is_available')
      .in('technician_id', ids).gte('exception_date', today);
    exceptions = (ex || []).map(r => ({
      technician_id: r.technician_id, date: r.exception_date, slot_key: r.slot_key, is_available: r.is_available,
    }));
    // Existing (non-cancelled) bookings occupy slots: a tech with a job in a slot
    // is NOT available for it, so the overview must subtract them (same rule the
    // New Booking calendar already uses). Mapped to { technician_id, date, slot_key }.
    const { data: bk } = await db.from('bookings')
      .select('technician_id, scheduled_at')
      .eq('business_id', biz.id).in('technician_id', ids)
      .neq('status', 'cancelled').not('scheduled_at', 'is', null)
      .order('scheduled_at', { ascending: true }).limit(2000);
    bookings = (bk || []).map(b => {
      const slot_key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
      return slot_key ? { technician_id: b.technician_id, date: localDateStr(tz, b.scheduled_at), slot_key } : null;
    }).filter(Boolean);
  }
  return res.status(200).json({ slots: SLOTS, days: DAYS, technicians: techs || [], availability, exceptions, bookings });
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
    .select('id, name, base_price, duration_minutes, category')
    .eq('business_id', biz.id).eq('active', true).order('sort_order').order('name');
  if (error) throw error;
  return res.status(200).json({ services: data || [] });
}

// ── Option groups + options for one service (drives the New Booking steps) ────
async function serviceOptions(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const serviceId = (req.query.service_id || '').toString();
  if (!serviceId) return res.status(400).json({ error: 'service_id required' });

  const { data: groups, error: gErr } = await db.from('service_option_groups')
    .select('id, key, label, min_select, max_select, sort_order')
    .eq('business_id', biz.id).eq('service_id', serviceId).order('sort_order');
  if (gErr) throw gErr;

  const ids = (groups || []).map(g => g.id);
  let options = [];
  if (ids.length) {
    const { data: opts, error: oErr } = await db.from('service_options')
      .select('id, group_id, label, price, metadata, sort_order')
      .in('group_id', ids).eq('active', true).order('sort_order');
    if (oErr) throw oErr;
    options = opts || [];
  }
  const byGroup = {};
  for (const o of options) (byGroup[o.group_id] = byGroup[o.group_id] || []).push(o);
  const result = (groups || []).map(g => ({ ...g, options: byGroup[g.id] || [] }));
  return res.status(200).json({ groups: result });
}

// ── Seed / repair the Handy Andy "TV Installation" option groups ─────────────
// The public widget (widget.js) hardcodes every TV-mounting option, so a DB that
// never received migrations 0003/0015 still books fine publicly — but the admin
// New Booking form reads the option groups from the DB and would only show the
// one group that 0001 seeds (TV Size). This action idempotently inserts every
// missing group + option so the full New Booking flow works. Matches 0003/0015.
const TV_OPTION_GROUPS = [
  { key: 'size',      label: 'TV Size',                       min: 1, max: 1, sort: 1, options: [
    { label: '32" or Less', price: 99,  zbk: '1685657519214x408615950244710660', sort: 1 },
    { label: '33"–59"',     price: 109, zbk: '1685657519214x406129807645840830', sort: 2 },
    { label: '60"–69"',     price: 119, zbk: '1685657519214x241977595988204900', sort: 3 },
    { label: '70"–84"',     price: 149, zbk: '1685657519214x168809705059288930', sort: 4 },
    { label: '85"–97"',     price: 179, zbk: '1693451324278x246099356920840200', sort: 5 },
    { label: '98"+',        price: 229, zbk: '1729566606709x280549383678984200', sort: 6 },
  ]},
  { key: 'bracket',   label: 'Bracket',                       min: 0, max: 1, sort: 2, options: [
    { label: 'I have my own bracket',                 price: 0,   zbk: '1685657519638x296785870103780400', sort: 1 },
    { label: 'Flat',                                  price: 45,  zbk: '1685657519638x151782031594280160', sort: 2 },
    { label: 'Tilting (recommended)',                 price: 60,  zbk: '1685657519638x293251872070913660', sort: 3 },
    { label: 'Full Motion',                           price: 110, zbk: '1685657519638x327788739524076600', sort: 4 },
    { label: '85"-100" TV Flat Bracket',              price: 90,  zbk: '1776229587207x710284994703786000', sort: 5 },
    { label: '85"-100" TV Tilting Bracket',           price: 110, zbk: '1776229598255x578976769128267800', sort: 6 },
    { label: '85"-100" TV Full Motion Bracket',       price: 190, zbk: '1776229610718x521138691917742100', sort: 7 },
    { label: 'Samsung Frame TV bracket (box included)', price: 25, zbk: '1736123941131x483930420018151400', sort: 8 },
  ]},
  { key: 'fireplace', label: 'Fireplace',                     min: 0, max: 1, sort: 3, options: [
    { label: 'TV NOT above a fireplace', price: 0,  zbk: '1690749164365x391343451869544450', sort: 1 },
    { label: 'TV above a fireplace',     price: 30, zbk: '1690749240392x103535038030413820', sort: 2 },
  ]},
  { key: 'surface',   label: 'Wall Surface',                  min: 0, max: 1, sort: 4, options: [
    { label: 'Drywall',             price: 0,  zbk: '1685657520672x628368921210809000', sort: 1 },
    { label: 'Brick',               price: 35, zbk: '1685657520672x962594124305617300', sort: 2 },
    { label: 'Uneven Stone or Tile', price: 50, zbk: '1685658012495x711713122836807700', sort: 3 },
    { label: 'Outdoor/Stucco',      price: 45, zbk: '1692765788131x467716510198005800', sort: 4 },
  ]},
  { key: 'wires',     label: 'Wire Hiding',                   min: 0, max: 1, sort: 5, options: [
    { label: 'Hide wires BEHIND the wall',  price: 75, zbk: '1685657520215x679178310990983400', sort: 1 },
    { label: 'Hide wires OUTSIDE the wall', price: 25, zbk: '1685657520215x860675929308834800', sort: 2 },
    { label: 'Wall already has plug behind TV', price: 0, zbk: '1685657520215x846697647726538900', sort: 3 },
    { label: 'Wires hang under the TV',     price: 0,  zbk: '1696472636219x934279187941818400', sort: 4 },
  ]},
  { key: 'lifting',   label: 'Second Technician (Large TVs)', min: 0, max: 1, sort: 6, options: [
    { label: 'TV under 70" (no lifting fee)',        price: 0,  zbk: '1685657521270x971699776821509000', sort: 1 },
    { label: '70–85" — customer can help lift',      price: 0,  zbk: '1685657521270x242389337506608420', sort: 2 },
    { label: '70–85" — customer cannot help lift',   price: 70, zbk: '1685657521270x264421370121691100', sort: 3 },
    { label: '85"+ (second technician required)',    price: 70, zbk: '1747842781494x315473919196528640', sort: 4 },
  ]},
  { key: 'dismount',  label: 'Dismount',                      min: 0, max: 1, sort: 7, options: [
    { label: 'Guaranteed Dismount Service (when upgrading later)', price: 35, zbk: '1685657521717x559414519649398460', sort: 1 },
    { label: "No — I'll handle removal myself",      price: 0,  zbk: '1751646796269x538012740525228000', sort: 2 },
  ]},
  { key: 'extras',    label: 'Add-ons',                       min: 0, max: 0, sort: 8, options: [
    { label: 'Install Samsung Frame OneConnect box behind TV', price: 350, zbk: '1736124404151x401859929508413400', sort: 1 },
    { label: 'Apple TV installation (mounting bracket included)', price: 25, zbk: '1711776157524x348981049297469440', sort: 2 },
    { label: 'Soundbar Installation', price: 50, zbk: '1698905037955x771952325080383500', sort: 3 },
    { label: 'Install shelf under TV', price: 45, zbk: '1698905090848x173584167038615550', sort: 4 },
    { label: 'LED Lights',            price: 50, zbk: '1698905111338x528324964985864200', sort: 5 },
    { label: '1 hour of Handyman Labor', price: 85, zbk: '1715820772054x920882061736149000', sort: 6 },
    { label: 'Other',                 price: 0,  zbk: '1698905159794x117137493532868600', sort: 7 },
  ]},
];

async function seedTvOptions(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }

  // Find the TV-mounting service (named "TV Installation"; fall back to category).
  let { data: svc } = await db.from('services')
    .select('id, name, category').eq('business_id', biz.id).eq('name', 'TV Installation').maybeSingle();
  if (!svc) {
    const { data: byCat } = await db.from('services')
      .select('id, name, category').eq('business_id', biz.id).eq('category', 'TV Mounting').limit(1);
    svc = (byCat && byCat[0]) || null;
  }
  if (!svc) { const e = new Error('TV Installation service not found for this business'); e.status = 404; throw e; }

  const report = { service: svc.name, groups_created: [], groups_existing: [], options_created: 0, options_existing: 0 };

  // Existing groups for this service, keyed by `key`.
  const { data: existingGroups } = await db.from('service_option_groups')
    .select('id, key').eq('business_id', biz.id).eq('service_id', svc.id);
  const groupByKey = {};
  for (const g of (existingGroups || [])) groupByKey[g.key] = g.id;

  for (const g of TV_OPTION_GROUPS) {
    let groupId = groupByKey[g.key];
    if (groupId) {
      report.groups_existing.push(g.key);
    } else {
      const { data: inserted, error: gErr } = await db.from('service_option_groups')
        .insert({ business_id: biz.id, service_id: svc.id, key: g.key, label: g.label,
                  min_select: g.min, max_select: g.max, sort_order: g.sort })
        .select('id').single();
      if (gErr) throw gErr;
      groupId = inserted.id;
      report.groups_created.push(g.key);
    }

    // Options already present in this group, keyed by zenbooker_option_id.
    const { data: existingOpts } = await db.from('service_options')
      .select('id, zenbooker_option_id').eq('business_id', biz.id).eq('group_id', groupId);
    const haveZbk = new Set((existingOpts || []).map(o => o.zenbooker_option_id));

    const toInsert = g.options.filter(o => !haveZbk.has(o.zbk)).map(o => ({
      business_id: biz.id, group_id: groupId, label: o.label, price: o.price,
      zenbooker_option_id: o.zbk, sort_order: o.sort, active: true,
    }));
    report.options_existing += g.options.length - toInsert.length;
    if (toInsert.length) {
      const { error: oErr } = await db.from('service_options').insert(toInsert);
      if (oErr) throw oErr;
      report.options_created += toInsert.length;
    }
  }

  return res.status(200).json({ ok: true, ...report });
}

// ── Available time slots for a date (filtered by technician if provided) ─────
async function availableSlots(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const dateStr = (req.query.date || '').toString();
  const techId = (req.query.technician_id || '').toString();
  if (!dateStr) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

  const dow = dayOfWeekFor(dateStr);
  const tz = biz.timezone || 'America/Denver';
  const keys = await availableSlotKeys(db, biz.id, techId, dateStr, dow, tz);
  const available = SLOTS.filter(s => keys.has(s.key))
    .map(s => ({ slot_key: s.key, label: s.label, start: s.start, end: s.end }));
  return res.status(200).json({ slots: available, date: dateStr, day_of_week: dow });
}

// ── Slot occupancy (existing bookings) ───────────────────────────────────────
// Local wall-clock HH:MM (business tz) for an instant.
function localHHMM(tz, instantISO) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(instantISO)).reduce((a, x) => (a[x.type] = x.value, a), {});
  let hh = p.hour === '24' ? '00' : p.hour;            // some envs emit 24 for midnight
  return `${hh}:${p.minute}`;
}
// Local calendar date 'YYYY-MM-DD' (business tz) for an instant.
function localDateStr(tz, instantISO) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instantISO));
}
// Which fixed slot (if any) a local wall-clock time falls inside: [start,end).
function slotKeyForLocalTime(hhmm) {
  const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const t = toMin(hhmm);
  for (const s of SLOTS) if (t >= toMin(s.start) && t < toMin(s.end)) return s.key;
  for (const s of SLOTS) if (toMin(s.start) === t) return s.key;   // exact-start fallback
  return null;
}
// Slot keys already occupied by a non-cancelled booking for ONE tech on a date.
// `excludeId` skips one booking (used when editing it, so it never conflicts
// with itself).
async function bookedSlotKeysForTech(db, bizId, techId, dateStr, tz, excludeId = null) {
  if (!techId || !dateStr) return new Set();
  const dayStart = localDateStartUTC(tz, dateStr);
  const dayEnd = localDateStartUTC(tz, addDaysStr(dateStr, 1));
  let q = db.from('bookings')
    .select('id, scheduled_at')
    .eq('business_id', bizId).eq('technician_id', techId)
    .neq('status', 'cancelled')
    .not('scheduled_at', 'is', null)
    .gte('scheduled_at', dayStart.toISOString())
    .lt('scheduled_at', dayEnd.toISOString());
  if (excludeId) q = q.neq('id', excludeId);
  const { data } = await q;
  const taken = new Set();
  for (const b of (data || [])) {
    const key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    if (key) taken.add(key);
  }
  return taken;
}

// Set of slot keys a tech (or ANY tech) is available for on an exact date,
// honouring recurring availability, one-time exceptions, AND existing bookings
// (a slot a tech is already booked for is no longer offered — no double-booking).
async function availableSlotKeys(db, bizId, techId, dateStr, dow, tz) {
  if (!techId || techId === 'any') {
    const { data: techs } = await db.from('technicians')
      .select('id').eq('business_id', bizId).eq('active', true);
    const union = new Set();
    for (const t of (techs || [])) {
      const ks = await singleTechSlotKeys(db, t.id, dateStr, dow);
      const booked = await bookedSlotKeysForTech(db, bizId, t.id, dateStr, tz);
      ks.forEach(k => { if (!booked.has(k)) union.add(k); });
    }
    return union;
  }
  const ks = await singleTechSlotKeys(db, techId, dateStr, dow);
  const booked = await bookedSlotKeysForTech(db, bizId, techId, dateStr, tz);
  booked.forEach(k => ks.delete(k));
  return ks;
}

// Pick the first active tech available for an exact date+slot (recurring OR a
// one-time exception) who is NOT already booked for that slot. Falls back to any
// active tech who is free in that slot so we never auto-create a double-booking.
async function pickAvailableTech(db, bizId, dateStr, slotKey, tz) {
  const { data: techs } = await db.from('technicians')
    .select('id').eq('business_id', bizId).eq('active', true)
    .order('created_at', { ascending: true });
  const list = techs || [];
  if (!list.length) return null;
  if (dateStr && slotKey) {
    const dow = dayOfWeekFor(dateStr);
    // First choice: scheduled-available AND free in this slot.
    for (const t of list) {
      const keys = await singleTechSlotKeys(db, t.id, dateStr, dow);
      if (!keys.has(slotKey)) continue;
      const booked = await bookedSlotKeysForTech(db, bizId, t.id, dateStr, tz);
      if (!booked.has(slotKey)) return t.id;
    }
    // Second choice: any active tech who is at least free in this slot, even if
    // not on their normal schedule — still never returns an already-booked tech.
    for (const t of list) {
      const booked = await bookedSlotKeysForTech(db, bizId, t.id, dateStr, tz);
      if (!booked.has(slotKey)) return t.id;
    }
    // Everyone is booked for this slot — leave unassigned rather than stack a
    // second job on a tech. bookingCreate will create it as 'confirmed'/unassigned.
    return null;
  }
  return list[0].id;
}

async function singleTechSlotKeys(db, techId, dateStr, dow) {
  const { data: av } = await db.from('technician_availability')
    .select('slot_key').eq('technician_id', techId).eq('day_of_week', dow);
  const slots = new Set((av || []).map(x => x.slot_key));
  const { data: exc } = await db.from('technician_availability_exceptions')
    .select('slot_key, is_available').eq('technician_id', techId).eq('exception_date', dateStr);
  for (const e of (exc || [])) {
    if (e.is_available) slots.add(e.slot_key); else slots.delete(e.slot_key);
  }
  return slots;
}

// Which dates in a month have at least one available slot (for the date picker).
async function availableDates(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const month = (req.query.month || '').toString();        // 'YYYY-MM'
  const techId = (req.query.technician_id || '').toString();
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayStr = new Date().toISOString().split('T')[0];

  // Pull recurring availability + this month's exceptions once, compute in memory.
  let techFilter = (q) => q;
  let techIds = null;
  if (!techId || techId === 'any') {
    const { data: techs } = await db.from('technicians').select('id').eq('business_id', biz.id).eq('active', true);
    techIds = (techs || []).map(t => t.id);
  } else {
    techIds = [techId];
  }
  if (!techIds.length) return res.status(200).json({ dates: [], month });

  const { data: av } = await db.from('technician_availability')
    .select('technician_id, day_of_week, slot_key').in('technician_id', techIds);
  const recurring = {};   // `${techId}:${dow}` -> Set(slot_key)
  for (const r of (av || [])) {
    const k = `${r.technician_id}:${r.day_of_week}`;
    (recurring[k] = recurring[k] || new Set()).add(r.slot_key);
  }
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const { data: exc } = await db.from('technician_availability_exceptions')
    .select('technician_id, exception_date, slot_key, is_available')
    .in('technician_id', techIds).gte('exception_date', monthStart).lte('exception_date', monthEnd);
  const excByDate = {};   // `${date}` -> [{tech,slot,is_available}]
  for (const e of (exc || [])) (excByDate[e.exception_date] = excByDate[e.exception_date] || []).push(e);

  // Existing bookings this month so fully-booked days don't show as available.
  const tz = biz.timezone || 'America/Denver';
  const winStart = localDateStartUTC(tz, monthStart);
  const winEnd = localDateStartUTC(tz, addDaysStr(monthEnd, 1));
  const { data: bk } = await db.from('bookings')
    .select('technician_id, scheduled_at')
    .eq('business_id', biz.id).in('technician_id', techIds)
    .neq('status', 'cancelled').not('scheduled_at', 'is', null)
    .gte('scheduled_at', winStart.toISOString()).lt('scheduled_at', winEnd.toISOString());
  const occ = {};   // `${techId}:${date}` -> Set(slot_key)
  for (const b of (bk || [])) {
    const date = localDateStr(tz, b.scheduled_at);
    const key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    if (!key) continue;
    const k = `${b.technician_id}:${date}`;
    (occ[k] = occ[k] || new Set()).add(key);
  }

  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month}-${String(d).padStart(2, '0')}`;
    if (dateStr < todayStr) continue;                       // no past dates
    const dow = dayOfWeekFor(dateStr);
    let anySlot = false;
    for (const tid of techIds) {
      const set = new Set(recurring[`${tid}:${dow}`] || []);
      for (const e of (excByDate[dateStr] || [])) {
        if (e.technician_id !== tid) continue;
        if (e.is_available) set.add(e.slot_key); else set.delete(e.slot_key);
      }
      for (const k of (occ[`${tid}:${dateStr}`] || [])) set.delete(k);   // drop booked slots
      if (set.size) { anySlot = true; break; }
    }
    if (anySlot) dates.push(dateStr);
  }
  return res.status(200).json({ dates, month });
}

// Attach a tokenized payment method to a Stripe customer (card on file).
// Returns { customerId, pmId } or null if Stripe isn't configured.
async function saveCardOnFile(pmId, cust) {
  const SK = process.env.STRIPE_SECRET_KEY;
  if (!SK) return null;
  const sAuth = { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  // Create a Stripe customer for the card.
  const cb = new URLSearchParams();
  if (cust.email) cb.set('email', cust.email);
  if (cust.name) cb.set('name', cust.name);
  if (cust.phone) cb.set('phone', cust.phone);
  cb.set('description', 'Dashboard booking customer');
  const ccr = await fetch('https://api.stripe.com/v1/customers', { method: 'POST', headers: sAuth, body: cb });
  const cc = await ccr.json();
  if (!ccr.ok) throw new Error(cc?.error?.message || 'Stripe customer create failed');
  const customerId = cc.id;
  // Attach the payment method and make it the default.
  const ab = new URLSearchParams(); ab.set('customer', customerId);
  const ar = await fetch(`https://api.stripe.com/v1/payment_methods/${pmId}/attach`, { method: 'POST', headers: sAuth, body: ab });
  const pm = await ar.json();
  if (!ar.ok) throw new Error(pm?.error?.message || 'Attach failed');
  const db = new URLSearchParams(); db.set('invoice_settings[default_payment_method]', pmId);
  await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { method: 'POST', headers: sAuth, body: db });
  return { customerId, pmId };
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

  // Convert scheduled_date + scheduled_slot to scheduled_at timestamp. The slot
  // start is a LOCAL wall-clock time in the business timezone, so anchor it to
  // local midnight (as UTC) and add the slot offset — never store it as raw UTC.
  const tz = biz.timezone || 'America/Denver';
  let scheduled_at = body.scheduled_at || null;
  if (body.scheduled_date && body.scheduled_slot) {
    const slotDef = SLOTS.find(s => s.key === body.scheduled_slot);
    if (slotDef) {
      const [hh, mm] = slotDef.start.split(':').map(Number);
      const midnight = localDateStartUTC(tz, body.scheduled_date);
      scheduled_at = new Date(midnight.getTime() + (hh * 60 + mm) * 60000).toISOString();
    }
  }

  // If technician_id='any', pick the first technician actually available for
  // this date+slot. Honours one-time exceptions (not just recurring), and falls
  // back to any active tech so a bookable date never lands as an unassigned job
  // the technician can't see.
  let technician_id = body.technician_id;
  if (technician_id === 'any') {
    technician_id = await pickAvailableTech(db, biz.id, body.scheduled_date, body.scheduled_slot, tz);
  }

  // Guard against double-booking: if a specific tech ends up assigned to a slot
  // they already have a non-cancelled booking in, reject the create. This backs
  // up the UI (which no longer offers booked slots) against stale forms / races.
  if (technician_id && scheduled_at) {
    const conflictDate = body.scheduled_date || localDateStr(tz, scheduled_at);
    const conflictSlot = body.scheduled_slot || slotKeyForLocalTime(localHHMM(tz, scheduled_at));
    if (conflictSlot) {
      const taken = await bookedSlotKeysForTech(db, biz.id, technician_id, conflictDate, tz);
      if (taken.has(conflictSlot)) {
        return res.status(409).json({ error: 'That technician is already booked for this time slot. Choose another time or technician.' });
      }
    }
  }

  const paymentMethod = body.payment_method || null;        // card | cash | quote | null
  const status = technician_id ? 'assigned' : 'confirmed';
  // Signed review-link token (30-day TTL) so the completion follow-up can point
  // the customer at the review widget. booking_id is patched in after insert.
  // Try to insert with sms_consent; if the column doesn't exist yet (migration not applied),
  // retry without it. This ensures bookings can be created even if 0014_sms_consent migration
  // hasn't been applied to the database yet.
  const bookingInsert = {
    business_id: biz.id, customer_id,
    technician_id: technician_id || null,
    service_id: body.service_id || null,
    status, source: 'manual',
    scheduled_at,
    subtotal: Number(body.subtotal) || 0,
    price: Number(body.price) || 0,
    notes: body.notes || null,
    customer_notes: body.customer_notes || null,
    address_line1: c.address_line1 || null, city: c.city || null, state: c.state || null, postal_code: c.postal_code || null,
    payment_required: !!paymentMethod && paymentMethod !== 'quote',
    payment_method: paymentMethod,
  };

  let { data: bRow, error: bErr } = await db.from('bookings').insert({
    ...bookingInsert,
    sms_consent: !!body.sms_consent,
  }).select('id').single();

  // If sms_consent column doesn't exist in schema cache, retry without it
  if (bErr && bErr.message?.includes('sms_consent')) {
    console.warn('[admin] sms_consent column not found, retrying without it');
    ({ data: bRow, error: bErr } = await db.from('bookings').insert(bookingInsert).select('id').single());
  }

  if (bErr) throw bErr;

  // Generate the review-link token now that we have the booking id.
  const reviewToken = signToken({ kind: 'review', booking_id: bRow.id }, 2592000);
  await db.from('bookings').update({ review_token: reviewToken }).eq('id', bRow.id);

  // Save a tokenized card on file in Stripe so it can be charged at service time.
  if (paymentMethod === 'card' && body.payment_method_id) {
    try {
      const ids = await saveCardOnFile(body.payment_method_id, { name: c.name, email: c.email, phone: c.phone });
      if (ids) await db.from('bookings').update({
        stripe_customer_id: ids.customerId, stripe_payment_method_id: ids.pmId,
      }).eq('id', bRow.id);
    } catch (e) { console.warn('[admin] card-on-file save failed:', e.message); }
  }

  // Frozen price breakdown — one line item per chosen option.
  const selections = Array.isArray(body.selections) ? body.selections : [];
  if (selections.length) {
    const rows = selections.map(s => {
      const qty = Number(s.quantity) || 1;
      const unit = Number(s.price) || 0;
      const kind = s.label === 'Travel Fee' ? 'addon' : 'option';
      return {
        booking_id: bRow.id, business_id: biz.id,
        kind, name: s.label || 'Option',
        quantity: qty, unit_price: unit, line_total: unit * qty,
        service_id: body.service_id || null, option_id: s.option_id || null,
      };
    });
    const { error: liErr } = await db.from('booking_line_items').insert(rows);
    if (liErr) throw liErr;
  }

  // Add tax as a line item
  if (Number(body.tax) > 0) {
    const { error: taxErr } = await db.from('booking_line_items').insert({
      booking_id: bRow.id, business_id: biz.id,
      kind: 'fee', name: 'Tax (8.25%)',
      quantity: 1, unit_price: Number(body.tax), line_total: Number(body.tax),
      service_id: null, option_id: null, taxable: false,
    });
    if (taxErr) throw taxErr;
  }

  await db.from('booking_status_events').insert({
    booking_id: bRow.id, business_id: biz.id, technician_id: technician_id || null,
    status, note: `Created by ${auth.role} (dashboard)`,
  });

  // Send booking confirmation SMS to customer (if they opted in)
  if (c.phone && scheduled_at && body.sms_consent) {
    const dateStr = new Date(scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const msg = `Your appointment is booked for ${dateStr}. We'll send you a message when your tech is on the way!`;
    sendSMS(c.phone, msg).catch(console.error);
  }

  // Notify the technician if one was assigned at creation time.
  if (technician_id) notifyTechAssigned(db, biz, technician_id, scheduled_at).catch(console.error);

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
    .select('id, status, technician_id, scheduled_at, review_token, sms_consent, customer:customers ( phone )').eq('id', id).eq('business_id', biz.id).single();
  if (e0 || !existing) return res.status(404).json({ error: 'Booking not found' });

  // Cancel deletes the booking outright. Child rows (line items, status events,
  // photos, notes) are removed by ON DELETE CASCADE.
  if (body.action === 'cancel') {
    const { error: eDel } = await db.from('bookings').delete().eq('id', id).eq('business_id', biz.id);
    if (eDel) throw eDel;
    return res.status(200).json({ ok: true, deleted: true });
  }

  const patch = {};
  let newStatus = null;
  const now = new Date().toISOString();

  switch (body.action) {
    case 'confirm':
      patch.status = newStatus = 'confirmed'; patch.confirmed_at = now; break;
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

  // Double-booking guard for reschedule / reassign: don't let an edit drop a tech
  // onto a slot they already have another non-cancelled booking in.
  if (body.action === 'reschedule' || body.action === 'assign') {
    const tz = biz.timezone || 'America/Denver';
    const effTech = ('technician_id' in patch) ? patch.technician_id : existing.technician_id;
    const effAt = patch.scheduled_at || existing.scheduled_at;
    if (effTech && effAt) {
      const slotKey = slotKeyForLocalTime(localHHMM(tz, effAt));
      if (slotKey) {
        const taken = await bookedSlotKeysForTech(db, biz.id, effTech, localDateStr(tz, effAt), tz, id);
        if (taken.has(slotKey)) {
          return res.status(409).json({ error: 'That technician is already booked for this time slot. Choose another time or technician.' });
        }
      }
    }
  }

  const { error: e1 } = await db.from('bookings').update(patch).eq('id', id).eq('business_id', biz.id);
  if (e1) throw e1;

  if (newStatus) {
    await db.from('booking_status_events').insert({
      booking_id: id, business_id: biz.id, technician_id: patch.technician_id ?? existing.technician_id,
      status: newStatus, note: `Set by ${auth.role} (dashboard)`,
    });

    // Send SMS when job is completed (if customer opted in)
    if (newStatus === 'completed' && existing.customer?.phone && existing.review_token && existing.sms_consent) {
      const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
      const reviewLink = `${baseUrl}/review.html?token=${encodeURIComponent(existing.review_token)}`;
      const msg = `Your job is complete! How did we do? ${reviewLink}`;
      sendSMS(existing.customer.phone, msg).catch(console.error);
    }
  }

  // Notify the technician when they are newly assigned to this job (only when the
  // tech actually changed, so re-saving the same assignment doesn't re-text them).
  if (body.action === 'assign' && patch.technician_id && patch.technician_id !== existing.technician_id) {
    notifyTechAssigned(db, biz, patch.technician_id, existing.scheduled_at).catch(console.error);
  }
  return res.status(200).json({ ok: true });
}

// ── Booking payments: charge card on file | mark paid (cash) | refund ────────
// Business model is "card on file at booking, charged at time of service". The
// card was attached to a Stripe customer (keyed by email) by the live widget,
// so we can charge it from here without ever touching the live booking code.
async function bookingPayment(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const act = (body.action || 'charge').toString();

  const { data: b, error } = await db.from('bookings')
    .select(`id, price, payment_status, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             customer:customers ( id, name, email, phone, stripe_customer_id )`)
    .eq('id', id).eq('business_id', biz.id).single();
  if (error || !b) return res.status(404).json({ error: 'Booking not found' });

  const now = new Date().toISOString();

  // Manual states — no Stripe involved (e.g. paid in cash to the technician).
  if (act === 'mark_paid') {
    await db.from('bookings').update({ payment_status: 'paid', paid_at: now, amount_paid: Number(b.price) || 0 }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'paid' });
  }
  if (act === 'mark_unpaid') {
    await db.from('bookings').update({ payment_status: 'unpaid', paid_at: null }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'unpaid' });
  }

  if (act === 'refund') {
    if (!b.stripe_payment_intent_id) return res.status(400).json({ error: 'No Stripe charge on this booking to refund.' });
    try { await stripe('/refunds', { body: { payment_intent: b.stripe_payment_intent_id } }); }
    catch (e) { return res.status(e.status || 400).json({ error: 'Refund failed: ' + e.message }); }
    await db.from('bookings').update({ payment_status: 'refunded' }).eq('id', id);
    return res.status(200).json({ ok: true, payment_status: 'refunded' });
  }

  // Charge the card on file.
  if (act !== 'charge') return res.status(400).json({ error: `Unknown payment action "${act}"` });
  if (!stripeConfigured()) return res.status(400).json({ error: 'Payments are not configured (STRIPE_SECRET_KEY missing). Use “Mark paid (cash)”.' });
  if (b.payment_status === 'paid') return res.status(400).json({ error: 'This booking is already paid.' });
  const dollars = body.amount != null ? Number(body.amount) : Number(b.price);
  if (!dollars || dollars <= 0) return res.status(400).json({ error: 'Enter an amount greater than $0.' });

  // Resolve a Stripe customer + payment method (stored first, else look up by email).
  let custId = b.stripe_customer_id || (b.customer && b.customer.stripe_customer_id) || null;
  let pmId = b.stripe_payment_method_id || null;
  try {
    if (!custId && b.customer && b.customer.email) {
      const r = await findCardOnFileByEmail(b.customer.email);
      custId = r.customerId; if (r.paymentMethodId) pmId = r.paymentMethodId;
    }
    if (custId && !pmId) pmId = await defaultPaymentMethod(custId);
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!custId || !pmId) return res.status(400).json({ error: 'No card on file for this customer. Use “Mark paid (cash)” instead.' });

  let pi;
  try {
    pi = await stripe('/payment_intents', { body: {
      amount: Math.round(dollars * 100), currency: 'usd',
      customer: custId, payment_method: pmId, off_session: true, confirm: true,
      description: `Booking ${id}`, metadata: { booking_id: id, business: biz.slug },
    }});
  } catch (e) {
    return res.status(e.status || 402).json({ error: 'Charge failed: ' + e.message });
  }
  if (pi.status !== 'succeeded') {
    return res.status(402).json({ error: `Charge not completed (status: ${pi.status}). The card may need the customer to re-authenticate.` });
  }

  await db.from('bookings').update({
    payment_status: 'paid', paid_at: now, amount_paid: dollars,
    stripe_payment_intent_id: pi.id, stripe_customer_id: custId, stripe_payment_method_id: pmId,
  }).eq('id', id);
  return res.status(200).json({ ok: true, payment_status: 'paid', amount: dollars, payment_intent_id: pi.id });
}

// ── Booking photos (view the tech's job photos; add/delete from the office) ──
async function assertBooking(db, biz, id) {
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const { data } = await db.from('bookings').select('id').eq('id', id).eq('business_id', biz.id).single();
  if (!data) { const e = new Error('Booking not found'); e.status = 404; throw e; }
}

async function bookingPhotos(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const id = (req.query.id || '').toString();
  try { await assertBooking(db, biz, id); } catch (e) { return bail(res, e); }
  const { data, error } = await db.from('booking_photos')
    .select('id, url, caption, uploader_name, uploaded_by_kind, created_at')
    .eq('booking_id', id).eq('business_id', biz.id).order('created_at', { ascending: true });
  if (error) throw error;
  return res.status(200).json({ photos: data || [] });
}

async function bookingPhotoAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  try { await assertBooking(db, biz, body.id); } catch (e) { return bail(res, e); }
  let up;
  try { up = await uploadImage(body.image, `${biz.id}/${body.id}`); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_photos').insert({
    business_id: biz.id, booking_id: body.id, technician_id: null,
    uploaded_by_kind: auth.role === 'owner' ? 'owner' : 'secretary', uploader_name: adminAuthorName(auth),
    storage_path: up.path, url: up.url, caption: (body.caption || '').toString().trim() || null,
  }).select('id, url, caption, uploader_name, uploaded_by_kind, created_at').single();
  if (error) { await deleteImage(up.path); throw error; }
  return res.status(200).json({ photo: data });
}

async function bookingPhotoDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.photo_id) return res.status(400).json({ error: 'photo_id required' });
  const { data: ph } = await db.from('booking_photos')
    .select('id, storage_path').eq('id', body.photo_id).eq('business_id', biz.id).single();
  if (!ph) return res.status(404).json({ error: 'Photo not found' });
  await db.from('booking_photos').delete().eq('id', body.photo_id);
  await deleteImage(ph.storage_path);
  return res.status(200).json({ ok: true });
}

// ── Booking notes (internal; owner/secretary author; permanent delete) ───────
async function bookingNotes(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const id = (req.query.id || '').toString();
  try { await assertBooking(db, biz, id); } catch (e) { return bail(res, e); }
  const { data, error } = await db.from('booking_notes')
    .select('id, body, author_kind, author_name, created_at')
    .eq('booking_id', id).eq('business_id', biz.id).order('created_at', { ascending: false });
  if (error) throw error;
  return res.status(200).json({ notes: data || [] });
}

async function bookingNoteAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  try { await assertBooking(db, biz, body.id); } catch (e) { return bail(res, e); }
  const text = (body.body || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Note text required' });
  const { data, error } = await db.from('booking_notes').insert({
    business_id: biz.id, booking_id: body.id,
    author_kind: auth.role === 'owner' ? 'owner' : 'secretary', author_id: null, author_name: adminAuthorName(auth),
    body: text,
  }).select('id, body, author_kind, author_name, created_at').single();
  if (error) throw error;
  return res.status(200).json({ note: data });
}

async function bookingNoteDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.note_id) return res.status(400).json({ error: 'note_id required' });
  await db.from('booking_notes').delete().eq('id', body.note_id).eq('business_id', biz.id);
  return res.status(200).json({ ok: true });
}

// ── Photo gallery (every job photo for the business, newest first) ───────────
async function photoGallery(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const offset = Number(req.query.offset) || 0;
  const { data, error } = await db.from('booking_photos')
    .select(`id, url, caption, uploader_name, created_at, booking_id,
             booking:bookings ( id, scheduled_at, status, customer:customers ( name ), technician:technicians ( name ) )`)
    .eq('business_id', biz.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const photos = (data || []).map(p => ({
    id: p.id, url: p.url, caption: p.caption, uploader_name: p.uploader_name, created_at: p.created_at,
    booking_id: p.booking_id,
    customer_name: p.booking?.customer?.name || 'Customer',
    technician_name: p.booking?.technician?.name || null,
    scheduled_at: p.booking?.scheduled_at || null,
    status: p.booking?.status || null,
  }));
  return res.status(200).json({ photos, limit, offset, has_more: photos.length === limit });
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

async function customerUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const { data: existing } = await db.from('customers').select('id').eq('id', id).eq('business_id', biz.id).single();
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  const patch = {};
  if (body.name !== undefined) {
    if (!String(body.name).trim()) return res.status(400).json({ error: 'Name is required' });
    patch.name = String(body.name).trim();
  }
  if (body.phone !== undefined) patch.phone = body.phone ? String(body.phone).trim() : null;
  if (body.email !== undefined) patch.email = body.email ? String(body.email).trim() : null;
  if (body.address_line1 !== undefined) patch.address_line1 = body.address_line1 ? String(body.address_line1).trim() : null;
  if (body.city !== undefined) patch.city = body.city ? String(body.city).trim() : null;
  if (body.state !== undefined) patch.state = body.state ? String(body.state).trim() : null;
  if (body.postal_code !== undefined) patch.postal_code = body.postal_code ? String(body.postal_code).trim() : null;

  if (Object.keys(patch).length) {
    const { error } = await db.from('customers').update(patch).eq('id', id).eq('business_id', biz.id);
    if (error) throw error;
  }
  return res.status(200).json({ ok: true });
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
  if (body.color !== undefined) patch.color = body.color || null;
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

  const today = new Date().toISOString().slice(0, 10);
  const { data: exc, error: e2 } = await db.from('technician_availability_exceptions')
    .select('exception_date, slot_key, is_available')
    .eq('technician_id', techId)
    .gte('exception_date', today)
    .order('exception_date');
  if (e2) throw e2;

  return res.status(200).json({
    slots: SLOTS, days: DAYS,
    availability: (data || []).map(r => ({ day_of_week: r.day_of_week, slot_key: r.slot_key })),
    exceptions: (exc || []).map(r => ({ date: r.exception_date, slot_key: r.slot_key, is_available: r.is_available })),
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

// Set a one-time, date-specific override for a tech (admin acting on their
// behalf). Same diff-against-recurring model as the tech app.
async function techAvailabilityExceptionSet(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const techId = (body.tech_id || '').toString();
  if (!techId) return res.status(400).json({ error: 'tech_id required' });
  const { data: tech } = await db.from('technicians').select('id').eq('id', techId).eq('business_id', biz.id).single();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  let date, rows;
  try {
    date = assertDate(body.date);
    const dow = dayOfWeekFor(date);
    const { data: recur, error } = await db.from('technician_availability')
      .select('slot_key').eq('technician_id', techId).eq('day_of_week', dow);
    if (error) throw error;
    rows = computeExceptionRows((recur || []).map(r => r.slot_key), body.selected);
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  await db.from('technician_availability_exceptions')
    .delete().eq('technician_id', techId).eq('exception_date', date);
  if (rows.length) {
    const { error } = await db.from('technician_availability_exceptions').insert(
      rows.map(r => ({ business_id: biz.id, technician_id: techId, exception_date: date, ...r }))
    );
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, date, count: rows.length });
}

// ── Shared shaping ───────────────────────────────────────────────────────────
function bookingSelect() {
  return `id, status, source, scheduled_at, scheduled_end, duration_minutes, price, payment_status, paid_at,
          notes, customer_notes, review_rating, review_text, technician_id, service_area_id,
          address_line1, city, state, postal_code,
          customer:customers ( id, name, phone, email ),
          technician:technicians ( id, name, status, color ),
          service:services ( id, name ),
          photos:booking_photos ( count ),
          notes_list:booking_notes ( count )`;
}

function shapeBooking(b) {
  return {
    id: b.id,
    status: b.status,
    source: b.source,
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    duration_minutes: b.duration_minutes,
    price: b.price,
    payment_status: b.payment_status,
    paid_at: b.paid_at,
    notes: b.notes,
    customer_notes: b.customer_notes,
    review_rating: b.review_rating,
    review_text: b.review_text,
    technician_id: b.technician_id,
    service_area_id: b.service_area_id,
    address: [b.address_line1, b.city, b.state, b.postal_code].filter(Boolean).join(', '),
    customer: b.customer || null,
    technician: b.technician || null,
    service: b.service || null,
    photo_count: Array.isArray(b.photos) ? (b.photos[0]?.count || 0) : 0,
    note_count: Array.isArray(b.notes_list) ? (b.notes_list[0]?.count || 0) : 0,
  };
}

// ── Review submission (customer review link) ────────────────────────────────
// Public endpoint: no auth required (token validates the booking).
async function review(req, res, body) {
  if (req.method === 'GET') return reviewCheck(req, res, body);
  if (req.method === 'POST') return reviewSubmit(req, res, body);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function reviewCheck(req, res, body) {
  const token = req.query.token || '';
  if (!token) return res.status(400).json({ error: 'token required' });

  const reviewToken = verifyToken(token);
  if (!reviewToken || !reviewToken.booking_id) return res.status(401).json({ error: 'Invalid token' });

  const db = serviceClient();
  const { data: booking, error } = await db.from('bookings')
    .select('id, reviewed_at, service_area:service_areas(review_url)')
    .eq('id', reviewToken.booking_id)
    .single();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });

  return res.status(200).json({
    booking_id: booking.id,
    already_reviewed: !!booking.reviewed_at,
    review_url: booking.service_area?.review_url || null,
  });
}

async function reviewSubmit(req, res, body) {
  const token = body.token || '';
  const rating = parseInt(body.rating) || 0;
  const feedback = (body.feedback || '').trim();

  if (!token) return res.status(400).json({ error: 'token required' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });

  const reviewToken = verifyToken(token);
  if (!reviewToken || !reviewToken.booking_id) return res.status(401).json({ error: 'Invalid token' });

  const db = serviceClient();

  // Fetch booking + business + customer info
  const { data: booking, error: bErr } = await db.from('bookings')
    .select(`
      id, reviewed_at, customer_id, business_id, status, service_area_id,
      customer:customers(name, phone, email),
      technician:technicians(id, name, phone),
      service_area:service_areas(name),
      business:businesses(id, slug, name, feedback_email)
    `)
    .eq('id', reviewToken.booking_id)
    .single();

  if (bErr || !booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.reviewed_at) return res.status(409).json({ error: 'Already reviewed' });

  // Update booking with review
  const now = new Date().toISOString();
  const { error: uErr } = await db.from('bookings').update({
    review_rating: rating,
    review_text: feedback || null,
    reviewed_at: now,
  }).eq('id', booking.id);

  if (uErr) throw uErr;

  // Send email if rating ≤ 4 and feedback exists
  if (rating <= 4 && feedback && booking.business?.feedback_email) {
    await sendFeedbackEmail({
      to: booking.business.feedback_email,
      businessSlug: booking.business.slug,
      businessName: booking.business.name,
      customerName: booking.customer?.name || 'Customer',
      rating,
      feedback,
      technicianName: booking.technician?.name || 'Technician',
      serviceAreaName: booking.service_area?.name || 'Service Area',
    }).catch(err => console.warn('[review] email send failed:', err));
  }

  // Send SMS to technician based on rating
  if (booking.technician?.phone) {
    const techName = booking.technician.name || 'Technician';
    if (rating === 5) {
      const msg = `${techName} you just received a GREAT review! check it out on your profile.`;
      await sendSMS(booking.technician.phone, msg).catch(err => console.warn('[review] tech SMS send failed:', err));
    } else if (rating <= 4) {
      const msg = `${techName} you just received a bad review... Please check your profile to view.`;
      await sendSMS(booking.technician.phone, msg).catch(err => console.warn('[review] tech SMS send failed:', err));
    }
  }

  // Send SMS to owner if rating ≤ 4
  if (rating <= 4) {
    const ownerPhone = process.env.OWNER_PHONE_NUMBER;
    if (ownerPhone) {
      const techName = booking.technician?.name || 'Technician';
      const msg = `${techName} received a ${rating}-star review on ${booking.business?.name || 'a booking'}. Customer: ${booking.customer?.name || 'Unknown'}`;
      await sendSMS(ownerPhone, msg).catch(err => console.warn('[review] owner SMS send failed:', err));
    }
  }

  return res.status(200).json({ ok: true, review_rating: rating });
}

// Per-business transactional email config (Resend).
// Each business may use its own Resend account — the free tier allows one
// verified domain per account, so Doms gets its own key + domain without
// forcing the shared account onto a paid plan. When DOMS_RESEND_API_KEY is
// unset (e.g. both domains live on one paid account) Doms transparently falls
// back to the shared RESEND_API_KEY. Handy Andy's behavior is unchanged.
function emailConfig(slug) {
  if (slug === 'doms') {
    return {
      apiKey: process.env.DOMS_RESEND_API_KEY || process.env.RESEND_API_KEY,
      from:   process.env.DOMS_EMAIL_FROM || 'contact@domstvmounting.com',
    };
  }
  return {
    apiKey: process.env.RESEND_API_KEY,
    from:   process.env.HANDY_ANDY_EMAIL_FROM || 'contact@ihandyandy.com',
  };
}

async function sendFeedbackEmail(params) {
  if (!notificationsOn()) { console.log('[review] notifications disabled; feedback email not sent'); return; }
  const { apiKey, from } = emailConfig(params.businessSlug);
  if (!apiKey) {
    console.log('[review] Resend key not set, logging feedback:', params);
    return;
  }

  const html = `
<div style="font-family:sans-serif;max-width:600px;">
  <h2>Customer Feedback: ${params.rating} Star${params.rating === 1 ? '' : 's'}</h2>
  <p><strong>Customer:</strong> ${params.customerName}</p>
  <p><strong>Business:</strong> ${params.businessName}</p>
  <p><strong>Technician:</strong> ${params.technicianName}</p>
  <p><strong>Service Area:</strong> ${params.serviceAreaName}</p>
  <p><strong>Rating:</strong> ${'⭐'.repeat(params.rating)}</p>
  <hr>
  <p><strong>Feedback:</strong></p>
  <p style="background:#f5f5f5;padding:16px;border-radius:8px;white-space:pre-wrap;">${params.feedback}</p>
</div>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: params.to,
      subject: `Customer Feedback: ${params.rating}⭐ from ${params.customerName}`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${res.status} ${err}`);
  }
}

// ── Reviews list (admin dashboard reviews tab) ──────────────────────────────
async function reviews(req, res, db, auth) {
  const biz = await resolveBusiness(db, auth, req.query.business || '');

  const { data: revs, error } = await db.from('bookings')
    .select(`
      id, status, scheduled_at, review_rating, review_text, reviewed_at,
      customer:customers(name, phone),
      technician:technicians(id, name, color),
      service_area:service_areas(name)
    `)
    .eq('business_id', biz.id)
    .not('review_rating', 'is', null)
    .order('reviewed_at', { ascending: false })
    .limit(100);

  if (error) throw error;

  const formatted = (revs || []).map(r => ({
    id: r.id,
    customer_name: r.customer?.name || '—',
    technician_name: r.technician?.name || '—',
    technician_id: r.technician?.id || null,
    rating: r.review_rating,
    feedback: r.review_text || '',
    reviewed_at: r.reviewed_at,
    service_area: r.service_area?.name || '—',
  }));

  return res.status(200).json({ reviews: formatted });
}

// ── Estimates (customer quote requests from the public estimate page) ────────
async function estimates(req, res, db, auth) {
  const biz = await resolveBusiness(db, auth, req.query.business || '');
  const status = (req.query.status || '').toString();
  // Select with the full column set; if an optional column (e.g. customer_zip
  // from a not-yet-applied migration) is missing from the schema cache, drop it
  // and retry so the Estimates list still loads instead of erroring outright.
  let cols = 'id, service_label, customer_name, customer_phone, customer_email, customer_zip, description, photo_url, preferred_slots, status, sms_consent, notes, created_at';
  const runQuery = () => {
    let q = db.from('estimates').select(cols)
      .eq('business_id', biz.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (status && status !== 'all') q = q.eq('status', status);
    return q;
  };
  let { data, error } = await runQuery();
  for (let i = 0; error && i < 4; i++) {
    const col = missingColumn(error.message);
    if (!col || !cols.includes(col)) break;
    console.warn(`[admin] estimates: '${col}' column missing, retrying without it`);
    cols = cols.split(',').map(s => s.trim()).filter(c => c !== col).join(', ');
    ({ data, error } = await runQuery());
  }
  if (error) throw error;
  return res.status(200).json({ estimates: data || [] });
}

async function estimateUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  // Confirm the estimate belongs to this business before touching it.
  const { data: existing } = await db.from('estimates')
    .select('id, photo_path').eq('id', body.id).eq('business_id', biz.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Estimate not found' });

  if (body.op === 'delete') {
    await db.from('estimates').delete().eq('id', body.id).eq('business_id', biz.id);
    if (existing.photo_path) deleteImage(existing.photo_path).catch(() => {});
    return res.status(200).json({ ok: true, deleted: true });
  }

  const patch = {};
  if (body.status) {
    const VALID = ['new', 'contacted', 'scheduled', 'closed'];
    if (!VALID.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
    patch.status = body.status;
  }
  if (typeof body.notes === 'string') patch.notes = body.notes.trim() || null;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  const { error } = await db.from('estimates').update(patch).eq('id', body.id).eq('business_id', biz.id);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

// Send quote SMS to customer
async function estimateSendSms(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const { data: est } = await db.from('estimates')
    .select('customer_name, customer_phone, service_label, description').eq('id', body.id).eq('business_id', biz.id).maybeSingle();
  if (!est) return res.status(404).json({ error: 'Estimate not found' });
  if (!est.customer_phone) return res.status(400).json({ error: 'Customer phone not available' });

  const svcTxt = est.service_label ? `${est.service_label} — ` : '';
  const msg = `Here is your quote for ${biz.name}. ${svcTxt}${est.description || 'Your estimate request'}. Check your email for more details.`;
  await sendSMS(est.customer_phone, msg);

  // Mark as contacted
  await db.from('estimates').update({ status: 'contacted' }).eq('id', body.id).eq('business_id', biz.id).catch(() => {});

  return res.status(200).json({ ok: true });
}

// Send quote email to customer
async function estimateSendEmail(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const { data: est } = await db.from('estimates')
    .select('customer_name, customer_email, service_label, description').eq('id', body.id).eq('business_id', biz.id).maybeSingle();
  if (!est) return res.status(404).json({ error: 'Estimate not found' });
  if (!est.customer_email) return res.status(400).json({ error: 'Customer email not available' });
  if (!notificationsOn()) return res.status(503).json({ error: 'Email notifications are turned off until the account is approved.' });

  const { apiKey, from } = emailConfig(biz.slug);
  if (!apiKey) {
    console.warn('[estimate] Resend key not set, cannot send email');
    return res.status(500).json({ error: 'Email service not configured' });
  }

  const svcTxt = est.service_label ? `<strong>${est.service_label}</strong><br>` : '';
  const html = `
<div style="font-family:sans-serif;max-width:600px;">
  <h2>Your ${biz.name} Quote</h2>
  <p>Hi ${est.customer_name},</p>
  <p>Here is your estimate:</p>
  <div style="background:#f5f5f5;padding:16px;border-radius:8px;margin:16px 0;">
    ${svcTxt}
    <p style="margin:0;white-space:pre-wrap;">${est.description || 'Estimate request'}</p>
  </div>
  <p>A member of our team will reach out to discuss this quote further.</p>
  <p>Thank you!</p>
</div>
  `;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: est.customer_email,
      subject: `Your ${biz.name} Estimate`,
      html,
    }),
  });

  if (!resendRes.ok) {
    const err = await resendRes.text();
    throw new Error(`Email API error: ${resendRes.status} ${err}`);
  }

  // Mark as contacted
  await db.from('estimates').update({ status: 'contacted' }).eq('id', body.id).eq('business_id', biz.id).catch(() => {});

  return res.status(200).json({ ok: true });
}
