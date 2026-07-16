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
import { smsNotificationsOn } from './_lib/notify.js';
import { demoMode } from './_lib/demo.js';
import { toE164, sendSMS, sendSMSResult } from './_lib/sms.js';
import { emailConfig, sendEmail, brandFor, reviewEmail } from './_lib/email.js';
import { localDayStartUTC, localDateStartUTC, addDaysStr, startOfWeekUTC } from './_lib/time.js';
import { SLOTS, SLOT_KEYS, DAYS, normalizeSlots, assertDate, dayOfWeekFor, computeExceptionRows, slotKeyForLocalTime, localHHMM, localDateStr } from './_lib/availability.js';
import { stripe, stripeConfigured, findCardOnFileByEmail, defaultPaymentMethod, saveCardOnFile, retrieveCard } from './_lib/stripe.js';
import { saveAuthorization } from './_lib/authorization.js';

// Publishable (client-side) Stripe key the tech app uses to tokenize a new card.
// Handy Andy's account is the main account; Doms has its own. Publishable keys
// are safe to expose. The global default mirrors the booking widget's key.
const STRIPE_PK_GLOBAL = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51Olvl3IqRVZvLFqu9lmppvTG7bOYTjAY30EoaDZXwKciPfGw5G24kAwVzU91FmgzypjfQfcmXFyGdc3UMBD3dOgF00DZZutNIA';
function jobStripePk(slug) {
  if (slug === 'doms') return process.env.DOMS_STRIPE_PUBLISHABLE_KEY || null;
  return STRIPE_PK_GLOBAL;
}
import { uploadImage, deleteImage } from './_lib/storage.js';
import { computeJobPay, PAY_DATE_OFFSET_DAYS } from './_lib/payroll.js';
import { formatAddress, isLikelyStreetAddress } from './_lib/address.js';

// A job is not "complete" until the tech has documented it with photos.
const MIN_PHOTOS_TO_COMPLETE = 2;

// ── Job ownership ────────────────────────────────────────────────────────────
// A job "belongs" to a tech when they are the PRIMARY *or* the SECOND technician,
// so a helper — including a cross-company one — can see and fully work the job in
// their own app. Some deployments predate the 0019 secondary_technician_id
// column; if a query referencing it errors, fall back to primary-only matching.
let techHasSecondCol = true;
// bookings.stripe_account (migration 0032) may not be applied yet; flipped off
// the first time a select errors on it so the charge path degrades gracefully.
let techHasStripeAcctCol = true;
// extra_slots (migration 0052): a big job reserves additional daily slots so the
// tech isn't double-booked into them. Optimistic select, degrade if not applied —
// mirrors the admin.js / availability.js pattern.
let techHasExtraCol = true;
const esCol = () => (techHasExtraCol ? ', extra_slots' : '');
const esOf = (b) => (techHasExtraCol && Array.isArray(b && b.extra_slots)) ? b.extra_slots : [];
// Gate on Postgres's actual "undefined column" code (42703), not just a message
// match — an unrelated error must never permanently disable the column for the
// rest of the lambda's lifetime.
const isExtraErr = (e) => !!(e && e.code === '42703' && /extra_slots/.test(e.message || ''));
function scopeMine(q, auth) {
  return techHasSecondCol
    ? q.or(`technician_id.eq.${auth.tech_id},secondary_technician_id.eq.${auth.tech_id}`)
    : q.eq('technician_id', auth.tech_id);
}
// Run a bookings query (rebuilt fresh on each call so it can be retried) with the
// primary-OR-second-tech scope, dropping the secondary column if the schema
// lacks it. `build()` must return a not-yet-awaited Supabase query.
async function fetchMine(build) {
  let r = await build();
  if (r.error && r.error.code === '42703' && /secondary_technician_id/.test(r.error.message || '')) {
    techHasSecondCol = false;
    r = await build();
  }
  return r;
}

// SMS sending (toE164 + sendSMS) now lives in ./_lib/sms.js — provider-agnostic
// (SimpleTexting with Twilio fallback), still gated by smsNotificationsOn().

// Status a technician is allowed to set, and how it maps to availability + the
// matching lifecycle timestamp on the booking.
const TECH_STATUS = {
  on_the_way:  { tech: 'on_job',    stamp: 'on_the_way_at' },
  arrived:     { tech: 'on_job',    stamp: 'arrived_at' },
  in_progress: { tech: 'on_job',    stamp: null },
  completed:   { tech: 'available', stamp: 'completed_at' },
};
// Forward-only progression, enforced server-side. Without this, a stale phone
// tab (an old job screen left open, a second tech's app, a slow browser-back)
// could flip an already-completed job back to "on_the_way" — re-marking the
// tech busy for a job that's actually done, and re-firing the en-route SMS
// (which has no once-guard of its own) to a customer whose job already
// finished. completed/cancelled/no_show are terminal: nothing changes a job's
// status from the tech app once it's reached one of those, in either
// direction. Statuses not listed here (a legacy/unknown value) rank as 0 so
// an unexpected current status never accidentally BLOCKS a normal forward move.
const STATUS_RANK = { pending: 0, confirmed: 0, assigned: 0, on_the_way: 1, arrived: 2, in_progress: 3, completed: 4 };
const TERMINAL_STATUS = new Set(['completed', 'cancelled', 'no_show']);

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    if (action === 'login') return await login(req, res, body);
    if (action === 'diagnostic') return await diagnostic(req, res);

    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'tech') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();
    switch (action) {
      case 'jobs':             return await jobs(req, res, db, auth);
      case 'job':              return await job(req, res, db, auth);
      case 'status':           return await status(req, res, db, auth, body);
      case 'job_line_items_save': return await jobLineItemsSave(req, res, db, auth, body);
      case 'job_payment':      return await jobPayment(req, res, db, auth, body);
      case 'job_card_update':  return await jobCardUpdate(req, res, db, auth, body);
      case 'job_bracket_supplier': return await jobBracketSetSupplier(req, res, db, auth, body);
      case 'job_slots':        return await jobSlots(req, res, db, auth, body);
      case 'job_photos':       return await jobPhotos(req, res, db, auth);
      case 'job_photo_add':    return await jobPhotoAdd(req, res, db, auth, body);
      case 'job_photo_delete': return await jobPhotoDelete(req, res, db, auth, body);
      case 'job_notes':        return await jobNotes(req, res, db, auth);
      case 'job_note_add':     return await jobNoteAdd(req, res, db, auth, body);
      case 'job_note_delete':  return await jobNoteDelete(req, res, db, auth, body);
      case 'availability':     return await getAvailability(req, res, db, auth);
      case 'availability_set': return await setAvailability(req, res, db, auth, body);
      case 'availability_exception_set': return await setAvailabilityException(req, res, db, auth, body);
      case 'tech_payroll':     return await techPayroll(req, res, db, auth);
      case 'tech_reviews':     return await techReviews(req, res, db, auth);
      case 'bracket_inventory': return await bracketInventory(req, res, db, auth);
      case 'bracket_inventory_set': return await bracketInventorySet(req, res, db, auth, body);
      case 'wire_plate_set': return await wirePlateSet(req, res, db, auth, body);
      default:                 return res.status(400).json({ error: `Unknown action "${action}"` });
    }
  } catch (err) {
    console.error('[tech]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

async function login(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rawPhone = (body.phone || '').toString().trim();
  const pin = (body.pin || '').toString().trim();
  if (!rawPhone || !pin) return res.status(400).json({ error: 'Phone and PIN required' });

  const db = serviceClient();
  // The number a tech types ("(720) 656-8761") rarely matches how it's stored
  // in the DB ("+17206568761"). verify_technician_pin does an EXACT string
  // compare, so we try the input in every canonical form — E.164, raw, and
  // digits-only — until one matches. This lets a tech type their number however
  // they like, regardless of which format is on their record.
  const digits = rawPhone.replace(/\D/g, '');
  const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  const candidates = [...new Set([
    toE164(rawPhone),   // +17206568761
    rawPhone,           // (720) 656-8761  (covers records stored verbatim)
    digits,             // 17206568761 or 7206568761
    national,           // 7206568761
  ].filter(Boolean))];

  // Verify against the hashed PIN inside the DB; the hash never leaves Postgres.
  let tech = null, error = null;
  for (const cand of candidates) {
    const r = await db.rpc('verify_technician_pin', { p_phone: cand, p_pin: pin });
    if (r.error) { error = r.error; break; }
    const t = Array.isArray(r.data) ? r.data[0] : r.data;
    if (t) { tech = t; break; }
  }
  if (error) throw error;
  if (!tech) return res.status(401).json({ error: 'Incorrect phone or PIN' });

  const token = signToken({ kind: 'tech', tech_id: tech.id, business_id: tech.business_id });
  let slug = '', tz = 'America/Denver';
  try {
    const { data: biz } = await db.from('businesses').select('slug, timezone').eq('id', tech.business_id).single();
    slug = biz?.slug || '';
    tz = biz?.timezone || 'America/Denver';
  } catch { /* slug/tz are cosmetic — ignore lookup failures */ }
  return res.status(200).json({
    token,
    technician: { id: tech.id, name: tech.name, status: tech.status, slug, tz, demo: demoMode() },
  });
}

// Diagnostic: show login readiness for all technicians (phone + PIN setup).
// Shows the EXACT stored phone string so a format mismatch is obvious, and
// reports whether a PIN hash exists. No secrets are leaked (hash itself stays
// in Postgres). Read-only.
async function diagnostic(req, res) {
  const db = serviceClient();
  const { data, error } = await db.from('technicians')
    .select('id, name, phone, active, pin_hash')
    .eq('active', true)
    .order('name');
  if (error) throw error;

  const ready = [];
  const missing = [];

  for (const t of data || []) {
    const issues = [];
    if (!t.phone) issues.push('missing phone');
    if (!t.pin_hash) issues.push('missing PIN');

    if (issues.length) {
      missing.push({ id: t.id, name: t.name, stored_phone: t.phone || null, issues });
    } else {
      ready.push({ id: t.id, name: t.name, stored_phone: t.phone });
    }
  }

  return res.status(200).json({ ready, missing, total_active: data?.length || 0 });
}

async function jobs(req, res, db, auth) {
  const { data: biz } = await db.from('businesses').select('timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';
  const reDate = /^\d{4}-\d{2}-\d{2}$/;

  // Range mode: from/to (inclusive) span multiple days for the week view.
  const from = reDate.test((req.query.from || '').toString()) ? req.query.from : null;
  const to = reDate.test((req.query.to || '').toString()) ? req.query.to : null;
  // Single-date mode: date (default today).
  const dateStr = reDate.test((req.query.date || '').toString()) ? req.query.date : null;

  // Window is computed from explicit calendar dates so it never drifts when the
  // server's UTC day differs from the business's local day.
  let lo, hi;
  if (from && to) {
    lo = localDateStartUTC(tz, from);
    hi = localDateStartUTC(tz, addDaysStr(to, 1));
  } else if (dateStr) {
    lo = localDateStartUTC(tz, dateStr);
    hi = localDateStartUTC(tz, addDaysStr(dateStr, 1));
  } else {
    lo = localDayStartUTC(tz, 0);
    hi = localDayStartUTC(tz, 1);
  }

  // Scoped to jobs this tech is on (primary OR second tech) and NOT by business,
  // so cross-company jobs — booked by the partner company but worked by this
  // tech — show in their own app. No question about who they're working for.
  const build = () => scopeMine(db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes,
             address_line1, address_line2, city, state, postal_code, lat, lng, business_id, service_area_id,
             customer:customers ( name, phone ),
             service:services ( name ),
             business:businesses ( name, timezone ),
             line_items:booking_line_items ( name, kind )`), auth)
    .neq('status', 'cancelled')
    .gte('scheduled_at', lo.toISOString())
    .lt('scheduled_at', hi.toISOString())
    .order('scheduled_at', { ascending: true });
  const { data, error } = await fetchMine(build);
  if (error) throw error;

  // Each job renders in its OWN metro (service-area) timezone, so a Central job
  // (Houston/Austin) shows its real slot time instead of the business's Mountain
  // clock. Batch-load the area timezones, then group the day + label the slot in
  // that tz. Flag cross-company jobs + the company they're for.
  const tzById = await areaTzMap(db, (data || []).map(b => b.service_area_id));
  const jobs = (data || []).map(b => {
    const j = shapeJob(b);
    const jtz = tzById[b.service_area_id] || b.business?.timezone || tz;
    j.local_date = localDateInTz(jtz, j.scheduled_at);
    j.slot_time = slotTimeLabel(jtz, j.scheduled_at);
    j.cross_company = !!(b.business_id && b.business_id !== auth.business_id);
    j.company_name = b.business?.name || null;
    return j;
  });
  return res.status(200).json({ jobs, tz });
}

// Business-timezone calendar date ('YYYY-MM-DD') for an instant.
function localDateInTz(tz, iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// The fixed slot label for a job, rendered in the job's OWN metro (service-area)
// timezone. Handy Andy spans Mountain (Denver) and Central (Houston/Austin), so
// formatting an 8am-Central job in the single business tz wrongly shows 7am. We
// read the job's local wall-clock time in the area tz, snap it to the slot it
// falls in, and return that slot's start label — so every location reads the
// same fixed slots (8:00 AM, 11:00 AM, 2:00 PM, 5:00 PM, 8:00 PM) no matter the
// tech's or customer's timezone. Falls back to the exact local time off-slot.
function slotTimeLabel(areaTz, iso) {
  if (!iso || !areaTz) return null;
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: areaTz, hour12: false, hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso)).reduce((a, x) => (a[x.type] = x.value, a), {});
    const mins = ((p.hour === '24' ? 0 : Number(p.hour)) * 60) + Number(p.minute);
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const to12 = (s) => { let [h, m] = s.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
    for (const s of SLOTS) if (mins >= toMin(s.start) && mins < toMin(s.end)) return to12(s.start);
    for (const s of SLOTS) if (toMin(s.start) === mins) return to12(s.start);
    return new Intl.DateTimeFormat('en-US', { timeZone: areaTz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch { return null; }
}

// One batched Map(service_area_id -> timezone) for the given ids, so each job can
// render in its own metro's timezone without a per-row query or a fragile embed.
async function areaTzMap(db, ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  const out = {};
  if (!uniq.length) return out;
  try {
    const { data } = await db.from('service_areas').select('id, timezone').in('id', uniq);
    for (const a of (data || [])) out[a.id] = a.timezone;
  } catch { /* fall back to business tz per job */ }
  return out;
}

// Diagnostic: surfaces who the token says we are vs. what bookings actually
// exist, so a tech who sees no jobs can tell us whether it's an ID/business
// mismatch, a date problem, or a status filter. Read-only, scoped to the
// logged-in tech's own business.
async function debugIdentity(req, res, db, auth) {
  const { data: biz } = await db.from('businesses')
    .select('slug, name, timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';
  const { data: me } = await db.from('technicians')
    .select('id, name, business_id, status').eq('id', auth.tech_id).single();

  // Bookings whose technician_id equals my login id — across ALL dates/statuses.
  const { data: mine } = await db.from('bookings')
    .select('id, status, scheduled_at, business_id')
    .eq('technician_id', auth.tech_id)
    .order('scheduled_at', { ascending: false }).limit(20);

  // Every recent booking in my business (any tech) so we can see what the
  // dashboard sees and compare technician_id / business_id.
  const { data: bizBookings } = await db.from('bookings')
    .select('id, status, scheduled_at, business_id, technician_id, technician:technicians!technician_id ( name )')
    .eq('business_id', auth.business_id)
    .order('scheduled_at', { ascending: false }).limit(20);

  // Run the EXACT same window + query that jobs() uses for the current week,
  // so we can see whether the date filter is what hides assigned jobs.
  const todayLocal = localDateInTz(tz, new Date().toISOString());
  const dow = new Date(todayLocal + 'T12:00:00Z').getUTCDay();
  const weekFrom = addDaysStr(todayLocal, -dow);
  const weekTo = addDaysStr(weekFrom, 6);
  const lo = localDateStartUTC(tz, weekFrom);
  const hi = localDateStartUTC(tz, addDaysStr(weekTo, 1));
  const { data: weekData, error: weekErr } = await db.from('bookings')
    .select('id, scheduled_at, status')
    .eq('business_id', auth.business_id)
    .eq('technician_id', auth.tech_id)
    .neq('status', 'cancelled')
    .gte('scheduled_at', lo.toISOString())
    .lt('scheduled_at', hi.toISOString());

  return res.status(200).json({
    you: {
      tech_id: auth.tech_id,
      tech_name: me?.name || null,
      token_business_id: auth.business_id,
      tech_record_business_id: me?.business_id || null,
      business_slug: biz?.slug || null,
      business_name: biz?.name || null,
      business_tz: tz,
    },
    week_test: {
      week_from: weekFrom, week_to: weekTo,
      window_lo: lo.toISOString(), window_hi: hi.toISOString(),
      jobs_found: (weekData || []).length,
      error: weekErr?.message || null,
    },
    assigned_to_you_count: (mine || []).length,
    assigned_to_you: (mine || []).map(b => ({
      id: b.id, status: b.status, scheduled_at: b.scheduled_at,
      local_date: localDateInTz(tz, b.scheduled_at),
    })),
    business_bookings_count: (bizBookings || []).length,
    business_bookings: (bizBookings || []).map(b => ({
      id: b.id, status: b.status, scheduled_at: b.scheduled_at,
      local_date: localDateInTz(tz, b.scheduled_at),
      business_id: b.business_id, technician_id: b.technician_id,
      assigned_tech_name: b.technician?.name || null,
      assigned_to_you: b.technician_id === auth.tech_id,
    })),
  });
}

async function job(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  // Primary OR second tech, any business, so a (cross-company) helper opens it.
  // The two technician embeds use explicit FK hints (technician_id /
  // secondary_technician_id) so PostgREST knows which relationship to follow.
  // The secondary embed is dropped on deployments predating migration 0019.
  const build = () => scopeMine(db.from('bookings')
    .select(`id, status, scheduled_at, scheduled_end, customer_notes, notes, price,
             review_rating, review_text, reviewed_at, business_id, technician_id, service_area_id,
             address_line1, address_line2, city, state, postal_code, lat, lng,
             payment_status, paid_at, tip, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             customer:customers ( name, phone, email ),
             service:services ( name ),
             business:businesses ( name, slug, timezone ),
             technician:technicians!technician_id ( name ),${techHasSecondCol ? `
             secondary_technician_id,
             secondary_technician:technicians!secondary_technician_id ( name ),` : ''}
             line_items:booking_line_items ( name, quantity, unit_price, line_total, kind )`), auth)
    .eq('id', id)
    .maybeSingle();
  const { data, error } = await fetchMine(build);
  if (error || !data) return res.status(404).json({ error: 'Job not found' });
  const shaped = shapeJob(data, true, true);
  shaped.cross_company = !!(data.business_id && data.business_id !== auth.business_id);
  shaped.company_name = data.business?.name || null;
  // Slot time in the job's OWN metro timezone (service area), so a Central job
  // reads its true slot (e.g. 8:00 AM) instead of the business's Mountain clock.
  {
    const jtz = (await areaTzMap(db, [data.service_area_id]))[data.service_area_id]
      || data.business?.timezone || 'America/Denver';
    shaped.slot_time = slotTimeLabel(jtz, data.scheduled_at);
  }
  // Publishable key so the tech app can collect/replace the card on file.
  shaped.stripe_pk = jobStripePk(data.business?.slug || null);
  // The OTHER technician on a two-person job (the partner the viewer works
  // alongside). If the viewer is the primary, that's the secondary tech; if
  // they're the secondary helper, it's the primary. Shown so each tech knows
  // who else is coming.
  const primaryName = data.technician?.name || null;
  const secondaryName = data.secondary_technician?.name || null;
  if (primaryName && secondaryName) {
    shaped.partner_tech = (data.technician_id === auth.tech_id) ? secondaryName : primaryName;
  } else {
    shaped.partner_tech = null;
  }
  // Bracket-supplier info: which company bracket(s) this job uses, the tech(s)
  // who could have supplied it, and who's recorded so far. Best-effort — if the
  // 0035 column isn't applied yet, no bracket card is shown (and no completion gate).
  // Only ASK who supplied the bracket on a two-person job — there one tech of the
  // pair brought it, so the office must know whose stock to count. On a solo job
  // the assigned tech is obviously the supplier, so no card and no completion gate.
  shaped.bracket = null;
  const need = detectBracketQtys(data.line_items || []);
  if (data.secondary_technician_id && bracketTotal(need) > 0) {
    try {
      const { data: bs, error: bsErr } = await db.from('bookings').select('bracket_supplied_by').eq('id', id).maybeSingle();
      if (!bsErr) {
        const techs = [];
        if (data.technician_id) techs.push({ id: data.technician_id, name: data.technician?.name || 'Technician' });
        if (data.secondary_technician_id) techs.push({ id: data.secondary_technician_id, name: data.secondary_technician?.name || 'Technician' });
        const suppliedBy = bs?.bracket_supplied_by || null;
        shaped.bracket = {
          needed: true,
          label: bracketLabel(need),
          techs,
          supplied_by: suppliedBy,
          supplied_by_name: (techs.find(t => t.id === suppliedBy) || {}).name || null,
        };
      }
    } catch (e) { /* 0035 not applied — leave bracket null */ }
  }

  // The viewing tech's expected pay for THIS job — shown under the line-items
  // Save button. Computed by the same payroll engine that cuts paychecks, but
  // projected as completed+paid so an in-progress job still shows what it'll
  // earn. Each tech sees only their own number (their name drives the rate).
  shaped.tech_pay = null;
  shaped.travel_bonus = 0;
  try {
    const viewerName = (data.technician_id === auth.tech_id)
      ? (data.technician?.name || null)
      : (data.secondary_technician?.name || data.technician?.name || null);
    const travelMap = await travelPayoutMap(db, data.business_id);
    const pay = computeJobPay({
      status: 'completed',
      payment_status: 'paid',
      price: data.price,
      // The tip the customer added at charge time (stored on the booking, not as a
      // line item) is 100% the tech's — include it so their shown pay reflects it.
      tip: data.tip,
      notes: data.notes,
      customer_notes: data.customer_notes,
      service_name: data.service?.name || '',
      business_slug: data.business?.slug || '',
      line_items: data.line_items || [],
      travel_payout: travelMap.get(String(data.postal_code || '')) || 0,
      // A second real tech on the job splits the base pay 50/50 (owner rule);
      // a solo tech keeps it all. Juan/TK bring their own helper and never split.
      second_tech: !!data.secondary_technician_id,
      is_secondary: data.secondary_technician_id === auth.tech_id && data.technician_id !== auth.tech_id,
    }, viewerName);
    // Keep cents — a two-tech split can be a half-dollar (e.g. $122.50), so don't
    // round it away to $122/$123.
    shaped.tech_pay = Math.round((Number(pay.pay) || 0) * 100) / 100;
    // Surface the travel bonus (the tech's share of the service-area surcharge) so
    // it shows as its own pay line — the tech sees the extra they earn for the drive.
    const tb = (pay.breakdown || []).find(x => /travel/i.test(x.label || ''));
    shaped.travel_bonus = tb ? Math.round(Number(tb.amount) || 0) : 0;
    // Surface the tip as its own pay line too (100% to the tech).
    const tp = (pay.breakdown || []).find(x => /\btip\b/i.test(x.label || ''));
    shaped.tip_pay = tp ? Math.round(Number(tp.amount) || 0) : 0;
  } catch (e) { shaped.tech_pay = null; }

  // ── Extra time slots (big-job "block my next slot") ──────────────────────────
  // How many daily slots this job holds and which later ones the tech can still
  // block. The occupancy readers all treat extra_slots as busy, so reserving one
  // keeps a new customer from being booked on top of a job that runs long.
  shaped.slots = null;
  if (data.scheduled_at) {
    try {
      const jtz = (await areaTzMap(db, [data.service_area_id]))[data.service_area_id]
        || data.business?.timezone || 'America/Denver';
      const dateStr = localDateStr(jtz, data.scheduled_at);
      const mainSlot = slotKeyForLocalTime(localHHMM(jtz, data.scheduled_at));
      // Refetch with extra_slots (the job() select omits it) so we know what's held.
      let current = [];
      const { data: es, error: esErr } = await db.from('bookings')
        .select(`id${esCol()}`).eq('id', id).maybeSingle();
      if (esErr && isExtraErr(esErr)) techHasExtraCol = false;
      else if (!esErr) current = esOf(es);
      // Slots already busy for THIS tech that day (their other jobs + those jobs'
      // extra slots), so we don't offer a slot they're already committed to.
      const takenByOthers = await takenSlotsForTech(db, auth.tech_id, jtz, dateStr, id);
      // A tech can only block slots AFTER the job's own slot (a job runs forward).
      const mainIdx = SLOTS.findIndex(s => s.key === mainSlot);
      const addable = SLOTS
        .filter((s, i) => i > mainIdx && !current.includes(s.key) && !takenByOthers.has(s.key))
        .map(s => ({ slot_key: s.key, label: s.label }));
      shaped.slots = {
        available: techHasExtraCol,
        main_slot: mainSlot,
        main_label: (SLOTS.find(s => s.key === mainSlot) || {}).label || null,
        extra: current.map(k => ({ slot_key: k, label: (SLOTS.find(s => s.key === k) || {}).label || k })),
        addable,
      };
    } catch (e) { shaped.slots = null; }
  }

  return res.status(200).json({ job: shaped });
}

// Slot keys already busy for a tech on a given local date: the main slot of each
// of their OTHER bookings that day, plus those bookings' reserved extra_slots.
// `excludeId` drops the job we're editing so its own slots don't count as taken.
async function takenSlotsForTech(db, techId, tz, dateStr, excludeId) {
  const taken = new Set();
  // Bound to the target local day (a generous UTC window; the exact date is
  // re-checked per row below, so metro-tz jobs near midnight still resolve).
  const winStart = localDateStartUTC(tz, dateStr).toISOString();
  const winEnd = localDateStartUTC(tz, addDaysStr(dateStr, 1)).toISOString();
  const build = () => scopeMine(db.from('bookings')
    .select(`id, scheduled_at, status${esCol()}`), { tech_id: techId })
    .neq('status', 'cancelled').not('scheduled_at', 'is', null)
    .gte('scheduled_at', winStart).lt('scheduled_at', winEnd);
  let { data, error } = await build();
  if (error && isExtraErr(error)) { techHasExtraCol = false; ({ data, error } = await build()); }
  if (error) return taken;
  for (const b of (data || [])) {
    if (b.id === excludeId) continue;
    if (localDateStr(tz, b.scheduled_at) !== dateStr) continue;
    const k = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    if (k) taken.add(k);
    for (const sk of esOf(b)) taken.add(sk);
  }
  return taken;
}

// POST { id, slots:[...] } — set this job's reserved extra slots. Tech-scoped: the
// caller must be assigned to the job. Validates each key is real, after the job's
// own slot, and free for this tech that day. Mirrors admin.js bookingSlots.
async function jobSlots(req, res, db, auth, body) {
  const id = (req.query.id || (body && body.id) || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  const build = () => scopeMine(db.from('bookings')
    .select(`id, scheduled_at, service_area_id, business:businesses ( timezone ), status${esCol()}`), auth)
    .eq('id', id).maybeSingle();
  let { data: b, error } = await build();
  if (error && isExtraErr(error)) { techHasExtraCol = false; ({ data: b, error } = await build()); }
  if (error || !b) return res.status(404).json({ error: 'Job not found' });
  if (!techHasExtraCol) return res.status(400).json({ error: 'Extra time slots need migration 0052 applied first.' });
  if (!b.scheduled_at) return res.status(400).json({ error: 'This job has no scheduled time yet.' });

  const jtz = (await areaTzMap(db, [b.service_area_id]))[b.service_area_id]
    || b.business?.timezone || 'America/Denver';
  const dateStr = localDateStr(jtz, b.scheduled_at);
  const mainSlot = slotKeyForLocalTime(localHHMM(jtz, b.scheduled_at));
  const mainIdx = SLOTS.findIndex(s => s.key === mainSlot);
  if (mainIdx < 0) return res.status(400).json({ error: "This job's time doesn't line up with a standard slot." });
  const takenByOthers = await takenSlotsForTech(db, auth.tech_id, jtz, dateStr, id);

  const requested = Array.isArray(body && body.slots) ? body.slots.map(String) : [];
  const clean = [];
  for (const sk of requested) {
    if (!SLOT_KEYS.has(sk)) return res.status(400).json({ error: `Invalid time slot: ${sk}` });
    if (sk === mainSlot) continue;                       // main slot is implied
    const idx = SLOTS.findIndex(s => s.key === sk);
    if (idx <= mainIdx) return res.status(400).json({ error: 'You can only reserve time slots after this job starts.' });
    if (takenByOthers.has(sk)) {
      const lab = (SLOTS.find(s => s.key === sk) || {}).label || sk;
      return res.status(409).json({ error: `${lab} is already booked for you — can't reserve it.` });
    }
    if (!clean.includes(sk)) clean.push(sk);
  }
  const { error: uErr } = await db.from('bookings').update({ extra_slots: clean }).eq('id', b.id);
  if (uErr) { if (isExtraErr(uErr)) { techHasExtraCol = false; return res.status(400).json({ error: 'Extra time slots need migration 0052 applied first.' }); } throw uErr; }
  return res.status(200).json({ ok: true, id: b.id, extra_slots: clean });
}

// Normalize editor line items to storable rows. Each editor line is { text, price }
// (a dollar amount), so quantity is 1 and line_total == unit_price == price.
// Blank lines (no text and no price) are dropped.
function sanitizeWorkLineItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(it => {
    const name = ((it && (it.name != null ? it.name : it.label)) || '').toString().trim().slice(0, 300);
    const qty = Math.max(1, Math.min(99, Math.round(Number(it && it.quantity) || 1)));
    // Per-unit price: prefer an explicit unit_price; older clients send a flat
    // `price`/`line_total` with no quantity, which we treat as the unit (qty 1).
    const unit = Math.round((Number(it && (it.unit_price != null ? it.unit_price : (it.price != null ? it.price : it.line_total))) || 0) * 100) / 100;
    const line_total = Math.round(unit * qty * 100) / 100;
    return { name, quantity: qty, unit_price: unit, line_total };
  }).filter(it => it.name || it.unit_price);
}

// ── Edit a job's line items (text + price), tech-side ────────────────────────
// A tech can edit the visible "work" lines on any of their own jobs (primary OR
// second tech). Fees/tips/coupons/the dismount up-sell are hidden from techs, so
// those rows are preserved untouched — the tech only replaces the work lines. The
// booking total is then recomputed from ALL remaining rows (preserved + new) so
// the price always equals the sum of its parts. The job id and tech scope come
// from the signed token, never the request, so a tech can only edit their own job.
async function jobLineItemsSave(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = (body.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  // Job must belong to this tech. Pull the current line items (with ids + kind)
  // so we know which are hidden (keep) vs visible work (replace).
  const build = () => scopeMine(db.from('bookings')
    .select('id, business_id, line_items:booking_line_items ( id, kind, name, line_total )'), auth)
    .eq('id', id).maybeSingle();
  const { data: bk, error } = await fetchMine(build);
  if (error || !bk) return res.status(404).json({ error: 'Job not found' });
  const bizId = bk.business_id;

  const existing = Array.isArray(bk.line_items) ? bk.line_items : [];
  const visibleIds = existing.filter(li => !isHiddenLi(li)).map(li => li.id);

  // Replace only the visible work lines; the hidden fee/tip/coupon/dismount rows
  // stay exactly as they were.
  if (visibleIds.length) {
    const { error: delErr } = await db.from('booking_line_items').delete().in('id', visibleIds);
    if (delErr) throw delErr;
  }

  const items = sanitizeWorkLineItems(body.items);
  if (items.length) {
    const rows = items.map(it => ({
      booking_id: id, business_id: bizId,
      kind: 'service', name: it.name,
      quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total,
      taxable: true,
    }));
    const { error: insErr } = await db.from('booking_line_items').insert(rows);
    if (insErr) throw insErr;
  }

  // Recompute the booking total from every remaining line (preserved hidden + new
  // work) so it can never drift from the items it's made of.
  const { data: all, error: sumErr } = await db.from('booking_line_items')
    .select('line_total').eq('booking_id', id);
  if (sumErr) throw sumErr;
  const price = Math.round((all || []).reduce((t, r) => t + (Number(r.line_total) || 0), 0) * 100) / 100;
  const { error: upErr } = await db.from('bookings').update({ price }).eq('id', id);
  if (upErr) throw upErr;

  return res.status(200).json({ ok: true, price });
}

async function status(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  const next = (body.status || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const map = TECH_STATUS[next];
  if (!map) return res.status(400).json({ error: `Invalid status "${next}"` });

  // The job must belong to this tech — primary OR second tech — so a helper can
  // advance it too. All downstream writes use the job's OWN business_id, not the
  // tech's home business.
  const build = () => scopeMine(db.from('bookings')
    .select(`id, status, scheduled_at, review_token, sms_consent, metadata, business_id, price, payment_status, business:businesses ( slug ), customer:customers ( name, phone, email )`), auth)
    .eq('id', id).maybeSingle();
  const { data: existing } = await fetchMine(build);
  if (!existing) return res.status(404).json({ error: 'Job not found' });
  const jobBizId = existing.business_id;

  if (TERMINAL_STATUS.has(existing.status)) {
    return res.status(409).json({ error: `This job is already ${existing.status.replace(/_/g, ' ')} — its status can't be changed from here. Refresh the job list if this doesn't look right.` });
  }
  if (STATUS_RANK[next] < (STATUS_RANK[existing.status] ?? 0)) {
    return res.status(409).json({ error: `This job has already moved past "${next.replace(/_/g, ' ')}" (it's currently ${existing.status.replace(/_/g, ' ')}) — refresh to see its latest status.` });
  }
  // Same-status replay (a laggy double-tap, a stale second tab re-tapping the
  // action the job is already in): succeed idempotently WITHOUT re-running any
  // side effects. Without this, the rank check above (strictly <) let an exact
  // replay through, and the on_the_way branch below — which has no once-guard
  // of its own — would text the customer a duplicate en-route SMS.
  if (next === existing.status) {
    return res.status(200).json({ ok: true, status: next });
  }

  // Gate completion on photo documentation (also enforced in the UI).
  if (next === 'completed') {
    const { count } = await db.from('booking_photos')
      .select('id', { count: 'exact', head: true })
      .eq('booking_id', id).eq('business_id', jobBizId);
    if ((count || 0) < MIN_PHOTOS_TO_COMPLETE) {
      return res.status(400).json({ error: `Add at least ${MIN_PHOTOS_TO_COMPLETE} photos before marking this job complete (${count || 0} so far).` });
    }
    // Gate completion on payment. Either tech can take the payment (card or cash),
    // but it must be collected before the job can be marked complete. Once paid,
    // the booking's shared payment_status reflects it for BOTH techs on the job.
    if (Number(existing.price) > 0 && existing.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Charge the card or take a cash payment before marking this job complete.' });
    }
    // Gate completion on recording who supplied the bracket — on a two-person job
    // only one tech supplies it, and that tech's inventory must be the one counted.
    if (await jobNeedsBracketSupplier(db, id)) {
      return res.status(400).json({ error: 'Select which technician supplied the bracket before completing this job.' });
    }
  }

  const patch = { status: next };
  if (map.stamp) patch[map.stamp] = new Date().toISOString();

  const { error: e1 } = await db.from('bookings').update(patch).eq('id', id);
  if (e1) throw e1;

  await db.from('booking_status_events').insert({
    booking_id: id, business_id: jobBizId, technician_id: auth.tech_id,
    status: next, note: body.note || 'Updated by technician',
  });

  // On completion: auto-decrement wire concealment plates for "behind the wall"
  // jobs (one plate per line unit). Stamped in metadata so re-completing the same
  // job never double-deducts. Charged to the recorded bracket supplier if known,
  // otherwise the tech completing the job. Best-effort — never blocks completion.
  if (next === 'completed' && !existing.metadata?.wire_plate_deducted_at) {
    try {
      const { data: liRows } = await db.from('booking_line_items')
        .select('name, quantity').eq('booking_id', id);
      const plateQty = detectWirePlateQty(liRows || []);
      if (plateQty > 0) {
        let chargeTech = auth.tech_id;
        try {
          const { data: sup } = await db.from('bookings')
            .select('bracket_supplied_by').eq('id', id).maybeSingle();
          if (sup?.bracket_supplied_by) chargeTech = sup.bracket_supplied_by;
        } catch (_) { /* column may not exist; fall back to completing tech */ }
        await adjustWirePlateInventory(db, jobBizId, chargeTech, plateQty, id);
        const newMeta = { ...(existing.metadata || {}), wire_plate_deducted_at: new Date().toISOString() };
        await db.from('bookings').update({ metadata: newMeta }).eq('id', id);
      }
    } catch (e) {
      console.error(`[wireplate] decrement failed for booking ${id}:`, e.message);
    }
  }

  // On completion: auto-decrement the company BRACKETS this job used (Flat /
  // Tilting / Full Motion) from the supplier's on-hand inventory — for EVERY job,
  // solo OR two-tech. (Previously only two-tech jobs ever decremented, via the
  // supplier picker, so a solo tech's count never went down — the TK/Greg bug.)
  // The supplier is the recorded bracket_supplied_by (two-tech), else the job's
  // assigned tech, else the completing tech. Stamped so re-completing never
  // double-deducts; customer-supplied/own brackets are skipped by detectBracketQtys.
  if (next === 'completed' && !existing.metadata?.bracket_deducted_at) {
    try {
      const { data: liRows } = await db.from('booking_line_items')
        .select('name, quantity').eq('booking_id', id);
      const need = detectBracketQtys(liRows || []);
      if (bracketTotal(need) > 0) {
        let supplier = auth.tech_id;
        try {
          const { data: sup } = await db.from('bookings')
            .select('bracket_supplied_by, technician_id').eq('id', id).maybeSingle();
          supplier = sup?.bracket_supplied_by || sup?.technician_id || auth.tech_id;
        } catch (_) { /* pre-0035: fall back to the completing tech */ }
        await adjustBracketInventory(db, jobBizId, supplier, need, -1);
        // Re-read metadata so we preserve the wire-plate stamp set just above.
        const { data: fresh } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
        await db.from('bookings').update({
          metadata: { ...(fresh?.metadata || existing.metadata || {}), bracket_deducted_at: new Date().toISOString() },
        }).eq('id', id);
      }
    } catch (e) {
      console.error(`[bracket] decrement failed for booking ${id}:`, e.message);
    }
  }

  // Reflect availability in the admin dashboard.
  await db.from('technicians').update({ status: map.tech }).eq('id', auth.tech_id);

  // Send SMS to customer on certain status changes (if customer opted in).
  if (next === 'on_the_way' && existing.customer?.phone && existing.sms_consent) {
    const etaMinutes = body.eta_minutes || 30;
    let techName = 'Your tech', bizName = 'us';
    try {
      const { data: _t } = await db.from('technicians')
        .select('name, business:businesses ( name )').eq('id', auth.tech_id).maybeSingle();
      if (_t?.name) techName = String(_t.name).split(' ')[0];
      if (_t?.business?.name) bizName = _t.business.name;
    } catch { /* best-effort — fall back to generic */ }
    const msg = `Heads up! ${techName} from ${bizName} is en route (ETA ~${etaMinutes} min). Please prepare for his arrival. STOP to opt out.`;
    // Real delivery tracking (admin/secretary dashboard only — never surfaced to
    // techs): a signed token carries the booking id through Twilio's status
    // callback (api/analytics.js action=sms_status), same pattern the review SMS
    // already uses. 'pending' is set immediately on a successful send attempt;
    // the callback later flips it to 'delivered' or 'failed'/'undelivered'.
    const otwBase = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const otwToken = signToken({ kind: 'on_the_way', booking_id: id }, 3600);
    const otwStatusCallback = `${otwBase}/api/analytics?action=sms_status&token=${encodeURIComponent(otwToken)}`;
    // Awaited, not fire-and-forget: Vercel can freeze the lambda the instant
    // the HTTP response goes out, so a .then()-only send (as this was) could
    // simply never run — the text, and its delivery-tracking write, silently
    // never happened. The status change itself is already saved above by this
    // point, so awaiting here only adds a beat to the tech's "On My Way ✓"
    // response, never risks losing the status update. Any failure is caught
    // and logged, same as before — never surfaced to the tech.
    try {
      const r = await sendSMSResult(existing.customer.phone, msg, { statusCallback: otwStatusCallback });
      const patch = r.ok
        ? { on_the_way_sms_status: 'pending', on_the_way_sms_sent_at: new Date().toISOString() }
        : { on_the_way_sms_status: 'failed', on_the_way_sms_sent_at: new Date().toISOString() };
      await db.from('bookings').update(patch).eq('id', id);
    } catch (e) {
      console.error('[on_the_way sms]', e.message);
    }
  }

  // On completion: send the branded review-request email immediately, and an SMS
  // 20 minutes later (if the customer opted in). The tech app, not the dashboard,
  // is where jobs are normally completed — so this is the path that matters.
  if (next === 'completed' && existing.review_token) {
    console.log(`[review] job ${id} marked completed, review_token=${existing.review_token}, email=${existing.customer?.email}`);
    const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    // Click-tracking redirect URLs (api/book.js review_click) — one per channel
    // so the dashboard can show which channel the customer engaged from.
    const emailClickUrl = `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(existing.review_token)}&ch=email`;
    const smsClickUrl = `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(existing.review_token)}&ch=sms`;
    // Twilio POSTs delivery status here as the text progresses (see api/analytics.js action=sms_status)
    const smsStatusCallback = `${baseUrl}/api/analytics?action=sms_status&token=${encodeURIComponent(existing.review_token)}`;

    // Brand the email by the JOB's business (orange vs blue) — for a
    // cross-company job that's the host company, not the tech's own.
    const slug = existing.business?.slug || '';

    // Review email — sent right away, only once (tracked in metadata).
    if (existing.customer?.email) {
      if (existing.metadata?.review_email_sent_at) {
        console.log(`[review] email already sent at ${existing.metadata.review_email_sent_at}, skipping`);
      } else {
        try {
          const brand = brandFor(slug);
          const { subject, html } = reviewEmail({
            firstName: existing.customer.name || 'there',
            clickUrl: emailClickUrl,
          }, brand);
          const { from } = emailConfig(slug);
          const emailResult = await sendEmail({ slug, to: existing.customer.email, subject, html, replyTo: from });
          if (emailResult.sent) {
            const nowIso = new Date().toISOString();
            // Re-read current metadata (not the start-of-request snapshot) so this
            // write doesn't clobber the wire_plate_deducted_at stamp written earlier
            // in this same completion. Mirrors the admin.js completion path.
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            const newMeta = { ...(cur?.metadata || existing.metadata || {}), review_email_sent_at: nowIso };
            await db.from('bookings').update({ metadata: newMeta }).eq('id', id);
            // review_email_id lets the Resend delivery webhook match its event
            // back to this booking; review_email_status starts 'sent' and the
            // webhook upgrades it to 'delivered'/'bounced'/'complained'.
            try {
              await db.from('bookings').update({
                review_email_sent_at: nowIso, review_email_count: 1,
                review_email_id: emailResult.id || null, review_email_status: 'sent',
              }).eq('id', id);
            } catch { /* column not applied yet */ }
            console.log(`[review] email sent to ${existing.customer.email} (${slug}) booking=${id}`);
          } else {
            console.warn(`[review] email NOT sent to ${existing.customer.email} (${slug}) booking=${id}:`, emailResult.skipped || emailResult.error);
          }
        } catch (e) {
          console.error(`[review] email failed for booking ${id}:`, e.message);
        }
      }
    } else {
      console.warn(`[review] no customer email on booking ${id}`);
    }

    // Review-request SMS (if customer opted in). Sent right away, only once —
    // the old setTimeout(20 min) never fired: Vercel freezes the function as
    // soon as the response is returned, so in-process timers silently die.
    if (existing.customer?.phone && existing.sms_consent) {
      if (existing.metadata?.review_sms_sent_at) {
        console.log(`[review] SMS already sent at ${existing.metadata.review_sms_sent_at}, skipping`);
      } else {
        try {
          const msg = `How did we do?\n\nLeave your technician a review here:\n${smsClickUrl}\n\nSTOP to opt out`;
          const r = await sendSMSResult(existing.customer.phone, msg, { statusCallback: smsStatusCallback });
          if (r.ok) {
            const nowIso = new Date().toISOString();
            // Re-read metadata (same reason as the email stamp above) and mark
            // sent — in metadata (always works) and the tracking columns
            // (best-effort until the migrations are applied). review_sms_status
            // starts 'sent'; Twilio's status callback upgrades it to
            // 'delivered'/'failed'/'undelivered' (see api/analytics.js).
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            await db.from('bookings').update({ metadata: { ...(cur?.metadata || existing.metadata || {}), review_sms_sent_at: nowIso } }).eq('id', id);
            try { await db.from('bookings').update({ review_sms_sent_at: nowIso, review_sms_status: 'sent' }).eq('id', id); } catch { /* column not applied yet */ }
            console.log(`[review] SMS sent (${slug}) booking=${id}`);
          } else {
            console.warn(`[review] SMS NOT sent booking=${id}:`, r.skipped || r.error);
          }
        } catch (e) {
          console.error(`[review] SMS failed for booking ${id}:`, e.message);
        }
      }
    }
  } else if (next === 'completed') {
    console.log(`[review] job ${id} marked completed but no review_token`);
  }

  return res.status(200).json({ ok: true, status: next });
}

// ── Add / change the card on file (customer wants to pay with a different card) ──
// The tech tokenizes the new card client-side (job.stripe_pk) and posts the
// payment_method_id here; we attach it in the booking's Stripe account and point
// the booking at it, so the next charge uses the new card. Scoped to the tech's
// own job (id + tech from the token).
async function jobCardUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = (body.id || '').toString();
  const pmId = (body.payment_method_id || '').toString();
  if (!id || !pmId) return res.status(400).json({ error: 'id and payment_method_id required' });

  const build = () => scopeMine(db.from('bookings')
    .select(`id, payment_status, ${techHasStripeAcctCol ? 'stripe_account, ' : ''}stripe_customer_id,
             business:businesses ( slug ),
             customer:customers ( name, email, phone )`), auth)
    .eq('id', id).maybeSingle();
  let { data: b, error } = await fetchMine(build);
  if (error && error.code === '42703' && /stripe_account/.test(error.message || '')) { techHasStripeAcctCol = false; ({ data: b, error } = await fetchMine(build)); }
  if (error || !b) return res.status(404).json({ error: 'Job not found' });
  if (b.payment_status === 'paid') return res.status(400).json({ error: 'This job is already paid — the card cannot be changed.' });
  // 'charging' is a transient lock a charge-in-progress holds (see
  // jobPayment) — changing the card underneath it would race the charge
  // itself, and this write's own `if (b.payment_status !== 'card_on_file')`
  // patch below would silently clobber the lock either way.
  if (b.payment_status === 'charging') return res.status(409).json({ error: 'This job is being charged right now — wait a moment and try again.' });

  const acct = { account: b.stripe_account || null, slug: b.business?.slug || null };
  if (!stripeConfigured(acct)) return res.status(400).json({ error: 'Payments are not configured on the server.' });

  let r;
  try {
    r = await saveCardOnFile({
      email: b.customer?.email, name: b.customer?.name, phone: b.customer?.phone,
      paymentMethodId: pmId, ...acct,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: 'Could not save the card: ' + e.message });
  }

  const patch = { stripe_payment_method_id: pmId };
  if (r.customerId) patch.stripe_customer_id = r.customerId;
  if (b.payment_status !== 'card_on_file') patch.payment_status = 'card_on_file';
  // CAS on the payment_status we READ, not a blind write: the 'charging' guard
  // above is a plain read, and the seconds-long Stripe call between it and
  // here is exactly wide enough for a charge to acquire its lock (or a cash
  // mark to land). Writing payment_status from the stale read would clobber
  // that. Zero rows updated = the state moved under us — the card IS attached
  // in Stripe (safe to redo), so a refresh-and-retry resolves it cleanly.
  const { data: upRow, error: upErr } = await db.from('bookings').update(patch)
    .eq('id', id).eq('payment_status', b.payment_status).select('id').maybeSingle();
  if (upErr) throw upErr;
  if (!upRow) return res.status(409).json({ error: 'The payment state changed while saving the card (a charge may be in progress) — refresh the job and try again.' });
  return res.status(200).json({ ok: true });
}

// ── Record which tech supplied the bracket (and move it off their inventory) ──
// On a two-person job only one tech supplies the bracket; that tech's stock is
// the one counted. Either tech on the job can record it. Re-recording to a
// different tech gives the count back to the previous supplier first.
async function jobBracketSetSupplier(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = (body.id || '').toString();
  const supplierId = (body.technician_id || '').toString();
  if (!id || !supplierId) return res.status(400).json({ error: 'id and technician_id required' });

  const build = () => scopeMine(db.from('bookings')
    .select(`id, business_id, technician_id, ${techHasSecondCol ? 'secondary_technician_id, ' : ''}bracket_supplied_by, line_items:booking_line_items ( name, quantity )`), auth)
    .eq('id', id).maybeSingle();
  let { data: b, error } = await fetchMine(build);
  if (error && /bracket_supplied_by/.test(error.message || '')) {
    return res.status(400).json({ error: "Bracket tracking isn't set up yet (run migration 0035)." });
  }
  if (error || !b) return res.status(404).json({ error: 'Job not found' });

  const jobTechs = [b.technician_id, b.secondary_technician_id].filter(Boolean);
  if (!jobTechs.includes(supplierId)) return res.status(400).json({ error: 'Pick a technician who is on this job.' });

  const qtys = detectBracketQtys(b.line_items || []);
  if (bracketTotal(qtys) <= 0) return res.status(400).json({ error: 'This job has no company-supplied bracket.' });

  const prev = b.bracket_supplied_by || null;
  if (prev === supplierId) return res.status(200).json({ ok: true, supplied_by: supplierId });

  // The actual inventory deduction happens ONCE, at job completion (see status()).
  // So here we only RECORD who supplied it — UNLESS the job was already completed
  // and deducted, in which case changing the supplier must MOVE the count from the
  // old supplier to the new one (give it back, take from the new).
  const { data: metaRow } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
  if (metaRow?.metadata?.bracket_deducted_at) {
    if (prev) await adjustBracketInventory(db, b.business_id, prev, qtys, +1);
    await adjustBracketInventory(db, b.business_id, supplierId, qtys, -1);
  }

  const { error: upErr } = await db.from('bookings')
    .update({ bracket_supplied_by: supplierId, bracket_supplied_at: new Date().toISOString() })
    .eq('id', id);
  if (upErr) throw upErr;
  return res.status(200).json({ ok: true, supplied_by: supplierId });
}

// ── Payment (techs can charge or mark-paid at service time) ────────────────────
async function jobPayment(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const act = (body.action || 'charge').toString();

  // stripe_account (migration 0032) may not be applied yet — select it
  // optimistically and drop it if the column is missing, so charging never
  // breaks on deploy order (absent -> undefined -> legacy slug behavior).
  const build = () => scopeMine(db.from('bookings')
    .select(`id, business_id, price, tip, payment_status, updated_at, scheduled_at, address_line1, city, state, postal_code, ${techHasStripeAcctCol ? 'stripe_account, ' : ''}stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             business:businesses ( slug, name ),
             customer:customers ( id, name, email, phone, stripe_customer_id )`), auth)
    .eq('id', id).maybeSingle();
  let { data: b, error } = await fetchMine(build);
  if (error && error.code === '42703' && /stripe_account/.test(error.message || '')) { techHasStripeAcctCol = false; ({ data: b, error } = await fetchMine(build)); }
  if (error || !b) return res.status(404).json({ error: 'Job not found' });

  // Charge/refund with the Stripe account the booking's card lives in: the
  // per-booking marker if stamped, else the business slug (legacy: Handy Andy ->
  // global account, Doms -> Doms account). Doms cards aren't in HA's account.
  const slug = b.business?.slug || null;
  const acct = { account: b.stripe_account || null, slug };
  const now = new Date().toISOString();

  // Fresh 'charging' lock = a real charge is mid-flight (maybe from the
  // office) — marking over it would double-collect (cash recorded + the
  // in-flight card charge still lands). Stale lock = crashed charge; the mark
  // is the escape hatch and passes through. CAS write so a state change in
  // the gap 409s instead of clobbering. Mirrors api/admin.js bookingPayment.
  if (act === 'mark_paid' || act === 'mark_unpaid') {
    if (b.payment_status === 'charging') {
      const lockAgeMs = Date.now() - new Date(b.updated_at || 0).getTime();
      if (lockAgeMs < 2 * 60 * 1000) {
        return res.status(409).json({ error: 'This job is being charged right now — wait a moment and check whether the charge went through before marking it.' });
      }
    }
    const patch = act === 'mark_paid'
      ? { payment_status: 'paid', paid_at: now, amount_paid: Number(b.price) || 0 }
      : { payment_status: 'unpaid', paid_at: null };
    const { data: updated } = await db.from('bookings').update(patch)
      .eq('id', id).eq('payment_status', b.payment_status).select('id').maybeSingle();
    if (!updated) return res.status(409).json({ error: 'The payment state just changed (maybe a charge finished) — refresh and check before marking it.' });
    return res.status(200).json({ ok: true, payment_status: patch.payment_status });
  }

  // Refunds are office-only. Techs must never issue refunds (owner request), so
  // the field app has no refund button and the API rejects the action outright —
  // defense in depth in case an old client or crafted request still sends it.
  if (act === 'refund') {
    return res.status(403).json({ error: 'Refunds are handled by the office, not the field app.' });
  }

  if (act === 'charge') {
    // The office has this same guard (api/admin.js bookingPayment) — the tech
    // app never had it, so a double-tap, a timed-out retry, or the office
    // charging the same job at the same moment from the dashboard could each
    // create a SECOND real charge. A plain "is it already paid" read isn't
    // enough by itself — two concurrent requests can both read "not paid"
    // before either writes. Acquire an actual lock via compare-and-swap: flip
    // payment_status to the transient 'charging' state conditioned on it
    // still being whatever we just read, so only ONE request can win the
    // swap. The loser gets a clear "already being charged" error instead of
    // a real second charge.
    let priorPaymentStatus;
    {
      const { data: fresh } = await db.from('bookings').select('payment_status').eq('id', id).maybeSingle();
      if (!fresh) return res.status(404).json({ error: 'Job not found' });
      if (fresh.payment_status === 'paid') return res.status(400).json({ error: 'This job is already paid.' });
      if (fresh.payment_status === 'charging') {
        return res.status(409).json({ error: 'This job is already being charged (maybe from the office or another device) — check if it went through before trying again.' });
      }
      priorPaymentStatus = fresh.payment_status;
      const { data: locked, error: lockErr } = await db.from('bookings')
        .update({ payment_status: 'charging' })
        .eq('id', id).eq('payment_status', priorPaymentStatus)
        .select('id').maybeSingle();
      if (lockErr) throw lockErr;
      if (!locked) {
        return res.status(409).json({ error: 'This job is already being charged (maybe from the office or another device) — check if it went through before trying again.' });
      }
    }

    // Past this point the lock is held — ANY exit must release it (restore
    // payment_status to what it was) or the job gets stuck showing "charging"
    // forever with no way to retry or use "Mark paid (cash)".
    try {
      if (!stripeConfigured(acct)) {
        console.warn(`[tech charge] job=${id} slug=${slug} account=${acct.account || '(legacy)'} -> payments NOT configured for this account`);
        const e = new Error(`Card payments aren't set up on the server for ${b.business?.name || slug || 'this business'}. Take cash and tap "Mark paid (cash)".`);
        e.status = 400; throw e;
      }
      const ticketAmount = Number(b.price) || 0;
      if (ticketAmount <= 0) { const e = new Error('Cannot charge for a job with no price.'); e.status = 400; throw e; }
      // Tip the customer added on the signature screen (0 if they skipped it).
      const tip = Math.max(0, Math.round((Number(body.tip) || 0) * 100) / 100);
      // No ceiling here means a fat-fingered tip (e.g. $1500 instead of $15)
      // would silently charge the customer's card for the full typo amount.
      // A 100%-of-ticket tip is already generous, so cap there and reject above it.
      if (tip > ticketAmount) { const e = new Error(`Tip ($${tip.toFixed(2)}) can't be more than the job total ($${ticketAmount.toFixed(2)}).`); e.status = 400; throw e; }
      const total = Math.round((ticketAmount + tip) * 100) / 100;

      let custId = b.stripe_customer_id || (b.customer && b.customer.stripe_customer_id) || null;
      let pmId = b.stripe_payment_method_id || null;
      try {
        if (!custId && b.customer && b.customer.email) {
          const r = await findCardOnFileByEmail(b.customer.email, acct);
          custId = r.customerId; if (r.paymentMethodId) pmId = r.paymentMethodId;
        }
        if (custId && !pmId) pmId = await defaultPaymentMethod(custId, acct);
      } catch (e) {
        console.warn(`[tech charge] job=${id} slug=${slug} account=${acct.account || '(legacy)'} email=${b.customer?.email || 'none'} -> card lookup failed: ${e.message}`);
        e.status = e.status || 400; throw e;
      }
      if (!custId || !pmId) {
        console.warn(`[tech charge] job=${id} slug=${slug} account=${acct.account || '(legacy)'} email=${b.customer?.email || 'none'} -> no card on file (customer=${!!custId} paymentMethod=${!!pmId})`);
        const e = new Error('No card on file for this customer. Take cash and tap "Mark paid (cash)".'); e.status = 400; throw e;
      }

      // Card brand/last4 for the receipt + dispute evidence (best-effort).
      let card = { brand: null, last4: null };
      try { card = await retrieveCard(pmId, acct); } catch (_) { /* unknown card is fine */ }

      let pi;
      try {
        // Keyed on booking id + exact amount + the CARD being charged, with the
        // SAME 'charge-' prefix the office path uses (api/admin.js): a true
        // retry (double-tap, a timed-out request resubmitted — from EITHER app)
        // has the same key and replays the same PaymentIntent instead of
        // charging twice. Changing the amount (different tip) OR the card
        // (customer hands over a new one after a decline) changes the key, so
        // a genuinely new attempt is never blocked by Stripe's replay cache.
        // Known residual: retrying the SAME card at the SAME total within 24h
        // of a decline replays the cached decline — nudge the tip a cent or
        // take cash if a customer insists the same card will work now.
        const idempotencyKey = `charge-${id}-${Math.round(total * 100)}-${String(pmId).slice(-8)}`;
        pi = await stripe('/payment_intents', { ...acct, idempotencyKey, body: {
          amount: Math.round(total * 100), currency: 'usd',
          customer: custId, payment_method: pmId, off_session: true, confirm: true,
          description: `Job ${id}`, metadata: { job_id: id, tip: String(tip) },
          receipt_email: (b.customer && b.customer.email) || undefined,
        }});
      } catch (e) {
        e.status = e.status || 402; e.message = 'Charge failed: ' + e.message; throw e;
      }
      if (pi.status !== 'succeeded') {
        const e = new Error(`Charge not completed (status: ${pi.status}). The card may need the customer to re-authenticate.`); e.status = 402; throw e;
      }
      const chargeId = pi.latest_charge || (pi.charges && pi.charges.data && pi.charges.data[0] && pi.charges.data[0].id) || null;

      // The money has MOVED at this point — this write is also the lock
      // release, so its error can't be ignored (supabase returns errors, it
      // doesn't throw): an unnoticed failure would 200 "paid" while the row
      // stays stuck on 'charging', blocking every retry/card-change/completion.
      const paidPatch = {
        payment_status: 'paid', paid_at: now, amount_paid: total, tip,
        stripe_payment_intent_id: pi.id, stripe_customer_id: custId, stripe_payment_method_id: pmId,
      };
      let { error: payErr } = await db.from('bookings').update(paidPatch).eq('id', id);
      if (payErr) ({ error: payErr } = await db.from('bookings').update(paidPatch).eq('id', id));   // one retry for a transient blip
      if (payErr) {
        // Still failing: free the lock with the minimal possible write so the
        // job isn't stuck, and surface a loud warning — NEVER report failure
        // (a "failed" message would invite a retry of a charge that succeeded).
        const { error: fbErr } = await db.from('bookings').update({ payment_status: 'paid' }).eq('id', id);
        console.error('[tech charge] CRITICAL: Stripe charge succeeded but booking update failed', { booking: id, pi: pi.id, err: payErr.message, minimal_write_ok: !fbErr });
        return res.status(200).json({ ok: true, payment_status: 'paid', amount: total, tip, payment_intent_id: pi.id,
          warning: `The charge WENT THROUGH on Stripe ($${total.toFixed(2)}), but saving it to the job failed: ${payErr.message}. Do NOT charge again — tell the office to reconcile this job.` });
      }

      // Freeze the signed authorization as chargeback evidence. Best-effort: the
      // money already moved, so a storage hiccup must never fail the charge.
      await saveAuthorization(db, req, b, { businessId: b.business_id, total, ticketAmount, tip, card, pi, chargeId, body });

      return res.status(200).json({ ok: true, payment_status: 'paid', amount: total, tip, payment_intent_id: pi.id });
    } catch (e) {
      // Release the lock on any failure so the job can be retried (or paid
      // with cash) instead of being stuck on 'charging'.
      try { await db.from('bookings').update({ payment_status: priorPaymentStatus }).eq('id', id).eq('payment_status', 'charging'); } catch (_) { /* best-effort */ }
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Unknown payment action "${act}"` });
}

// ── Job photos (tech documents the job; 2 required before completing) ─────────
// Confirm a booking belongs to the logged-in tech before touching its photos/notes.
// Owned when this tech is the primary OR second tech (so a helper can add
// photos/notes too). Returns the job's OWN business_id, which callers use for
// those writes (never the tech's home business).
async function assertOwnedJob(db, auth, id) {
  if (!id) { const e = new Error('id required'); e.status = 400; throw e; }
  const build = () => scopeMine(db.from('bookings').select('id, business_id'), auth).eq('id', id).maybeSingle();
  const { data } = await fetchMine(build);
  if (!data) { const e = new Error('Job not found'); e.status = 404; throw e; }
  return data.business_id;
}

async function jobPhotos(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_photos')
    .select('id, url, caption, uploader_name, created_at')
    .eq('booking_id', id).eq('business_id', bizId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return res.status(200).json({ photos: data || [], min_required: MIN_PHOTOS_TO_COMPLETE });
}

async function jobPhotoAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const { data: tech } = await db.from('technicians').select('name').eq('id', auth.tech_id).single();
  let up;
  try { up = await uploadImage(body.image, `${bizId}/${id}`); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const { data, error } = await db.from('booking_photos').insert({
    business_id: bizId, booking_id: id, technician_id: auth.tech_id,
    uploaded_by_kind: 'technician', uploader_name: tech?.name || 'Technician',
    storage_path: up.path, url: up.url, caption: (body.caption || '').toString().trim() || null,
  }).select('id, url, caption, uploader_name, created_at').single();
  if (error) { await deleteImage(up.path); throw error; }

  const { count } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).eq('booking_id', id).eq('business_id', bizId);
  return res.status(200).json({ photo: data, count: count || 0, min_required: MIN_PHOTOS_TO_COMPLETE });
}

async function jobPhotoDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id, photoId = body.photo_id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!photoId) return res.status(400).json({ error: 'photo_id required' });

  const { data: ph } = await db.from('booking_photos')
    .select('id, storage_path').eq('id', photoId).eq('booking_id', id).eq('business_id', bizId).single();
  if (!ph) return res.status(404).json({ error: 'Photo not found' });
  await db.from('booking_photos').delete().eq('id', photoId);
  await deleteImage(ph.storage_path);

  const { count } = await db.from('booking_photos')
    .select('id', { count: 'exact', head: true }).eq('booking_id', id).eq('business_id', bizId);
  return res.status(200).json({ ok: true, count: count || 0, min_required: MIN_PHOTOS_TO_COMPLETE });
}

// ── Job notes (internal; tech can add/delete on their own jobs) ──────────────
async function jobNotes(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('booking_notes')
    .select('id, body, author_kind, author_name, created_at')
    .eq('booking_id', id).eq('business_id', bizId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.status(200).json({ notes: data || [] });
}

async function jobNoteAdd(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const text = (body.body || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'Note text required' });

  const { data: tech } = await db.from('technicians').select('name').eq('id', auth.tech_id).single();
  const { data, error } = await db.from('booking_notes').insert({
    business_id: bizId, booking_id: id,
    author_kind: 'technician', author_id: auth.tech_id, author_name: tech?.name || 'Technician',
    body: text,
  }).select('id, body, author_kind, author_name, created_at').single();
  if (error) throw error;
  return res.status(200).json({ note: data });
}

async function jobNoteDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id, noteId = body.note_id;
  let bizId;
  try { bizId = await assertOwnedJob(db, auth, id); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!noteId) return res.status(400).json({ error: 'note_id required' });
  // Permanent delete (no soft-delete), scoped to this tech's job.
  await db.from('booking_notes').delete()
    .eq('id', noteId).eq('booking_id', id).eq('business_id', bizId);
  return res.status(200).json({ ok: true });
}

// ── Weekly availability (the tech edits their OWN) ──────────────────────────
// Return this tech's selected slots plus the fixed slot/day definitions so the
// app renders the picker without hardcoding them.
async function getAvailability(req, res, db, auth) {
  const { data, error } = await db.from('technician_availability')
    .select('day_of_week, slot_key')
    .eq('technician_id', auth.tech_id);
  if (error) throw error;

  // Upcoming one-time exceptions (today onward) so the app can show & edit them.
  const today = new Date().toISOString().slice(0, 10);
  const { data: exc, error: e2 } = await db.from('technician_availability_exceptions')
    .select('exception_date, slot_key, is_available')
    .eq('technician_id', auth.tech_id)
    .gte('exception_date', today)
    .order('exception_date');
  if (e2) throw e2;

  return res.status(200).json({
    slots: SLOTS, days: DAYS,
    availability: (data || []).map(r => ({ day_of_week: r.day_of_week, slot_key: r.slot_key })),
    exceptions: (exc || []).map(r => ({ date: r.exception_date, slot_key: r.slot_key, is_available: r.is_available })),
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

// Set a ONE-TIME override for a single date. The client sends the slot keys the
// tech will actually work that date; we store only the differences from their
// recurring schedule (so the weekly schedule is never touched). Sending a
// selection that matches the recurring schedule clears the date back to normal.
async function setAvailabilityException(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let date, rows;
  try {
    date = assertDate(body.date);
    const dow = dayOfWeekFor(date);
    const { data: recur, error } = await db.from('technician_availability')
      .select('slot_key').eq('technician_id', auth.tech_id).eq('day_of_week', dow);
    if (error) throw error;
    rows = computeExceptionRows((recur || []).map(r => r.slot_key), body.selected);
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  await db.from('technician_availability_exceptions')
    .delete().eq('technician_id', auth.tech_id).eq('exception_date', date);
  if (rows.length) {
    const { error } = await db.from('technician_availability_exceptions').insert(
      rows.map(r => ({ business_id: auth.business_id, technician_id: auth.tech_id, exception_date: date, ...r }))
    );
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, date, count: rows.length });
}

// Line items the tech should never see as "work" (fees, tips, coupons, and the
// dismount up-sell which is a payment concern, not a task). Shared by shapeJob
// (to filter the view) and jobLineItemsSave (to preserve these when a tech edits
// the visible work items, so techs can't touch fees/tips and the total stays right).
const HIDDEN_LI = new Set(['Guaranteed Dismount Service']);
// A coupon/discount line — by our own kind, OR by name for the paths that store
// it as a generic line item (the Zenbooker custom_service flow doesn't carry our
// 'kind', so a coupon lands as kind 'service' and would otherwise look editable).
function isCouponLi(li) {
  return ((li && li.kind) === 'coupon') || /^coupon\b/i.test(((li && li.name) || '').trim());
}
// Sales tax — by name (covers the Zenbooker path where it lands as kind 'service'
// instead of our 'fee'). Kept out of the tech's editable list; shown in Payment.
function isTaxLi(li) {
  return /^tax\b/i.test(((li && li.name) || '').trim());
}
// Non-labor fees the tech must NOT edit or set a quantity on — surcharge / after-
// hours / travel. They arrive as kind 'service' via the Zenbooker path, so match
// by name too. Shown read-only in the Payment section, not the editable list.
function isFeeLi(li) {
  return /service area surcharge|after[\s-]?hours|travel fee|service\s*minimum/i.test(((li && li.name) || '').trim());
}
// The Guaranteed Dismount up-sell — a payment/warranty concern, not a task the
// tech edits. Match by pattern (not an exact name) so a category prefix
// ("Add-ons: Guaranteed Dismount Service") or a wording variant is still caught.
function isDismountLi(li) {
  // Guaranteed-dismount up-sell AND the dismount question's answers ("No, I will
  // handle TV removal myself") — dismount lives in the payment/dismount context,
  // not the editable work lines, so we preserve these instead of deleting on save.
  return /guarante\w*\s+dismount|dismount\s+service|\btv removal\b/i.test(((li && li.name) || '').trim());
}
function isHiddenLi(li) {
  const kind = (li && li.kind) || 'service';
  if (kind === 'fee' || kind === 'tip' || kind === 'coupon') return true;
  if (isCouponLi(li) || isTaxLi(li) || isFeeLi(li) || isDismountLi(li)) return true;   // coupons, tax, fees & dismount up-sell aren't editable work lines
  return HIDDEN_LI.has(((li && li.name) || '').trim());
}

// Count the COMPANY-supplied brackets on a job by type, from its line items.
// "Customer supplied" brackets don't draw from inventory and are ignored.
function detectBracketQtys(lineItems) {
  const out = { flat: 0, tilting: 0, full_motion: 0 };
  for (const li of lineItems || []) {
    const name = (li.name || '').toLowerCase();
    const qty = Number(li.quantity) || 1;
    if (/customer.?supplied/.test(name)) continue;
    if (/full.?motion/.test(name)) out.full_motion += qty;
    else if (/tilt/.test(name)) out.tilting += qty;
    else if (/\bflat\b|fixed/.test(name)) out.flat += qty;
  }
  return out;
}
function bracketTotal(q) { return (q.flat || 0) + (q.tilting || 0) + (q.full_motion || 0); }
// Human label for the brackets on a job, e.g. "1× Full Motion".
function bracketLabel(q) {
  const parts = [];
  if (q.full_motion) parts.push(`${q.full_motion}× Full Motion`);
  if (q.tilting) parts.push(`${q.tilting}× Tilting`);
  if (q.flat) parts.push(`${q.flat}× Flat`);
  return parts.join(', ');
}

// Add (sign +1) or subtract (sign -1) bracket quantities from a tech's inventory
// row, creating it if missing. Floors at 0 so the read-only count never goes negative.
//
// Inventory is tracked per TECH, not per job — one physical truck stock,
// regardless of which company's customer it's used for. Since Denver
// cross-hire (a tech can complete a job for the OTHER company), `businessId`
// here may be the JOB's business, which can differ from the tech's own.
// Always resolve+use the tech's real home business_id so a cross-hire job
// deducts from their actual stock instead of creating a phantom always-zero
// row under the other company (the bug that made TK show a false "reorder"
// alert under Handy Andy's inventory table).
async function adjustBracketInventory(db, businessId, techId, qtys, sign) {
  const { data: techRow } = await db.from('technicians').select('business_id').eq('id', techId).maybeSingle();
  const homeBizId = techRow?.business_id || businessId;
  const { data: inv } = await db.from('bracket_inventory')
    .select('id, flat_qty, tilting_qty, full_motion_qty')
    .eq('business_id', homeBizId).eq('technician_id', techId).maybeSingle();
  const cur = inv || { flat_qty: 0, tilting_qty: 0, full_motion_qty: 0 };
  const next = {
    flat_qty:        Math.max(0, (Number(cur.flat_qty) || 0) + sign * (qtys.flat || 0)),
    tilting_qty:     Math.max(0, (Number(cur.tilting_qty) || 0) + sign * (qtys.tilting || 0)),
    full_motion_qty: Math.max(0, (Number(cur.full_motion_qty) || 0) + sign * (qtys.full_motion || 0)),
  };
  if (inv) await db.from('bracket_inventory').update({ ...next, updated_at: new Date().toISOString() }).eq('id', inv.id);
  else await db.from('bracket_inventory').insert({ business_id: homeBizId, technician_id: techId, ...next });
}

// Wire concealment plates used on a job: one per unit of the "Hide wires BEHIND
// the wall" service. Match on behind + wall + a wire/conceal word so small label
// variations still count, while a surface ("on the wall") cord-cover line — which
// uses no plate — does not.
function detectWirePlateQty(lineItems) {
  let n = 0;
  for (const li of lineItems || []) {
    const name = (li.name || '').toLowerCase();
    if (/behind/.test(name) && /wall/.test(name) && /(wire|cord|conceal)/.test(name)) {
      n += Number(li.quantity) || 1;
    }
  }
  return n;
}

// Subtract wire concealment plates from a tech's inventory (floor 0) and log the
// usage. No-ops gracefully if migration 0039 hasn't added the columns yet, and
// never throws into the completion path (inventory bookkeeping must not block a
// tech from finishing a job). Same cross-hire fix as adjustBracketInventory
// above: the STOCK row lives under the tech's own home business, never the job's.
async function adjustWirePlateInventory(db, businessId, techId, qty, bookingId) {
  if (!qty || !techId) return;
  const { data: techRow } = await db.from('technicians').select('business_id').eq('id', techId).maybeSingle();
  const homeBizId = techRow?.business_id || businessId;
  let { data: inv, error } = await db.from('bracket_inventory')
    .select('id, wire_plate_qty')
    .eq('business_id', homeBizId).eq('technician_id', techId).maybeSingle();
  if (error) { if (/wire_plate_qty/.test(error.message || '')) return; throw error; }
  if (!inv) {
    const { data: created } = await db.from('bracket_inventory')
      .insert({ business_id: homeBizId, technician_id: techId, wire_plate_qty: 0 })
      .select('id, wire_plate_qty').maybeSingle();
    inv = created || { id: null, wire_plate_qty: 0 };
  }
  const nextQty = Math.max(0, (Number(inv.wire_plate_qty) || 0) - qty);
  if (inv.id) {
    await db.from('bracket_inventory')
      .update({ wire_plate_qty: nextQty, updated_at: new Date().toISOString() })
      .eq('id', inv.id);
  }
  try {
    // Usage LOG stays attributed to the JOB's business (which company's
    // customer consumed it) — only the inventory row above moves to the
    // tech's home business.
    await db.from('bracket_usage_logs').insert({
      business_id: businessId, booking_id: bookingId || null, technician_id: techId,
      flat_used: 0, tilting_used: 0, full_motion_used: 0, wire_plate_used: qty,
      logged_by_kind: 'technician', notes: 'Behind-the-wall wire concealment',
    });
  } catch (_) { /* usage log is best-effort */ }
}

// Does this job still need a bracket-supplier selection before it can complete?
// Best-effort: if the bracket_supplied_by column (0035) isn't applied yet, never
// block completion.
async function jobNeedsBracketSupplier(db, bookingId) {
  // The supplier question only exists for two-person jobs. Without 0019's second
  // tech column there's no such thing, so never gate.
  if (!techHasSecondCol) return false;
  try {
    const { data: b, error } = await db.from('bookings')
      .select('bracket_supplied_by, secondary_technician_id, line_items:booking_line_items ( name, quantity )')
      .eq('id', bookingId).maybeSingle();
    if (error || !b) return false;
    if (!b.secondary_technician_id) return false;   // solo job: assigned tech is the supplier
    if (b.bracket_supplied_by) return false;
    return bracketTotal(detectBracketQtys(b.line_items || [])) > 0;
  } catch (e) { return false; }
}

// Collapse the linked service into the category the tech should see: "TV
// Mounting", "Handyman", or "Assurion". Mirrors the dashboard's classifier so
// both apps label a job the same way.
function classifyServiceCat(b) {
  if (/assurion/i.test(String(b.notes || '')) || /assurion/i.test(String(b.service?.name || ''))) return 'Assurion';
  const svc = String(b.service?.name || '').toLowerCase();
  const names = (b.line_items || []).map(li => String(li.name || '').toLowerCase());
  if (/handyman/.test(svc) || names.some(n => /handyman/.test(n))) return 'Handyman';
  return 'TV Mounting';
}

function shapeJob(b, full = false, forTech = false) {
  const address = formatAddress(b);
  // No usable street address on file (missing, or an email/phone in the box) —
  // drives the critical "call the customer for the address" alert.
  const addressMissing = !isLikelyStreetAddress(b.address_line1);
  // Show the service CATEGORY the tech recognizes — "TV Mounting", "Handyman",
  // or "Assurion" — never the generic linked-service name "Service".
  const serviceName = classifyServiceCat(b);
  const out = {
    id: b.id,
    status: b.status,
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    customer_name: b.customer?.name || 'Customer',
    customer_phone: b.customer?.phone || null,
    service: serviceName,
    address,
    address_missing: addressMissing,
    customer_notes: b.customer_notes || null,
    maps_url: address ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}` : null,
    lat: b.lat || null,
    lng: b.lng || null,
  };
  if (full) {
    out.customer_email = b.customer?.email || null;
    out.notes = b.notes || null;
    out.price = b.price;
    // Google Maps Street View Static API key (client-side, referrer-restricted).
    // Sent so the tech portal can render a Street View of the job location even
    // when lat/lng aren't stored (it can geocode the address string instead).
    out.maps_key = process.env.GOOGLE_MAPS_API_KEY || null;
    // For techs, only show work items; hide fees, tips, coupons, and dismount.
    out.line_items = (b.line_items || []).filter(li => forTech ? !isHiddenLi(li) : true);
    // Coupons/discounts are pulled OUT of the editable list and sent separately so
    // the app can show them on their own at the bottom (a tech can't edit/remove a
    // discount). Amounts are negative (a price reduction).
    out.discounts = (b.line_items || []).filter(isCouponLi)
      .map(li => ({ name: li.name || 'Coupon', amount: Number(li.line_total) || 0 }));
    // Sales tax, shown in the Payment section (never an editable line item).
    out.tax = Math.round((b.line_items || []).filter(isTaxLi)
      .reduce((t, li) => t + (Number(li.line_total) || 0), 0) * 100) / 100;
    // Non-labor fees (surcharge / after-hours / travel), shown read-only in the
    // Payment section — the tech can't edit them or change a quantity.
    const isAnyFee = li => isFeeLi(li) || isDismountLi(li) || (((li && li.kind) === 'fee') && !isTaxLi(li) && !isCouponLi(li) && !/\btip\b/i.test((li && li.name) || ''));
    // The travel fee / service-area surcharge is HIDDEN from the tech's Payment
    // view: the owner keeps part of it, so the tech shouldn't see the
    // customer-facing amount. It still rides in the total (price) — just not
    // itemized here. (After-hours and other fees stay visible.)
    const isTravelFee = li => /service area surcharge|travel\s*fee/i.test((li && li.name) || '');
    out.fees = (b.line_items || []).filter(li => isAnyFee(li) && !(forTech && isTravelFee(li)) && (Number(li.line_total) || 0) !== 0)
      .map(li => ({ name: li.name || 'Fee', amount: Number(li.line_total) || 0 }));
    // Sum of the lines the tech CAN'T see (fees/tips/coupons/dismount). Sent so the
    // line-item editor can seed correctly: when a job has no visible work lines, the
    // starting line should be (price − hidden_total), not the whole price.
    out.hidden_total = forTech
      ? Math.round((b.line_items || []).filter(isHiddenLi).reduce((t, li) => t + (Number(li.line_total) || 0), 0) * 100) / 100
      : 0;
    out.payment_status = b.payment_status || 'unpaid';
    out.paid_at = b.paid_at || null;
    out.stripe_customer_id = b.stripe_customer_id || null;
    out.stripe_payment_method_id = b.stripe_payment_method_id || null;
    out.stripe_payment_intent_id = b.stripe_payment_intent_id || null;
    // Customer review for this job (so the tech sees the rating + comment in context).
    out.review_rating = b.review_rating || null;
    out.review_text = b.review_text || null;
    out.reviewed_at = b.reviewed_at || null;
  }
  return out;
}

// ── Payroll Report ─────────────────────────────────────────────────────────
// Tech pay for one Sun–Sat week, computed from the rate sheet (api/_lib/payroll.js).
// Jobs are bucketed: paid (counted this week), deferred (unpaid — future week),
// or flagged (computed but needs owner review). Pay date = period-end Sat + 15d.
// Map(postal_code -> tech_payout) for a business's travel tiers. One batched
// read; empty Map if the tech_payout column (migration 0032) isn't applied yet.
async function travelPayoutMap(db, businessId) {
  const map = new Map();
  const { data, error } = await db.from('service_area_zips')
    .select('postal_code, tech_payout').eq('business_id', businessId);
  if (error) return map;
  for (const r of data || []) {
    const p = Number(r.tech_payout) || 0;
    if (p > 0) map.set(String(r.postal_code), p);
  }
  return map;
}

async function techPayroll(req, res, db, auth) {
  const weekStart = (req.query.week_start || '').toString();
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return res.status(400).json({ error: 'week_start (YYYY-MM-DD, Sunday) required' });
  }

  const techId = auth.tech_id;
  const weekEnd = addDaysStr(weekStart, 6);

  // The tech's business slug drives Dom's-vs-HA handling inside the engine.
  // Also pull the owner-set manual "expected pay" (may predate migration 0038).
  let techRow = null;
  {
    let r = await db.from('technicians')
      .select('name, businesses(slug), manual_pay_amount, manual_pay_date').eq('id', techId).single();
    if (r.error && /manual_pay_(amount|date)/.test(r.error.message || '')) {
      r = await db.from('technicians').select('name, businesses(slug)').eq('id', techId).single();
    }
    techRow = r.data;
  }
  const techName = techRow?.name || '';
  const businessSlug = techRow?.businesses?.slug || '';
  // Owner-set expected pay belongs to ONE deposit (a Monday). It must show ONLY on
  // the week whose pay date is that Monday — otherwise a tech sees the same money
  // on every week they scroll to, including weeks they never worked and weeks
  // before this system existed. The deposit's work week is the one ending
  // PAY_DATE_OFFSET_DAYS before manual_pay_date, so surface it only when this
  // week's pay date equals manual_pay_date.
  const payDateForWeek = addDaysStr(weekEnd, PAY_DATE_OFFSET_DAYS);
  const manualPay = (techRow?.manual_pay_date && techRow.manual_pay_date === payDateForWeek && techRow?.manual_pay_amount != null)
    ? { amount: Number(techRow.manual_pay_amount), date: techRow.manual_pay_date }
    : null;

  // Completed jobs for this tech in the week, with everything the engine needs.
  // Completed jobs for this tech this week. secondary_technician_id (migration
  // 0019) is selected optimistically so a two-tech job splits 50/50; dropped on
  // older DBs so payroll never breaks waiting on a migration.
  const secCol = techHasSecondCol ? 'secondary_technician_id, ' : '';
  const jobsSelect = `
      id, scheduled_at, status, subtotal, price, payment_status, amount_paid,
      tip, notes, customer_notes, zenbooker_job_number, postal_code, technician_id, ${secCol}
      customers(name), services(name),
      line_items:booking_line_items(kind, name, unit_price, line_total)
    `;
  // A job counts for this tech whether they're the primary OR the secondary
  // (helper) technician — otherwise a two-tech job's helper leg is silently
  // dropped from their own payroll view (mirrors the admin.js payroll() fix).
  let jobsQuery = db.from('bookings')
    .select(jobsSelect)
    .eq('status', 'completed')
    .gte('scheduled_at', weekStart + 'T00:00:00Z')
    .lte('scheduled_at', weekEnd + 'T23:59:59Z')
    .order('scheduled_at');
  jobsQuery = techHasSecondCol
    ? jobsQuery.or(`technician_id.eq.${techId},secondary_technician_id.eq.${techId}`)
    : jobsQuery.eq('technician_id', techId);
  let { data: jobs, error } = await jobsQuery;
  if (error && error.code === '42703' && /secondary_technician_id/.test(error.message || '')) {
    techHasSecondCol = false;
    ({ data: jobs, error } = await db.from('bookings')
      .select(jobsSelect.replace('secondary_technician_id, ', ''))
      .eq('technician_id', techId).eq('status', 'completed')
      .gte('scheduled_at', weekStart + 'T00:00:00Z')
      .lte('scheduled_at', weekEnd + 'T23:59:59Z')
      .order('scheduled_at'));
  }
  if (error) throw error;

  // Per-zip travel payout (the "$X paid to the tech" half of the surcharge tier).
  const travelPayoutByZip = await travelPayoutMap(db, auth.business_id);

  const paidJobs = [];
  const deferredJobs = [];
  let totalPay = 0;

  for (const b of jobs || []) {
    const result = computeJobPay({
      status: b.status,
      payment_status: b.payment_status,
      price: b.price,
      subtotal: b.subtotal,
      amount_paid: b.amount_paid,
      tip: b.tip,
      notes: b.notes,
      customer_notes: b.customer_notes,
      zenbooker_job_number: b.zenbooker_job_number,
      service_name: b.services?.name || '',
      business_slug: businessSlug,
      line_items: b.line_items || [],
      travel_payout: travelPayoutByZip.get(String(b.postal_code || '')) || 0,
      second_tech: !!b.secondary_technician_id,
      is_secondary: techId === b.secondary_technician_id && techId !== b.technician_id,
    }, techName);

    const base = {
      id: b.id,
      customer_name: b.customers?.name || 'Unknown',
      service: b.services?.name || 'Service',
      time: new Date(b.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    };

    if (result.state === 'deferred') {
      deferredJobs.push({ ...base, customer_due: Math.floor((Number(b.price) || 0) - (Number(b.amount_paid) || 0)) });
    } else if (result.state === 'excluded') {
      // not paid, not shown
    } else {
      paidJobs.push({
        ...base,
        tech_pay: result.pay,
        breakdown: result.breakdown,
        flags: result.flags,
        needs_review: result.flags.length > 0 || result.state === 'partial',
      });
      totalPay += result.pay;
    }
  }

  return res.status(200).json({
    week_start: weekStart,
    week_end: weekEnd,
    pay_date: addDaysStr(weekEnd, PAY_DATE_OFFSET_DAYS),
    tech_name: techName,
    jobs: paidJobs,
    deferred: deferredJobs,
    total: totalPay,
    manual_pay: manualPay,
  });
}

// ── Reviews Report ───────────────────────────────────────────────────────────
// The customer reviews this tech has earned: all-time average + count, how many
// landed this week (business-tz Sun–Sat), and a recent list. Each review carries
// the star rating, the customer's comment, and which job/service it was for.
// Reviews live on bookings (review_rating 1-5, review_text, reviewed_at).
async function techReviews(req, res, db, auth) {
  const { data: biz } = await db.from('businesses').select('timezone').eq('id', auth.business_id).single();
  const tz = biz?.timezone || 'America/Denver';
  const weekStartMs = startOfWeekUTC(tz).getTime();

  // technician_id alone so reviews earned on cross-company jobs count too.
  const { data, error } = await db.from('bookings')
    .select(`id, scheduled_at, reviewed_at, review_rating, review_text,
             customer:customers ( name ),
             service:services ( name )`)
    .eq('technician_id', auth.tech_id)
    .not('review_rating', 'is', null)
    .order('reviewed_at', { ascending: false, nullsFirst: false })
    .limit(100);
  if (error) throw error;

  const all = data || [];
  const total = all.length;
  const sum = all.reduce((a, r) => a + (Number(r.review_rating) || 0), 0);
  const average = total ? Math.round((sum / total) * 10) / 10 : 0;

  let weekCount = 0;
  const reviews = all.map(r => {
    // reviewed_at can be null for reviews imported without a timestamp; those
    // simply don't count toward "this week".
    const ts = r.reviewed_at ? new Date(r.reviewed_at).getTime() : 0;
    const this_week = ts >= weekStartMs;
    if (this_week) weekCount++;
    return {
      id: r.id,
      rating: r.review_rating,
      text: r.review_text || '',
      service: r.service?.name || null,
      customer_name: r.customer?.name || 'Customer',
      reviewed_at: r.reviewed_at,
      scheduled_at: r.scheduled_at,
      this_week,
    };
  });

  return res.status(200).json({ average, total, week_count: weekCount, reviews });
}

// ── Bracket inventory (read-only) ────────────────────────────────────────────
// The logged-in tech's own bracket stock (flat / tilting / full motion). Techs
// can SEE their count but NOT change it — only the owner edits counts (admin
// dashboard) and assigns deliveries. The tech id comes from the signed token,
// never the request, so a tech can only ever read their OWN inventory.
// TEMPORARY: let a tech set their OWN bracket counts. The tech id + business come
// from the signed token (never the request), so a tech can only edit their own row.
async function bracketInventorySet(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Bracket counts are now managed by the office only — techs can view but not
  // edit their inventory. Reject any direct edit attempt (the tech UI no longer
  // offers it; this closes the API path too).
  return res.status(403).json({ error: 'Bracket inventory is managed by the office.' });
  // eslint-disable-next-line no-unreachable
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const flat = n(body.flat), tilting = n(body.tilting), full_motion = n(body.full_motion);
  const now = new Date().toISOString();
  const { data: inv } = await db.from('bracket_inventory')
    .select('id').eq('technician_id', auth.tech_id).eq('business_id', auth.business_id).maybeSingle();
  if (inv) {
    const { error } = await db.from('bracket_inventory')
      .update({ flat_qty: flat, tilting_qty: tilting, full_motion_qty: full_motion, updated_at: now })
      .eq('id', inv.id);
    if (error) throw error;
  } else {
    const { error } = await db.from('bracket_inventory')
      .insert({ business_id: auth.business_id, technician_id: auth.tech_id, flat_qty: flat, tilting_qty: tilting, full_motion_qty: full_motion });
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, flat, tilting, full_motion, total: flat + tilting + full_motion });
}

async function bracketInventory(req, res, db, auth) {
  const sel = (withWp) => db.from('bracket_inventory')
    .select(`flat_qty, tilting_qty, full_motion_qty, updated_at${withWp ? ', wire_plate_qty' : ''}`)
    .eq('technician_id', auth.tech_id)
    .eq('business_id', auth.business_id)
    .maybeSingle();
  // wire_plate_qty arrives with migration 0039; degrade gracefully (plates -> 0)
  // if the column isn't applied yet so the inventory view never hard-fails.
  let { data: inv, error } = await sel(true);
  let hasWp = true;
  if (error && /wire_plate_qty/.test(error.message || '')) { hasWp = false; ({ data: inv, error } = await sel(false)); }
  if (error) throw error;

  const flat = inv?.flat_qty || 0;
  const tilting = inv?.tilting_qty || 0;
  const full_motion = inv?.full_motion_qty || 0;

  // In-route orders assigned to this tech — brackets on the way but not yet
  // delivered, so the tech knows what's coming and roughly when. Best-effort:
  // if the query fails for any reason we just return an empty list (the on-hand
  // counts above must never be blocked by this extra lookup).
  let in_route = [];
  try {
    const irCols = (withEst) =>
      `id, walmart_order_num, flat_qty, tilting_qty, full_motion_qty, order_date, created_at${withEst ? ', estimated_delivery' : ''}`;
    let { data: rows, error: irErr } = await db.from('bracket_purchases')
      .select(irCols(true))
      .eq('technician_id', auth.tech_id)
      .eq('business_id', auth.business_id)
      .eq('status', 'in_route')
      .order('created_at', { ascending: true });
    // estimated_delivery arrives with its migration; degrade gracefully if absent.
    if (irErr && /estimated_delivery/.test(irErr.message || '')) {
      ({ data: rows } = await db.from('bracket_purchases')
        .select(irCols(false))
        .eq('technician_id', auth.tech_id)
        .eq('business_id', auth.business_id)
        .eq('status', 'in_route')
        .order('created_at', { ascending: true }));
    }
    in_route = (rows || []).map((r) => {
      // Estimated arrival: the parsed "Arrives …" date if we have it, otherwise
      // ~7 days after the order date (Walmart's typical bracket shipping window).
      let est = r.estimated_delivery || null;
      if (!est) {
        const base = r.order_date || (r.created_at ? String(r.created_at).slice(0, 10) : null);
        if (base) {
          const d = new Date(base + 'T00:00:00Z');
          if (!isNaN(d.getTime())) { d.setUTCDate(d.getUTCDate() + 7); est = d.toISOString().slice(0, 10); }
        }
      }
      return {
        order_num: r.walmart_order_num || null,
        flat: r.flat_qty || 0,
        tilting: r.tilting_qty || 0,
        full_motion: r.full_motion_qty || 0,
        estimated_delivery: est,
      };
    }).filter((o) => (o.flat + o.tilting + o.full_motion) > 0);
  } catch (e) { in_route = []; }

  return res.status(200).json({
    flat,
    tilting,
    full_motion,
    total: flat + tilting + full_motion,
    wire_plate: hasWp ? (inv?.wire_plate_qty || 0) : 0,
    updated_at: inv?.updated_at || null,
    in_route,
  });
}

// Tech sets their OWN wire-plate count (an exact number, up or down). Unlike
// brackets (office-managed, read-only), techs manage their own plates — these
// auto-decrement on behind-the-wall jobs, so a tech can correct a miscount.
// Identity comes ONLY from the signed token (never the body); writes ONLY the
// plate column so it can't disturb the office-managed bracket counts.
async function wirePlateSet(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const target = Math.max(0, Math.floor(Number(body.wire_plate) || 0));
  const now = new Date().toISOString();
  try {
    const { data: inv } = await db.from('bracket_inventory')
      .select('id, wire_plate_qty').eq('technician_id', auth.tech_id).eq('business_id', auth.business_id).maybeSingle();
    const before = inv?.wire_plate_qty || 0;
    if (inv) {
      const { error } = await db.from('bracket_inventory')
        .update({ wire_plate_qty: target, updated_at: now }).eq('id', inv.id);
      if (error) throw error;
    } else {
      const { error } = await db.from('bracket_inventory')
        .insert({ business_id: auth.business_id, technician_id: auth.tech_id, wire_plate_qty: target });
      if (error) throw error;
    }
    // Best-effort audit log; never blocks the save.
    try {
      await db.from('bracket_usage_logs').insert({
        business_id: auth.business_id, technician_id: auth.tech_id,
        wire_plate_used: Math.abs(target - before),
        logged_by_kind: 'technician', notes: 'Tech manual plate count correction',
      });
    } catch (_) { /* logging is optional */ }
    return res.status(200).json({ ok: true, wire_plate: target });
  } catch (e) {
    if (/wire_plate_qty/.test((e && e.message) || '')) {
      return res.status(400).json({ error: 'Plate inventory needs the 0039 database update applied first.' });
    }
    throw e;
  }
}
