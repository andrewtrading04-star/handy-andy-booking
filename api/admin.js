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
import { emailNotificationsOn, smsNotificationsOn } from './_lib/notify.js';
import { demoMode } from './_lib/demo.js';
import { toE164, sendSMS, sendSMSResult, smsConfigured } from './_lib/sms.js';
import { emailConfig, sendEmail, bookingConfirmationEmail, brandFor, reviewEmail, estimateEmail } from './_lib/email.js';
import { sendOwnerBookingAlert, maybeSendBigBracketAlert } from './_lib/owner-notify.js';
import { localDayStartUTC, localDateStartUTC, startOfWeekUTC, startOfMonthUTC, addDaysStr } from './_lib/time.js';
import { SLOTS, SLOT_KEYS, DAYS, normalizeSlots, assertDate, dayOfWeekFor, computeExceptionRows, publicOpenSlots } from './_lib/availability.js';
import { formatAddress, isLikelyStreetAddress } from './_lib/address.js';
import { stripe, stripeConfigured, findCardOnFileByEmail, defaultPaymentMethod, businessSecretKey, saveCardOnFile as saveCardOnFileAcct, retrieveCard, stripeUploadFile, listOpenDisputes, submitDisputeEvidence, findLandedCharge } from './_lib/stripe.js';
import { saveAuthorization, buildDisputeEvidence } from './_lib/authorization.js';
import { gscQuery } from './_lib/gsc.js';

// Search Console domain per business — the free "what did people search to
// find us" data source (see api/_lib/gsc.js).
const GSC_DOMAIN_BY_SLUG = { 'handy-andy': 'ihandyandy.com', 'doms': 'domstvmounting.com' };
// Substrings that mark a query as "branded" (already knew the business name)
// vs. genuine new discovery, for the branded/non-branded split.
const GSC_BRAND_TERMS = {
  'handy-andy': ['handy andy', 'ihandyandy', 'handyandy'],
  'doms': ["dom's tv", 'doms tv', 'domstvmounting', "dom's tv mounting"],
};

// Publishable Stripe key for the admin/tech card-on-file UIs, by business (safe
// to expose). Handy Andy uses the main account; Doms uses its own.
const STRIPE_PK_GLOBAL = process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51Olvl3IqRVZvLFqu9lmppvTG7bOYTjAY30EoaDZXwKciPfGw5G24kAwVzU91FmgzypjfQfcmXFyGdc3UMBD3dOgF00DZZutNIA';
// Demo mode runs with no real Stripe keys at all (demoStripeResponse fakes
// every call) — without this branch, a Doms demo session would get
// stripe_pk:null (DOMS_STRIPE_PUBLISHABLE_KEY is never set there) and New
// Booking/Change Card would hard-refuse card entry, breaking "click every
// button" for a prospective buyer touring Doms. Real deployments are
// unaffected: demoMode() is false there.
function bookingStripePk(slug) { return (slug === 'doms' && !demoMode()) ? (process.env.DOMS_STRIPE_PUBLISHABLE_KEY || null) : STRIPE_PK_GLOBAL; }
import { uploadImage, deleteImage } from './_lib/storage.js';
import { computeJobPay, PAY_DATE_OFFSET_DAYS, isJuan } from './_lib/payroll.js';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed'];

// Technicians who can NEVER be the second tech on a two-person job. They cover
// out-of-town territories (Zach → Austin, Juan → Houston) and only ever work as
// the primary on their own jobs. The frontend hides them from the second-tech
// dropdown; this server-side list is the backstop so an "Any <company>"
// auto-pick can't slip them into the secondary slot. Matched case-insensitively
// by first name. Keep in sync with nbPopulateSecondTechs() in admin.html.
//
// These SAME techs bring their OWN second person on two-person jobs (an
// off-schedule spouse/helper). So when one of them is the PRIMARY, we never
// assign — nor require — a roster second tech: they cover it themselves. The
// customer is still charged the two-person fee (the lifting line item stays).
// bringsOwnSecondTech() is the readable alias for that primary-side rule.
const SECONDARY_INELIGIBLE_NAMES = ['juan', 'zach'];
function isSecondaryIneligibleName(name) {
  return SECONDARY_INELIGIBLE_NAMES.includes((name || '').trim().toLowerCase());
}
const bringsOwnSecondTech = isSecondaryIneligibleName;

// ── Cross-company booking ────────────────────────────────────────────────────
// Each business may book the OTHER company's technicians when its own are full.
// A booking always lives on its HOST business (the one the secretary is logged
// into); only the assigned technician_id may belong to the partner. A job is
// "cross-company" whenever the booking's business differs from the assigned
// tech's home business — derived live, so no schema change is needed.
const PARTNER_SLUG = { 'handy-andy': 'doms', 'doms': 'handy-andy' };

// The partner business row for a host slug, or null when there isn't one.
async function partnerBusiness(db, hostSlug) {
  const pslug = PARTNER_SLUG[hostSlug];
  if (!pslug) return null;
  const { data } = await db.from('businesses')
    .select('id, slug, name, timezone').eq('slug', pslug).eq('active', true).maybeSingle();
  return data || null;
}

// Which business's technician roster an "Any Technician" / auto-pick should scan:
// the partner company when pool==='partner' (and one exists), else the host.
async function rosterBizId(db, hostBiz, pool) {
  if (pool === 'partner') {
    const p = await partnerBusiness(db, hostBiz.slug);
    if (p) return p.id;
  }
  return hostBiz.id;
}

// Look up the service_area_id for a postal code in a given business.
// Returns null if postal_code is not provided or not found.
async function serviceAreaIdFromPostal(db, businessId, postalCode) {
  if (!postalCode) return null;
  const { data } = await db.from('service_area_zips')
    .select('service_area_id')
    .eq('business_id', businessId)
    .eq('postal_code', postalCode)
    .maybeSingle();
  return data?.service_area_id || null;
}

// The timezone of a service area (its metro), or `fallbackTz` if none. Handy
// Andy spans Mountain (Denver) and Central (Houston/Austin), so a job's SLOT
// time must be anchored/stored/displayed in its metro's tz — never the single
// business tz — or an 8am Central slot drifts by an hour.
async function areaTimezone(db, serviceAreaId, fallbackTz) {
  if (!serviceAreaId) return fallbackTz;
  try {
    const { data } = await db.from('service_areas').select('timezone').eq('id', serviceAreaId).maybeSingle();
    return data?.timezone || fallbackTz;
  } catch { return fallbackTz; }
}

// The fixed slot label for an instant, rendered in a given (metro) timezone and
// snapped to the slot it falls in — so every location reads the same fixed slots
// (8:00 AM, 11:00 AM, 2:00 PM, 5:00 PM, 8:00 PM) regardless of the viewer's tz.
function slotTimeLabel(tz, iso) {
  if (!iso || !tz) return null;
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(iso)).reduce((a, x) => (a[x.type] = x.value, a), {});
    const mins = ((p.hour === '24' ? 0 : Number(p.hour)) * 60) + Number(p.minute);
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const to12 = (s) => { let [h, m] = s.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
    for (const s of SLOTS) if (mins >= toMin(s.start) && mins < toMin(s.end)) return to12(s.start);
    for (const s of SLOTS) if (toMin(s.start) === mins) return to12(s.start);
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch { return null; }
}

// Build a Map(postal_code -> tech_payout) for a business, for payroll's travel
// payout. One batched read; returns an empty Map if the tech_payout column isn't
// applied yet (migration 0032) so payroll never breaks waiting on a migration.
async function travelPayoutMap(db, businessId) {
  const map = new Map();
  let { data, error } = await db.from('service_area_zips')
    .select('postal_code, tech_payout').eq('business_id', businessId);
  if (error) return map;   // column missing or read failed -> no payouts
  for (const r of data || []) {
    const p = Number(r.tech_payout) || 0;
    if (p > 0) map.set(String(r.postal_code), p);
  }
  return map;
}

// ── SMS Helper ──────────────────────────────────────────────────────────────
// Normalize US/CA numbers to E.164 (+1XXXXXXXXXX), which Twilio requires.
// Display label for an internal note/photo authored from the dashboard.
function adminAuthorName(auth) { return auth.role === 'owner' ? 'Owner' : 'Office'; }

// Notify a technician by SMS that they've been assigned a job. Fire-and-forget;
// safe to call even if the tech has no phone (sendSMS no-ops). `scheduledAtISO`
// may be null (unscheduled job) — we fall back to a generic line.
async function notifyTechAssigned(db, biz, technicianId, scheduledAtISO, areaTz) {
  if (!technicianId) return;
  // Look up by id ALONE (not business) so a cross-company tech — whose home
  // business differs from this booking's — is still found and texted.
  const { data: tech } = await db.from('technicians')
    .select('phone, business_id').eq('id', technicianId).maybeSingle();
  if (!tech?.phone) return;
  // The time must be the JOB's local time (an Austin job is Central), not the
  // business's home tz — else the tech is told an hour off. Caller passes the
  // service-area tz; fall back to the business tz only when it's unknown.
  const tz = areaTz || biz.timezone || 'America/Denver';
  let whenTxt = 'a new job';
  if (scheduledAtISO) {
    try {
      whenTxt = new Date(scheduledAtISO).toLocaleString('en-US', {
        timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
    } catch { /* keep generic */ }
  }
  // Cross-company: the tech works for the other company today. Make it
  // unmistakable which business this job belongs to.
  const appLink = (process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')) + '/tech.html';
  const crossCompany = tech.business_id && tech.business_id !== biz.id;
  const msg = crossCompany
    ? `You got a job for ${String(biz.name || '').toUpperCase()} (not your own company)! ${whenTxt}. Address & details in the app: ${appLink}`
    : `You got a job! ${whenTxt}. Address & details in the app: ${appLink}`;
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
    if (action === 'estimate_approve') return await estimateApprove(req, res, body);
    if (action === 'estimate_approve_info') return await estimateApproveInfo(req, res, body);
    if (action === 'estimate_slots') return await estimateSlots(req, res);
    if (action === 'session_status') return await sessionStatus(req, res);

    // Everything below requires a valid admin token.
    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();

    switch (action) {
      case 'summary':           return await summary(req, res, db, auth);
      case 'services':          return await services(req, res, db, auth);
      case 'service_options':   return await serviceOptions(req, res, db, auth);
      case 'seed_tv_options':   return await seedTvOptions(req, res, db, auth);
      case 'relabel_tv_size':   return await relabelTvSize(req, res, db, auth);
      case 'available_slots':   return await availableSlots(req, res, db, auth);
      case 'available_dates':   return await availableDates(req, res, db, auth);
      case 'calendar':          return await calendar(req, res, db, auth);
      case 'calendar_probe':    return await calendarProbe(req, res, db, auth);
      case 'availability_overview': return await availabilityOverview(req, res, db, auth);
      case 'bookings':          return await bookings(req, res, db, auth);
      case 'booking_create':    return await bookingCreate(req, res, db, auth, body);
      case 'booking_update':    return await bookingUpdate(req, res, db, auth, body);
      case 'booking_address_update': return await bookingAddressUpdate(req, res, db, auth, body);
      case 'booking_authorization': return await bookingAuthorization(req, res, db, auth);
      case 'booking_line_items_save': return await bookingLineItemsSave(req, res, db, auth, body);
      case 'booking_slots':        return await bookingSlots(req, res, db, auth, body);
      case 'booking_card_update': return await bookingCardUpdate(req, res, db, auth, body);
      case 'booking_payment':   return await bookingPayment(req, res, db, auth, body);
      case 'booking_card':      return await bookingCard(req, res, db, auth);
      case 'disputes':          return await disputes(req, res, db, auth);
      case 'dispute_submit':    return await disputeSubmit(req, res, db, auth, body);
      case 'booking_photos':       return await bookingPhotos(req, res, db, auth);
      case 'booking_photo_add':    return await bookingPhotoAdd(req, res, db, auth, body);
      case 'booking_photo_delete': return await bookingPhotoDelete(req, res, db, auth, body);
      case 'booking_photo_set_status': return await bookingPhotoSetStatus(req, res, db, auth, body);
      case 'booking_notes':        return await bookingNotes(req, res, db, auth);
      case 'booking_note_add':     return await bookingNoteAdd(req, res, db, auth, body);
      case 'booking_note_delete':  return await bookingNoteDelete(req, res, db, auth, body);
      case 'photo_gallery':        return await photoGallery(req, res, db, auth);
      case 'customers':         return await customers(req, res, db, auth);
      case 'customer_update':   return await customerUpdate(req, res, db, auth, body);
      case 'technicians':       return await technicians(req, res, db, auth);
      case 'zip_area':          return await zipArea(req, res, db, auth);
      case 'partner_technicians': return await partnerTechnicians(req, res, db, auth);
      case 'technician_update': return await technicianUpdate(req, res, db, auth, body);
      case 'technician_photo_upload': return await technicianPhotoUpload(req, res, db, auth, body);
      case 'tech_availability':     return await techAvailability(req, res, db, auth);
      case 'tech_availability_set': return await techAvailabilitySet(req, res, db, auth, body);
      case 'tech_availability_exception_set': return await techAvailabilityExceptionSet(req, res, db, auth, body);
      case 'reviews':           return await reviews(req, res, db, auth);
      case 'review_requests':   return await reviewRequests(req, res, db, auth);
      case 'review_resend':     return await reviewResend(req, res, db, auth, body);
      case 'review_calls':      return await reviewCalls(req, res, db, auth);
      case 'review_call_log':   return await reviewCallLog(req, res, db, auth, body);
      case 'bad_reviews':       return await badReviews(req, res, db, auth);
      case 'google_reviews':       return await googleReviews(req, res, db, auth);
      case 'google_review_update': return await googleReviewUpdate(req, res, db, auth, body);
      case 'avg_ticket':        return await avgTicketWeek(req, res, db, auth);
      case 'gsc_queries':       return await gscQueries(req, res, db, auth);
      case 'estimates':         return await estimates(req, res, db, auth);
      case 'estimate_update':   return await estimateUpdate(req, res, db, auth, body);
      case 'estimate_create':   return await estimateCreate(req, res, db, auth, body);
      case 'estimate_send_sms': return await estimateSendSms(req, res, db, auth, body);
      case 'estimate_send_email': return await estimateSendEmail(req, res, db, auth, body);
      case 'email_quota': return await emailQuota(req, res, auth);
      case 'bracket_inventory': return await bracketInventory(req, res, db, auth);
      case 'bracket_purchases': return await bracketPurchases(req, res, db, auth);
      case 'bracket_update': return await bracketUpdate(req, res, db, auth, body);
      case 'bracket_parse_email': return await bracketParseEmail(req, res, db, auth, body);
      case 'bracket_pending': return await bracketPending(req, res, db, auth);
      case 'bracket_assign': return await bracketAssign(req, res, db, auth, body);
      case 'wire_plate_pending': return await wirePlatePending(req, res, db, auth);
      case 'wire_plate_orders': return await wirePlateOrders(req, res, db, auth);
      case 'wire_plate_assign': return await wirePlateAssign(req, res, db, auth, body);
      case 'wire_plate_remove': return await wirePlateRemove(req, res, db, auth, body);
      case 'bracket_set_status': return await bracketSetStatus(req, res, db, auth, body);
      case 'payroll': return await payroll(req, res, db, auth);
      case 'actual_profit_save': return await actualProfitSave(req, res, db, auth);
      case 'places_autocomplete': return await placesAutocomplete(req, res, auth);
      case 'place_details':       return await placeDetails(req, res, auth);
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
  // Each business's OWN Stripe publishable key (Doms has a separate Stripe
  // account from Handy Andy) — a publishable key is safe to expose to the
  // client. Without this, New Booking's card entry had no way to know which
  // account to tokenize against and always used the wrong one for Doms,
  // silently failing to save the card (booking still succeeded either way).
  for (const b of (businesses || [])) b.stripe_pk = bookingStripePk(b.slug);

  let name = displayNameFor(scope);
  // Demo: source the owner's greeting name from the DB (seeded) so it's driven by
  // data, not an env var. Production keeps the env-configured name.
  if (scope === 'all' && demoMode()) {
    try { const { data: o } = await db.from('staff_users').select('name').eq('role', 'owner').limit(1).maybeSingle(); if (o && o.name) name = o.name; } catch { /* fall back to env */ }
  }
  const token = signToken({ kind: 'admin', role, scope, name });
  // Tell the dashboard which outbound channels are wired up so it can show or
  // hide the Send SMS / Send Email buttons instead of surfacing a dead click.
  const config = {
    email: demoMode() || !!process.env.RESEND_API_KEY,
    sms: smsConfigured(),
    demo: demoMode(),
    maps_key: process.env.GOOGLE_MAPS_API_KEY || null,   // powers address autocomplete
    // Address autocomplete stays OFF until the Maps key is confirmed to have the
    // Maps JavaScript API + Places API enabled. Set MAPS_AUTOCOMPLETE=1 in Vercel
    // once those are on; otherwise Google's client renders a broken dropdown over
    // the address field. With it off, the field is a plain, reliable text input.
    maps_autocomplete: process.env.MAPS_AUTOCOMPLETE === '1' && !!process.env.GOOGLE_MAPS_API_KEY,
  };
  return res.status(200).json({ token, role, scope, name, config, businesses: businesses || [] });
}

// Validate the current session token and return user data. Called by tryAutoLogin()
// to restore a session without requiring a new password entry. If the token is
// invalid or expired, returns 401 and the frontend shows the login screen.
async function sessionStatus(req, res) {
  const auth = verifyToken(getBearer(req));
  if (!auth || auth.kind !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

  const db = serviceClient();
  let q = db.from('businesses').select('id, slug, name, timezone, brand_navy, brand_orange').eq('active', true).order('name');
  if (auth.scope !== 'all') q = q.eq('slug', auth.scope);
  const { data: businesses, error } = await q;
  if (error) throw error;
  // Same per-business Stripe publishable key login() sends — session_status is
  // how EXISTING sessions (no fresh login) refresh their cached business list,
  // so omitting it here would leave long-lived sessions tokenizing New Booking
  // cards with the wrong account's key (the original Doms card-save bug).
  for (const b of (businesses || [])) b.stripe_pk = bookingStripePk(b.slug);

  const config = {
    email: demoMode() || !!process.env.RESEND_API_KEY,
    sms: smsConfigured(),
    demo: demoMode(),
    maps_key: process.env.GOOGLE_MAPS_API_KEY || null,   // powers address autocomplete
    // Address autocomplete stays OFF until the Maps key is confirmed to have the
    // Maps JavaScript API + Places API enabled. Set MAPS_AUTOCOMPLETE=1 in Vercel
    // once those are on; otherwise Google's client renders a broken dropdown over
    // the address field. With it off, the field is a plain, reliable text input.
    maps_autocomplete: process.env.MAPS_AUTOCOMPLETE === '1' && !!process.env.GOOGLE_MAPS_API_KEY,
  };
  return res.status(200).json({
    token: getBearer(req), role: auth.role, scope: auth.scope, name: auth.name, config, businesses: businesses || []
  });
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

  // The 4 stat boxes track the WEEK shown on the schedule. `week` is any date in
  // that week (the client sends the week's Sunday); default = the current week.
  const wparam = (req.query.week || '').toString();
  const base = /^\d{4}-\d{2}-\d{2}$/.test(wparam) ? new Date(wparam + 'T12:00:00Z') : new Date();
  const weekStart = startOfWeekUTC(tz, base);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const monthStart = startOfMonthUTC(tz, weekStart);
  const monthEnd = startOfMonthUTC(tz, new Date(monthStart.getTime() + 40 * 24 * 60 * 60 * 1000));
  // A week can straddle two months (e.g. Jun 28–Jul 4), so pull the union range.
  const rangeStart = weekStart < monthStart ? weekStart : monthStart;
  const rangeEnd = weekEnd > monthEnd ? weekEnd : monthEnd;

  // One parallel wave for the always-needed reads: today's jobs (for the "jobs
  // scheduled today" line + counts), the week/month revenue range, and the tech
  // roster — three sequential round-trips collapsed into one.
  const [
    { data: today, error: e1 },
    { data: rangeJobs, error: e2 },
    { data: techs, error: e3 },
  ] = await Promise.all([
    fetchBookingRows(sel => db.from('bookings').select(sel)
      .eq('business_id', biz.id)
      .gte('scheduled_at', todayStart.toISOString())
      .lt('scheduled_at', tomorrow.toISOString())
      .order('scheduled_at', { ascending: true })),
    db.from('bookings').select('price, scheduled_at, status')
      .eq('business_id', biz.id)
      .gte('scheduled_at', rangeStart.toISOString())
      .lt('scheduled_at', rangeEnd.toISOString())
      .in('status', ACTIVE_STATUSES),
    db.from('technicians').select('id, name, phone, status, active')
      .eq('business_id', biz.id).eq('active', true).order('name'),
  ]);
  if (e1) throw e1; if (e2) throw e2; if (e3) throw e3;

  // Revenue across the viewed week's union range, bucketed into week + month.
  const sum = (rows) => Math.round(rows.reduce((n, r) => n + Number(r.price || 0), 0) * 100) / 100;
  const inWindow = (rows, a, b) => rows.filter(r => { const t = new Date(r.scheduled_at); return t >= a && t < b; });
  // Average ticket — mean price of COMPLETED jobs this month (revenue ÷ jobs).
  const monthCompleted = inWindow(rangeJobs, monthStart, monthEnd).filter(r => r.status === 'completed');
  const avgTicket = monthCompleted.length ? Math.round(sum(monthCompleted) / monthCompleted.length) : 0;
  const revenue = {
    week:  sum(inWindow(rangeJobs, weekStart, weekEnd)),
    month: sum(inWindow(rangeJobs, monthStart, monthEnd)),
    avg_ticket: avgTicket,
  };

  // Owner-only: REALIZED profit (revenue − tech payout − bracket cost) for the
  // viewed week and for TODAY (the real current Denver day, independent of the
  // viewed week). Only money actually earned counts — a job contributes once it
  // is COMPLETED and PAID, never while it's still upcoming/unpaid. Sensitive
  // margin data: gated on owner; never even computed for secretaries/techs.
  let profit = null;
  if (auth.role === 'owner') {
    // One parallel wave for every owner-only read: this business's week/month
    // jobs, yesterday's jobs, the business list, and this business's travel-payout
    // map (fetched ONCE and shared across all the economics below).
    const yStart = localDayStartUTC(tz, -1);
    const [{ data: pjobs }, { data: yRows }, { data: allBiz }, travelBiz] = await Promise.all([
      fetchEconomicsRows(sel => db.from('bookings').select(sel)
        .eq('business_id', biz.id)
        .gte('scheduled_at', rangeStart.toISOString())
        .lt('scheduled_at', rangeEnd.toISOString())
        .order('scheduled_at', { ascending: true })),
      fetchEconomicsRows(sel => db.from('bookings').select(sel)
        .eq('business_id', biz.id)
        .gte('scheduled_at', yStart.toISOString())
        .lt('scheduled_at', todayStart.toISOString())),
      db.from('businesses').select('id, slug, name, timezone').eq('active', true),
      travelPayoutMap(db, biz.id),
    ]);

    const earned = (rows) => (rows || []).filter(b => b.status === 'completed' && b.payment_status === 'paid');
    // Per-business travel-payout map cache (this business already fetched), so the
    // cross-business loops never refetch the same map.
    const travelCache = new Map([[biz.id, travelBiz]]);
    const travelMapFor = async (bb) => {
      if (travelCache.has(bb.id)) return travelCache.get(bb.id);
      const m = await travelPayoutMap(db, bb.id);
      travelCache.set(bb.id, m);
      return m;
    };

    // Per-business week rows (weekStart–weekEnd), fetched ONCE per business and
    // shared by realized profit (weekBySlug/pWeek) AND predicted income
    // (predictedBySlug) below — these used to be two separate fetches of the
    // exact same rows (one per metric), each followed by its own
    // computeJobEconomics pass. `active` (every non-cancelled/no-show status,
    // which includes 'completed') is a superset of the realized/"earned" rows
    // (completed AND paid), and computeJobEconomics projects EVERY row as if
    // completed+paid regardless of its real status — so one pass over `active`
    // yields correct per-job profit for both the realized subset and the full
    // predicted set. The currently-viewed business's rows are sliced out of
    // `pjobs` (already fetched above, whose range already covers this week)
    // instead of a redundant fetch.
    const weekEconBySlugP = Promise.all((allBiz || []).map(async (bb) => {
      let rows;
      if (bb.id === biz.id) {
        rows = (pjobs || []).filter(b => { const t = new Date(b.scheduled_at); return t >= weekStart && t < weekEnd; });
      } else {
        const r = await fetchEconomicsRows(sel => db.from('bookings').select(sel)
          .eq('business_id', bb.id)
          .gte('scheduled_at', weekStart.toISOString())
          .lt('scheduled_at', weekEnd.toISOString()));
        rows = r.data || [];
      }
      const active = rows.filter(b => ACTIVE_STATUSES.includes(b.status));
      const e = await computeJobEconomics(db, bb, active, true, await travelMapFor(bb));
      const paidProfit = Math.round(earned(active).reduce((n, j) => n + (Number(e[j.id]?.profit) || 0), 0));
      const predictedProfit = Math.round(active.reduce((n, j) => n + (Number(e[j.id]?.profit) || 0), 0));
      return { slug: bb.slug, paidProfit, predictedProfit };
    }));

    // Per-business AVG TICKET over the LAST 7 DAYS (parallel across businesses).
    // Average ticket = total of real completed tickets ÷ number of them. Blank /
    // free / $0 tickets are excluded from BOTH the total and the count (they're
    // not real tickets), and days with no jobs simply don't contribute — so a
    // light day never drags the number down. Rolling window = today + prior 6 days.
    const d7Start = localDayStartUTC(tz, -6);
    const d7End = localDayStartUTC(tz, 1);
    const avgBySlugP = Promise.all((allBiz || []).map(async (bb) => {
      const { data: rows } = await db.from('bookings').select('price')
        .eq('business_id', bb.id)
        .gte('scheduled_at', d7Start.toISOString())
        .lt('scheduled_at', d7End.toISOString())
        .eq('status', 'completed');
      const real = (rows || []).filter(x => Number(x.price) > 0);   // drop $0 / free / blank tickets
      const count = real.length;
      const total = Math.round(real.reduce((n, x) => n + Number(x.price || 0), 0) * 100) / 100;
      const avg = count ? Math.round(total / count) : null;
      return [bb.slug, { avg, count, total }];
    }));

    // Net daily profit for a day offset (0 = today, -1 = yesterday), summed across
    // ALL active businesses (each in its OWN local day), parallel across businesses.
    // Returns BOTH the combined total (net daily profit, both companies) AND the
    // per-business breakdown (today_by_slug / yesterday_by_slug) — one pass of
    // queries serves both, so the per-business split costs nothing extra.
    const netDailyFor = async (offset) => {
      const parts = await Promise.all((allBiz || []).map(async (bb) => {
        let rows;
        if (offset === 0 && bb.id === biz.id) {
          rows = today;   // reuse this business's already-fetched today rows
        } else if (offset === -1 && bb.id === biz.id) {
          rows = yRows;   // reuse this business's already-fetched yesterday rows
        } else {
          const btz = bb.timezone || 'America/Denver';
          const d0 = localDayStartUTC(btz, offset), d1 = localDayStartUTC(btz, offset + 1);
          ({ data: rows } = await fetchEconomicsRows(sel => db.from('bookings').select(sel)
            .eq('business_id', bb.id)
            .gte('scheduled_at', d0.toISOString())
            .lt('scheduled_at', d1.toISOString())));
        }
        const paidDone = (rows || []).filter(x => x.status === 'completed' && x.payment_status === 'paid');
        if (!paidDone.length) return [bb.slug, 0];
        const e = await computeJobEconomics(db, bb, paidDone, true, await travelMapFor(bb));
        return [bb.slug, Math.round(paidDone.reduce((n, j) => n + (Number(e[j.id]?.profit) || 0), 0))];
      }));
      const bySlug = Object.fromEntries(parts);
      const total = Math.round(parts.reduce((a, [, v]) => a + v, 0));
      return { total, bySlug };
    };

    // Predicted income ("active jobs, as if every one gets paid") is now just
    // the other half of weekEconBySlugP above — see its comment.

    // Realized profit for the week BEFORE the viewed one — same "completed AND
    // paid" definition as pWeek, just shifted back 7 days — so the greeting can
    // show a week-over-week % change. Summed across ALL businesses like pWeek.
    // For the CURRENT week (the only case the greeting actually shows), this
    // week is necessarily partial — it's only Wednesday, say — so comparing it
    // against ALL of last week is comparing a partial week to a full one (a
    // normal Wednesday reads as "down 87%" for no real reason). Last week's
    // window is capped to the SAME elapsed time into the week, so the
    // comparison is apples-to-apples. A fully-elapsed past week being viewed
    // (via the schedule's week navigator) still compares full week to full week.
    const now = new Date();
    const isCurrentWeek = now >= weekStart && now < weekEnd;
    const lastWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekEnd = isCurrentWeek ? new Date(lastWeekStart.getTime() + (now.getTime() - weekStart.getTime())) : weekStart;
    const lastWeekProfitP = Promise.all((allBiz || []).map(async (bb) => {
      const { data: rows } = await fetchEconomicsRows(sel => db.from('bookings').select(sel)
        .eq('business_id', bb.id)
        .gte('scheduled_at', lastWeekStart.toISOString())
        .lt('scheduled_at', lastWeekEnd.toISOString()));
      const paid = earned(rows);
      if (!paid.length) return 0;
      const e = await computeJobEconomics(db, bb, paid, true, await travelMapFor(bb));
      return paid.reduce((n, j) => n + (Number(e[j.id]?.profit) || 0), 0);
    })).then(parts => parts.reduce((a, b) => a + b, 0));

    // All of the above are independent — resolve them concurrently.
    // "today"/"yesterday" and net_daily/net_daily_yesterday are the SAME metric
    // (realized profit for that day) — netDailyFor already computes it correctly
    // across both businesses (and reuses the already-fetched today/yRows rows for
    // this one), so today/yesterday are just its totals, not a separate query.
    const [weekEconBySlug, avgBySlug, netToday, netYesterday, pWeekLast] = await Promise.all([
      weekEconBySlugP,
      avgBySlugP,
      netDailyFor(0),
      netDailyFor(-1),
      lastWeekProfitP,
    ]);
    // Split the combined per-business pass back into the two [slug, value] pair
    // arrays the rest of this function (and profit's shape below) already expects.
    const weekBySlug = weekEconBySlug.map(x => [x.slug, x.paidProfit]);
    const predictedBySlug = weekEconBySlug.map(x => [x.slug, x.predictedProfit]);
    const pWeek = weekEconBySlug.find(x => x.slug === biz.slug)?.paidProfit || 0;

    const weekLastRounded = Math.round(pWeekLast);
    // The dashboard's "This week" Profit figure is BOTH businesses combined
    // (week_by_slug summed) — `pWeek` above is scoped to just the CURRENTLY
    // VIEWED business, which is a different, smaller number. The trend must
    // compare the same combined total the Profit box actually displays, or the
    // greeting and the Profit box show two different "this week" figures.
    const weekTotalCombined = Math.round(weekBySlug.reduce((n, [, v]) => n + v, 0));
    profit = {
      week: Math.round(pWeek),
      week_total: weekTotalCombined,
      today: netToday.total,
      yesterday: netYesterday.total,
      week_predicted: Math.round(predictedBySlug.reduce((n, [, v]) => n + v, 0)),
      week_by_slug: Object.fromEntries(weekBySlug),
      avg_by_slug: Object.fromEntries(avgBySlug),
      net_daily: netToday.total,
      net_daily_yesterday: netYesterday.total,
      today_by_slug: netToday.bySlug,
      yesterday_by_slug: netYesterday.bySlug,
      week_predicted_by_slug: Object.fromEntries(predictedBySlug),
      // Week-over-week realized-profit trend for the greeting sentence, both
      // sides combined across businesses. null when last week had no realized
      // profit at all — a % change off zero is meaningless.
      week_last: weekLastRounded,
      week_change_pct: weekLastRounded > 0 ? Math.round(((weekTotalCombined - weekLastRounded) / weekLastRounded) * 1000) / 10 : null,
    };

    // Income history for the dashboard's "Income" box (owner-only, hand-entered
    // via the payroll page's Actual Profit tracker). Only weeks with all three
    // fields filled in have a real total_made; last 24 for a readable chart.
    {
      const { data: apRows } = await db.from('actual_profit_weekly')
        .select('pay_date, doms_stripe_payout, handy_andy_stripe_payout, tech_pay')
        .not('doms_stripe_payout', 'is', null)
        .not('handy_andy_stripe_payout', 'is', null)
        .not('tech_pay', 'is', null)
        .order('pay_date', { ascending: false })
        .limit(24);
      profit.income_history = (apRows || []).map(r => ({
        pay_date: r.pay_date,
        total_made: Math.round((Number(r.doms_stripe_payout) + Number(r.handy_andy_stripe_payout) - Number(r.tech_pay)) * 100) / 100,
      })).reverse();
    }

    // Per-business JOB REVENUE for the Sunday–Saturday work week — the SAME week
    // window as Profit this week / Predicted income (weekStart/weekEnd above), per
    // owner's rule (previously this ran its own Sat→Fri window; now unified across
    // all three cards). Revenue counts ONLY jobs that have actually been
    // COMPLETED — upcoming/pending/assigned jobs are not revenue yet. Sums each
    // COMPLETED job's price per business over that 7-day window and reports both
    // companies side by side. Not tied to any Stripe account.
    // Default to a defined zero so a transient failure below shows $0 rather than
    // silently falling back (client-side) to a stale figure.
    revenue.week_by_slug = null;
    revenue.week_total = 0;
    try {
      const revBySlug = await Promise.all((allBiz || []).map(async (bb) => {
        const { data: rows } = await db.from('bookings').select('price, status')
          .eq('business_id', bb.id)
          .gte('scheduled_at', weekStart.toISOString())
          .lt('scheduled_at', weekEnd.toISOString())
          .eq('status', 'completed');
        const total = Math.round((rows || []).reduce((n, r) => n + Number(r.price || 0), 0) * 100) / 100;
        return [bb.slug, total];
      }));
      const bySlug = Object.fromEntries(revBySlug);
      const fmtMD = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
      const lastDay = new Date(weekEnd.getTime() - 24 * 60 * 60 * 1000);
      revenue.week_by_slug = bySlug;
      revenue.week_total = Math.round(Object.values(bySlug).reduce((a, b) => a + b, 0) * 100) / 100;
      revenue.week_range_label = `${fmtMD(weekStart)} – ${fmtMD(lastDay)}`;
    } catch (e) { console.warn('[admin] weekly revenue-by-business failed:', e.message); }
  }

  // Photos "To Post" + address alerts are independent — fetch them concurrently.
  const [photosToPost, address_alerts, estimate_alerts] = await Promise.all([
    // Photos flagged "To Post" (the social-media queue) for this business. Safe
    // even before the 0043 migration — the status column exists (0026); 'to_post'
    // simply yields 0 until photos are categorized. Never let a photo-count hiccup
    // break the whole dashboard summary.
    (async () => {
      try {
        const { count, error } = await db.from('booking_photos')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id).eq('status', 'to_post');
        return error ? 0 : (count || 0);
      } catch { return 0; }
    })(),
    // ── Critical alerts: upcoming, not-yet-completed jobs with NO usable street
    // address (missing, or an email/phone typed into the address box). The tech
    // can't find the house, so the office must call the customer. Auto-clears once
    // the job is completed (excluded below) or the address is fixed.
    (async () => {
      const ALERT_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress'];
      const out = [];
      try {
        const { data: aRows } = await db.from('bookings')
          .select('id, scheduled_at, address_line1, service_area_id, customer:customers ( name, phone )')
          .eq('business_id', biz.id)
          .gte('scheduled_at', localDayStartUTC(tz, 0).toISOString())
          .in('status', ALERT_STATUSES)
          .order('scheduled_at', { ascending: true }).limit(300);
        // Resolve each DISTINCT service-area timezone once (was a query per row).
        const tzCache = new Map();
        const tzFor = async (id) => { const k = String(id || ''); if (tzCache.has(k)) return tzCache.get(k); const v = await areaTimezone(db, id, tz); tzCache.set(k, v); return v; };
        for (const b of (aRows || [])) {
          if (isLikelyStreetAddress(b.address_line1)) continue;
          const atz = await tzFor(b.service_area_id);
          const d = new Date(b.scheduled_at);
          const day = new Intl.DateTimeFormat('en-US', { timeZone: atz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
          const time = slotTimeLabel(atz, b.scheduled_at) || new Intl.DateTimeFormat('en-US', { timeZone: atz, hour: 'numeric', minute: '2-digit' }).format(d);
          out.push({ id: b.id, name: b.customer?.name || 'Customer', phone: b.customer?.phone || null, when: `${day}, ${time}` });
        }
      } catch (e) { console.warn('[admin] address alerts failed:', e.message); }
      return out;
    })(),
    // ── Approved estimates still waiting to be booked. An estimate the customer
    // has APPROVED (status 'scheduled') but that hasn't been turned into a job yet
    // is a hot, ready-to-book lead — flag it so the office books it ASAP. Auto-
    // clears the moment it's converted (converting archives it) or otherwise leaves
    // the approved state. Ones missing an address on file are called out specially.
    (async () => {
      const out = [];
      try {
        // Show the "book ASAP" alert ONLY for estimates explicitly flagged for it
        // (book_alert = true) and not yet archived — controllable per estimate via
        // a data flag rather than firing on every approved one, and with no name
        // hardcoded. Degrades to no alerts until the book_alert column exists.
        const { data: eRows, error } = await db.from('estimates')
          .select('id, customer_name, customer_phone, customer_zip, created_at')
          .eq('business_id', biz.id).eq('book_alert', true).neq('status', 'archived')
          .order('created_at', { ascending: false }).limit(50);
        if (error) { if (/book_alert/.test(error.message || '')) return []; throw error; }
        // One alert per person: dedupe on name + phone so a duplicate estimate
        // (e.g. "Anne Fowler" and "anne fowler") doesn't show the banner twice.
        const seen = new Set();
        for (const e of (eRows || [])) {
          const key = `${String(e.customer_name || '').trim().toLowerCase()}|${String(e.customer_phone || '').replace(/\D/g, '')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            id: e.id,
            name: e.customer_name || 'Customer',
            phone: e.customer_phone || null,
            no_address: !(e.customer_zip && String(e.customer_zip).trim()),
          });
        }
      } catch (err) { console.warn('[admin] estimate alerts failed:', err.message); }
      return out;
    })(),
  ]);

  return res.status(200).json({
    business: { id: biz.id, slug: biz.slug, name: biz.name, timezone: tz },
    today: (today || []).map(shapeBooking),
    address_alerts,
    estimate_alerts,
    revenue,
    profit,
    technicians: techs || [],
    counts: {
      todayTotal: (today || []).length,
      unassigned: (today || []).filter(b => !b.technician_id && b.status !== 'cancelled').length,
      photos_to_post: photosToPost,
    },
  });
}

// ── Calendar (week/day grid) ─────────────────────────────────────────────────
// Bookings within an explicit [from, to) window, plus the technicians and
// service areas the sidebar needs to render filters and avatars — one call
// bootstraps the whole calendar view.
// Cheap "has this booking range changed" fingerprint — count + the most
// recent updated_at — shared by calendar() (which already has full rows in
// hand) and calendarProbe() (which fetches only these two columns for exactly
// this purpose). bookings.updated_at is DB-trigger-maintained (BEFORE UPDATE,
// every column, every write) so this is trustworthy for detecting a status
// change, reschedule, assignment, price edit, etc. — anything that touches
// the row. Known gap: a technician's color/active flag can change with no
// bookings row touched, so this alone won't catch that — acceptable for a
// polling optimization since it self-heals on the next real fetch (tab
// switch, reload, or any actual booking change in the meantime).
function calFingerprint(rows) {
  let maxUpdatedAt = '';
  for (const r of rows) { if (r.updated_at && r.updated_at > maxUpdatedAt) maxUpdatedAt = r.updated_at; }
  return { count: rows.length, maxUpdatedAt };
}
async function calendar(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const from = (req.query.from || '').toString();
  const to = (req.query.to || '').toString();
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const { data: bk, error } = await fetchBookingRows(sel => db.from('bookings').select(sel)
    .eq('business_id', biz.id)
    .gte('scheduled_at', from).lt('scheduled_at', to)
    .order('scheduled_at', { ascending: true }).limit(2000));
  if (error) throw error;

  const { data: techs } = await db.from('technicians')
    .select('id, name, status, color, active, service_area_id, business_id').eq('business_id', biz.id).eq('active', true).order('name');
  const { data: areas } = await db.from('service_areas')
    .select('id, name, state, timezone').eq('business_id', biz.id).eq('active', true).order('name');

  // Ghost bookings: a shared tech (matched by name, since each business keeps
  // its own `technicians` row) can be booked on a partner-company job at the
  // same time — Heather has no visibility into that from this business's own
  // schedule. Surface it as a separate read-only list, never merged into
  // `bookings`, so it can never be double-counted in payroll or job counts.
  let ghostBookings = [];
  try {
    const partner = await partnerBusiness(db, biz.slug);
    if (partner && (techs || []).length) {
      const nameByLower = {};
      for (const t of techs) nameByLower[t.name.trim().toLowerCase()] = t;
      const { data: partnerTechs } = await db.from('technicians')
        .select('id, name').eq('business_id', partner.id).eq('active', true);
      const sharedPartnerIds = (partnerTechs || [])
        .filter(pt => nameByLower[pt.name.trim().toLowerCase()])
        .map(pt => pt.id);
      if (sharedPartnerIds.length) {
        const { data: pbk } = await db.from('bookings')
          .select('id, technician_id, scheduled_at, duration_minutes, status')
          .eq('business_id', partner.id)
          .in('technician_id', sharedPartnerIds)
          .not('status', 'in', '("cancelled","no_show")')
          .gte('scheduled_at', from).lt('scheduled_at', to)
          .limit(2000);
        const partnerTechName = {};
        for (const pt of partnerTechs) partnerTechName[pt.id] = pt.name;
        ghostBookings = (pbk || []).map(b => ({
          technician_id: nameByLower[partnerTechName[b.technician_id].trim().toLowerCase()].id,
          scheduled_at: b.scheduled_at,
          duration_minutes: b.duration_minutes || 60,
          partner_company: partner.name,
        }));
      }
    }
  } catch (e) { console.warn('[admin] calendar ghost bookings failed:', e.message); ghostBookings = []; }
  // Metro tz per area, so each job's slot renders in its own timezone (Central
  // for Houston/Austin) instead of the single business (Mountain) clock.
  const areaTzById = {};
  for (const a of (areas || [])) areaTzById[a.id] = a.timezone;

  // Job economics for the List view. Everyone (owner + secretary) gets the
  // service category, cost to customer, and paid status. Tech payout and profit
  // are PRIVATE to the owner — the payroll projection only runs when
  // auth.role==='owner', so those numbers are never even sent to a secretary.
  let econById = {};
  try { econById = await computeJobEconomics(db, biz, bk || [], auth.role === 'owner'); }
  catch (e) { console.warn('[admin] calendar economics failed:', e.message); econById = {}; }

  const bookings = (bk || []).map(b => {
    const s = shapeBooking(b);
    if (econById[b.id]) s.econ = econById[b.id];
    s.slot_time = slotTimeLabel(areaTzById[b.service_area_id] || biz.timezone || 'America/Denver', b.scheduled_at);
    return s;
  });

  return res.status(200).json({
    business: { id: biz.id, slug: biz.slug, name: biz.name, timezone: biz.timezone || 'America/Denver' },
    bookings,
    technicians: techs || [],
    areas: areas || [],
    ghost_bookings: ghostBookings,
    fingerprint: calFingerprint(bk || []),
  });
}
// Lightweight sibling of calendar(): no embeds, no per-job economics — just
// enough to detect whether anything in this range changed since the last full
// fetch, so the 60s schedule poll can skip re-fetching+re-computing the whole
// week when nothing did. See calFingerprint() for what this can and can't detect.
async function calendarProbe(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const from = (req.query.from || '').toString();
  const to = (req.query.to || '').toString();
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const { data: rows, error } = await db.from('bookings')
    .select('updated_at')
    .eq('business_id', biz.id)
    .gte('scheduled_at', from).lt('scheduled_at', to)
    .limit(2000);
  if (error) throw error;

  return res.status(200).json(calFingerprint(rows || []));
}

// Owner-only: collapse a service into exactly one of the three buckets the
// office cares about — "TV Mounting", "Handyman", or "Assurion".
function classifyService(b) {
  if (/assurion/i.test(String(b.notes || '')) || /assurion/i.test(String(b.service?.name || ''))) return 'Assurion';
  const svc = String(b.service?.name || '').toLowerCase();
  const names = (b.line_items || []).map(li => String(li.name || '').toLowerCase());
  if (/handyman/.test(svc) || names.some(n => /handyman/.test(n))) return 'Handyman';
  return 'TV Mounting';
}

// Per-booking economics for the List view. Always returns { service_cat,
// customer_cost }. When includePay is true (owner only) it also returns the
// projected { tech_payout, profit, assigned } — tech_payout is the total paid to
// every tech on the job (primary + any second tech) and profit = cost − payout.
// Projection forces completed+paid so an upcoming job still shows what it's
// expected to earn. When includePay is false (secretary) the payroll engine is
// never run, so those private numbers don't leave the server.
// What the business pays to BUY each bracket (hardware cost), deducted from
// profit. Juan buys his own brackets and is reimbursed through his payout, so for
// a Juan job the hardware cost is already counted there — don't double-deduct.
// Customer-supplied / in-the-box brackets cost the business nothing.
const BRACKET_HW_COST = [
  { test: /full\s*motion/i, cost: 60 },
  { test: /tilting/i,       cost: 28 },
  { test: /\bflat\b/i,      cost: 20 },
];
function bracketHardwareCost(lineItems, hasJuan) {
  if (hasJuan) return 0;
  let total = 0;
  for (const li of lineItems || []) {
    const n = String(li.name || '');
    if (/own bracket|in the box|customer supplied/i.test(n)) continue;
    const hit = BRACKET_HW_COST.find(b => b.test.test(n));
    if (hit) total += hit.cost * (Number(li.quantity) || 1);
  }
  return total;
}

async function computeJobEconomics(db, biz, rows, includePay, travelMap = null) {
  // Callers that compute economics for many row sets of the SAME business pass a
  // pre-fetched travel-payout map so we don't re-query it every time.
  const travelPayoutByZip = includePay ? (travelMap || await travelPayoutMap(db, biz.id)) : null;
  const out = {};
  for (const b of rows) {
    const cost = Number(b.price) || 0;
    const econ = { service_cat: classifyService(b), customer_cost: cost };
    if (includePay) {
      const techNames = [];
      if (b.technician?.name) techNames.push(b.technician.name);
      if (b.secondary_technician?.name) techNames.push(b.secondary_technician.name);
      const projJob = {
        status: 'completed',
        payment_status: 'paid',
        price: b.price,
        subtotal: b.subtotal,
        notes: b.notes,
        customer_notes: b.customer_notes,
        zenbooker_job_number: b.zenbooker_job_number,
        service_name: b.service?.name || '',
        business_slug: biz.slug,
        line_items: b.line_items || [],
        travel_payout: travelPayoutByZip.get(String(b.postal_code || '')) || 0,
        // Two assigned techs split the job 50/50 even without a "lift help" line.
        second_tech: techNames.length > 1,
      };
      let payout = 0;
      // techNames[0] is the lead, [1] the secondary. Tell the engine which one is
      // the helper (is_secondary) so a two-tech job isn't DOUBLE-paid: the base
      // splits 50/50 on a real two-person job, or the assigned helper earns $0 on a
      // one-person job — matching what the tech app / payroll actually pay. Without
      // this, both techs were computed as full-pay leads, so profit read far too low.
      for (let i = 0; i < techNames.length; i++) {
        payout += Number(computeJobPay({ ...projJob, is_secondary: i > 0 }, techNames[i]).pay) || 0;
      }
      // Bracket hardware the business bought (skipped when Juan supplies his own).
      const bracketCost = bracketHardwareCost(b.line_items, techNames.some(isJuan));
      // Tips are 100% the tech's and pass straight through (customer -> tech), so
      // they RAISE the tech's payout but never touch business profit — profit is
      // computed from the service price and base pay only, with the tip excluded
      // on both sides.
      const tip = Number(b.tip) || 0;
      econ.tech_payout = Math.round(payout + tip);
      econ.bracket_cost = Math.round(bracketCost);
      econ.profit = Math.round(cost - payout - bracketCost);
      econ.assigned = techNames.length > 0;
    }
    out[b.id] = econ;
  }
  return out;
}

// All techs' weekly availability + upcoming exceptions for one business, so the
// calendar's "Availability" view can show who's free per day/slot.
async function availabilityOverview(req, res, db, auth) {
  // Cross-business by design: any signed-in office user can VIEW another
  // business's availability (who's free per slot) to coordinate coverage — the
  // same non-sensitive occupancy data already exposed when assigning a
  // cross-company second tech. No pay or customer data is returned here.
  // (Mirrors reviewCalls, which spans both businesses regardless of scope.) The
  // secretary's own business is the default; the toggle just switches the view.
  const slug = (req.query.business || '').toString();
  if (!slug) return res.status(400).json({ error: 'business is required' });
  const { data: allBiz } = await db.from('businesses')
    .select('id, slug, name, timezone').eq('active', true).order('name');
  const biz = (allBiz || []).find(b => b.slug === slug);
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  const bizList = (allBiz || []).map(b => ({ slug: b.slug, name: b.name }));
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
    // No business filter: a tech busy on a CROSS-COMPANY job (booked by the
    // partner company) must still show as occupied here, so the office never
    // double-books them. (technician_id is globally unique.) A tech counts as
    // busy whether they're the PRIMARY or the SECOND tech on the job — without the
    // secondary_technician_id leg, a tech booked only as a helper would wrongly
    // show free here (the bug that let the same helper be stacked onto two jobs).
    const idList = ids.join(',');
    const runBk = (withSecond) => {
      let q = db.from('bookings')
        .select((withSecond ? 'technician_id, secondary_technician_id, scheduled_at' : 'technician_id, scheduled_at') + esCol())
        .neq('status', 'cancelled').not('scheduled_at', 'is', null)
        .order('scheduled_at', { ascending: true }).limit(2000);
      return withSecond
        ? q.or(`technician_id.in.(${idList}),secondary_technician_id.in.(${idList})`)
        : q.in('technician_id', ids);
    };
    let { data: bk, error: bkErr } = await runBk(bookingLiftCols);
    if (bkErr && (/secondary_technician_id/.test(bkErr.message || '') || isExtraSlotsErr(bkErr))) {
      if (/secondary_technician_id/.test(bkErr.message || '')) bookingLiftCols = false;
      if (isExtraSlotsErr(bkErr)) extraSlotsCol = false;
      ({ data: bk } = await runBk(bookingLiftCols));
    }
    const idSet = new Set(ids);
    const occRows = [];
    for (const b of (bk || [])) {
      const slot_key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
      if (!slot_key) continue;
      const date = localDateStr(tz, b.scheduled_at);
      // Each slot the job holds (main + any extra) is a busy row for its tech(s).
      const keys = [slot_key, ...esOf(b)];
      for (const k of keys) {
        if (idSet.has(b.technician_id)) occRows.push({ technician_id: b.technician_id, date, slot_key: k });
        if (b.secondary_technician_id && idSet.has(b.secondary_technician_id))
          occRows.push({ technician_id: b.secondary_technician_id, date, slot_key: k });
      }
    }
    bookings = occRows;
  }
  return res.status(200).json({ slots: SLOTS, days: DAYS, technicians: techs || [], availability, exceptions, bookings, businesses: bizList, business: { slug: biz.slug, name: biz.name } });
}

// ── Bookings list ────────────────────────────────────────────────────────────
async function bookings(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const tz = biz.timezone || 'America/Denver';
  const range = (req.query.range || 'upcoming').toString();
  const status = (req.query.status || '').toString();

  // Single-booking lookup (e.g. opening a job from a bad-review alert). Still
  // scoped to the resolved business, so a secretary can't read another's job.
  const oneId = (req.query.id || '').toString();
  if (oneId) {
    const { data, error } = await fetchBookingRows((sel) =>
      db.from('bookings').select(sel).eq('business_id', biz.id).eq('id', oneId).limit(1));
    if (error) throw error;
    return res.status(200).json({ bookings: (data || []).map(shapeBooking) });
  }

  const makeQ = (sel) => {
    let q = db.from('bookings').select(sel).eq('business_id', biz.id);
    if (range === 'today') {
      q = q.gte('scheduled_at', localDayStartUTC(tz, 0).toISOString())
           .lt('scheduled_at', localDayStartUTC(tz, 1).toISOString());
    } else if (range === 'week') {
      q = q.gte('scheduled_at', startOfWeekUTC(tz).toISOString());
    } else if (range === 'upcoming') {
      q = q.gte('scheduled_at', localDayStartUTC(tz, 0).toISOString());
    } // 'all' = no date filter
    if (status) q = q.eq('status', status);
    return q.order('scheduled_at', { ascending: true }).limit(500);
  };

  const { data, error } = await fetchBookingRows(makeQ);
  if (error) throw error;
  return res.status(200).json({ bookings: (data || []).map(shapeBooking) });
}

// ── Extra time slots on a booking (big jobs) ─────────────────────────────────
// GET  -> { main_slot, extra_slots, addable:[{slot_key,label}], date }
// POST { slots:[...] } -> validate each is free for the job's tech(s) that day
//        (not the main slot, not booked by another job) and set extra_slots.
// The occupancy readers (office availability, the widget, auto-assign, the grid)
// all treat extra_slots as busy, so this reserves the slot without a phantom row.
async function bookingSlots(req, res, db, auth, body) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business || (body && body.business)); } catch (e) { return bail(res, e); }
  const id = (req.query.id || (body && body.id) || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  const { data: b, error } = await db.from('bookings')
    .select(`id, scheduled_at, technician_id, secondary_technician_id, service_area_id, status${esCol()}`)
    .eq('business_id', biz.id).eq('id', id).maybeSingle();
  if (error && isExtraSlotsErr(error)) { extraSlotsCol = false; return res.status(400).json({ error: 'Extra time slots need migration 0052 applied first.' }); }
  if (error) throw error;
  if (!b) return res.status(404).json({ error: 'Job not found' });
  if (!b.scheduled_at) return res.status(400).json({ error: 'Give this job a date and time first, then add extra slots.' });

  const tz = await areaTimezone(db, b.service_area_id, biz.timezone || 'America/Denver');
  const dateStr = localDateStr(tz, b.scheduled_at);
  const mainSlot = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
  const current = esOf(b);

  // Slots already taken by OTHER bookings for either tech on this date (this job excluded).
  const techIds = [b.technician_id, b.secondary_technician_id].filter(Boolean);
  const takenByOthers = new Set();
  for (const tid of techIds) {
    const s = await bookedSlotKeysForTech(db, biz.id, tid, dateStr, tz, id);
    for (const k of s) takenByOthers.add(k);
  }

  if (req.method !== 'POST') {
    const addable = SLOTS
      .filter(s => s.key !== mainSlot && !current.includes(s.key) && !takenByOthers.has(s.key))
      .map(s => ({ slot_key: s.key, label: s.label }));
    return res.status(200).json({
      id, date: dateStr, main_slot: mainSlot, extra_slots: current,
      slots: SLOTS.map(s => ({ slot_key: s.key, label: s.label })),
      addable,
    });
  }

  if (!extraSlotsCol) return res.status(400).json({ error: 'Extra time slots need migration 0052 applied first.' });
  const requested = Array.isArray(body && body.slots) ? body.slots.map(String) : [];
  const clean = [];
  for (const sk of requested) {
    if (!SLOT_KEYS.has(sk)) return res.status(400).json({ error: `Invalid time slot: ${sk}` });
    if (sk === mainSlot) continue;                       // the main slot is implied, never an extra
    if (takenByOthers.has(sk)) {
      const lab = (SLOTS.find(s => s.key === sk) || {}).label || sk;
      return res.status(409).json({ error: `${lab} is already booked for this technician — can't add it.` });
    }
    if (!clean.includes(sk)) clean.push(sk);
  }
  const { error: uErr } = await db.from('bookings').update({ extra_slots: clean }).eq('id', id).eq('business_id', biz.id);
  if (uErr) throw uErr;
  return res.status(200).json({ ok: true, id, extra_slots: clean });
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
    { label: '70"–85"',     price: 149, zbk: '1685657519214x168809705059288930', sort: 4 },
    { label: '86"–97"',     price: 179, zbk: '1693451324278x246099356920840200', sort: 5 },
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

// Normalize the three large TV size tiers to their canonical labels for
// whichever business is calling: 70–84 → 70–85", 85–97 → 86–97" (non-overlapping
// at 85), and "98 plus" → 98"+. Label-only, never inserts rows, so it's safe for
// any business regardless of its option set. Each rule fires only on the LEGACY
// form, so it's idempotent (the renamed labels no longer match). The admin New
// Booking flow calls this once when it detects a stale label, so the rename
// reaches the live DB on its own.
function targetSizeLabel(label) {
  const nums = (label.match(/\d+/g) || []).map(Number);
  if (nums.includes(70) && nums.includes(84)) return '70"–85"';   // 70–84 → 70–85
  if (nums.includes(85) && nums.includes(97)) return '86"–97"';   // 85–97 → 86–97
  if (/plus/i.test(label) && nums.includes(98)) return '98"+';    // "98 plus" → 98"+
  return null;                                                    // small tiers untouched
}
async function relabelTvSize(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data: svcs } = await db.from('services')
    .select('id, name, category').eq('business_id', biz.id);
  const tvSvcIds = (svcs || [])
    .filter(s => /tv/i.test(s.name || '') || /tv mounting/i.test(s.category || ''))
    .map(s => s.id);
  if (!tvSvcIds.length) return res.status(200).json({ ok: true, updated: 0 });
  const { data: groups } = await db.from('service_option_groups')
    .select('id').eq('business_id', biz.id).in('service_id', tvSvcIds).eq('key', 'size');
  const gids = (groups || []).map(g => g.id);
  if (!gids.length) return res.status(200).json({ ok: true, updated: 0 });
  const { data: opts } = await db.from('service_options')
    .select('id, label').eq('business_id', biz.id).in('group_id', gids);
  let updated = 0;
  for (const o of (opts || [])) {
    const t = targetSizeLabel(o.label);
    if (t && t !== o.label) {
      const { error } = await db.from('service_options').update({ label: t }).eq('id', o.id);
      if (!error) updated++;
    }
  }
  return res.status(200).json({ ok: true, updated });
}

// ── Available time slots for a date (filtered by technician if provided) ─────
async function availableSlots(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const dateStr = (req.query.date || '').toString();
  const techId = (req.query.technician_id || '').toString();
  const techId2 = (req.query.secondary_technician_id || '').toString();
  const postalCode = (req.query.postal_code || '').toString();
  if (!dateStr) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

  const dow = dayOfWeekFor(dateStr);
  // Slots + occupancy are computed in the customer's METRO timezone (from the
  // zip), so a Central booking's slots line up with how its jobs are stored —
  // not the single business (Mountain) clock.
  const bookingAreaId = await serviceAreaIdFromPostal(db, biz.id, postalCode);
  const tz = await areaTimezone(db, bookingAreaId, biz.timezone || 'America/Denver');
  // Each technician can come from a different company pool: pool drives the
  // primary, pool2 the second tech. 'partner' scans the OTHER company's roster.
  const ridPrimary = await rosterBizId(db, biz, (req.query.pool || '').toString());
  // Want a two-tech pair whenever a second tech is requested — unless it's the
  // SAME concrete person as the primary (not a real pair). Two "any" sides ARE
  // a pair: we look for two DISTINCT free techs below.
  const wantPair = !!techId2 && !(techId2 === techId && techId2 !== 'any');

  // For cross-company secondary tech selection, match techs to the customer's
  // service area (already resolved from the postal code above).
  const serviceAreaId = (wantPair && techId2 === 'any') ? bookingAreaId : null;

  let keys;
  if (!wantPair) {
    keys = await availableSlotKeys(db, ridPrimary, techId, dateStr, dow, tz);
  } else {
    // Two-technician job (e.g. a large-TV lift): only offer slots where a
    // DISTINCT pair is free — one tech from the primary side and a different
    // tech from the second side. Each side may be a concrete person OR "any" of
    // a (possibly different) company pool.
    const ridSecondary = await rosterBizId(db, biz, (req.query.pool2 || '').toString());
    const pMap = await freeSlotTechMap(db, ridPrimary, techId, dateStr, dow, tz);
    // Pass serviceAreaId + ineligible-secondary filter to the SECOND-tech side so
    // an "Any <company>" pick never offers a slot only Juan/Zach can cover.
    const sMap = await freeSlotTechMap(db, ridSecondary, techId2, dateStr, dow, tz, serviceAreaId, true);
    keys = new Set();
    for (const [k, P] of pMap) {
      const S = sMap.get(k);
      if (!S || !S.size) continue;
      // Both sides have someone free here; it's a valid pair unless that
      // "someone" is the exact same single person on both sides.
      if (new Set([...P, ...S]).size >= 2) keys.add(k);
    }
  }
  // Drop slots that have already started, but only for TODAY (in the same
  // metro tz everything else here is computed in) — a future date's slots are
  // never affected. Compared by START time, not end: once a slot's window has
  // begun, it's no longer a real "book this" option even if it technically
  // runs for another hour or two.
  const nowISO = new Date().toISOString();
  const isToday = dateStr === localDateStr(tz, nowISO);
  const nowHHMM = isToday ? localHHMM(tz, nowISO) : null;
  const available = SLOTS.filter(s => keys.has(s.key))
    .filter(s => !isToday || s.start > nowHHMM)
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
  // Match where the tech is the PRIMARY *or* the SECOND tech on a two-person job,
  // for ANY company (no business filter): a tech booked anywhere in this slot is
  // unavailable everywhere. This is what makes a cross-company booking remove the
  // slot on BOTH platforms. (technician_id is a globally-unique UUID, so this
  // never widens results for single-company jobs.) Checking secondary_technician_id
  // too means a tech booked as a HELPER is correctly seen as busy — without it a
  // second job could be stacked onto a tech who's already someone's second tech.
  const run = (withSecond) => {
    let q = db.from('bookings')
      .select(`id, scheduled_at${esCol()}`)
      .neq('status', 'cancelled')
      .not('scheduled_at', 'is', null)
      .gte('scheduled_at', dayStart.toISOString())
      .lt('scheduled_at', dayEnd.toISOString());
    q = withSecond
      ? q.or(`technician_id.eq.${techId},secondary_technician_id.eq.${techId}`)
      : q.eq('technician_id', techId);
    if (excludeId) q = q.neq('id', excludeId);
    return q;
  };
  // Drop the secondary leg on databases predating migration 0019 (column absent);
  // drop extra_slots on DBs predating migration 0052 — same graceful degrade.
  let { data, error } = await run(bookingLiftCols);
  if (error && (/secondary_technician_id/.test(error.message || '') || isExtraSlotsErr(error))) {
    if (/secondary_technician_id/.test(error.message || '')) bookingLiftCols = false;
    if (isExtraSlotsErr(error)) extraSlotsCol = false;
    ({ data, error } = await run(bookingLiftCols));
  }
  const taken = new Set();
  for (const b of (data || [])) {
    const key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    if (key) taken.add(key);
    for (const sk of esOf(b)) taken.add(sk);   // a big job's extra slots are busy too
  }
  return taken;
}

// Batched per-date availability for MANY techs at once: 3 queries TOTAL
// (recurring, exceptions, bookings) instead of 3 PER TECH. The old per-tech
// loop made every date click in New Booking's "Any Technician" flow cost
// ~0.5–2s of sequential round trips; this is the same math over the same
// rows, just fetched together. Returns Map(techId -> { keys, booked }) with
// identical semantics to singleTechSlotKeys + bookedSlotKeysForTech
// (cross-company booked check — no business filter — including jobs where
// the tech is the SECOND person, and extra_slots block their slots too).
async function batchTechSlotState(db, techIds, dateStr, dow, tz) {
  const out = new Map(); techIds.forEach(id => out.set(id, { keys: new Set(), booked: new Set() }));
  if (!techIds.length) return out;
  const [avR, excR] = await Promise.all([
    db.from('technician_availability').select('technician_id, slot_key').in('technician_id', techIds).eq('day_of_week', dow),
    db.from('technician_availability_exceptions').select('technician_id, slot_key, is_available').in('technician_id', techIds).eq('exception_date', dateStr),
  ]);
  for (const r of (avR.data || [])) { const s = out.get(r.technician_id); if (s) s.keys.add(r.slot_key); }
  for (const e of (excR.data || [])) { const s = out.get(e.technician_id); if (!s) continue; if (e.is_available) s.keys.add(e.slot_key); else s.keys.delete(e.slot_key); }
  const dayStart = localDateStartUTC(tz, dateStr).toISOString();
  const dayEnd = localDateStartUTC(tz, addDaysStr(dateStr, 1)).toISOString();
  const idList = techIds.join(',');
  const run = (withSecond) => {
    let q = db.from('bookings')
      .select(`id, technician_id${withSecond ? ', secondary_technician_id' : ''}, scheduled_at${esCol()}`)
      .neq('status', 'cancelled').not('scheduled_at', 'is', null)
      .gte('scheduled_at', dayStart).lt('scheduled_at', dayEnd);
    return withSecond
      ? q.or(`technician_id.in.(${idList}),secondary_technician_id.in.(${idList})`)
      : q.in('technician_id', techIds);
  };
  let { data, error } = await run(bookingLiftCols);
  if (error && (/secondary_technician_id/.test(error.message || '') || isExtraSlotsErr(error))) {
    if (/secondary_technician_id/.test(error.message || '')) bookingLiftCols = false;
    if (isExtraSlotsErr(error)) extraSlotsCol = false;
    ({ data, error } = await run(bookingLiftCols));
  }
  for (const b of (data || [])) {
    const key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    for (const tid of [b.technician_id, b.secondary_technician_id]) {
      const s = tid ? out.get(tid) : null; if (!s) continue;
      if (key) s.booked.add(key);
      for (const sk of esOf(b)) s.booked.add(sk);
    }
  }
  return out;
}

// Set of slot keys a tech (or ANY tech) is available for on an exact date,
// honouring recurring availability, one-time exceptions, AND existing bookings
// (a slot a tech is already booked for is no longer offered — no double-booking).
// excludeTechId drops one tech from the "ANY" union, so the SAME person can't be
// counted as both the primary and the second technician on a two-tech job.
async function availableSlotKeys(db, bizId, techId, dateStr, dow, tz, excludeTechId = null) {
  if (!techId || techId === 'any') {
    const { data: techs } = await db.from('technicians')
      .select('id').eq('business_id', bizId).eq('active', true);
    const ids = (techs || []).map(t => t.id).filter(id => !excludeTechId || id !== excludeTechId);
    const state = await batchTechSlotState(db, ids, dateStr, dow, tz);
    const union = new Set();
    for (const [, s] of state) s.keys.forEach(k => { if (!s.booked.has(k)) union.add(k); });
    return union;
  }
  const ks = await singleTechSlotKeys(db, techId, dateStr, dow);
  const booked = await bookedSlotKeysForTech(db, bizId, techId, dateStr, tz);
  booked.forEach(k => ks.delete(k));
  return ks;
}

// Map slot_key -> Set(techId) of techs FREE at that slot on a date, for a side
// that is either a concrete tech or "any" of a roster (recurring ± exceptions −
// existing bookings). Used to match a DISTINCT two-tech pair for big-TV jobs:
// the union of the two sides' free techs in a slot must be ≥ 2 distinct people.
async function freeSlotTechMap(db, bizId, techId, dateStr, dow, tz, serviceAreaId = null, excludeIneligibleSecondary = false) {
  let techIds;
  if (!techId || techId === 'any') {
    let query = db.from('technicians')
      .select('id, name').eq('business_id', bizId).eq('active', true);
    if (serviceAreaId) query = query.eq('service_area_id', serviceAreaId);
    const { data: techs } = await query;
    let pool = techs || [];
    if (excludeIneligibleSecondary) pool = pool.filter(t => !isSecondaryIneligibleName(t.name));
    techIds = pool.map(t => t.id);
  } else {
    techIds = [techId];
  }
  // Batched (3 queries total) — was 3 sequential queries PER TECH, the other
  // half of the every-date-click N+1 alongside availableSlotKeys.
  const state = await batchTechSlotState(db, techIds, dateStr, dow, tz);
  const map = new Map();
  for (const [tid, s] of state) {
    for (const k of s.keys) {
      if (s.booked.has(k)) continue;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(tid);
    }
  }
  return map;
}

// Pick the first active tech available for an exact date+slot (recurring OR a
// one-time exception) who is NOT already booked for that slot. Falls back to any
// active tech who is free in that slot so we never auto-create a double-booking.
// excludeTechId skips one tech (e.g. the primary, when auto-picking the second).
// serviceAreaId restricts to techs in a specific service area (for cross-company secondary tech selection).
// excludeIneligibleSecondary drops techs who can never be a second tech (Juan/Zach).
async function pickAvailableTech(db, bizId, dateStr, slotKey, tz, excludeTechId = null, serviceAreaId = null, excludeIneligibleSecondary = false) {
  let query = db.from('technicians')
    .select('id, name').eq('business_id', bizId).eq('active', true)
    .order('created_at', { ascending: true });
  if (serviceAreaId) query = query.eq('service_area_id', serviceAreaId);
  const { data: techs } = await query;
  let list = (techs || []).filter(t => !excludeTechId || t.id !== excludeTechId);
  if (excludeIneligibleSecondary) list = list.filter(t => !isSecondaryIneligibleName(t.name));
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

// Pick a SECONDARY tech who is genuinely SCHEDULED to work AND free in this exact
// slot, trying each roster scope in priority order (roster order = created_at
// ascending). Skips the primary and out-of-town primary-only techs (Juan/Zach).
// Unlike pickAvailableTech, it never falls back to a tech who isn't on the
// schedule that day — that's the whole point of the cross-company default: only
// assign someone who is actually working. Returns null if no scheduled tech is
// free in any scope (caller leaves the 2nd-tech slot blank for manual assignment).
async function pickScheduledSecondary(db, scopes, dateStr, slotKey, tz, excludeTechId = null) {
  if (!dateStr || !slotKey) return null;
  const dow = dayOfWeekFor(dateStr);
  for (const sc of scopes) {
    if (!sc || !sc.bizId) continue;
    let query = db.from('technicians').select('id, name')
      .eq('business_id', sc.bizId).eq('active', true)
      .order('created_at', { ascending: true });
    if (sc.serviceAreaId) query = query.eq('service_area_id', sc.serviceAreaId);
    const { data: techs } = await query;
    for (const t of (techs || [])) {
      if (excludeTechId && t.id === excludeTechId) continue;
      if (isSecondaryIneligibleName(t.name)) continue;
      const keys = await singleTechSlotKeys(db, t.id, dateStr, dow);
      if (!keys.has(slotKey)) continue;                          // not scheduled this slot
      const booked = await bookedSlotKeysForTech(db, sc.bizId, t.id, dateStr, tz);
      if (!booked.has(slotKey)) return t.id;                     // scheduled + free → take
    }
  }
  return null;
}

// Resolve the default SECONDARY tech for a job. For a Dom's job the default is the
// Handy Andy technician scheduled to work that day (same metro, roster order);
// if none is scheduled+free, fall back to any tech scheduled+free that day (e.g.
// the other Dom's tech). For a Handy Andy job, keep the existing pool-based pick.
async function resolveDefaultSecondary(db, biz, postalCode, dateStr, slotKey, tz, primaryTechId, pool2) {
  const partner = await partnerBusiness(db, biz.slug);
  if (biz.slug === 'doms' && partner) {
    const haArea  = await serviceAreaIdFromPostal(db, partner.id, postalCode);
    const ownArea = await serviceAreaIdFromPostal(db, biz.id, postalCode);
    return await pickScheduledSecondary(db, [
      { bizId: partner.id, serviceAreaId: haArea },   // Handy Andy first — the new default
      { bizId: biz.id,     serviceAreaId: ownArea },   // fallback: any available Dom's tech
    ], dateStr, slotKey, tz, primaryTechId);
  }
  const rid2 = await rosterBizId(db, biz, (pool2 || '').toString());
  const serviceAreaId = pool2 === 'partner' ? await serviceAreaIdFromPostal(db, biz.id, postalCode) : null;
  return await pickAvailableTech(db, rid2, dateStr, slotKey, tz, primaryTechId, serviceAreaId, true);
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
  const techId2 = (req.query.secondary_technician_id || '').toString();
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required (YYYY-MM)' });

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayStr = new Date().toISOString().split('T')[0];

  // Resolve each side (primary, optional second tech) to a concrete list of
  // technician ids to consider. Each side has its own company pool: pool drives
  // the primary, pool2 the second tech. A side that is "any" expands to that
  // pool's whole active roster.
  const rosterIds = async (rid) => {
    const { data } = await db.from('technicians').select('id').eq('business_id', rid).eq('active', true);
    return (data || []).map(t => t.id);
  };
  const primaryIds = (techId && techId !== 'any')
    ? [techId]
    : await rosterIds(await rosterBizId(db, biz, (req.query.pool || '').toString()));
  // Want a two-tech pair whenever a second tech is requested — unless it's the
  // SAME concrete person as the primary (not a real pair). Two "any" sides ARE
  // a pair: distinctness is enforced per-slot below, not by filtering rosters.
  const wantPair = !!techId2 && !(techId2 === techId && techId2 !== 'any');
  let secondaryIds = [];
  if (wantPair) {
    secondaryIds = (techId2 && techId2 !== 'any')
      ? [techId2]
      : await rosterIds(await rosterBizId(db, biz, (req.query.pool2 || '').toString()));
  }
  if (!primaryIds.length || (wantPair && !secondaryIds.length)) return res.status(200).json({ dates: [], month });
  const techIds = [...new Set([...primaryIds, ...secondaryIds])];

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
  // No business filter: a partner tech's jobs in their OWN company must also
  // count as busy, so cross-company bookings can't double-book them. Count a tech
  // as busy whether they're the PRIMARY or the SECOND tech — a date a tech is
  // only a helper on must not show as bookable (mirrors bookedSlotKeysForTech).
  const tidList = techIds.join(',');
  const runBk = (withSecond) => {
    let q = db.from('bookings')
      .select((withSecond ? 'technician_id, secondary_technician_id, scheduled_at' : 'technician_id, scheduled_at') + esCol())
      .neq('status', 'cancelled').not('scheduled_at', 'is', null)
      .gte('scheduled_at', winStart.toISOString()).lt('scheduled_at', winEnd.toISOString());
    return withSecond
      ? q.or(`technician_id.in.(${tidList}),secondary_technician_id.in.(${tidList})`)
      : q.in('technician_id', techIds);
  };
  let { data: bk, error: bkErr } = await runBk(bookingLiftCols);
  if (bkErr && (/secondary_technician_id/.test(bkErr.message || '') || isExtraSlotsErr(bkErr))) {
    if (/secondary_technician_id/.test(bkErr.message || '')) bookingLiftCols = false;
    if (isExtraSlotsErr(bkErr)) extraSlotsCol = false;
    ({ data: bk } = await runBk(bookingLiftCols));
  }
  const techIdSet = new Set(techIds);
  const occ = {};   // `${techId}:${date}` -> Set(slot_key)
  const addOcc = (tid, date, key) => { (occ[`${tid}:${date}`] = occ[`${tid}:${date}`] || new Set()).add(key); };
  for (const b of (bk || [])) {
    const date = localDateStr(tz, b.scheduled_at);
    const key = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    if (!key) continue;
    for (const k of [key, ...esOf(b)]) {   // main slot + any extra slots this job holds
      if (techIdSet.has(b.technician_id)) addOcc(b.technician_id, date, k);
      if (b.secondary_technician_id && techIdSet.has(b.secondary_technician_id)) addOcc(b.secondary_technician_id, date, k);
    }
  }

  // Compute one tech's free slot set for a given date (recurring ± exceptions − booked).
  const daySetFor = (tid, dow, dateStr) => {
    const set = new Set(recurring[`${tid}:${dow}`] || []);
    for (const e of (excByDate[dateStr] || [])) {
      if (e.technician_id !== tid) continue;
      if (e.is_available) set.add(e.slot_key); else set.delete(e.slot_key);
    }
    for (const k of (occ[`${tid}:${dateStr}`] || [])) set.delete(k);   // drop booked slots
    return set;
  };

  // Union of one side's free slots for a date (across that side's tech ids).
  const sideSet = (ids, dow, dateStr) => {
    const set = new Set();
    for (const tid of ids) for (const k of daySetFor(tid, dow, dateStr)) set.add(k);
    return set;
  };
  // Map slot_key -> Set(techId) free for a side on a date (for pair matching).
  const sideSlotTechs = (ids, dow, dateStr) => {
    const map = new Map();
    for (const tid of ids) for (const k of daySetFor(tid, dow, dateStr)) {
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(tid);
    }
    return map;
  };
  // Is there a slot where a primary tech AND a DISTINCT second tech are both
  // free? Both sides nonempty in a slot is a pair unless it's the same lone
  // person on both sides (union of the two free sets must be ≥ 2 people).
  const pairHasSlot = (pMap, sMap) => {
    for (const [k, P] of pMap) {
      const S = sMap.get(k);
      if (!S || !S.size) continue;
      if (new Set([...P, ...S]).size >= 2) return true;
    }
    return false;
  };
  const dates = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month}-${String(d).padStart(2, '0')}`;
    if (dateStr < todayStr) continue;                       // no past dates
    const dow = dayOfWeekFor(dateStr);
    if (wantPair) {
      if (pairHasSlot(sideSlotTechs(primaryIds, dow, dateStr), sideSlotTechs(secondaryIds, dow, dateStr))) dates.push(dateStr);
    } else if (sideSet(primaryIds, dow, dateStr).size) {
      dates.push(dateStr);
    }
  }
  return res.status(200).json({ dates, month });
}

// Attach a tokenized payment method to a Stripe customer (card on file).
// Returns { customerId, pmId } or null if Stripe isn't configured.
// `slug` selects the business's Stripe account (Doms has its own).
async function saveCardOnFile(pmId, cust, slug = null) {
  const SK = businessSecretKey(slug);
  if (!SK) return null;
  const sAuth = { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  // Each Stripe call is capped at 15s — these three run serially inside
  // booking_create's response path, so one stalled connection would otherwise
  // hang the office UI on "Processing…" with the booking already created.
  const fetchT = async (url, opts) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    catch (e) { throw e.name === 'AbortError' ? new Error('Stripe request timed out') : e; }
    finally { clearTimeout(timer); }
  };
  // Create a Stripe customer for the card.
  const cb = new URLSearchParams();
  if (cust.email) cb.set('email', cust.email);
  if (cust.name) cb.set('name', cust.name);
  if (cust.phone) cb.set('phone', cust.phone);
  cb.set('description', 'Dashboard booking customer');
  const ccr = await fetchT('https://api.stripe.com/v1/customers', { method: 'POST', headers: sAuth, body: cb });
  const cc = await ccr.json();
  if (!ccr.ok) throw new Error(cc?.error?.message || 'Stripe customer create failed');
  const customerId = cc.id;
  // Attach the payment method and make it the default.
  const ab = new URLSearchParams(); ab.set('customer', customerId);
  const ar = await fetchT(`https://api.stripe.com/v1/payment_methods/${pmId}/attach`, { method: 'POST', headers: sAuth, body: ab });
  const pm = await ar.json();
  if (!ar.ok) throw new Error(pm?.error?.message || 'Attach failed');
  const db = new URLSearchParams(); db.set('invoice_settings[default_payment_method]', pmId);
  await fetchT(`https://api.stripe.com/v1/customers/${customerId}`, { method: 'POST', headers: sAuth, body: db });
  return { customerId, pmId, brand: pm?.card?.brand || null, last4: pm?.card?.last4 || null };
}

// ── Create a manual / phone booking ──────────────────────────────────────────
async function bookingCreate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const c = body.customer || {};
  if (!c.name && !c.phone) return res.status(400).json({ error: 'Customer name or phone required' });
  console.log(`[admin] booking create: biz=${biz.slug} customer email=${c.email ? 'present' : 'ABSENT'} phone=${c.phone ? 'present' : 'absent'}`);

  // Idempotency: the dashboard sends one key per booking attempt. A double-submit
  // (double-click, or two concurrent requests) carries the SAME key. If a booking
  // with this key already exists, return it instead of creating a duplicate. This
  // is the first line of defense; a partial unique index (migration 0024) is the
  // real backstop for the concurrent race (handled at insert time below). The
  // select is best-effort: on a DB predating 0024 the column is absent and the
  // query errors — we ignore that and fall through to a normal create.
  const idempotencyKey = (body.idempotency_key || '').toString().trim() || null;
  if (idempotencyKey) {
    const { data: dupe } = await db.from('bookings')
      .select('id').eq('business_id', biz.id).eq('idempotency_key', idempotencyKey).maybeSingle();
    if (dupe?.id) return res.status(200).json({ id: dupe.id, duplicate: true });
  }

  // Reuse an existing customer (by phone, then email) or create one.
  let customer_id = c.id || null;
  let matchedExisting = !!c.id;
  if (!customer_id && c.phone) {
    const { data } = await db.from('customers').select('id').eq('business_id', biz.id).eq('phone', c.phone).maybeSingle();
    if (data?.id) { customer_id = data.id; matchedExisting = true; }
  }
  if (!customer_id && c.email) {
    const { data } = await db.from('customers').select('id').eq('business_id', biz.id).eq('email', c.email).maybeSingle();
    if (data?.id) { customer_id = data.id; matchedExisting = true; }
  }
  if (!customer_id) {
    const { data, error } = await db.from('customers').insert({
      business_id: biz.id, name: c.name || 'Customer', phone: c.phone || null, email: c.email || null,
      address_line1: c.address_line1 || null, city: c.city || null, state: c.state || null, postal_code: c.postal_code || null,
    }).select('id').single();
    if (error) throw error;
    customer_id = data.id;
  } else if (matchedExisting) {
    // Backfill/refresh contact details the form supplied so info added later
    // (e.g. an email captured on a repeat booking) actually lands on the record
    // instead of being silently dropped. Only non-empty fields are written.
    const patch = {};
    if (c.email) patch.email = c.email;
    if (c.name) patch.name = c.name;
    if (c.phone) patch.phone = c.phone;
    if (c.address_line1) patch.address_line1 = c.address_line1;
    if (c.city) patch.city = c.city;
    if (c.state) patch.state = c.state;
    if (c.postal_code) patch.postal_code = c.postal_code;
    if (Object.keys(patch).length) {
      const { error: upErr } = await db.from('customers').update(patch).eq('id', customer_id).eq('business_id', biz.id);
      if (upErr) console.warn('[admin] customer backfill failed:', upErr.message);
    }
  }

  // This booking's METRO timezone (Central for Houston/Austin), resolved from the
  // customer's zip → service area. ALL of this booking's time math is anchored
  // here — the slot's wall-clock time, availability picks, and the confirmation's
  // displayed time — never the single business tz, so a Central 8am slot is truly
  // stored and shown as 8am Central. Also stamps service_area_id on the booking.
  const bookingAreaId = await serviceAreaIdFromPostal(db, biz.id, c.postal_code);
  const tz = await areaTimezone(db, bookingAreaId, biz.timezone || 'America/Denver');

  // Convert scheduled_date + scheduled_slot to scheduled_at timestamp. The slot
  // start is a LOCAL wall-clock time in the metro timezone, so anchor it to local
  // midnight (as UTC) and add the slot offset — never store it as raw UTC.
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
  // pool='partner' books from the OTHER company's roster. A specific partner
  // tech UUID is used as-is (technician_id is globally unique); 'any' auto-picks
  // from whichever roster the pool points at.
  let technician_id = body.technician_id;
  let unassignedWarning = null;
  if (technician_id === 'any') {
    const rid = await rosterBizId(db, biz, (body.pool || '').toString());
    technician_id = await pickAvailableTech(db, rid, body.scheduled_date, body.scheduled_slot, tz);
    // The slot showed as available when the office picked it, but every tech
    // got booked in the meantime (a two-secretary race). The booking is still
    // created — losing the customer over a race would be worse — but it lands
    // UNASSIGNED, and silently: the office had no idea anyone still had to be
    // assigned. Surface it as a blocking warning on the response.
    if (!technician_id) {
      unassignedWarning = 'Heads up: no technician was still free for that slot, so this booking was created UNASSIGNED. Open the job and assign a tech (or move the time) — nobody is scheduled to show up yet.';
    }
  }

  // Does the primary tech bring their own second person (Juan/Zach + spouse)? If
  // so we never assign a roster second tech and a two-person job doesn't require
  // one. Resolve the primary's name to decide (covers a concrete pick AND an
  // "any" pick that happened to land on Juan/Zach).
  let primaryBringsOwnSecond = false;
  // Also carries photo_url/bio_years/bio_blurb for the confirmation email's
  // "Meet your tech" block further down — one query serves both purposes.
  let primaryTechInfo = null;
  if (technician_id) {
    const { data: pt } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
    primaryBringsOwnSecond = bringsOwnSecondTech(pt?.name);
    primaryTechInfo = pt || null;
  }

  // Secondary technician (for jobs requiring 2 techs, e.g. a large-TV lift). The
  // second tech may come from EITHER company (pool2) and may be "any", which we
  // auto-pick from that pool excluding the primary so it's never the same person.
  // For cross-company secondary tech selection, filter by the booking's service area.
  let secondary_technician_id = body.secondary_technician_id || null;
  if (primaryBringsOwnSecond) {
    // Juan/Zach bring their own helper (off-schedule) — never put a roster tech
    // in the secondary slot, even if the form sent one. The two-person fee still
    // applies (it rides on the line items, not on this field).
    secondary_technician_id = null;
  } else if (secondary_technician_id === 'any') {
    // Default the 2nd tech. For a Dom's job this prefers the Handy Andy tech
    // scheduled to work that day; otherwise the existing pool-based pick. Never
    // auto-picks Juan/Zach, and never picks a tech who isn't scheduled+free.
    secondary_technician_id = await resolveDefaultSecondary(
      db, biz, c.postal_code, body.scheduled_date, body.scheduled_slot, tz, technician_id, body.pool2);
  }
  // Backstop: a concrete second tech (or one that slipped through) must never be
  // an out-of-town, primary-only tech (Juan/Zach). Verify by name before saving.
  if (secondary_technician_id) {
    const { data: secTech } = await db.from('technicians').select('name').eq('id', secondary_technician_id).maybeSingle();
    if (secTech && isSecondaryIneligibleName(secTech.name)) {
      return res.status(400).json({ error: `${secTech.name} can't be booked as a second technician. Pick another second tech or another time.` });
    }
  }
  // A mandatory two-person job (large TV, customer can't help lift) must end up
  // with a concrete second technician, and the two must differ — UNLESS the
  // primary brings their own second person (Juan/Zach), who covers the job
  // without a roster second tech.
  if (body.needs_lifting && !secondary_technician_id && !primaryBringsOwnSecond) {
    return res.status(400).json({ error: 'This job requires a second technician, but no one from the chosen team is free for that time. Pick a specific second tech or another time.' });
  }
  if (secondary_technician_id && secondary_technician_id === technician_id) {
    return res.status(400).json({ error: 'The two technicians must be different.' });
  }

  // Guard against double-booking: if a specific tech ends up assigned to a slot
  // they already have a non-cancelled booking in, reject the create. This backs
  // up the UI (which no longer offers booked slots) against stale forms / races.
  if (scheduled_at) {
    const conflictDate = body.scheduled_date || localDateStr(tz, scheduled_at);
    const conflictSlot = body.scheduled_slot || slotKeyForLocalTime(localHHMM(tz, scheduled_at));
    if (conflictSlot) {
      if (technician_id) {
        const taken = await bookedSlotKeysForTech(db, biz.id, technician_id, conflictDate, tz);
        if (taken.has(conflictSlot)) {
          return res.status(409).json({ error: 'That technician is already booked for this time slot. Choose another time or technician.' });
        }
      }
      if (secondary_technician_id) {
        const taken2 = await bookedSlotKeysForTech(db, biz.id, secondary_technician_id, conflictDate, tz);
        if (taken2.has(conflictSlot)) {
          return res.status(409).json({ error: 'The second technician is already booked for this time slot. Choose another time or technician.' });
        }
      }
      // Guard against booking a tech during a time they've marked unavailable
      // (a requested day off, or just not on their recurring schedule). Picking
      // a CONCRETE tech from the dropdown used to skip this entirely — only the
      // 'any'-pick path (pickAvailableTech) ever consulted the exceptions table.
      // Soft block: office can override via force_unavailable if the tech agreed
      // to come in anyway despite the day off.
      if (!body.force_unavailable) {
        const dow = dayOfWeekFor(conflictDate);
        if (technician_id) {
          const keys = await singleTechSlotKeys(db, technician_id, conflictDate, dow);
          if (!keys.has(conflictSlot)) {
            const { data: t } = await db.from('technicians').select('name').eq('id', technician_id).maybeSingle();
            return res.status(409).json({ error: `${t?.name || 'This technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable' });
          }
        }
        if (secondary_technician_id) {
          const keys2 = await singleTechSlotKeys(db, secondary_technician_id, conflictDate, dow);
          if (!keys2.has(conflictSlot)) {
            const { data: t2 } = await db.from('technicians').select('name').eq('id', secondary_technician_id).maybeSingle();
            return res.status(409).json({ error: `${t2?.name || 'The second technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable' });
          }
        }
      }
    }
  }

  const paymentMethod = body.payment_method || null;        // card | cash | quote | null
  const status = technician_id ? 'assigned' : 'confirmed';

  // Duplicate backstop BEYOND the idempotency key: the dashboard mints a fresh
  // key per modal-open, so "request timed out → close modal → reopen → re-enter
  // the same job" carries a NEW key and the key dedupe can't catch it. The same
  // customer with a non-cancelled booking at the same exact date+slot is that
  // exact re-entry — refuse with the existing booking id instead of silently
  // double-booking (best-effort: any query error falls through to a normal create).
  if (customer_id && scheduled_at) {
    try {
      const { data: same } = await db.from('bookings').select('id, status')
        .eq('business_id', biz.id).eq('customer_id', customer_id).eq('scheduled_at', scheduled_at)
        .not('status', 'in', '(cancelled,no_show)').limit(1).maybeSingle();
      if (same?.id) {
        return res.status(409).json({
          error: 'This customer already has a booking at that exact date and time — it may have gone through on a previous attempt. Check the schedule before re-booking.',
          id: same.id, duplicate: true,
        });
      }
    } catch { /* dedupe is best-effort — never block a legitimate booking on it */ }
  }

  // Signed review-link token (30-day TTL) so the completion follow-up can point
  // the customer at the review widget. booking_id is patched in after insert.
  const bookingInsert = {
    business_id: biz.id, customer_id,
    technician_id: technician_id || null,
    secondary_technician_id: secondary_technician_id || null,
    service_id: body.service_id || null,
    service_area_id: bookingAreaId || null,
    status, source: 'manual',
    scheduled_at,
    subtotal: Number(body.subtotal) || 0,
    price: Number(body.price) || 0,
    notes: body.notes || null,
    customer_notes: body.customer_notes || null,
    address_line1: c.address_line1 || null, city: c.city || null, state: c.state || null, postal_code: c.postal_code || null,
    payment_required: !!paymentMethod && paymentMethod !== 'quote',
    payment_method: paymentMethod,
    needs_lifting: !!body.needs_lifting,
    tv_size_category: body.tv_size_category || null,
    // Opt-out model (every SMS we send already says "STOP to opt out"): default
    // to consented unless the office explicitly unchecked the box for this
    // customer. Matches the estimate/quote flow's sms_consent default below.
    sms_consent: body.sms_consent !== false,
    idempotency_key: idempotencyKey,
    // Who booked it, for the "Booked by" line on the job detail. Owner = "Admin";
    // a secretary = their name (Heather / Joey). Widget bookings carry source
    // 'widget' instead and are labeled "Booking widget" client-side.
    metadata: { booked_by: auth.role === 'owner' ? 'Admin' : (auth.name || 'Office') },
  };

  // Some columns depend on later migrations (0014 sms_consent, 0019 lift cols).
  // If a DB hasn't been migrated yet, the insert reports the missing column —
  // drop it and retry so a booking can still be created. Loop in case more than
  // one optional column is missing.
  //
  // EXCEPTION: if the office actually assigned a SECOND technician but the
  // secondary_technician_id column is missing, do NOT silently drop them — that
  // would create a one-tech job and the second tech would never see it. Fail
  // loudly with a fix hint so the booking isn't quietly wrong.
  const OPTIONAL_INSERT_COLS = ['sms_consent', 'secondary_technician_id', 'needs_lifting', 'tv_size_category', 'idempotency_key'];
  const wantedSecondTech = !!bookingInsert.secondary_technician_id;
  let insertObj = { ...bookingInsert };
  let bRow, bErr;
  for (let attempt = 0; attempt < OPTIONAL_INSERT_COLS.length + 1; attempt++) {
    ({ data: bRow, error: bErr } = await db.from('bookings').insert(insertObj).select('id').single());
    if (!bErr) break;
    // Concurrent duplicate: a simultaneous request with the SAME idempotency key
    // won the race and already inserted. The unique index (0024) rejects this one
    // with a 23505 — return the winner's booking instead of erroring, so a
    // double-submit is a no-op rather than a phantom job.
    if (idempotencyKey && (bErr.code === '23505' || /idempotency/i.test(bErr.message || '') || /duplicate key/i.test(bErr.message || ''))) {
      const { data: winner } = await db.from('bookings')
        .select('id').eq('business_id', biz.id).eq('idempotency_key', idempotencyKey).maybeSingle();
      if (winner?.id) return res.status(200).json({ id: winner.id, duplicate: true });
    }
    // Tech/slot race lost at the DB (bookings_tech_slot_unique, migration 0073):
    // two offices passed the pre-insert conflict check simultaneously and the
    // other one's insert won. This surfaced as a raw 500 ("duplicate key…")
    // instead of the same friendly 409 the pre-check gives.
    if (bErr.code === '23505' && /bookings_tech_slot_unique/.test(bErr.message || '')) {
      return res.status(409).json({ error: 'That technician was just booked for this exact time slot by someone else. Refresh the available times and pick another slot or technician.' });
    }
    const missing = OPTIONAL_INSERT_COLS.find(c => (bErr.message || '').includes(c) && c in insertObj);
    if (!missing) break;                       // not an optional-column problem — give up
    if (missing === 'secondary_technician_id' && wantedSecondTech) {
      return res.status(503).json({ error: 'This database can\'t store a second technician yet (missing the two-technician upgrade). Apply migration 0019_secondary_technician.sql in Supabase, then rebook. The booking was not created so the second tech isn\'t silently lost.' });
    }
    console.warn(`[admin] bookings.${missing} not found, retrying without it`);
    delete insertObj[missing];
  }

  if (bErr) throw bErr;

  // Generate the review-link token now that we have the booking id.
  const reviewToken = signToken({ kind: 'review', booking_id: bRow.id }, 2592000);
  await db.from('bookings').update({ review_token: reviewToken }).eq('id', bRow.id);

  // NOTE: the booking row already exists past this point. NOTHING below may
  // throw a 500 — that would tell the office "booking failed" for a booking
  // that EXISTS, and the natural retry double-books. Failures here are
  // collected as a warning on the (still-200) response instead. Seeded with
  // the unassigned-race warning from the tech pick above, if any.
  let postInsertWarning = unassignedWarning;

  // Save a tokenized card on file in Stripe so it can be charged at service time.
  // A failure here used to be silently swallowed (console.warn only) — the
  // booking looked completely successful (confirmation email/SMS still sent),
  // so the office had no way to know the card never actually attached until a
  // charge attempt failed at time of service, sometimes days later. Now it
  // surfaces as a warning on the (still-successful) booking-create response.
  if (paymentMethod === 'card' && body.payment_method_id) {
    try {
      const ids = await saveCardOnFile(body.payment_method_id, { name: c.name, email: c.email, phone: c.phone }, biz.slug);
      if (ids) await db.from('bookings').update({
        stripe_customer_id: ids.customerId, stripe_payment_method_id: ids.pmId,
      }).eq('id', bRow.id);
    } catch (e) {
      console.warn('[admin] card-on-file save failed:', e.message);
      // Compose (don't clobber) — the unassigned-race warning may already be
      // set, and both are must-see: no tech AND no card is a double surprise.
      const cardWarn = `Booking was created, but the card could not be saved (${e.message}). Open the job and use "Change card" to add it before the appointment.`;
      postInsertWarning = postInsertWarning ? `${postInsertWarning}\n\n${cardWarn}` : cardWarn;
    }
  }
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
    if (liErr) {
      console.error('[admin] line-items insert failed (booking exists):', liErr.message);
      // `||`, never a plain assignment — a prior card-save warning (money-
      // relevant) must never be silently discarded just because line items
      // ALSO failed to save in the same request. Matches the tax-line warning
      // below, which already gets this right.
      postInsertWarning = postInsertWarning || 'Booking was created, but its line items could not be saved — open the job and re-add them.';
    }
  }

  // Add tax as a line item
  if (Number(body.tax) > 0) {
    const { error: taxErr } = await db.from('booking_line_items').insert({
      booking_id: bRow.id, business_id: biz.id,
      kind: 'fee', name: 'Tax (8.25%)',
      quantity: 1, unit_price: Number(body.tax), line_total: Number(body.tax),
      service_id: null, option_id: null, taxable: false,
    });
    if (taxErr) {
      console.error('[admin] tax line-item insert failed (booking exists):', taxErr.message);
      postInsertWarning = postInsertWarning || 'Booking was created, but the tax line could not be saved — open the job and re-add it.';
    }
  }

  await db.from('booking_status_events').insert({
    booking_id: bRow.id, business_id: biz.id, technician_id: technician_id || null,
    status, note: `Created by ${auth.role} (dashboard)`,
  });

  // Send booking confirmation SMS to customer (if they opted in)
  if (c.phone && scheduled_at && body.sms_consent) {
    // Use the JOB's local time (tz was resolved from the service area above), so an
    // Austin customer sees Central time — not the business's Mountain time.
    const _d = new Date(scheduled_at);
    const dateStr = _d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = _d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const msg = `You're booked! ✅ ${biz.name} will see you ${dateStr} at ${timeStr}. We'll text you when your tech is on the way. Reply STOP to opt out.`;
    sendSMS(c.phone, msg).catch(console.error);
  }

  // Notify the technician if one was assigned at creation time (job-local tz).
  if (technician_id) notifyTechAssigned(db, biz, technician_id, scheduled_at, tz).catch(console.error);
  if (secondary_technician_id) notifyTechAssigned(db, biz, secondary_technician_id, scheduled_at, tz).catch(console.error);

  // Owner SMS when this ticket carries 4+ brackets (same alert as widget bookings).
  maybeSendBigBracketAlert({
    lines: selections,
    customerName: c.name || '',
    whenStr: (() => {
      try { return scheduled_at ? new Date(scheduled_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }) : null; }
      catch { return body.scheduled_date || null; }
    })(),
  });

  // ---- Branded booking-confirmation email (best-effort; never fails the booking) ----
  // Mirrors the public widget's confirmation so phone-in jobs the office books
  // also get the branded "You're booked" email. Brand-aware: Handy Andy and Doms
  // each get their own colors, sender, and reply-to via emailConfig/brandFor.
  // sendEmail itself is gated by emailNotificationsOn() + the Resend key, so this
  // no-ops safely until those are set.
  // Both notification emails run CONCURRENTLY and each Resend call is capped at
  // 8s inside sendEmail — they stay awaited (a serverless function must not
  // return before its sends finish or they get frozen mid-flight), but they can
  // no longer stall the response unboundedly: worst case adds a few seconds, not
  // the pre-timeout "Processing… forever" hang the office was hitting.
  const confirmationEmailP = (async () => {
    if (!c.email) return;
    try {
      const firstName = (c.name || '').trim().split(/\s+/)[0] || '';
      let dateLong = '';
      if (scheduled_at) {
        try { dateLong = new Date(scheduled_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric' }); } catch { /* keep blank */ }
      }
      const slotDef = SLOTS.find(s => s.key === body.scheduled_slot);
      const timeWindow = slotDef ? slotDef.label : '';

      // Calendar links: scheduled_at is the slot start (UTC); derive the end from
      // the slot's duration (default 2h) so the .ics / Google event has a window.
      let startEpoch = null, endEpoch = null;
      if (scheduled_at) {
        startEpoch = Math.floor(new Date(scheduled_at).getTime() / 1000);
        let durMin = 120;
        if (slotDef) {
          const [sh, sm] = slotDef.start.split(':').map(Number);
          const [eh, em] = slotDef.end.split(':').map(Number);
          durMin = (eh * 60 + em) - (sh * 60 + sm);
        }
        endEpoch = startEpoch + durMin * 60;
      }
      const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

      // Price block only when there's an actual charge (skip $0 insurance jobs).
      const hasPrice = (Number(body.price) || 0) > 0;
      let emailLines = null;
      if (hasPrice) {
        emailLines = selections.map(s => {
          const qty = Number(s.quantity) || 1;
          const unit = Number(s.price) || 0;
          return { label: s.label || 'Option', qty, amount: unit * qty };
        });
        if (emailLines.length && Number(body.tax) > 0) emailLines.push({ label: 'Tax (8.25%)', qty: 1, amount: Number(body.tax) });
        if (!emailLines.length) emailLines.push({ label: 'Service total', qty: 1, amount: Number(body.price) });
      }

      const { subject, html } = bookingConfirmationEmail({
        firstName,
        dateLong, timeWindow,
        technicianName: primaryTechInfo?.name || null,
        technicianPhotoUrl: primaryTechInfo?.photo_url || null,
        technicianBioYears: primaryTechInfo?.bio_years || null,
        technicianBioBlurb: primaryTechInfo?.bio_blurb || null,
        address: { line1: c.address_line1, city: c.city, state: c.state, zip: c.postal_code },
        lines: emailLines,
        total: hasPrice ? Number(body.price) : null,
        tip: 0,
        twoTechs: !!body.needs_lifting,
        startEpoch, endEpoch, baseUrl,
        jobId: bRow.id,
      }, brandFor(biz.slug));
      const { from } = emailConfig(biz.slug);
      // TEMP diagnostic: reveal which Resend key path is in use (no secrets logged).
      // Tells us if DOMS_RESEND_API_KEY is actually present on this project/env or
      // if we're silently falling back to the shared Handy Andy key (which can't
      // send from domstvmounting.com). Safe to remove once Doms email is confirmed.
      const _domsKey = process.env.DOMS_RESEND_API_KEY || '';
      const _haKey = process.env.RESEND_API_KEY || '';
      console.log(`[admin] email key path (${biz.slug}): DOMS_RESEND_API_KEY set=${!!_domsKey} (len=${_domsKey.length}) RESEND_API_KEY set=${!!_haKey} (len=${_haKey.length}) usingFallback=${biz.slug === 'doms' && !_domsKey} domsKeyDiffersFromHA=${!!_domsKey && _domsKey !== _haKey} from=${from}`);
      const result = await sendEmail({ slug: biz.slug, to: c.email, subject, html, replyTo: from });
      if (result.sent) console.log(`[admin] confirmation email SENT to ${c.email} (${biz.slug}) id=${result.id || '?'}`);
      else console.warn(`[admin] confirmation email NOT sent to ${c.email} (${biz.slug}):`, result.skipped || result.error);
    } catch (e) {
      console.error('[admin] confirmation email error:', e.message);
    }
  })();

  // TEMPORARY owner heads-up: email the owner when a SECRETARY (Heather/Joey)
  // books a job from the dashboard — NOT when the owner books one. Toggle off any
  // time by setting NOTIFY_SECRETARY_BOOKINGS=0 in the environment. Best-effort.
  const ownerAlertP = (async () => {
    if (auth.role === 'owner' || process.env.NOTIFY_SECRETARY_BOOKINGS === '0') return;
    try {
      let techName = null;
      const techIds = [technician_id, secondary_technician_id].filter(Boolean);
      if (techIds.length) {
        const { data: tns } = await db.from('technicians').select('id, name').in('id', techIds);
        techName = (tns || []).map(t => t.name).filter(Boolean).join(' & ') || null;
      }
      const slotDef2 = SLOTS.find(s => s.key === body.scheduled_slot);
      let scheduledEnd = null;
      if (scheduled_at && slotDef2) {
        const [sh, sm] = slotDef2.start.split(':').map(Number);
        const [eh, em] = slotDef2.end.split(':').map(Number);
        scheduledEnd = new Date(new Date(scheduled_at).getTime() + ((eh * 60 + em) - (sh * 60 + sm)) * 60000).toISOString();
      }
      const lineItems = (Array.isArray(body.selections) ? body.selections : []).map(s => ({
        name: s.label || 'Option', quantity: Number(s.quantity) || 1,
        line_total: (Number(s.price) || 0) * (Number(s.quantity) || 1),
      }));
      if (Number(body.tax) > 0) lineItems.push({ name: 'Tax (8.25%)', quantity: 1, line_total: Number(body.tax) });
      await sendOwnerBookingAlert({
        slug: biz.slug, businessName: biz.name, timezone: tz,
        bookedBy: auth.name || 'Office',
        customer: { name: c.name, phone: c.phone, email: c.email },
        address: { line1: c.address_line1, city: c.city, state: c.state, zip: c.postal_code },
        scheduledAt: scheduled_at, scheduledEnd,
        technicianName: techName, price: Number(body.price) || 0,
        lineItems, customerNotes: body.customer_notes || null, bookingId: bRow.id,
      });
    } catch (e) { console.warn('[admin] secretary booking alert non-fatal:', e.message); }
  })();

  await Promise.all([confirmationEmailP, ownerAlertP]);

  return res.status(200).json({ ok: true, id: bRow.id, ...(postInsertWarning ? { warning: postInsertWarning } : {}) });
}

// ── Booking update: confirm | cancel | reschedule | assign | status ──────────
async function bookingUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  // Confirm the booking belongs to this business before touching it. The 0019
  // column (secondary_technician_id) may not exist yet — fall back without it so
  // confirm/cancel/status/assign keep working until the migration is applied.
  const existingSel = () => `id, status, technician_id, ${bookingLiftCols ? 'secondary_technician_id, ' : ''}scheduled_at, postal_code, review_token, sms_consent, metadata, customer:customers ( phone, email, name )`;
  let { data: existing, error: e0 } = await db.from('bookings')
    .select(existingSel()).eq('id', id).eq('business_id', biz.id).single();
  if (e0 && /secondary_technician_id/.test(e0.message || '')) {
    bookingLiftCols = false;
    ({ data: existing, error: e0 } = await db.from('bookings').select(existingSel()).eq('id', id).eq('business_id', biz.id).single());
  }
  if (e0 || !existing) return res.status(404).json({ error: 'Booking not found' });

  // Cancel deletes the booking outright. Child rows (line items, status events,
  // photos, notes) are removed by ON DELETE CASCADE.
  const patch = {};
  let newStatus = null;
  const now = new Date().toISOString();

  switch (body.action) {
    case 'confirm':
      patch.status = newStatus = 'confirmed'; patch.confirmed_at = now; break;
    case 'cancel':
      // Soft-cancel: keep the row (status='cancelled') so it stays auditable and
      // visible under "Include canceled". Every slot-occupancy query excludes
      // cancelled bookings, so the slot is freed exactly as the old delete did.
      patch.status = newStatus = 'cancelled'; patch.cancelled_at = now;
      // Notify the assigned tech their job was canceled (internal, no consent
      // needed). Fire-and-forget + best-effort so it can never block the cancel.
      if (existing.technician_id) {
        (async () => {
          try {
            const { data: _t } = await db.from('technicians').select('phone').eq('id', existing.technician_id).maybeSingle();
            if (!_t?.phone) return;
            const _tz = biz.timezone || 'America/Denver';
            let when = 'your job';
            if (existing.scheduled_at) {
              const _d = new Date(existing.scheduled_at);
              when = _d.toLocaleDateString('en-US', { timeZone: _tz, weekday: 'short', month: 'short', day: 'numeric' }) +
                     ' ' + _d.toLocaleTimeString('en-US', { timeZone: _tz, hour: 'numeric', minute: '2-digit' });
            }
            const msg = `❌ Job canceled: ${when} (${existing.customer?.name || 'customer'}). No action needed — your calendar's updated.`;
            sendSMS(_t.phone, msg).catch(console.error);
          } catch (e) { console.warn('[cancel] tech SMS failed:', e.message); }
        })();
      }
      break;
    case 'reschedule': {
      // Preferred path: a calendar date + one of the fixed slots. Convert it to a
      // timestamp server-side in the booking's METRO timezone (same logic as new
      // bookings) and derive scheduled_end from the slot, so the calendar shows
      // the right time range. Falls back to a raw scheduled_at if one is passed.
      const rtz = await areaTimezone(db, await serviceAreaIdFromPostal(db, biz.id, existing.postal_code), biz.timezone || 'America/Denver');
      if (body.scheduled_date && body.scheduled_slot) {
        const slotDef = SLOTS.find(s => s.key === body.scheduled_slot);
        if (!slotDef) return res.status(400).json({ error: 'Invalid time slot' });
        const [sh, sm] = slotDef.start.split(':').map(Number);
        const [eh, em] = slotDef.end.split(':').map(Number);
        const midnight = localDateStartUTC(rtz, body.scheduled_date);
        patch.scheduled_at = new Date(midnight.getTime() + (sh * 60 + sm) * 60000).toISOString();
        patch.scheduled_end = new Date(midnight.getTime() + (eh * 60 + em) * 60000).toISOString();
      } else if (body.scheduled_at) {
        patch.scheduled_at = body.scheduled_at;
        if (body.scheduled_end) patch.scheduled_end = body.scheduled_end;
      } else {
        return res.status(400).json({ error: 'scheduled_at (or scheduled_date + scheduled_slot) required' });
      }
      // A big job's extra slots were reserved for the OLD time — drop them on a
      // reschedule so they can't silently land on another job at the new time.
      if (extraSlotsCol) patch.extra_slots = [];
      // A lateness alert already sent for the OLD time doesn't mean anything
      // about the NEW time — clear it so a tech who's late for the rescheduled
      // slot is still checked/alerted (see api/_lib/tech-late.js). No grace-
      // period stamp needed here (unlike reassignment): the new scheduled_at
      // itself is the buffer, since the lateness check only fires 30+ min
      // after whatever scheduled_at currently says.
      {
        const existMetaResched = existing.metadata || {};
        const { late_alert_sent_at, tech_late_notified_ids, staff_late_notified_at, ...restMetaResched } = existMetaResched;
        patch.metadata = restMetaResched;
      }
      break;
    }
    case 'assign': {
      // Only touch the field that was actually sent, so changing the second tech
      // doesn't wipe the primary (and vice-versa). Skip the secondary if the DB
      // hasn't been migrated for it yet.
      if (body.technician_id !== undefined) patch.technician_id = body.technician_id || null;
      const primaryChanged = body.technician_id !== undefined && (body.technician_id || null) !== (existing.technician_id || null);
      // Changing the PRIMARY tech moves the reserved extra slots to a different
      // person — drop them so they must be re-added (and re-validated) for the new tech.
      if (primaryChanged && extraSlotsCol) patch.extra_slots = [];
      let secondaryChanged = false;
      if (body.secondary_technician_id !== undefined && bookingLiftCols) {
        let sec = body.secondary_technician_id || null;
        // 'any' → resolve to the scheduled default (Handy Andy first for Dom's).
        if (sec === 'any') {
          const aTz = biz.timezone || 'America/Denver';
          const effTechId = (body.technician_id !== undefined ? patch.technician_id : existing.technician_id) || null;
          const aDate = existing.scheduled_at ? localDateStr(aTz, existing.scheduled_at) : null;
          const aSlot = existing.scheduled_at ? slotKeyForLocalTime(localHHMM(aTz, existing.scheduled_at)) : null;
          sec = await resolveDefaultSecondary(db, biz, existing.postal_code, aDate, aSlot, aTz, effTechId, body.pool2);
        }
        patch.secondary_technician_id = sec;
        secondaryChanged = (sec || null) !== (existing.secondary_technician_id || null);
      }
      // Either tech changing means whoever's newly on the hook for this job
      // didn't cause any lateness already tracked against it — clear the
      // lateness-alert state and stamp reassigned_at so tech-late.js gives
      // them a full fresh 30-minute grace period instead of instantly
      // flagging them late for a slot that was already overdue when it
      // landed on them (see api/_lib/tech-late.js). One shared timestamp for
      // the whole booking is deliberate — simpler than tracking a grace
      // period per tech slot, and the only cost is a rare few extra minutes
      // of delay on a legitimately new lateness incident.
      if (primaryChanged || secondaryChanged) {
        const existMetaAssign = existing.metadata || {};
        const { late_alert_sent_at, tech_late_notified_ids, staff_late_notified_at, ...restMeta } = existMetaAssign;
        patch.metadata = { ...restMeta, reassigned_at: now };
      }
      if (body.technician_id && existing.status === 'confirmed') { patch.status = newStatus = 'assigned'; patch.assigned_at = now; }
      break;
    }
    case 'reopen':
      // Reopen a completed job by setting it back to assigned (if tech is assigned)
      // or confirmed (if no tech). Mark it so we never resend the review email.
      if (existing.status !== 'completed') return res.status(400).json({ error: 'Only completed jobs can be reopened' });
      patch.status = newStatus = existing.technician_id ? 'assigned' : 'confirmed';
      {
        const existMeta = existing.metadata || {};
        // Any lateness alert already sent belongs to whatever happened before
        // this reopen — clear it so the reopened job (protected by its own
        // 30-min reopened_at grace period, see api/_lib/tech-late.js) is still
        // checked/alerted fresh if it genuinely goes late again.
        const { late_alert_sent_at, tech_late_notified_ids, staff_late_notified_at, ...restMeta } = existMeta;
        patch.metadata = { ...restMeta, reopened_at: now, reopened_from: 'completed' };
      }
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
    const effSecondTech = ('secondary_technician_id' in patch) ? patch.secondary_technician_id : existing.secondary_technician_id;
    // The same person can't be both technicians on one job.
    if (effTech && effSecondTech && effTech === effSecondTech) {
      return res.status(400).json({ error: 'The two technicians must be different.' });
    }
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
    // Also check secondary technician if one is assigned
    if (effSecondTech && effAt) {
      const slotKey = slotKeyForLocalTime(localHHMM(tz, effAt));
      if (slotKey) {
        const taken = await bookedSlotKeysForTech(db, biz.id, effSecondTech, localDateStr(tz, effAt), tz, id);
        if (taken.has(slotKey)) {
          return res.status(409).json({ error: 'The second technician is already booked for this time slot. Choose another time or technician.' });
        }
      }
    }
    // Guard against reassigning/rescheduling onto a tech's marked day off — see
    // the matching check in bookingCreate for why this is needed (the concrete-
    // tech dropdown path never consulted the exceptions table before).
    if (!body.force_unavailable && effAt) {
      const slotKey = slotKeyForLocalTime(localHHMM(tz, effAt));
      const effDate = localDateStr(tz, effAt);
      const dow = dayOfWeekFor(effDate);
      if (slotKey) {
        if (effTech) {
          const keys = await singleTechSlotKeys(db, effTech, effDate, dow);
          if (!keys.has(slotKey)) {
            const { data: t } = await db.from('technicians').select('name').eq('id', effTech).maybeSingle();
            return res.status(409).json({ error: `${t?.name || 'This technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable' });
          }
        }
        if (effSecondTech) {
          const keys2 = await singleTechSlotKeys(db, effSecondTech, effDate, dow);
          if (!keys2.has(slotKey)) {
            const { data: t2 } = await db.from('technicians').select('name').eq('id', effSecondTech).maybeSingle();
            return res.status(409).json({ error: `${t2?.name || 'The second technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable' });
          }
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

    // Send review email and SMS when job is completed
    if (newStatus === 'completed' && existing.review_token) {
      const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
      // Click-tracking redirect URL for both email and SMS — logs which channel the click came from
      const emailClickUrl = `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(existing.review_token)}&ch=email`;
      const smsClickUrl = `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(existing.review_token)}&ch=sms`;
      // Twilio POSTs delivery status here as the text progresses (see api/analytics.js action=sms_status)
      const smsStatusCallback = `${baseUrl}/api/analytics?action=sms_status&token=${encodeURIComponent(existing.review_token)}`;

      // Send review email immediately — only once per booking (metadata stamp),
      // so a reopen → re-complete never double-emails the customer.
      if (existing.customer?.email && !existing.metadata?.review_email_sent_at) {
        try {
          const brand = brandFor(biz.slug);
          const { subject, html } = reviewEmail({
            firstName: existing.customer.name || 'there',
            clickUrl: emailClickUrl,
          }, brand);
          const { from } = emailConfig(biz.slug);
          const emailResult = await sendEmail({ slug: biz.slug, to: existing.customer.email, subject, html, replyTo: from });

          // Mark review email as sent — best-effort, never blocks completion
          if (emailResult.sent) {
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            const newMeta = { ...(cur?.metadata || existing.metadata || {}), review_email_sent_at: now };
            await db.from('bookings').update({ metadata: newMeta }).eq('id', id);
            // review_email_id lets the Resend delivery webhook match its event
            // back to this booking; review_email_status starts 'sent' and the
            // webhook upgrades it to 'delivered'/'bounced'/'complained'.
            try {
              await db.from('bookings').update({
                review_email_sent_at: now, review_email_count: 1,
                review_email_id: emailResult.id || null, review_email_status: 'sent',
              }).eq('id', id);
            } catch { /* column not applied yet */ }
            console.log(`[review] email sent to ${existing.customer.email} (${biz.slug}) booking=${id}`);
          }
        } catch (e) {
          console.error(`[review] email failed for booking ${id}:`, e.message);
        }
      }

      // Review-request SMS if the customer opted in — same once-only stamp.
      // (Replaces the old setTimeout pattern that never fired on serverless.)
      if (existing.customer?.phone && existing.sms_consent && !existing.metadata?.review_sms_sent_at) {
        try {
          const msg = `How did we do?\n\nLeave your technician a review here:\n${smsClickUrl}\n\nSTOP to opt out`;
          const smsResult = await sendSMSResult(existing.customer.phone, msg, { statusCallback: smsStatusCallback });
          if (smsResult.ok) {
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            await db.from('bookings').update({ metadata: { ...(cur?.metadata || existing.metadata || {}), review_sms_sent_at: now } }).eq('id', id);
            // review_sms_status starts 'sent'; Twilio's status callback upgrades
            // it to 'delivered'/'failed'/'undelivered' (see api/analytics.js).
            try { await db.from('bookings').update({ review_sms_sent_at: now, review_sms_status: 'sent' }).eq('id', id); } catch { /* column not applied yet */ }
            console.log(`[review] SMS sent (${biz.slug}) booking=${id}`);
          } else {
            console.warn(`[review] SMS NOT sent booking=${id}:`, smsResult.skipped || smsResult.error);
          }
        } catch (e) {
          console.error(`[review] SMS failed for booking ${id}:`, e.message);
        }
      }
    }

    // Auto-decrement wire concealment plates when a "behind the wall" job is
    // completed from the dashboard — same rule as the tech app. Stamped in
    // metadata so completing/reopening never double-deducts (the stamp is shared
    // with the tech path). Best-effort; never blocks completion.
    if (newStatus === 'completed' && !existing.metadata?.wire_plate_deducted_at) {
      try {
        const { data: liRows } = await db.from('booking_line_items')
          .select('name, quantity').eq('booking_id', id);
        const plateQty = detectWirePlateQty(liRows || []);
        if (plateQty > 0) {
          let chargeTech = existing.technician_id || null;
          try {
            const { data: sup } = await db.from('bookings')
              .select('bracket_supplied_by').eq('id', id).maybeSingle();
            if (sup?.bracket_supplied_by) chargeTech = sup.bracket_supplied_by;
          } catch (_) { /* column may not exist; fall back to assigned tech */ }
          if (chargeTech) {
            await adjustWirePlateInventory(db, biz.id, chargeTech, plateQty, id);
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            const newMeta = { ...(cur?.metadata || existing.metadata || {}), wire_plate_deducted_at: now };
            await db.from('bookings').update({ metadata: newMeta }).eq('id', id);
          }
        }
      } catch (e) {
        console.error(`[wireplate] decrement failed for booking ${id}:`, e.message);
      }
    }

    // Auto-decrement the company BRACKETS this job used from the supplier's
    // inventory — same rule as the tech app, for solo AND two-tech jobs. Stamped
    // (bracket_deducted_at) so completing/reopening never double-deducts.
    if (newStatus === 'completed' && !existing.metadata?.bracket_deducted_at) {
      try {
        const { data: liRows } = await db.from('booking_line_items')
          .select('name, quantity').eq('booking_id', id);
        const need = detectBracketQtys(liRows || []);
        if (bracketTotal(need) > 0) {
          let supplier = existing.technician_id || null;
          try {
            const { data: sup } = await db.from('bookings')
              .select('bracket_supplied_by, technician_id').eq('id', id).maybeSingle();
            supplier = sup?.bracket_supplied_by || sup?.technician_id || existing.technician_id || null;
          } catch (_) { /* pre-0035: fall back to assigned tech */ }
          if (supplier) {
            await adjustBracketInventory(db, biz.id, supplier, need, -1);
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            await db.from('bookings').update({
              metadata: { ...(cur?.metadata || existing.metadata || {}), bracket_deducted_at: now },
            }).eq('id', id);
          }
        }
      } catch (e) {
        console.error(`[bracket] decrement failed for booking ${id}:`, e.message);
      }
    }
  }

  // Notify the technician when they are newly assigned to this job (only when the
  // tech actually changed, so re-saving the same assignment doesn't re-text them).
  // Resolve the JOB's local tz from its zip so the texted time is the job's local
  // time (an Austin job is Central), not the business's Mountain time.
  const assignTz = (body.action === 'assign')
    ? await areaTimezone(db, await serviceAreaIdFromPostal(db, biz.id, existing.postal_code), biz.timezone || 'America/Denver')
    : (biz.timezone || 'America/Denver');
  if (body.action === 'assign' && patch.technician_id && patch.technician_id !== existing.technician_id) {
    notifyTechAssigned(db, biz, patch.technician_id, existing.scheduled_at, assignTz).catch(console.error);
  }
  // Also notify secondary technician if assigned
  if (body.action === 'assign' && 'secondary_technician_id' in patch && patch.secondary_technician_id && patch.secondary_technician_id !== existing.secondary_technician_id) {
    notifyTechAssigned(db, biz, patch.secondary_technician_id, existing.scheduled_at, assignTz).catch(console.error);
  }
  return res.status(200).json({ ok: true });
}

// Normalize editor line items into storable booking_line_items rows. Each
// editor line is just { text, price } (a dollar amount), so quantity is always 1
// and line_total == unit_price == price. `kind` is preserved when the client
// sends it back (so a fee/tip/coupon line keeps its category); new lines default
// to 'service'. Blank lines (no text and no price) are dropped.
function sanitizeBookingLineItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(it => {
    const name = ((it && (it.name != null ? it.name : it.label)) || '').toString().trim().slice(0, 300);
    const qty = Math.min(99, Math.max(1, Math.round(Number(it && it.quantity) || 1)));
    // Prefer an explicit per-item unit_price; otherwise derive it from a total
    // (price / line_total) divided by the quantity. Backward-compatible with
    // callers that only send a single total and no quantity (qty defaults to 1).
    let unit;
    if (it && it.unit_price != null && Number.isFinite(Number(it.unit_price))) {
      unit = Number(it.unit_price);
    } else {
      const total = Number(it && (it.price != null ? it.price : it.line_total)) || 0;
      unit = qty > 0 ? total / qty : total;
    }
    unit = Math.round(unit * 100) / 100;
    const line_total = Math.round(unit * qty * 100) / 100;
    const kind = (it && it.kind) || 'service';
    const taxable = !(it && it.taxable === false);
    return { name, quantity: qty, unit_price: unit, line_total, kind, taxable };
  }).filter(it => it.name || it.unit_price);
}

// ── Edit a booking's line items (text + price) ───────────────────────────────
// Owner + secretary. The office sees every line on a job, so the posted set is
// authoritative: we delete the old rows and insert the new ones, then set the
// booking's price to the sum of the lines so the total can never drift from the
// items it's made of. Works on any job, including imported (Zenbooker) jobs that
// arrived with no line items at all — the editor seeds one line from the price.
async function bookingLineItemsSave(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const { data: existing, error: e0 } = await db.from('bookings')
    .select('id').eq('id', id).eq('business_id', biz.id).single();
  if (e0 || !existing) return res.status(404).json({ error: 'Booking not found' });

  const items = sanitizeBookingLineItems(body.items);

  // Replace the whole set: drop the current rows, insert the edited ones.
  const { error: delErr } = await db.from('booking_line_items')
    .delete().eq('booking_id', id).eq('business_id', biz.id);
  if (delErr) throw delErr;

  if (items.length) {
    // sort_order = the array's index, so however the office dragged the rows
    // into order on save is exactly how they read back next time (migration
    // 0071 — without it, a delete-and-reinsert has no reliable original order:
    // created_at is identical for every row in one insert, id is a random uuid).
    const rows = items.map((it, i) => ({
      booking_id: id, business_id: biz.id,
      kind: it.kind, name: it.name,
      quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total,
      taxable: it.taxable, sort_order: i,
    }));
    let { error: insErr } = await db.from('booking_line_items').insert(rows);
    if (insErr && /sort_order/.test(insErr.message || '')) {
      ({ error: insErr } = await db.from('booking_line_items').insert(rows.map(({ sort_order, ...r }) => r)));
    }
    if (insErr) throw insErr;
  }

  const price = Math.round(items.reduce((t, it) => t + it.line_total, 0) * 100) / 100;
  const { error: upErr } = await db.from('bookings')
    .update({ price }).eq('id', id).eq('business_id', biz.id);
  if (upErr) throw upErr;

  return res.status(200).json({ ok: true, price, count: items.length });
}

// ── Add / change the card on file (customer wants to pay with a different card) ──
// The office tokenizes the new card client-side (booking.stripe_pk) and posts the
// payment_method_id here; we attach it in the booking's Stripe account and point
// the booking at it, so the next charge uses the new card.
async function bookingCardUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  const pmId = (body.payment_method_id || '').toString();
  if (!id || !pmId) return res.status(400).json({ error: 'id and payment_method_id required' });

  const cols = (withAcct) => `id, payment_status, ${withAcct ? 'stripe_account, ' : ''}customer:customers ( name, email, phone )`;
  let { data: b, error } = await db.from('bookings').select(cols(true)).eq('id', id).eq('business_id', biz.id).single();
  if (error && missingColumn(error.message) === 'stripe_account') {
    ({ data: b, error } = await db.from('bookings').select(cols(false)).eq('id', id).eq('business_id', biz.id).single());
  }
  if (error || !b) return res.status(404).json({ error: 'Booking not found' });
  if (b.payment_status === 'paid') return res.status(400).json({ error: 'This booking is already paid — the card cannot be changed.' });
  // 'charging' is a transient lock a charge-in-progress holds (see
  // bookingPayment) — changing the card underneath it would race the charge
  // itself, and this write's own `if (b.payment_status !== 'card_on_file')`
  // patch below would silently clobber the lock either way.
  if (b.payment_status === 'charging') return res.status(409).json({ error: 'This booking is being charged right now — wait a moment and try again.' });

  const acct = { account: b.stripe_account || null, slug: biz.slug };
  if (!stripeConfigured(acct)) return res.status(400).json({ error: 'Payments are not configured for this business.' });

  let r;
  try {
    r = await saveCardOnFileAcct({
      email: b.customer?.email, name: b.customer?.name, phone: b.customer?.phone,
      paymentMethodId: pmId, ...acct,
    });
  } catch (e) {
    return res.status(e.status || 400).json({ error: 'Could not save the card: ' + e.message });
  }

  const patch = { stripe_payment_method_id: pmId };
  if (r.customerId) patch.stripe_customer_id = r.customerId;
  if (b.payment_status !== 'card_on_file') patch.payment_status = 'card_on_file';
  // CAS on the payment_status we READ — see api/tech.js jobCardUpdate for why:
  // the 'charging' guard above is a plain read, and a charge can acquire its
  // lock during the seconds-long Stripe call between it and this write.
  const { data: upRow, error: upErr } = await db.from('bookings').update(patch)
    .eq('id', id).eq('business_id', biz.id).eq('payment_status', b.payment_status).select('id').maybeSingle();
  if (upErr) throw upErr;
  if (!upRow) return res.status(409).json({ error: 'The payment state changed while saving the card (a charge may be in progress) — refresh the booking and try again.' });
  return res.status(200).json({ ok: true });
}

// Read-only "which card is this?" lookup — same resolution order the real
// charge path uses (stored id -> email lookup -> customer's default payment
// method), but never charges anything. Lets the office tell a customer which
// card is on file before/without actually running a charge. Best-effort: any
// resolution failure just means "no card info to show," never an error the
// office has to deal with.
async function bookingCard(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  const cols = (withAcct) => `id, ${withAcct ? 'stripe_account, ' : ''}stripe_customer_id, stripe_payment_method_id,
             customer:customers ( email, stripe_customer_id )`;
  let { data: b, error } = await db.from('bookings').select(cols(true)).eq('id', id).eq('business_id', biz.id).maybeSingle();
  if (error && missingColumn(error.message) === 'stripe_account') {
    ({ data: b, error } = await db.from('bookings').select(cols(false)).eq('id', id).eq('business_id', biz.id).maybeSingle());
  }
  if (error || !b) return res.status(404).json({ error: 'Booking not found' });

  const acct = { account: b.stripe_account || null, slug: biz.slug };
  let custId = b.stripe_customer_id || (b.customer && b.customer.stripe_customer_id) || null;
  let pmId = b.stripe_payment_method_id || null;
  try {
    if (!custId && b.customer && b.customer.email) {
      const r = await findCardOnFileByEmail(b.customer.email, acct);
      custId = r.customerId; if (r.paymentMethodId) pmId = r.paymentMethodId;
    }
    if (custId && !pmId) pmId = await defaultPaymentMethod(custId, acct);
  } catch (_) { /* no card on file is a normal, common case */ }
  if (!pmId) return res.status(200).json({ has_card: false });

  let card = { brand: null, last4: null };
  try { card = await retrieveCard(pmId, acct); } catch (_) { /* Stripe hiccup — just show nothing */ }
  if (!card.brand && !card.last4) return res.status(200).json({ has_card: false });
  return res.status(200).json({ has_card: true, brand: card.brand, last4: card.last4 });
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
  // Each business is its own Stripe account; charge/refund the card with THIS
  // booking's business key (Handy Andy → global key, Doms → DOMS_STRIPE_SECRET_KEY).
  const slug = biz.slug;

  // stripe_account (migration 0032) may not be applied yet — select it
  // optimistically and fall back without it so charging never breaks on deploy
  // order. Absent column -> b.stripe_account undefined -> legacy slug behavior.
  const payCols = (withAcct) => `id, price, payment_status, updated_at, ${withAcct ? 'stripe_account, ' : ''}stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id,
             customer:customers ( id, name, email, phone, stripe_customer_id )`;
  let { data: b, error } = await db.from('bookings').select(payCols(true)).eq('id', id).eq('business_id', biz.id).single();
  if (error && missingColumn(error.message) === 'stripe_account') {
    ({ data: b, error } = await db.from('bookings').select(payCols(false)).eq('id', id).eq('business_id', biz.id).single());
  }
  if (error || !b) return res.status(404).json({ error: 'Booking not found' });

  // The card lives in the Stripe account it was saved in. Prefer the per-booking
  // marker; fall back to the business slug for bookings made before stamping
  // (Handy Andy -> global account, Doms -> Doms account) so nothing changes for them.
  const acct = { account: b.stripe_account || null, slug };

  const now = new Date().toISOString();

  // Manual states — no Stripe involved (e.g. paid in cash to the technician).
  // A FRESH 'charging' lock means a real card charge is mid-flight right now
  // (the whole charge path finishes in well under 2 minutes) — marking cash
  // over it would record cash AND let the in-flight card charge land: double
  // collection. A STALE 'charging' lock is a crashed charge; mark-paid is the
  // office's escape hatch for exactly that, so it's allowed through. The
  // updated_at trigger stamps every write, including the lock acquisition,
  // so lock age is just now - updated_at. The write itself is a CAS on the
  // status we read, so a state change in the gap cleanly 409s instead of
  // clobbering.
  if (act === 'mark_paid' || act === 'mark_unpaid') {
    // A booking paid by a REAL card charge must never be quietly re-opened:
    // the money already moved, and 'unpaid' would let a second charge through
    // (a different amount/card gets a different idempotency key — a genuine
    // second charge, not a replay). Refund it instead.
    if (act === 'mark_unpaid' && b.payment_status === 'paid' && b.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'This booking was paid by CARD (the charge is on file with Stripe). Marking it unpaid could lead to charging the customer twice — issue a refund instead.' });
    }
    if (b.payment_status === 'charging') {
      const lockAgeMs = Date.now() - new Date(b.updated_at || 0).getTime();
      if (lockAgeMs < 2 * 60 * 1000) {
        return res.status(409).json({ error: 'This booking is being charged right now — wait a moment and check whether the charge went through before marking it.' });
      }
    }
    // Cash-mark reconciliation: see api/tech.js — a client-side charge timeout
    // doesn't stop Stripe finishing server-side; if an unrecorded landed charge
    // exists, record THAT instead of cash so the customer isn't collected twice.
    if (act === 'mark_paid' && !b.stripe_payment_intent_id) {
      const landed = await findLandedCharge(id, acct);
      if (landed) {
        const patch = { payment_status: 'paid', paid_at: now, amount_paid: landed.amount, tip: landed.tip, stripe_payment_intent_id: landed.id };
        if (landed.customerId) patch.stripe_customer_id = landed.customerId;
        if (landed.paymentMethodId) patch.stripe_payment_method_id = landed.paymentMethodId;
        const { data: rec } = await db.from('bookings').update(patch)
          .eq('id', id).eq('payment_status', b.payment_status).select('id').maybeSingle();
        if (!rec) return res.status(409).json({ error: 'The payment state just changed — refresh and check before marking it.' });
        return res.status(200).json({ ok: true, payment_status: 'paid', recovered: true,
          warning: `This booking's card charge actually WENT THROUGH ($${landed.amount.toFixed(2)}) on an earlier attempt that looked like it failed. It's been recorded as a CARD payment — don't also collect cash.` });
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

  // refund_status / refund both need the TRUE remaining refundable balance —
  // re-fetched from Stripe rather than trusted from our own amount_refunded
  // column, since that column could drift (e.g. a refund issued directly in
  // the Stripe dashboard) and refunding off a stale number risks over-refunding.
  if (act === 'refund_status' || act === 'refund') {
    if (!b.stripe_payment_intent_id) return res.status(400).json({ error: 'No Stripe charge on this booking to refund.' });
    let pi;
    try { pi = await stripe(`/payment_intents/${b.stripe_payment_intent_id}?expand[]=latest_charge`, { method: 'GET', ...acct }); }
    catch (e) { return res.status(e.status || 400).json({ error: 'Could not look up this charge on Stripe: ' + e.message }); }
    const charge = pi.latest_charge || null;
    if (!charge) return res.status(400).json({ error: 'No captured charge found for this booking — nothing to refund.' });
    const capturedCents = charge.amount;
    const refundedCents = charge.amount_refunded || 0;
    const remainingCents = capturedCents - refundedCents;

    if (act === 'refund_status') return res.status(200).json({ ok: true, remaining: remainingCents / 100 });

    if (remainingCents <= 0) return res.status(400).json({ error: 'This charge has already been fully refunded.' });
    // Amount is REQUIRED — never fall back to refunding the full remaining
    // balance just because it was omitted (that's a silent full refund).
    if (body.amount == null) return res.status(400).json({ error: 'A refund amount is required.' });
    const requestedDollars = Number(body.amount);
    if (!requestedDollars || !isFinite(requestedDollars) || requestedDollars <= 0) return res.status(400).json({ error: 'Enter an amount greater than $0.' });
    // toFixed(2) first to dodge float noise (e.g. 10.005*100 -> 1000.4999999999999)
    // before rounding to the nearest whole cent.
    const requestedCents = Math.round(Number((requestedDollars * 100).toFixed(2)));
    if (requestedCents <= 0) return res.status(400).json({ error: 'Enter an amount greater than $0.' });
    if (requestedCents > remainingCents) return res.status(400).json({ error: `Amount exceeds the refundable balance ($${(remainingCents / 100).toFixed(2)}).` });
    // Keyed on the id + the refunded-balance we just read + the requested amount:
    // a double-click (or a browser retry of the same request) reads the SAME
    // pre-refund refundedCents and submits the SAME amount, so it replays this
    // same idempotency key and Stripe coalesces it into the one real refund
    // instead of a second one. A genuinely later, separate refund has a
    // different refundedCents by then (the first one already posted), so it
    // still gets its own fresh key.
    const idempotencyKey = `refund-${id}-${refundedCents}-${requestedCents}`;
    try { await stripe('/refunds', { idempotencyKey, body: { payment_intent: b.stripe_payment_intent_id, amount: requestedCents }, ...acct }); }
    catch (e) { return res.status(e.status || 400).json({ error: 'Refund failed: ' + e.message }); }
    const newRefundedCents = refundedCents + requestedCents;
    const amount_refunded = Math.round(newRefundedCents) / 100;
    // Deliberately NOT a new payment_status value — payroll's paymentState()
    // and the revenue 'earned' filters below both key on status === 'paid',
    // so a partial refund must keep reading as 'paid'. Only flip to 'refunded'
    // once the balance is fully exhausted, same as a one-shot full refund today.
    const payment_status = newRefundedCents >= capturedCents ? 'refunded' : 'paid';
    // Mirror the esCol()/extraSlotsCol short-circuit convention: skip straight
    // to the column-less write once we already know amount_refunded is missing,
    // instead of a write-then-catch round trip every time.
    const patch = amountRefundedCol ? { payment_status, amount_refunded } : { payment_status };
    const { error: updErr } = await db.from('bookings').update(patch).eq('id', id);
    // The Stripe refund already succeeded above regardless of what happens here.
    if (updErr) {
      if (isAmountRefundedErr(updErr)) {
        amountRefundedCol = false;
        const { error: fallbackErr } = await db.from('bookings').update({ payment_status }).eq('id', id);
        if (fallbackErr) return res.status(200).json({ ok: true, payment_status, amount_refunded, warning: `Refund succeeded on Stripe ($${(requestedCents / 100).toFixed(2)}), but saving it to the booking failed: ${fallbackErr.message}. Please reconcile manually.` });
        return res.status(200).json({ ok: true, payment_status, amount_refunded, warning: 'Refund succeeded, but the running refunded-total could not be saved yet — run migration 0061, then it will track correctly on the next refund.' });
      }
      return res.status(200).json({ ok: true, payment_status, amount_refunded, warning: `Refund succeeded on Stripe ($${(requestedCents / 100).toFixed(2)}), but saving it to the booking failed: ${updErr.message}. Please reconcile manually.` });
    }
    return res.status(200).json({ ok: true, payment_status, amount_refunded, remaining: (capturedCents - newRefundedCents) / 100 });
  }

  // Charge the card on file.
  if (act !== 'charge') return res.status(400).json({ error: `Unknown payment action "${act}"` });
  if (!stripeConfigured(acct)) return res.status(400).json({ error: 'Payments are not configured for this business. Use “Mark paid (cash)”.' });
  if (b.payment_status === 'paid') return res.status(400).json({ error: 'This booking is already paid.' });

  // The tech app can charge this SAME booking from the field at the same
  // moment the office charges it here — a plain "not paid yet" read isn't
  // enough on its own (two requests can both read "not paid" before either
  // writes). Acquire an actual lock via compare-and-swap: flip payment_status
  // to the transient 'charging' state conditioned on it still being whatever
  // we just read, so only ONE request can win the swap. The loser gets a
  // clear "already being charged" error instead of creating a second charge.
  let priorPaymentStatus;
  {
    const { data: fresh } = await db.from('bookings').select('payment_status').eq('id', id).eq('business_id', biz.id).maybeSingle();
    if (!fresh) return res.status(404).json({ error: 'Booking not found' });
    if (fresh.payment_status === 'paid') return res.status(400).json({ error: 'This booking is already paid.' });
    if (fresh.payment_status === 'charging') {
      return res.status(409).json({ error: 'This booking is already being charged (maybe from the tech app) — check if it went through before trying again.' });
    }
    priorPaymentStatus = fresh.payment_status;
    const { data: locked, error: lockErr } = await db.from('bookings')
      .update({ payment_status: 'charging' })
      .eq('id', id).eq('business_id', biz.id).eq('payment_status', priorPaymentStatus)
      .select('id').maybeSingle();
    if (lockErr) throw lockErr;
    if (!locked) {
      return res.status(409).json({ error: 'This booking is already being charged (maybe from the tech app) — check if it went through before trying again.' });
    }
  }

  // Past this point the lock is held — ANY exit must release it (restore
  // payment_status to what it was) or the booking gets stuck showing
  // "charging" forever with no way to retry or use "Mark paid (cash)".
  try {
    // Reconciliation guard: a previous attempt (from EITHER app) that timed
    // out client-side may still have LANDED on Stripe, leaving this booking
    // unpaid with no recorded intent. A retry at a different amount/card gets
    // a different idempotency key — a second real charge. If an unrecorded
    // landed charge exists, ADOPT it and stop. See api/tech.js for details.
    if (!b.stripe_payment_intent_id) {
      const landed = await findLandedCharge(id, acct);
      if (landed) {
        const patch = { payment_status: 'paid', paid_at: now, amount_paid: landed.amount, tip: landed.tip, stripe_payment_intent_id: landed.id };
        if (landed.customerId) patch.stripe_customer_id = landed.customerId;
        if (landed.paymentMethodId) patch.stripe_payment_method_id = landed.paymentMethodId;
        let { error: recErr } = await db.from('bookings').update(patch).eq('id', id);
        if (recErr) ({ error: recErr } = await db.from('bookings').update(patch).eq('id', id));
        if (recErr) { await db.from('bookings').update({ payment_status: 'paid' }).eq('id', id); console.error('[admin charge] CRITICAL: landed-charge adopt write failed', { booking: id, pi: landed.id, err: recErr.message }); }
        return res.status(200).json({ ok: true, payment_status: 'paid', amount: landed.amount, tip: landed.tip, payment_intent_id: landed.id, recovered: true,
          warning: `This booking was ALREADY charged $${landed.amount.toFixed(2)} on an earlier attempt that looked like it failed. No new charge was made.` });
      }
    }

    const ticketAmount = body.amount != null ? Number(body.amount) : Number(b.price);
    if (!ticketAmount || ticketAmount <= 0) { const e = new Error('Enter an amount greater than $0.'); e.status = 400; throw e; }
    // Optional tip (e.g. the office runs the signed flow on a tablet too).
    const tip = Math.max(0, Math.round((Number(body.tip) || 0) * 100) / 100);
    // No ceiling here means a fat-fingered tip (e.g. $1500 instead of $15)
    // would silently charge the customer's card for the full typo amount.
    // A 100%-of-ticket tip is already generous, so cap there and reject above it.
    if (tip > ticketAmount) { const e = new Error(`Tip ($${tip.toFixed(2)}) can't be more than the amount charged ($${ticketAmount.toFixed(2)}).`); e.status = 400; throw e; }
    const dollars = Math.round((ticketAmount + tip) * 100) / 100;

    // Resolve a Stripe customer + payment method (stored first, else look up by email).
    let custId = b.stripe_customer_id || (b.customer && b.customer.stripe_customer_id) || null;
    let pmId = b.stripe_payment_method_id || null;
    try {
      if (!custId && b.customer && b.customer.email) {
        const r = await findCardOnFileByEmail(b.customer.email, acct);
        custId = r.customerId; if (r.paymentMethodId) pmId = r.paymentMethodId;
      }
      if (custId && !pmId) pmId = await defaultPaymentMethod(custId, acct);
    } catch (e) { e.status = e.status || 400; throw e; }
    if (!custId || !pmId) { const e = new Error('No card on file for this customer. Use “Mark paid (cash)” instead.'); e.status = 400; throw e; }

    // Card brand/last4 for the receipt + dispute evidence (best-effort).
    let card = { brand: null, last4: null };
    try { card = await retrieveCard(pmId, acct); } catch (_) { /* unknown card is fine */ }

    // Keyed on booking id + exact amount + the CARD being charged, with the
    // SAME 'charge-' prefix the tech path uses (api/tech.js): a true retry —
    // from EITHER app — replays the same PaymentIntent instead of charging
    // twice (previously the two paths used different prefixes, so an office
    // retry of a tech charge, or vice versa, created a second real charge).
    // Changing the amount OR the card changes the key, so a genuinely new
    // attempt after a decline is never blocked by Stripe's replay cache.
    const idempotencyKey = `charge-${id}-${Math.round(dollars * 100)}-${String(pmId).slice(-8)}`;
    let pi;
    try {
      pi = await stripe('/payment_intents', { ...acct, idempotencyKey, body: {
        amount: Math.round(dollars * 100), currency: 'usd',
        customer: custId, payment_method: pmId, off_session: true, confirm: true,
        description: `Booking ${id}`, metadata: { booking_id: id, business: biz.slug, tip: String(tip) },
        receipt_email: (b.customer && b.customer.email) || undefined,
      }});
    } catch (e) {
      e.status = e.status || 402; e.message = 'Charge failed: ' + e.message; throw e;
    }
    if (pi.status !== 'succeeded') {
      const e = new Error(`Charge not completed (status: ${pi.status}). The card may need the customer to re-authenticate.`); e.status = 402; throw e;
    }
    const chargeId = pi.latest_charge || (pi.charges && pi.charges.data && pi.charges.data[0] && pi.charges.data[0].id) || null;

    // The money has MOVED at this point — this write is also the lock release,
    // so its error can't be ignored (supabase returns errors, it doesn't
    // throw): an unnoticed failure would 200 "paid" while the row stays stuck
    // on 'charging', blocking every retry/card-change. Mirrors api/tech.js.
    const paidPatch = {
      payment_status: 'paid', paid_at: now, amount_paid: dollars, tip,
      stripe_payment_intent_id: pi.id, stripe_customer_id: custId, stripe_payment_method_id: pmId,
    };
    let { error: payErr } = await db.from('bookings').update(paidPatch).eq('id', id);
    if (payErr) ({ error: payErr } = await db.from('bookings').update(paidPatch).eq('id', id));   // one retry for a transient blip
    if (payErr) {
      const { error: fbErr } = await db.from('bookings').update({ payment_status: 'paid' }).eq('id', id);
      console.error('[admin charge] CRITICAL: Stripe charge succeeded but booking update failed', { booking: id, pi: pi.id, err: payErr.message, minimal_write_ok: !fbErr });
      return res.status(200).json({ ok: true, payment_status: 'paid', amount: dollars, tip, payment_intent_id: pi.id,
        warning: `The charge WENT THROUGH on Stripe ($${dollars.toFixed(2)}, intent ${pi.id}), but saving it to the booking failed: ${payErr.message}. Do NOT charge again — reconcile manually.` });
    }

    // Freeze the authorization (signature is optional from the office). Best-effort.
    await saveAuthorization(db, req, { ...b, business_id: biz.id }, { businessId: biz.id, total: dollars, ticketAmount, tip, card, pi, chargeId, body });

    return res.status(200).json({ ok: true, payment_status: 'paid', amount: dollars, tip, payment_intent_id: pi.id });
  } catch (e) {
    // Release the lock on any failure so the booking can be retried (or paid
    // with cash) instead of being stuck on 'charging'.
    try { await db.from('bookings').update({ payment_status: priorPaymentStatus }).eq('id', id).eq('payment_status', 'charging'); } catch (_) { /* best-effort */ }
    return res.status(e.status || 500).json({ error: e.message });
  }
}

// Edit a booking's SERVICE address after it's booked (office fixes a typo or the
// customer moves the job). Re-derives the service area from the new zip so the
// territory filter + travel payout stay correct. Available to any office user.
async function bookingAddressUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  const { data: existing } = await db.from('bookings')
    .select('id, postal_code').eq('id', id).eq('business_id', biz.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Booking not found' });

  const str = (v) => (v == null ? '' : String(v).trim());
  const patch = {
    address_line1: str(body.address_line1) || null,
    address_line2: str(body.address_line2) || null,
    city: str(body.city) || null,
    state: str(body.state).toUpperCase() || null,
    postal_code: str(body.postal_code) || null,
  };
  // A new zip changes territory + travel tier — re-resolve the service area when
  // the zip is one we serve; otherwise leave the existing area untouched.
  if (patch.postal_code && patch.postal_code !== existing.postal_code) {
    const areaId = await serviceAreaIdFromPostal(db, biz.id, patch.postal_code);
    if (areaId) patch.service_area_id = areaId;
  }

  const { error } = await db.from('bookings').update(patch).eq('id', id).eq('business_id', biz.id);
  if (error) return res.status(500).json({ error: error.message });
  const address = [patch.address_line1, patch.city, patch.state, patch.postal_code].filter(Boolean).join(', ');
  return res.status(200).json({ ok: true, address, ...patch });
}

// Fetch the signed authorization stored for a booking (the tech/office charge
// flow captures the signature + tip + terms + signing IP/time). Returns the most
// recent one. Degrades cleanly before migration 0046 is applied.
async function bookingAuthorization(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const cols = 'id, signature_url, customer_name, card_brand, card_last4, amount, ticket_amount, tip, terms_text, terms_version, signed_ip, signed_user_agent, signed_at, created_at';
  const { data, error } = await db.from('booking_authorizations')
    .select(cols).eq('business_id', biz.id).eq('booking_id', id)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    // Table not created yet (migration 0046 not applied) — say so, don't 500.
    if (/relation|does not exist|booking_authorizations/i.test(error.message || '')) {
      return res.status(200).json({ authorization: null, table_missing: true });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ authorization: data || null });
}

// ── Chargeback disputes (draft evidence from stored signatures, owner submits) ──
// A booking's card can live in more than one Stripe account for a business
// (Handy Andy: the legacy 'global' account AND its own; Doms: its own). Return
// every account we might have charged in for this business.
function candidateAccounts(slug) {
  if (slug === 'doms') return ['doms'];
  if (slug === 'handy-andy') return ['global', 'handy-andy'];
  return ['global'];
}

async function fetchAsBase64(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length ? b.toString('base64') : null;
  } catch (_) { return null; }
}

// List open (needs-response) disputes across this business's Stripe account(s),
// each matched to the signed authorization we stored so the office can see the
// evidence we'll submit. No writes — this is the "inbox".
async function disputes(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const accounts = candidateAccounts(biz.slug).filter(a => businessSecretKey({ account: a }));
  if (!accounts.length) return res.status(200).json({ disputes: [], configured: false });

  const raw = [];
  for (const account of accounts) {
    try { for (const d of await listOpenDisputes({ account })) raw.push({ d, account }); }
    catch (_) { /* one account erroring must not hide the others */ }
  }
  if (!raw.length) return res.status(200).json({ disputes: [], configured: true });

  const piOf = ({ d }) => d.payment_intent || (d.charge && d.charge.payment_intent) || null;
  const pis = [...new Set(raw.map(piOf).filter(Boolean))];
  const authByPi = new Map();
  if (pis.length) {
    const { data: auths } = await db.from('booking_authorizations')
      .select('*').eq('business_id', biz.id).in('stripe_payment_intent_id', pis);
    for (const a of auths || []) authByPi.set(a.stripe_payment_intent_id, a);
  }

  const out = [];
  for (const item of raw) {
    const { d, account } = item;
    const pi = piOf(item);
    const a0 = pi ? authByPi.get(pi) : null;
    let photosCount = 0;
    if (a0) {
      const { count } = await db.from('booking_photos')
        .select('id', { count: 'exact', head: true }).eq('booking_id', a0.booking_id);
      photosCount = count || 0;
    }
    out.push({
      id: d.id, account, amount: (d.amount || 0) / 100, currency: d.currency,
      reason: d.reason, status: d.status,
      due_by: (d.evidence_details && d.evidence_details.due_by) ? d.evidence_details.due_by * 1000 : null,
      payment_intent: pi, matched: !!a0,
      booking_id: a0 ? a0.booking_id : null,
      customer_name: a0 ? a0.customer_name : null,
      signed_at: a0 ? a0.signed_at : null,
      signed_ip: a0 ? a0.signed_ip : null,
      card_last4: a0 ? a0.card_last4 : null,
      has_signature: !!(a0 && a0.signature_url),
      signature_url: a0 ? a0.signature_url : null,
      photos_count: photosCount,
    });
  }
  // Soonest deadline first so the office answers the most urgent one next.
  out.sort((x, y) => (x.due_by || Infinity) - (y.due_by || Infinity));
  return res.status(200).json({ disputes: out, configured: true });
}

// Owner-only: assemble the evidence packet from our stored authorization + job
// photos, upload the signature/photo to Stripe, and submit it for the dispute.
async function disputeSubmit(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can submit dispute evidence.' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const disputeId = (body.dispute_id || '').toString();
  const account = (body.account || '').toString();
  const pi = (body.payment_intent || '').toString();
  if (!disputeId || !account || !pi) return res.status(400).json({ error: 'dispute_id, account and payment_intent are required.' });
  if (!candidateAccounts(biz.slug).includes(account)) return res.status(400).json({ error: 'That Stripe account is not owned by this business.' });

  const { data: a0 } = await db.from('booking_authorizations')
    .select('*').eq('business_id', biz.id).eq('stripe_payment_intent_id', pi).maybeSingle();
  if (!a0) return res.status(404).json({ error: 'No signed authorization is stored for this charge — submit the evidence manually in Stripe.' });

  const { data: booking } = await db.from('bookings')
    .select('id, scheduled_at, address_line1, city, state, postal_code, customer:customers ( name, email )')
    .eq('id', a0.booking_id).eq('business_id', biz.id).maybeSingle();
  const { data: photos } = await db.from('booking_photos')
    .select('url').eq('booking_id', a0.booking_id).eq('business_id', biz.id).order('created_at', { ascending: true }).limit(1);

  const { evidence } = buildDisputeEvidence({ booking: booking || {}, auth: a0, customer: booking && booking.customer });
  const sel = { account };

  // The signature is the centerpiece evidence — upload it as customer_signature.
  if (a0.signature_url) {
    try {
      const b64 = await fetchAsBase64(a0.signature_url);
      if (b64) evidence.customer_signature = await stripeUploadFile({ dataBase64: b64, contentType: 'image/png', filename: 'signature.png', ...sel });
    } catch (_) { /* fall back to text-only evidence */ }
  }
  // A completed-work photo backs "service provided".
  if (photos && photos[0] && photos[0].url) {
    try {
      const b64 = await fetchAsBase64(photos[0].url);
      if (b64) evidence.service_documentation = await stripeUploadFile({ dataBase64: b64, contentType: 'image/jpeg', filename: 'service.jpg', ...sel });
    } catch (_) { /* optional */ }
  }

  try { await submitDisputeEvidence(disputeId, evidence, sel, true); }
  catch (e) { return res.status(e.status || 400).json({ error: 'Stripe rejected the evidence: ' + e.message }); }
  return res.status(200).json({ ok: true, submitted: true });
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
  const sel = (withStatus) => db.from('booking_photos')
    .select(`id, url, caption, uploader_name, created_at, booking_id${withStatus ? ', status' : ''},
             booking:bookings ( id, scheduled_at, status, customer:customers ( name ), technician:technicians!technician_id ( name ) )`)
    .eq('business_id', biz.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  // Try selecting the photo category (status). If the migration hasn't been
  // applied yet the column is missing — fall back and treat everything as
  // 'new' (the inbox) so the gallery still loads.
  let { data, error } = await sel(true);
  let hasStatus = true;
  if (error && /status/i.test(error.message || '')) {
    hasStatus = false;
    ({ data, error } = await sel(false));
  }
  if (error) throw error;
  const photos = (data || []).map(p => ({
    id: p.id, url: p.url, caption: p.caption, uploader_name: p.uploader_name, created_at: p.created_at,
    booking_id: p.booking_id,
    status: hasStatus ? (p.status || 'new') : 'new',
    customer_name: p.booking?.customer?.name || 'Customer',
    technician_name: p.booking?.technician?.name || null,
    scheduled_at: p.booking?.scheduled_at || null,
    status_booking: p.booking?.status || null,
  }));
  return res.status(200).json({ photos, limit, offset, has_more: photos.length === limit, status_supported: hasStatus });
}

// Move a photo between categories (New / To Post / Posted / Records). No-op-safe:
// validates the target category and that the photo belongs to this business.
// 'private' stays accepted so legacy photos can still be re-filed.
const PHOTO_CATEGORIES = ['new', 'to_post', 'posted', 'records', 'private'];
async function bookingPhotoSetStatus(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.photo_id) return res.status(400).json({ error: 'photo_id required' });
  const status = (body.status || '').toString();
  if (!PHOTO_CATEGORIES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${PHOTO_CATEGORIES.join(', ')}` });
  }
  const { data, error } = await db.from('booking_photos')
    .update({ status })
    .eq('id', body.photo_id).eq('business_id', biz.id)
    .select('id, status').maybeSingle();   // 0 rows -> data:null (clean 404), not a PGRST116 throw
  if (error) {
    // CHECK violation (status_check) or missing column → the category migration
    // (0043) hasn't been applied to this database yet.
    if (/status/i.test(error.message || '')) {
      return res.status(400).json({ error: 'Photo categories need the 0043 database update applied first.' });
    }
    throw error;
  }
  if (!data) return res.status(404).json({ error: 'Photo not found' });
  return res.status(200).json({ ok: true, id: data.id, status: data.status });
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
// Resolve which service area (metro) a zip falls in, so New Booking can show
// only that metro's technicians. Returns { service_area_id, name } (nulls if the
// zip isn't mapped — the form then shows all techs, unfiltered).
async function zipArea(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const postal = (req.query.postal_code || '').toString().trim();
  if (!postal) return res.status(200).json({ service_area_id: null, name: null, surcharge: 0 });
  // Also return the per-zip surcharge so the manual New Booking form can auto-fill
  // the Travel Fee the same way the public widget auto-applies it. Tolerate the
  // surcharge column being absent on older DBs (degrade to 0).
  let data = null;
  ({ data } = await db.from('service_area_zips')
    .select('service_area_id, surcharge, service_area:service_areas ( name )')
    .eq('business_id', biz.id).eq('postal_code', postal).maybeSingle()
    .then(r => r, () => ({ data: null })));
  if (!data) {
    ({ data } = await db.from('service_area_zips')
      .select('service_area_id, service_area:service_areas ( name )')
      .eq('business_id', biz.id).eq('postal_code', postal).maybeSingle());
  }
  // Not served by THIS business? Check whether the OTHER company covers the zip
  // (e.g. a Houston zip typed while the dashboard is on Dom's, which is
  // Denver-only). The office was told "new area" with no hint that the zip is
  // perfectly bookable one tab over — surface which business serves it instead.
  let other_business = null;
  if (!data) {
    try {
      const { data: hit } = await db.from('service_area_zips')
        .select('surcharge, business:businesses!inner ( slug, name, active ), service_area:service_areas ( name )')
        .eq('postal_code', postal).neq('business_id', biz.id)
        .eq('business.active', true).limit(1).maybeSingle();
      if (hit?.business) {
        other_business = {
          slug: hit.business.slug,
          name: hit.business.name,
          area: hit.service_area?.name || null,
          surcharge: Number(hit.surcharge) || 0,
        };
      }
    } catch (e) { /* hint only — never block the zip answer */ }
  }
  return res.status(200).json({
    service_area_id: data?.service_area_id || null,
    name: data?.service_area?.name || null,
    surcharge: Number(data?.surcharge) || 0,
    other_business,
  });
}

// ── Address autocomplete (server-side proxy to Google Places) ────────────────
// The dashboard draws its OWN suggestion dropdown; these two endpoints are the
// only thing that talks to Google. Keeping the key server-side means: no key in
// the browser, no HTTP-referrer allow-list to maintain, no Maps JavaScript API,
// and — crucially — Google can never inject broken UI into the page (the failure
// mode that broke the old in-browser widget). Requirement on the key: the
// "Places API" enabled with billing on. If the key is missing or Google rejects
// the request, we return an empty list and the field stays a plain text box.
async function placesAutocomplete(req, res, auth) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const input = (req.query.input || (req.body && req.body.input) || '').toString().trim();
  const token = (req.query.session || (req.body && req.body.session) || '').toString().trim();
  if (!key || input.length < 3) return res.status(200).json({ predictions: [] });
  const u = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  u.searchParams.set('input', input);
  u.searchParams.set('key', key);
  u.searchParams.set('types', 'address');
  u.searchParams.set('components', 'country:us');
  if (token) u.searchParams.set('sessiontoken', token);
  try {
    const r = await fetch(u.toString());
    const j = await r.json();
    if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') {
      console.warn('[places] autocomplete', j.status, j.error_message || '');
      return res.status(200).json({ predictions: [], status: j.status });
    }
    const predictions = (j.predictions || []).slice(0, 5).map(p => ({
      description: p.description, place_id: p.place_id,
    }));
    return res.status(200).json({ predictions });
  } catch (e) {
    console.error('[places] autocomplete failed:', e.message);
    return res.status(200).json({ predictions: [] });
  }
}

async function placeDetails(req, res, auth) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const placeId = (req.query.place_id || (req.body && req.body.place_id) || '').toString().trim();
  const token = (req.query.session || (req.body && req.body.session) || '').toString().trim();
  if (!key || !placeId) return res.status(200).json({ address: null });
  const u = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  u.searchParams.set('place_id', placeId);
  u.searchParams.set('key', key);
  u.searchParams.set('fields', 'address_component');
  if (token) u.searchParams.set('sessiontoken', token);
  try {
    const r = await fetch(u.toString());
    const j = await r.json();
    if (j.status !== 'OK') {
      console.warn('[places] details', j.status, j.error_message || '');
      return res.status(200).json({ address: null, status: j.status });
    }
    const comps = j.result?.address_components || [];
    const get = (type, short) => {
      const c = comps.find(x => (x.types || []).includes(type));
      return c ? (short ? c.short_name : c.long_name) : '';
    };
    const street = [get('street_number'), get('route')].filter(Boolean).join(' ');
    const address = {
      street,
      city: get('locality') || get('sublocality') || get('postal_town') || get('administrative_area_level_2'),
      state: get('administrative_area_level_1', true),
      zip: get('postal_code'),
    };
    return res.status(200).json({ address });
  } catch (e) {
    console.error('[places] details failed:', e.message);
    return res.status(200).json({ address: null });
  }
}

async function technicians(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  // service_area_id (0022) powers the New Booking metro filter; max_jobs_per_day
  // (0034) is the per-tech daily cap; photo_url/bio_years/bio_blurb (0060) power
  // the "Meet your tech" confirmation-email block. All optional — drop whichever
  // column the DB doesn't have yet so the roster always loads.
  let cols = 'id, name, phone, email, status, active, service_area_id, max_jobs_per_day, pin_hash, photo_url, bio_years, bio_blurb';
  let data, error;
  for (let i = 0; i < 8; i++) {
    ({ data, error } = await db.from('technicians').select(cols).eq('business_id', biz.id).order('name'));
    if (!error) break;
    const col = missingColumn(error.message);
    if (col && cols.includes(col)) { cols = cols.split(', ').filter(c => c !== col).join(', '); continue; }
    break;
  }
  if (error) throw error;
  // Never leak the hash; just say whether a PIN is set.
  const techs = (data || []).map(({ pin_hash, ...t }) => ({ ...t, pin_set: !!pin_hash }));

  // Average rating per technician, in ONE batched query. This used to be a
  // serial per-tech loop (N+1) fetching every reviewed booking one tech at a
  // time — on a 10-tech roster that alone added ~10 round-trips to every New
  // Booking modal open, which waits on this endpoint before showing.
  for (const tech of techs) tech.average_rating = null;
  try {
    const ids = techs.map(t => t.id);
    if (ids.length) {
      const { data: ratings } = await db.from('bookings')
        .select('technician_id, review_rating')
        .in('technician_id', ids)
        .not('review_rating', 'is', null);
      const agg = new Map();   // technician_id -> { sum, n }
      for (const r of (ratings || [])) {
        const a = agg.get(r.technician_id) || { sum: 0, n: 0 };
        a.sum += r.review_rating; a.n++;
        agg.set(r.technician_id, a);
      }
      for (const tech of techs) {
        const a = agg.get(tech.id);
        if (a && a.n) tech.average_rating = Math.round((a.sum / a.n) * 10) / 10;
      }
    }
  } catch (e) { console.warn('[admin] tech ratings batch non-fatal:', e.message); }

  return res.status(200).json({ technicians: techs });
}

// ── Partner-company technicians (cross-company booking) ──────────────────────
// The OTHER company's bookable technicians, so a secretary can fill a gap with a
// partner tech when their own are full. Scope is enforced on the HOST business
// (the caller's own) — only names + ids are returned for the picker.
// When postal_code is provided, filters to techs in that service area.
async function partnerTechnicians(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const partner = await partnerBusiness(db, biz.slug);
  if (!partner) return res.status(200).json({ partner: null, technicians: [] });

  // Resolve the zip against the PARTNER's own service-area table, not the
  // host's — each business has its own row per metro (Doms's Denver and Handy
  // Andy's Denver are different service_area_id values), so filtering the
  // partner's technicians by the host's id could never match anything. This
  // silently returned zero cross-hire techs for every ZIP entered on either
  // side (reported: no Doms techs offered as 2nd tech on any Handy Andy job).
  const postalCode = (req.query.postal_code || '').toString();
  let serviceAreaId = null;
  if (postalCode) {
    serviceAreaId = await serviceAreaIdFromPostal(db, partner.id, postalCode);
  }

  let query = db.from('technicians')
    .select('id, name').eq('business_id', partner.id).eq('active', true);
  if (serviceAreaId) query = query.eq('service_area_id', serviceAreaId);
  const { data, error } = await query.order('name');
  if (error) throw error;
  return res.status(200).json({
    partner: { slug: partner.slug, name: partner.name },
    technicians: data || [],
  });
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
  // Daily job cap — OWNER ONLY (secretaries can open the Technicians tab but must
  // not set it). Empty/blank = no limit; otherwise a non-negative whole number.
  if (auth.role === 'owner' && body.max_jobs_per_day !== undefined) {
    const v = body.max_jobs_per_day;
    patch.max_jobs_per_day = (v === '' || v == null) ? null : Math.max(0, Math.floor(Number(v)) || 0);
  }
  // Bio for the "Meet your tech" confirmation-email block. bio_years is a
  // non-negative whole number or null (blank = don't show a years claim).
  if (body.bio_years !== undefined) {
    const v = body.bio_years;
    patch.bio_years = (v === '' || v == null) ? null : Math.max(0, Math.floor(Number(v)) || 0);
  }
  if (body.bio_blurb !== undefined) patch.bio_blurb = (body.bio_blurb || '').toString().trim().slice(0, 400) || null;
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

// Upload/replace a technician's profile photo — used by the "Meet your tech"
// confirmation-email block. Reuses the same booking-photos storage bucket as
// job photos. POST { business, id, image } (image = data URL from the browser,
// already resized client-side).
async function technicianPhotoUpload(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data: existing } = await db.from('technicians').select('id, photo_url').eq('id', id).eq('business_id', biz.id).single();
  if (!existing) return res.status(404).json({ error: 'Technician not found' });

  const up = await uploadImage(body.image, `tech-photos/${biz.id}/${id}`);
  const { error } = await db.from('technicians').update({ photo_url: up.url }).eq('id', id).eq('business_id', biz.id);
  if (error) throw error;
  return res.status(200).json({ ok: true, photo_url: up.url });
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
// The 0019 migration (secondary_technician_id / needs_lifting / tv_size_category)
// may not be applied yet on every DB. Select those columns optimistically; if the
// DB doesn't have them, flip this flag off and the reads fall back gracefully so
// the dashboard never goes down waiting on a migration.
let bookingLiftCols = true;
// extra_slots (migration 0052) — same optimistic pattern. When the column isn't
// applied yet, flip off and every occupancy read omits it (a booking then blocks
// only its main slot, never breaking the schedule while the migration lands).
let extraSlotsCol = true;
const esCol = () => (extraSlotsCol ? ', extra_slots' : '');            // append to a raw select
const esOf = (b) => (extraSlotsCol && Array.isArray(b && b.extra_slots)) ? b.extra_slots : [];
const isExtraSlotsErr = (e) => /extra_slots/.test((e && e.message) || '');
// amount_refunded (migration 0061) — same optimistic pattern, so the dashboard
// never breaks reading bookings while that migration hasn't landed yet.
let amountRefundedCol = true;
const arCol = () => (amountRefundedCol ? ', amount_refunded' : '');
const isAmountRefundedErr = (e) => /amount_refunded/.test((e && e.message) || '');
// booking_line_items.sort_order (migration 0071) — same optimistic pattern, so
// reads never break while that migration hasn't landed yet (falls back to
// whatever order the DB naturally returns, same as before this feature existed).
let sortOrderCol = true;
const isSortOrderErr = (e) => /sort_order/.test((e && e.message) || '');
function bookingSelect() {
  // The technician embeds are disambiguated by FK column (technician_id /
  // secondary_technician_id) because bookings has TWO foreign keys to
  // technicians once migration 0019 is applied; without the hint PostgREST
  // can't tell which relationship to follow and the read errors.
  const base = `id, status, source, metadata, scheduled_at, scheduled_end, duration_minutes, price, subtotal, tip, payment_status, paid_at,
          notes, customer_notes, review_rating, review_text, technician_id, service_area_id, business_id, updated_at, zenbooker_job_number${esCol()}${arCol()},
          on_the_way_sms_status, on_the_way_sms_sent_at, on_the_way_sms_delivered_at,
          address_line1, address_line2, city, state, postal_code,
          business:businesses ( slug ),
          customer:customers ( id, name, phone, email ),
          technician:technicians!technician_id ( id, name, status, color, business_id, business:businesses ( name ) ),
          service:services ( id, name ),
          photos:booking_photos ( count ),
          notes_list:booking_notes ( count ),
          line_items:booking_line_items ( option_id, name, kind, quantity, unit_price, line_total )`;
  return bookingLiftCols
    ? `${base}, secondary_technician_id, needs_lifting, tv_size_category,
          secondary_technician:technicians!secondary_technician_id ( id, name, status, color, business_id, business:businesses ( name ) )`
    : base;
}
// Run a bookings read, retrying once without the 0019 columns if they're missing.
// makeQuery receives the select string and returns a fresh (awaitable) query.
async function fetchBookingRows(makeQuery) {
  // Order embedded line items by sort_order (migration 0071) so a dragged-into-
  // order edit round-trips correctly on the next read, everywhere a booking is
  // fetched — degrades to the DB's natural order if the column isn't there yet.
  const run = () => {
    let q = makeQuery(bookingSelect());
    if (sortOrderCol) q = q.order('sort_order', { ascending: true, foreignTable: 'booking_line_items' });
    return q;
  };
  let { data, error } = await run();
  if (error && isSortOrderErr(error)) { sortOrderCol = false; ({ data, error } = await run()); }
  if (error && (/secondary_technician_id|needs_lifting|tv_size_category/.test(error.message || '') || isExtraSlotsErr(error) || isAmountRefundedErr(error))) {
    if (/secondary_technician_id|needs_lifting|tv_size_category/.test(error.message || '')) bookingLiftCols = false;
    if (isExtraSlotsErr(error)) extraSlotsCol = false;
    if (isAmountRefundedErr(error)) amountRefundedCol = false;
    ({ data, error } = await run());
  }
  return { data, error };
}

// Slim projection of bookingSelect() for PURE ECONOMICS MATH (profit /
// predicted-income sums in summary()) — no customer info, no photo/note
// counts, no display-only technician/business fields. Every field here is
// actually read somewhere in the profit chain: computeJobEconomics itself
// (price, subtotal, tip, postal_code, technician/secondary_technician name),
// classifyService (notes, service name, line items), and the payroll engine's
// computeJobPay (notes for payroll-override/Assurion detection,
// zenbooker_job_number for pay overrides, service name for special-service
// detection, line items for the whole pay walk). Dropping a field here would
// silently change a computed profit number rather than error, so this list
// was built by tracing every job.* / b.* read in that call chain — don't trim
// further without re-checking api/_lib/payroll.js.
function economicsSelect() {
  const base = `id, status, payment_status, price, subtotal, tip, notes, customer_notes,
          zenbooker_job_number, scheduled_at, postal_code,
          service:services ( name ),
          technician:technicians!technician_id ( name ),
          line_items:booking_line_items ( name, kind, quantity, unit_price, line_total )`;
  return bookingLiftCols
    ? `${base}, secondary_technician:technicians!secondary_technician_id ( name )`
    : base;
}
// Run a bookings read for economicsSelect(), same missing-column degrade as
// fetchBookingRows. Gate note: economicsSelect's conditional piece is an
// EMBED (technicians!secondary_technician_id), and PostgREST reports a
// missing embed relationship with a PGRST-prefixed code, not Postgres 42703
// (42703 is what a missing RAW column returns) — so accept either code
// family, still requiring the column name in the message so an unrelated
// error can never flip the flag (the repair #11 rule).
async function fetchEconomicsRows(makeQuery) {
  let { data, error } = await makeQuery(economicsSelect());
  const codeOk = (e) => e.code === '42703' || String(e.code || '').startsWith('PGRST');
  if (error && codeOk(error) && /secondary_technician_id/.test(error.message || '')) {
    bookingLiftCols = false;
    ({ data, error } = await makeQuery(economicsSelect()));
  }
  return { data, error };
}

function shapeBooking(b) {
  return {
    id: b.id,
    status: b.status,
    source: b.source,
    // Who booked it: 'Admin' / 'Heather' / 'Joey' (stored at create), or null on
    // older/widget bookings (the client falls back to source for "Booking widget").
    booked_by: b.metadata?.booked_by || null,
    // Publishable key for the "Change card" UI, by the booking's business.
    stripe_pk: bookingStripePk(b.business?.slug || null),
    scheduled_at: b.scheduled_at,
    scheduled_end: b.scheduled_end,
    duration_minutes: b.duration_minutes,
    // Additional slot keys this big job reserves (migration 0052). The main slot
    // comes from scheduled_at; these are the extra ones the office blocked.
    extra_slots: esOf(b),
    price: b.price,
    // Gratuity the customer added at charge time (100% to the tech). Kept so the
    // schedule card can show the true total the customer paid (price + tip).
    tip: b.tip,
    payment_status: b.payment_status,
    amount_refunded: amountRefundedCol ? (b.amount_refunded || null) : null,
    paid_at: b.paid_at,
    // "On the way" text delivery — admin/secretary dashboard only, never sent to
    // the tech app's own booking read (that's a separate query in tech.js).
    on_the_way_sms_status: b.on_the_way_sms_status || null,
    on_the_way_sms_sent_at: b.on_the_way_sms_sent_at || null,
    on_the_way_sms_delivered_at: b.on_the_way_sms_delivered_at || null,
    notes: b.notes,
    customer_notes: b.customer_notes,
    review_rating: b.review_rating,
    review_text: b.review_text,
    technician_id: b.technician_id,
    secondary_technician_id: b.secondary_technician_id,
    needs_lifting: b.needs_lifting,
    tv_size_category: b.tv_size_category,
    service_area_id: b.service_area_id,
    business_id: b.business_id,
    // Cross-company: the assigned tech's home business differs from this booking's.
    // partner_company is that tech's company name (e.g. "Doms") for a clear tag.
    cross_company: !!(b.technician?.business_id && b.business_id && b.technician.business_id !== b.business_id),
    partner_company: b.technician?.business?.name || null,
    address: formatAddress(b),
    // Raw address parts so the office can edit the service address after booking.
    address_line1: b.address_line1 || '',
    address_line2: b.address_line2 || '',
    city: b.city || '',
    state: b.state || '',
    postal_code: b.postal_code || '',
    customer: b.customer || null,
    technician: b.technician ? { id: b.technician.id, name: b.technician.name, status: b.technician.status, color: b.technician.color } : null,
    // Second technician (large-TV lifts / cross-company helpers). Carries the
    // company name + a cross-company flag so the dashboard can label a partner
    // helper (e.g. "Gregory · Doms") without exposing it to the customer.
    secondary_technician: b.secondary_technician ? {
      id: b.secondary_technician.id, name: b.secondary_technician.name,
      status: b.secondary_technician.status, color: b.secondary_technician.color,
      company: b.secondary_technician.business?.name || null,
      cross_company: !!(b.secondary_technician.business_id && b.business_id && b.secondary_technician.business_id !== b.business_id),
    } : null,
    service: b.service || null,
    // Normalize the stored columns (name/unit_price) to the {label, price} shape
    // the dashboard renders. line_total is the per-line subtotal (unit × qty).
    line_items: Array.isArray(b.line_items) ? b.line_items.map(li => ({
      option_id: li.option_id || null,
      label: li.name,
      kind: li.kind,
      quantity: Number(li.quantity) || 1,
      price: Number(li.unit_price) || 0,
      line_total: Number(li.line_total) || 0,
    })) : [],
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

// ── Google review (GMB) routing ─────────────────────────────────────────────
// A 5-star customer is sent to a Google listing to post their review. The goal
// is to spread reviews across BOTH accounts in a metro so no single profile
// gets them all. Routing is by metro; within a metro with two listings the
// pick is stable per booking (refresh-safe) and split ~50/50 across them.
//
// Metro is decided by the technician first (the owner thinks of it that way:
// "Juan -> Houston, Zach -> Austin, Steve/Kregg -> Denver"); if the tech isn't
// mapped we fall back to the booking's service-area name, then a default.
// Doms has a single listing, so every Doms job goes there.
const GMB_LISTINGS = {
  'handy-andy': {
    houston: ['https://g.page/r/CdizxHwpwcE0EBM/review', 'https://g.page/r/CeA7fWzbLgO8EBM/review'],
    denver:  ['https://g.page/r/Ccj-ZjdeLtzfEBM/review', 'https://g.page/r/CWcIi45TvszbEBM/review'],
    austin:  ['https://g.page/r/CYE7aX6tVMnkEBM/review'],
  },
  'doms': {
    _all: ['https://g.page/r/Cffr7Tp2DSNOEBM/review'],
  },
};
// Technician first name (lowercase) -> metro. Extend as the roster grows.
const TECH_METRO = {
  'handy-andy': { juan: 'houston', zach: 'austin', steve: 'denver', kregg: 'denver' },
};
const HA_DEFAULT_METRO = 'denver';

// Stable, ~even index into a list from any string key (e.g. booking id).
function hashIndex(str, n) {
  if (n <= 1) return 0;
  let h = 0; const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}

// Resolve the Google review URL for a booking. `bookingId` keeps the choice
// stable across page refreshes; the hash spreads bookings across the metro's
// listings so both accounts collect reviews.
function resolveGoogleReviewUrl({ slug, techName, areaName, bookingId }) {
  if (slug === 'doms') return GMB_LISTINGS.doms._all[0] || null;

  const metros = GMB_LISTINGS[slug];
  if (!metros) return null;

  // 1) technician → metro
  let metro = null;
  const first = (techName || '').trim().toLowerCase().split(/\s+/)[0];
  if (first && TECH_METRO[slug] && TECH_METRO[slug][first]) metro = TECH_METRO[slug][first];
  // 2) service-area name → metro
  if (!metro && areaName) {
    const a = areaName.toLowerCase();
    if (a.includes('houston')) metro = 'houston';
    else if (a.includes('denver')) metro = 'denver';
    else if (a.includes('austin')) metro = 'austin';
  }
  // 3) default
  if (!metro) metro = HA_DEFAULT_METRO;

  const list = metros[metro] || metros[HA_DEFAULT_METRO] || [];
  if (!list.length) return null;
  return list[hashIndex(bookingId, list.length)];
}

async function reviewCheck(req, res, body) {
  const token = req.query.token || '';
  if (!token) return res.status(400).json({ error: 'token required' });

  const reviewToken = verifyToken(token);
  if (!reviewToken || !reviewToken.booking_id) return res.status(401).json({ error: 'Invalid token' });

  const db = serviceClient();
  const { data: booking, error } = await db.from('bookings')
    .select('id, reviewed_at, service_area:service_areas(name), technician:technicians!technician_id(name), business:businesses(slug, name)')
    .eq('id', reviewToken.booking_id)
    .single();

  if (error || !booking) return res.status(404).json({ error: 'Booking not found' });

  // Reaching this page means the customer CLICKED a review link — count it even
  // when they arrived via an old direct link that skipped the review_click
  // redirect. Channel unknown here, so only stamp the time. Best-effort; never
  // block the page load.
  db.from('bookings').update({ review_clicked_at: new Date().toISOString() })
    .eq('id', booking.id).is('review_clicked_at', null)
    .then(() => {}, () => {});

  const slug = booking.business?.slug || 'handy-andy';
  const reviewUrl = resolveGoogleReviewUrl({
    slug,
    techName: booking.technician?.name || '',
    areaName: booking.service_area?.name || '',
    bookingId: booking.id,
  });

  return res.status(200).json({
    booking_id: booking.id,
    already_reviewed: !!booking.reviewed_at,
    review_url: reviewUrl,
    business_slug: slug,
    business_name: booking.business?.name || 'Handy Andy',
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
      technician:technicians!technician_id(id, name, phone),
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

  // Submitting a review is proof the customer clicked through — backfill the
  // click time if the redirect stamp never landed, so a real review can never
  // read "link not clicked". Best-effort.
  db.from('bookings').update({ review_clicked_at: now })
    .eq('id', booking.id).is('review_clicked_at', null)
    .then(() => {}, () => {});

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

  // Send SMS to technician on a poor review only. (5-star "great review" texts
  // were removed for both businesses — no notification on a perfect rating.)
  if (booking.technician?.phone && rating <= 4) {
    const techName = booking.technician.name || 'Technician';
    const msg = `${techName} you just received a bad review... Please check your profile to view.`;
    await sendSMS(booking.technician.phone, msg).catch(err => console.warn('[review] tech SMS send failed:', err));
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

// Per-business transactional email config (Resend) now lives in ./_lib/email.js
// (imported above) so the booking, estimate and review flows share one source
// of truth for keys and from-addresses.

async function sendFeedbackEmail(params) {
  if (!emailNotificationsOn()) { console.log('[review] notifications disabled; feedback email not sent'); return; }
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
// Review-request tracking: every completed job with a full per-channel
// Sent → Delivered → Opened pipeline (email + SMS), newest first, paginated —
// plus a 30-day email-vs-SMS engagement scoreboard computed independently of
// the page window so it stays accurate regardless of which page is showing.
const REVIEW_TRACK_COLS = `review_email_sent_at, review_email_count, review_email_id,
      review_email_delivered_at, review_email_status, review_email_clicked_at,
      review_sms_sent_at, review_sms_delivered_at, review_sms_status, review_sms_clicked_at,
      review_clicked_at, review_click_channel`;

function channelState(hasChannel, sentAt, deliveredAt, status, openedAt) {
  if (!hasChannel) return { eligible: false, sent_at: null, delivered_at: null, status: null, opened_at: null };
  const resolvedStatus = status || (deliveredAt ? 'delivered' : (sentAt ? 'sent' : null));
  return { eligible: true, sent_at: sentAt || null, delivered_at: deliveredAt || null, status: resolvedStatus, opened_at: openedAt || null };
}

async function reviewRequests(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business || ''); } catch (e) { return bail(res, e); }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const cols = (t) => `id, scheduled_at, completed_at, review_rating, review_text, reviewed_at, review_token, metadata, sms_consent,
      ${t ? REVIEW_TRACK_COLS + ', ' : ''}
      customer:customers(name, email, phone), technician:technicians!technician_id(name)`;
  let hasTrack = true;
  let { data, error, count } = await db.from('bookings').select(cols(true), { count: 'exact' })
    .eq('business_id', biz.id).eq('status', 'completed')
    .order('completed_at', { ascending: false }).range(from, to);
  // Any tracking column missing (migrations 0033/0062/0063 not applied) →
  // re-select without them; the bookings.metadata stamps carry the sent-at
  // data as fallback (delivered/status/per-channel-opened have no metadata
  // fallback — they're new bonus signals, not core functionality).
  if (error && /review_(email|sms|click)/.test(error.message || '')) {
    hasTrack = false;
    ({ data, error, count } = await db.from('bookings').select(cols(false), { count: 'exact' })
      .eq('business_id', biz.id).eq('status', 'completed')
      .order('completed_at', { ascending: false }).range(from, to));
  }
  if (error) throw error;

  const rows = (data || []).map(b => {
    const hasEmail = !!b.customer?.email;
    const hasSms = !!b.customer?.phone && !!b.sms_consent;
    const emailSentAt = (hasTrack ? b.review_email_sent_at : null) || b.metadata?.review_email_sent_at || null;
    const smsSentAt = (hasTrack ? b.review_sms_sent_at : null) || b.metadata?.review_sms_sent_at || null;
    // Per-channel opened: prefer the 0063 per-channel column; fall back to the
    // 0062 shared "first click" column when it matches this channel (covers
    // clicks recorded before 0063 was applied).
    const emailOpenedAt = (hasTrack ? b.review_email_clicked_at : null)
      || b.metadata?.review_email_clicked_at
      || ((hasTrack ? b.review_click_channel : b.metadata?.review_click_channel) === 'email' ? (b.review_clicked_at || b.metadata?.review_clicked_at) : null) || null;
    const smsOpenedAt = (hasTrack ? b.review_sms_clicked_at : null)
      || b.metadata?.review_sms_clicked_at
      || ((hasTrack ? b.review_click_channel : b.metadata?.review_click_channel) === 'sms' ? (b.review_clicked_at || b.metadata?.review_clicked_at) : null) || null;
    // Channel-UNKNOWN open: the customer provably clicked through (the review
    // page stamped review_clicked_at, or they outright left a review) but
    // neither channel recorded the click — legacy kindless tokens skipped the
    // channel-stamping redirect (see api/book.js review_click). Without this,
    // a card could show a 5-star review sitting above "Not opened" on both
    // channels, which reads as the system contradicting itself.
    const openedUnknownAt = (!emailOpenedAt && !smsOpenedAt)
      ? ((hasTrack ? b.review_clicked_at : null) || b.metadata?.review_clicked_at || b.reviewed_at || null)
      : null;
    return {
      id: b.id,
      customer_name: b.customer?.name || '—',
      technician_name: b.technician?.name || '—',
      completed_at: b.completed_at || b.scheduled_at || null,
      has_email: hasEmail,
      email_count: hasTrack ? (b.review_email_count || 0) : (emailSentAt ? 1 : 0),
      email: channelState(hasEmail, emailSentAt, hasTrack ? b.review_email_delivered_at : null, hasTrack ? b.review_email_status : null, emailOpenedAt),
      sms: channelState(hasSms, smsSentAt, hasTrack ? b.review_sms_delivered_at : null, hasTrack ? b.review_sms_status : null, smsOpenedAt),
      opened_unknown_at: openedUnknownAt,
      rating: b.review_rating || null,
      review_text: b.review_text || null,
      reviewed_at: b.reviewed_at || null,
      tracking: hasTrack,
    };
  });

  const scoreboard = await reviewScoreboard(db, biz.id, hasTrack);
  return res.status(200).json({ requests: rows, page, limit, total: count || rows.length, scoreboard });
}

// 30-day email-vs-SMS engagement scoreboard — computed over ALL completed
// jobs in the window, independent of reviewRequests' pagination, so it's
// always the true last-30-days number regardless of which page is showing.
async function reviewScoreboard(db, businessId, hasTrack) {
  const windowDays = 30;
  if (!hasTrack) return { windowDays, email: null, sms: null };
  const sinceISO = new Date(Date.now() - windowDays * 86400000).toISOString();
  const { data, error } = await db.from('bookings')
    .select('review_email_sent_at, review_email_delivered_at, review_email_clicked_at, review_sms_sent_at, review_sms_delivered_at, review_sms_clicked_at, review_clicked_at, review_click_channel')
    .eq('business_id', businessId).eq('status', 'completed')
    .gte('completed_at', sinceISO);
  if (error || !data) return { windowDays, email: null, sms: null };

  const tally = (sentKey, deliveredKey, clickedKey) => {
    let sent = 0, delivered = 0, opened = 0;
    for (const b of data) {
      if (!b[sentKey]) continue;
      sent++;
      if (b[deliveredKey]) delivered++;
      const ch = clickedKey === 'review_sms_clicked_at' ? 'sms' : 'email';
      const openedAt = b[clickedKey] || (b.review_click_channel === ch ? b.review_clicked_at : null);
      if (openedAt) opened++;
    }
    return { sent, delivered, opened, openRate: sent ? Math.round((opened / sent) * 100) : null };
  };
  return {
    windowDays,
    email: tally('review_email_sent_at', 'review_email_delivered_at', 'review_email_clicked_at'),
    sms: tally('review_sms_sent_at', 'review_sms_delivered_at', 'review_sms_clicked_at'),
  };
}

// Resend the "How did we do?" email for one completed job.
async function reviewResend(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const channel = body.channel === 'sms' ? 'sms' : 'email';
  const { data: b, error } = await db.from('bookings')
    .select('id, review_token, metadata, sms_consent, customer:customers(name, email, phone)')
    .eq('id', id).eq('business_id', biz.id).single();
  if (error || !b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.review_token) return res.status(400).json({ error: 'This job has no review link yet.' });

  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

  if (channel === 'sms') {
    if (!b.customer?.phone || !b.sms_consent) return res.status(400).json({ error: 'No SMS consent on file for this job.' });
    if (!smsNotificationsOn()) return res.status(503).json({ error: 'Text notifications are turned off.' });
    const smsClickUrl = `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(b.review_token)}&ch=sms`;
    const smsStatusCallback = `${baseUrl}/api/analytics?action=sms_status&token=${encodeURIComponent(b.review_token)}`;
    const msg = `How did we do?\n\nLeave your technician a review here:\n${smsClickUrl}\n\nSTOP to opt out`;
    const r = await sendSMSResult(b.customer.phone, msg, { statusCallback: smsStatusCallback });
    if (!r.ok) return res.status(502).json({ error: 'Text failed to send: ' + (r.error || 'unknown error') });

    const now = new Date().toISOString();
    await db.from('bookings').update({ metadata: { ...(b.metadata || {}), review_sms_sent_at: now } }).eq('id', id);
    // Best-effort tracking-column bump — same fresh-delivery-attempt reset as
    // the email path below (Twilio's status callback matches by review_token,
    // not message sid, so there's no id column to re-point here).
    try {
      await db.from('bookings').update({
        review_sms_sent_at: now, review_sms_status: 'sent', review_sms_delivered_at: null,
      }).eq('id', id);
    } catch (e) { /* column absent — metadata already updated above */ }
    return res.status(200).json({ ok: true });
  }

  if (!b.customer?.email) return res.status(400).json({ error: 'No customer email on file for this job.' });
  if (!emailNotificationsOn()) return res.status(503).json({ error: 'Email notifications are turned off.' });

  const emailClickUrl = `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(b.review_token)}&ch=email`;
  const { from } = emailConfig(biz.slug);
  const { subject, html } = reviewEmail({ firstName: b.customer.name || 'there', clickUrl: emailClickUrl }, brandFor(biz.slug));
  let emailResult;
  try {
    emailResult = await sendEmail({ slug: biz.slug, to: b.customer.email, subject, html, replyTo: from, throwOnError: true });
  } catch (e) {
    return res.status(502).json({ error: 'Email failed to send: ' + e.message });
  }

  const now = new Date().toISOString();
  await db.from('bookings').update({ metadata: { ...(b.metadata || {}), review_email_sent_at: now } }).eq('id', id);
  // Best-effort tracking-column bump (no-op if migration 0033 isn't applied).
  // A resend is a fresh delivery attempt — reset status to 'sent' and re-point
  // review_email_id at the NEW Resend message so the delivery webhook matches
  // the right send (the old id, if it never got picked up by the webhook,
  // simply goes stale).
  try {
    const { data: cur } = await db.from('bookings').select('review_email_count').eq('id', id).single();
    const next = (Number(cur?.review_email_count) || 0) + 1;
    await db.from('bookings').update({
      review_email_sent_at: now, review_email_count: next,
      review_email_id: emailResult.id || null, review_email_status: 'sent', review_email_delivered_at: null,
    }).eq('id', id);
  } catch (e) { /* column absent — metadata already updated above */ }

  return res.status(200).json({ ok: true });
}

// ── Review-call queue (Joey's daily outreach) ────────────────────────────────
// Cross-business: customers from BOTH companies who had a non-cancelled job on
// the schedule in the last `days` days (default 1 = yesterday, by scheduled_at so
// imported / not-yet-marked-done jobs still count), haven't submitted a review
// through our filter (reviewed_at null) and aren't a Google 4–5★, and haven't
// been resolved (promised / complaint / do-not-contact). Available to any
// signed-in office user — this is a calling tool, so it deliberately spans both
// businesses regardless of the secretary's normal single-business scope.
const REVIEW_CALL_STATUSES = ['called', 'voicemail', 'callback', 'reviewed', 'declined', 'do_not_contact', 'promised_review', 'complaint'];
// Statuses that resolve a customer OFF the queue: they promised a review, raised
// a complaint (handled + logged), or asked not to be contacted. 'voicemail' /
// 'callback' stay on the list so Joey tries again. ('reviewed' kept for old data.)
const REVIEW_CALL_RESOLVED = ['reviewed', 'do_not_contact', 'promised_review', 'complaint'];
const RC_TZ = 'America/Denver';
// NOTE: line_items lives in the booking_line_items TABLE (not a bookings
// column) — it must be embedded as a relation, exactly like bookingSelect().
const rcSelFor = (cc) => `id, status, completed_at, scheduled_at, review_rating, reviewed_at,
    review_email_opened_at, review_email_count, review_token, postal_code, sms_consent, ${cc}
    customer:customers ( name, phone, email, postal_code ),
    technician:technicians!technician_id ( name ),
    service:services ( id, name ),
    line_items:booking_line_items ( name, quantity, unit_price, line_total )`;
const RC_CALL_COLS = 'review_call_status, review_call_at, review_call_by, review_call_notes,';
function rcMapRow(row, b) {
  return {
    id: row.id,
    business_slug: b.slug,
    business_name: b.name,
    customer_name: row.customer?.name || '—',
    phone: row.customer?.phone || null,
    zip: row.postal_code || row.customer?.postal_code || null,   // booking zip first; imported customers often have it only on the booking
    has_email: !!row.customer?.email,
    has_sms: !!(row.customer?.phone && row.sms_consent),
    technician_name: row.technician?.name || '—',
    service_name: row.service?.name || 'Service',
    // What they bought — so Joey can reference it on the call.
    line_items: (Array.isArray(row.line_items) ? row.line_items : [])
      .filter(li => li && (li.name || li.description))
      .map(li => ({ name: String(li.name || li.description), qty: Number(li.quantity || li.qty) || 1, price: Number(li.line_total != null ? li.line_total : li.unit_price) || 0 })),
    when: row.scheduled_at || row.completed_at || null,
    is_completed: row.status === 'completed',
    email_opened: !!row.review_email_opened_at,
    email_count: row.review_email_count || 0,
    rating: row.review_rating || null,          // 1–3 = they gave us negative feedback (handle with care)
    has_review_link: !!row.review_token,
    reviewed: row.reviewed_at != null || Number(row.review_rating) >= 4,
    call_status: row.review_call_status || null,
    call_at: row.review_call_at || null,
    call_by: row.review_call_by || null,
    call_notes: row.review_call_notes || null,
  };
}
// Which review_call_status values live in each browsable folder — 'voicemail'
// and 'callback' both mean "left a message, try again," so they share a folder.
const RC_STATUS_TO_FOLDER = { complaint: 'complaint', promised_review: 'promised_review', voicemail: 'voicemail', callback: 'voicemail', do_not_contact: 'do_not_contact' };

async function reviewCalls(req, res, db, auth) {
  // Joey's (Doms) outreach tool — not part of Heather's (Handy Andy) platform.
  if (auth.scope === 'handy-andy') return res.status(403).json({ error: 'Review Calls is not available on this account.' });
  const folder = (req.query.folder || 'to_call').toString();
  const { data: bizs } = await db.from('businesses').select('id, slug, name, timezone').eq('active', true);
  const warnings = [];

  if (folder !== 'to_call') {
    // Folder browsing (Complaints / Promised review / Voicemail / Do not
    // contact) — grouped by the calendar week (Sun–Sat) the call was LOGGED
    // (review_call_at), not the job's scheduled date, so resolved calls are
    // still reachable weeks later instead of disappearing once handled.
    if (!['complaint', 'promised_review', 'voicemail', 'do_not_contact'].includes(folder)) {
      return res.status(400).json({ error: 'Invalid folder' });
    }
    let weekOffset = parseInt(req.query.week_offset);
    if (!isFinite(weekOffset)) weekOffset = 0;
    weekOffset = Math.max(-520, Math.min(0, weekOffset));   // up to ~10 years back, never the future
    const weekBase = new Date(Date.now() + weekOffset * 7 * 86400000);
    const weekStart = startOfWeekUTC(RC_TZ, weekBase);
    const weekEnd = localDayStartUTC(RC_TZ, 7, weekStart);

    const out = [];
    const folderCounts = { complaint: 0, promised_review: 0, voicemail: 0, do_not_contact: 0 };
    for (const b of (bizs || [])) {
      const { data, error } = await db.from('bookings').select(rcSelFor(RC_CALL_COLS))
        .eq('business_id', b.id)
        .gte('review_call_at', weekStart.toISOString()).lt('review_call_at', weekEnd.toISOString())
        .order('review_call_at', { ascending: false }).limit(500);
      if (error) { console.warn('[review_calls:folder]', b.slug, error.message); warnings.push(`${b.name}: ${error.message}`); continue; }
      for (const row of (data || [])) {
        const fkey = RC_STATUS_TO_FOLDER[row.review_call_status];
        if (!fkey) continue;
        folderCounts[fkey]++;
        if (fkey === folder) out.push(rcMapRow(row, b));
      }
    }
    out.sort((a, c) => new Date(c.call_at || 0) - new Date(a.call_at || 0));
    const fmtMD = (d) => new Intl.DateTimeFormat('en-US', { timeZone: RC_TZ, month: 'short', day: 'numeric' }).format(d);
    const weekLastDay = new Date(weekEnd.getTime() - 86400000);
    return res.status(200).json({
      calls: out,
      warning: warnings.length ? warnings.join(' · ') : null,
      folder_counts: folderCounts,
      week_offset: weekOffset,
      week_label: `${fmtMD(weekStart)} – ${fmtMD(weekLastDay)}`,
    });
  }

  const days = Math.max(1, Math.min(Number(req.query.days) || 1, 30));
  const out = [];
  for (const b of (bizs || [])) {
    const tz = b.timezone || RC_TZ;
    const winStart = localDayStartUTC(tz, -days);   // start of (today − days), that business's local day
    const winEnd = localDayStartUTC(tz, 0);          // start of today — give them the day of the job to review first
    // Base the window on scheduled_at (ALWAYS set) rather than completed_at — the
    // latter is null for imported jobs and for any job the tech didn't tap
    // "complete" on. Include every non-cancelled booking that was on the schedule
    // that day: a job scheduled yesterday happened, whether or not it's marked done.
    const run = (cc) => db.from('bookings').select(rcSelFor(cc))
      .eq('business_id', b.id)
      .in('status', ['confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed'])
      .gte('scheduled_at', winStart.toISOString()).lt('scheduled_at', winEnd.toISOString())
      .order('scheduled_at', { ascending: false }).limit(500);
    let { data, error } = await run(RC_CALL_COLS);
    if (error && /review_call_/.test(error.message || '')) ({ data, error } = await run(''));   // migration 0049 not applied yet
    if (error) { console.warn('[review_calls]', b.slug, error.message); warnings.push(`${b.name}: ${error.message}`); continue; }
    for (const row of (data || [])) {
      // Skip anyone who already left us a rating through our review filter:
      // reviewed_at is stamped whenever a customer submits ANY 1–5★ (Google-routed
      // 4–5★ or private 1–3★), so it's the precise "they rated us in the CRM"
      // signal. Plus a >= 4 backstop. A job that merely carries a stale imported
      // rating (no submission → no reviewed_at) stays callable.
      if (row.reviewed_at != null || Number(row.review_rating) >= 4) continue;
      if (REVIEW_CALL_RESOLVED.includes(row.review_call_status)) continue;   // handled by Joey — find it under its folder tab now
      out.push(rcMapRow(row, b));
    }
  }
  // Not-yet-called first, then most-recently-completed first.
  out.sort((a, c) => {
    const au = a.call_status ? 1 : 0, cu = c.call_status ? 1 : 0;
    if (au !== cu) return au - cu;
    return new Date(c.when || 0) - new Date(a.when || 0);
  });
  return res.status(200).json({
    calls: out,
    warning: warnings.length ? warnings.join(' · ') : null,
    counts: {
      total: out.length,
      to_call: out.filter(x => !x.call_status).length,
      called: out.filter(x => x.call_status).length,
    },
  });
}

// Log the outcome of a review call (Joey). Cross-business: resolve by id.
async function reviewCallLog(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.scope === 'handy-andy') return res.status(403).json({ error: 'Review Calls is not available on this account.' });
  const id = body && body.id;
  const status = ((body && body.status) || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  if (status && !REVIEW_CALL_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const { data: bk } = await db.from('bookings').select('id').eq('id', id).maybeSingle();
  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  const patch = {
    review_call_status: status || null,
    review_call_at: status ? new Date().toISOString() : null,
    review_call_by: status ? displayNameFor(auth.scope) : null,
  };
  if (typeof body.notes === 'string') patch.review_call_notes = body.notes.trim().slice(0, 500) || null;

  let { error } = await db.from('bookings').update(patch).eq('id', id);
  if (error && /review_call_/.test(error.message || '')) {
    return res.status(503).json({ error: 'The review-call queue needs a quick database update (migration 0049) before outcomes can be saved.' });
  }
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function reviews(req, res, db, auth) {
  const biz = await resolveBusiness(db, auth, req.query.business || '');

  const { data: revs, error } = await db.from('bookings')
    .select(`
      id, status, scheduled_at, review_rating, review_text, reviewed_at,
      customer:customers(name, phone),
      technician:technicians!technician_id(id, name, color),
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

// ── Google Business Profile reviews ─────────────────────────────────────────
// Reviews ingested from the Google review-notification emails (migration 0042).
// Degrades to an empty list if the table isn't applied yet.
async function googleReviews(req, res, db, auth) {
  const biz = await resolveBusiness(db, auth, req.query.business || '');
  const selectWithDismiss = `id, reviewer_name, rating, review_text, review_date, seen, dismissed_at, created_at, technician_id, booking_id,
             technician:technicians ( id, name )`;
  let { data: rows, error } = await db.from('google_reviews')
    .select(selectWithDismiss)
    .eq('business_id', biz.id)
    .order('created_at', { ascending: false })
    .limit(100);
  // Pre-0065 database: dismissed_at doesn't exist yet — retry without it so the
  // list still works (nothing can be dismissed until the migration is applied).
  if (error && /dismissed_at/.test(error.message || '')) {
    ({ data: rows, error } = await db.from('google_reviews')
      .select(`id, reviewer_name, rating, review_text, review_date, seen, created_at, technician_id, booking_id,
               technician:technicians ( id, name )`)
      .eq('business_id', biz.id)
      .order('created_at', { ascending: false })
      .limit(100));
  }
  if (error) {
    if (/google_reviews/.test(error.message || '')) return res.status(200).json({ reviews: [] });
    throw error;
  }
  return res.status(200).json({
    reviews: (rows || []).filter(r => !r.dismissed_at).map(r => ({
      id: r.id,
      reviewer_name: r.reviewer_name || 'A customer',
      rating: r.rating,
      review_text: r.review_text || '',
      review_date: r.review_date,
      created_at: r.created_at,
      seen: !!r.seen,
      technician_id: r.technician_id || null,
      technician_name: r.technician?.name || null,
      booking_id: r.booking_id || null,
    })),
  });
}

// Dismiss the "new Google review" banner (seen=true), permanently hide it from
// the Reviews tab list (dismissed=true), or re-attribute it to a technician.
// Scoped to the caller's business.
async function googleReviewUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const biz = await resolveBusiness(db, auth, body.business || '');
  const id = (body.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const patch = {};
  if (body.seen !== undefined) patch.seen = !!body.seen;
  if (body.dismissed !== undefined) patch.dismissed_at = body.dismissed ? new Date().toISOString() : null;
  if (body.technician_id !== undefined) {
    const tid = (body.technician_id || '').toString() || null;
    if (tid) {
      let { data: t } = await db.from('technicians').select('id').eq('id', tid).eq('business_id', biz.id).maybeSingle();
      // A review can legitimately credit a cross-hire tech from the partner
      // company (e.g. a Dom's tech who helped on a Handy Andy job) — the
      // dropdown already offers them (public/admin.html renderReviews), so
      // the same id must be accepted here instead of 404ing.
      if (!t) {
        const partner = await partnerBusiness(db, biz.slug);
        if (partner) {
          ({ data: t } = await db.from('technicians').select('id').eq('id', tid).eq('business_id', partner.id).maybeSingle());
        }
      }
      if (!t) return res.status(404).json({ error: 'Technician not found' });
    }
    patch.technician_id = tid;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });
  let { error } = await db.from('google_reviews').update(patch).eq('id', id).eq('business_id', biz.id);
  // Pre-0065 database: dismissed_at doesn't exist yet — drop it and retry so
  // seen/technician updates still work even before the migration is applied.
  if (error && /dismissed_at/.test(error.message || '') && 'dismissed_at' in patch) {
    delete patch.dismissed_at;
    if (!Object.keys(patch).length) return res.status(503).json({ error: 'Dismiss not available yet — migration 0065 not applied.' });
    ({ error } = await db.from('google_reviews').update(patch).eq('id', id).eq('business_id', biz.id));
  }
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

// ── Bad-review alerts (1-star reviews in the last 24h) ──────────────────────
// Powers the red "ATTENTION" banner at the top of the dashboard. Scope-aware:
//   owner      -> 1-star reviews across ALL active businesses
//   secretary  -> only their own business (Heather=Handy Andy, Joey=Doms)
// A review auto-drops off the banner 24h after it was submitted. Each alert
// carries enough to display (tech, customer name/phone, appointment date) and
// the booking id so the dashboard can open the exact job on click.
async function badReviews(req, res, db, auth) {
  // Businesses this token may see. The list itself enforces the scoping.
  let bizQ = db.from('businesses').select('id, slug, name').eq('active', true);
  if (auth.scope !== 'all') bizQ = bizQ.eq('slug', auth.scope);
  const { data: bizRows, error: bizErr } = await bizQ;
  if (bizErr) throw bizErr;
  const bizById = new Map((bizRows || []).map(b => [b.id, b]));
  const bizIds = (bizRows || []).map(b => b.id);
  if (!bizIds.length) return res.status(200).json({ alerts: [] });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: revs, error } = await db.from('bookings')
    .select(`id, business_id, scheduled_at, reviewed_at, review_rating, review_text,
             customer:customers ( name, phone ),
             technician:technicians!technician_id ( id, name )`)
    .in('business_id', bizIds)
    .in('review_rating', [1, 2, 3])
    .gte('reviewed_at', since)
    .order('reviewed_at', { ascending: false })
    .limit(50);
  if (error) throw error;

  const alerts = (revs || []).map(r => {
    const biz = bizById.get(r.business_id) || {};
    return {
      id: r.id,
      rating: r.review_rating,
      business_slug: biz.slug || '',
      business_name: biz.name || '',
      technician_name: r.technician?.name || 'Unassigned',
      customer_name: r.customer?.name || 'Customer',
      customer_phone: r.customer?.phone || '',
      scheduled_at: r.scheduled_at,
      reviewed_at: r.reviewed_at,
      review_text: r.review_text || '',
    };
  });
  return res.status(200).json({ alerts });
}

// ── Estimates (customer quote requests from the public estimate page) ────────
// Avg ticket per business for a 7-day window offset by whole weeks (0 = last 7
// days, -1 = the week before, …). Same math as the dashboard's avg_by_slug, so
// the box can page back/forward a week. Owner-only.
async function avgTicketWeek(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const tz = biz.timezone || 'America/Denver';
  let offset = parseInt(req.query.offset);
  if (!isFinite(offset)) offset = 0;
  offset = Math.max(-260, Math.min(0, offset));   // up to ~5 years back, never the future
  const start = localDayStartUTC(tz, -6 + offset * 7);
  const end = localDayStartUTC(tz, 1 + offset * 7);
  const { data: allBiz } = await db.from('businesses').select('id, slug').eq('active', true);
  const bySlug = {};
  await Promise.all((allBiz || []).map(async (bb) => {
    const { data: rows } = await db.from('bookings').select('price')
      .eq('business_id', bb.id)
      .gte('scheduled_at', start.toISOString()).lt('scheduled_at', end.toISOString())
      .eq('status', 'completed');
    const real = (rows || []).filter(x => Number(x.price) > 0);   // drop $0/free tickets
    const count = real.length;
    const total = Math.round(real.reduce((n, x) => n + Number(x.price || 0), 0) * 100) / 100;
    bySlug[bb.slug] = { avg: count ? Math.round(total / count) : null, count, total };
  }));
  const fmtMD = (d) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
  const lastDay = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return res.status(200).json({ avg_by_slug: bySlug, range_label: `${fmtMD(start)} – ${fmtMD(lastDay)}`, offset });
}

// Google Search Console data for a business's site (free — see api/_lib/gsc.js).
// Best-effort: this is a bonus data source layered onto Website Analytics, so a
// missing/misconfigured credential degrades to empty lists with an explanatory
// `error` string rather than breaking the page. Two API calls cover four views:
//   - dimensions=['query'] (up to 500 rows) -> top queries, striking-distance
//     keywords (position 11-20), and the branded/non-branded click split
//   - dimensions=['query','page'] -> which landing page each query lands on
async function gscQueries(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const domain = GSC_DOMAIN_BY_SLUG[biz.slug];
  if (!domain) return res.status(200).json({ rows: [], strikingDistance: [], queryPages: [], brandSplit: null, error: `No Search Console domain configured for ${biz.slug}` });
  const days = Math.max(1, Math.min(Number(req.query.days) || 28, 480));
  // Search Console data lags ~2-3 days behind real time, so end a few days
  // back instead of "today" — otherwise the freshest days come back empty.
  const end = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().split('T')[0];
  const startDate = fmt(start), endDate = fmt(end);
  try {
    const [byQuery, byQueryPage] = await Promise.all([
      gscQuery({ domain, startDate, endDate, dimensions: ['query'], rowLimit: 500 }),
      gscQuery({ domain, startDate, endDate, dimensions: ['query', 'page'], rowLimit: 50 }),
    ]);
    const queryRows = byQuery.rows.map(r => ({ query: r.keys[0] || '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
    const rows = [...queryRows].sort((a, b) => b.clicks - a.clicks).slice(0, 25);

    // Striking distance: page-2-ish rankings with real impressions behind them
    // — small on-page work here has the best odds of moving the needle.
    const strikingDistance = queryRows
      .filter(r => r.position >= 11 && r.position <= 20 && r.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 25);

    // Branded vs non-branded — how much of this traffic already knew the
    // business name vs. genuine new discovery through search.
    const brandTerms = GSC_BRAND_TERMS[biz.slug] || [];
    const isBranded = (q) => brandTerms.some(t => q.toLowerCase().includes(t));
    const brandedClicks = queryRows.filter(r => isBranded(r.query)).reduce((s, r) => s + r.clicks, 0);
    const totalClicks = queryRows.reduce((s, r) => s + r.clicks, 0);
    const brandSplit = { branded: brandedClicks, nonBranded: totalClicks - brandedClicks };

    const queryPages = byQueryPage.rows
      .map(r => ({ query: r.keys[0] || '', page: r.keys[1] || '', clicks: r.clicks, impressions: r.impressions, position: r.position }))
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 25);

    return res.status(200).json({ site: byQuery.site, rangeDays: days, rows, strikingDistance, queryPages, brandSplit });
  } catch (e) {
    return res.status(200).json({ rows: [], strikingDistance: [], queryPages: [], brandSplit: null, error: e.message });
  }
}

async function estimates(req, res, db, auth) {
  const biz = await resolveBusiness(db, auth, req.query.business || '');
  const status = (req.query.status || '').toString();
  // Select with the full column set; if an optional column (e.g. customer_zip
  // from a not-yet-applied migration) is missing from the schema cache, drop it
  // and retry so the Estimates list still loads instead of erroring outright.
  // Auto-archive: UNSENT requests (status 'new') older than 7 days drop into the
  // Archived folder, since nobody ever quoted them and the working "Needs
  // Response" list should only show the last week's worth. Once an estimate has
  // been SENT ('contacted') or APPROVED ('scheduled') it is exempt and stays
  // visible indefinitely under "Estimate sent" — the office wants to keep
  // seeing it (with its "no response in Nd+ days" badge) rather than have it
  // silently vanish into Archived while still awaiting the customer.
  // Idempotent (skips already-archived); best-effort so it never blocks the list.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await db.from('estimates').update({ status: 'archived' })
      .eq('business_id', biz.id).eq('status', 'new')
      .lt('created_at', sevenDaysAgo);
  } catch (e) { console.warn('[admin] estimate auto-archive failed:', e.message); }

  let cols = 'id, service_label, customer_name, customer_phone, customer_email, customer_zip, description, photo_url, preferred_slots, status, sms_consent, notes, line_items, tax_rate, upsells, accepted_upsells, approved_total, approved_at, created_at, contacted_at, contacted_by';
  const runQuery = () => {
    let q = db.from('estimates').select(cols)
      .eq('business_id', biz.id)
      .order('created_at', { ascending: false })
      .limit(200);
    // A specific status (incl. 'archived') filters to it; the default/'all' view
    // hides archived so converted + aged-out estimates leave the working list.
    if (status && status !== 'all') q = q.eq('status', status);
    else q = q.neq('status', 'archived');
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
    const VALID = ['new', 'contacted', 'scheduled', 'closed', 'archived'];
    if (!VALID.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
    patch.status = body.status;
    // Manually flipping the status dropdown to "Estimate sent" is the same
    // real-world event as the Send email/text buttons (markEstimateContacted) —
    // stamp who/when the same way, so the card always shows it regardless of
    // which path got it there. The missing-column degrade below (stripAndRetry)
    // already drops these two if the migration isn't applied yet.
    if (body.status === 'contacted') {
      patch.contacted_at = new Date().toISOString();
      patch.contacted_by = auth.name || adminAuthorName(auth);
    }
  }
  if (typeof body.notes === 'string') patch.notes = body.notes.trim() || null;
  if (typeof body.service_label === 'string') patch.service_label = body.service_label.trim() || null;
  if (typeof body.description === 'string') patch.description = body.description.trim();
  if (Array.isArray(body.line_items)) patch.line_items = sanitizeLineItems(body.line_items);
  if (Array.isArray(body.upsells)) patch.upsells = sanitizeUpsells(body.upsells);
  if (body.tax_rate !== undefined) patch.tax_rate = normalizeTaxRate(body.tax_rate);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  // line_items / tax_rate / upsells come from not-yet-applied migrations on some
  // databases. If the missing column is one of those, drop it and retry so the
  // rest of the update still lands (upsells silently no-ops until 0048 is applied).
  const stripAndRetry = async () => {
    let { error } = await db.from('estimates').update(patch).eq('id', body.id).eq('business_id', biz.id);
    for (let i = 0; error && i < 3; i++) {
      const col = missingColumn(error.message);
      if (!col || !(col in patch)) break;
      console.warn(`[estimate_update] '${col}' column missing, retrying without it`);
      delete patch[col];
      if (!Object.keys(patch).length) return { error: null };
      ({ error } = await db.from('estimates').update(patch).eq('id', body.id).eq('business_id', biz.id));
    }
    return { error };
  };
  let { error } = await stripAndRetry();
  if (error && ['line_items', 'tax_rate'].includes(missingColumn(error.message))) {
    return res.status(503).json({ error: 'The quote builder needs a quick database update (migration 0028) before it can save. Please apply it and try again.' });
  }
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

// Clamp a tax rate to a sane fraction (0 .. 0.25). Accepts 8.75 (percent) or
// 0.0875 (fraction); values > 1 are treated as a percentage.
function normalizeTaxRate(raw) {
  let r = Number(raw);
  if (!Number.isFinite(r) || r < 0) r = 0;
  if (r > 1) r = r / 100;
  if (r > 0.25) r = 0.25;
  return Math.round(r * 100000) / 100000;
}

// Tax rate for estimates created from the NEW BOOKING modal's "Send estimate"
// branch (its only consumer). Must equal the modal's own TAX_RATE (8.25%,
// public/admin.html) — this used to be 8.75%, so the emailed/texted estimate
// total never matched what the secretary saw on screen, nor what the booking
// would charge after conversion. The Estimates-tab quote builder keeps its own
// separate default (EST_TAX_RATE in admin.html) and per-estimate tax_rate.
const DEFAULT_EST_TAX_RATE = 0.0825;

// Normalize quote line items to the stored shape: { description, qty, unit_price }.
// Drops blank rows, clamps to sane numbers, caps the list so a bad client can't
// bloat a row. qty/unit_price are coerced to non-negative numbers.
function sanitizeLineItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 50)
    .map(it => {
      const description = String((it && it.description) || '').trim().slice(0, 300);
      let qty = Number(it && it.qty);
      let unit_price = Number(it && it.unit_price);
      if (!Number.isFinite(qty) || qty < 0) qty = 0;
      if (!Number.isFinite(unit_price) || unit_price < 0) unit_price = 0;
      // round qty to 2 decimals (allows "1.5 hrs"), price to cents
      qty = Math.round(qty * 100) / 100;
      unit_price = Math.round(unit_price * 100) / 100;
      return { description, qty, unit_price };
    })
    .filter(it => it.description || it.unit_price > 0);
}

// Normalize the recommended-add-on menu the office attaches to an estimate.
// Stored shape: { id, description, qty, unit_price, tech_pay, badge, blurb, default_on }.
// - id: a short stable key so the customer's selection can be matched back to the
//   server's stored price (client prices are never trusted on approval).
// - tech_pay: OFFICE-ONLY — carried through to convert-to-job/payroll, never sent
//   to the public approve page.
// Caps the list and clamps every number so a bad client can't bloat or mis-price a row.
function sanitizeUpsells(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .slice(0, 30)
    .map((it, i) => {
      const description = String((it && it.description) || '').trim().slice(0, 160);
      let id = String((it && it.id) || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
      if (!id) id = 'u' + i;
      let qty = Number(it && it.qty);
      let unit_price = Number(it && it.unit_price);
      let tech_pay = Number(it && it.tech_pay);
      if (!Number.isFinite(qty) || qty <= 0) qty = 1;
      if (!Number.isFinite(unit_price) || unit_price < 0) unit_price = 0;
      if (!Number.isFinite(tech_pay) || tech_pay < 0) tech_pay = 0;
      qty = Math.round(qty * 100) / 100;
      unit_price = Math.round(unit_price * 100) / 100;
      tech_pay = Math.round(tech_pay * 100) / 100;
      const badge = String((it && it.badge) || '').trim().slice(0, 40);
      const blurb = String((it && it.blurb) || '').trim().slice(0, 240);
      const default_on = !!(it && it.default_on);
      return { id, description, qty, unit_price, tech_pay, badge, blurb, default_on };
    })
    .filter(it => it.description)
    // de-dupe ids so the customer's selection always maps to exactly one price
    .filter(it => { if (seen.has(it.id)) return false; seen.add(it.id); return true; });
}

// Public-safe view of the upsell menu for the approve page: drops tech_pay so the
// customer never sees our cost/margin.
function publicUpsells(items) {
  return (Array.isArray(items) ? items : []).map(u => ({
    id: u.id, description: u.description, qty: u.qty, unit_price: u.unit_price,
    badge: u.badge || '', blurb: u.blurb || '', default_on: !!u.default_on,
  }));
}

// Fetch one estimate by id, tolerating the quote columns (line_items, tax_rate)
// being absent (migration 0028 not applied) by dropping whichever is missing and
// retrying. Returns the row with line_items: [] and tax_rate: 0 defaulted.
async function fetchEstimate(db, id, businessId, baseCols) {
  const optional = ['line_items', 'tax_rate'];
  let cols = [baseCols, ...optional].join(', ');
  let data, error;
  for (let i = 0; i < 4; i++) {
    ({ data, error } = await db.from('estimates').select(cols).eq('id', id).eq('business_id', businessId).maybeSingle());
    if (!error) break;
    const col = missingColumn(error.message);
    if (!col || !cols.includes(col)) break;
    cols = cols.split(',').map(s => s.trim()).filter(c => c !== col).join(', ');
  }
  if (error) throw error;
  if (data) {
    if (!Array.isArray(data.line_items)) data.line_items = [];
    if (data.tax_rate == null) data.tax_rate = 0;
  }
  return data;
}

// { subtotal, tax, total } for a quote, all rounded to cents.
function quoteTotals(items, taxRate) {
  const subtotal = lineItemsTotal(items);
  const rate = Number(taxRate) || 0;
  const tax = Math.round(subtotal * rate * 100) / 100;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

// Insert an estimate, tolerating a column the local schema doesn't have yet
// (e.g. line_items before migration 0028 is applied) by dropping it and retrying.
async function insertEstimateResilient(db, row) {
  const payload = { ...row };
  for (let i = 0; i < 6; i++) {
    const { data, error } = await db.from('estimates').insert(payload).select('id').maybeSingle();
    if (!error) return { data, error: null };
    const col = missingColumn(error.message);
    if (col && Object.prototype.hasOwnProperty.call(payload, col)) {
      console.warn(`[estimate_create] '${col}' column missing, retrying without it`);
      delete payload[col];
      continue;
    }
    return { data: null, error };
  }
  return { data: null, error: new Error('insert estimate failed after stripping unknown columns') };
}

// Sum of qty * unit_price across line items, rounded to cents.
function lineItemsTotal(items) {
  const sum = (Array.isArray(items) ? items : [])
    .reduce((t, it) => t + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
  return Math.round(sum * 100) / 100;
}

// Best-effort "mark contacted" after a quote goes out. Never throws — a failed
// status bump must not turn a successful send into an error for the user.
// Stamps WHO sent it and WHEN (migration estimates_contacted_stamp) so the
// Estimates tab can show "Sent by Heather · Fri, Jul 17, 9:02 AM" instead of
// just a status label. Degrades to a status-only update if that migration
// isn't applied yet on some environment.
async function markEstimateContacted(db, businessId, id, sentBy) {
  try {
    const { error } = await db.from('estimates')
      .update({ status: 'contacted', contacted_at: new Date().toISOString(), contacted_by: sentBy || null })
      .eq('id', id).eq('business_id', businessId);
    if (error && missingColumn(error.message)) {
      const { error: e2 } = await db.from('estimates').update({ status: 'contacted' }).eq('id', id).eq('business_id', businessId);
      if (e2) console.warn('[estimate] could not mark contacted:', e2.message);
      return;
    }
    if (error) console.warn('[estimate] could not mark contacted:', error.message);
  } catch (e) {
    console.warn('[estimate] mark contacted threw:', e.message);
  }
}

// Create an estimate from New Booking form data, then email it to the customer
async function estimateCreate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const { customer_name, customer_phone, customer_email, selections, service_label } = body;
  if (!customer_name || !customer_email) return res.status(400).json({ error: 'Customer name and email required' });
  // Keep the zip so the approve page can show real availability for the right metro.
  const customer_zip = (body.postal_code || body.customer_zip || '').toString().replace(/\D/g, '').slice(0, 5) || null;

  // Turn the selections into priced line items — these ARE the estimate detail.
  let description = '';
  let line_items = [];
  if (selections && Array.isArray(selections)) {
    line_items = sanitizeLineItems(selections.map(s => ({
      description: s.label,
      qty: s.quantity || 1,
      unit_price: s.price || 0,
    })));
  }
  // Don't also store a comma-joined dump of the selections as the description —
  // it just duplicated the line items on the estimate card. Only keep a
  // description when there are no line items to show instead.
  if (!line_items.length) description = 'Estimate for services requested';

  // Recommended add-ons the office attached in the "Send Estimate" popover. These
  // ride on the estimate so the customer can toggle them on the approve page.
  const upsells = sanitizeUpsells(body.upsells);

  // Create the estimate record. insertResilientEstimate() tolerates a column
  // being absent (line_items before 0028, upsells before 0048) by dropping it
  // and retrying, so an estimate is never lost to schema drift.
  const { data: est, error: createErr } = await insertEstimateResilient(db, {
    business_id: biz.id,
    customer_name: customer_name.trim(),
    customer_phone: customer_phone ? customer_phone.trim() : null,
    customer_email: customer_email.trim(),
    customer_zip,
    service_label: service_label || 'Custom Estimate',
    description,
    line_items,
    upsells,
    // Store the rate the email/SMS totals were computed with, so the estimate
    // card and the customer approve page show the SAME tax the customer was
    // quoted (previously left null — the card showed no tax at all).
    tax_rate: DEFAULT_EST_TAX_RATE,
    status: 'new',
    sms_consent: body.sms_consent !== false,
    source: 'manual',
  });

  if (createErr) throw createErr;
  if (!est) return res.status(500).json({ error: 'Failed to create estimate' });

  // Now send the email immediately
  if (!emailNotificationsOn()) {
    // Still created, but email won't send
    return res.status(201).json({ id: est.id, ok: true, warning: 'Email notifications are turned off' });
  }

  const { apiKey } = emailConfig(biz.slug);
  if (!apiKey) {
    return res.status(201).json({ id: est.id, ok: true, warning: 'Email service not configured' });
  }

  const firstName = (customer_name || '').trim().split(/\s+/)[0];
  // 90-day signed approve link (same as the Estimates-tab "send" flow), so the
  // New Booking estimate email also gets an "I approve this estimate" button.
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const approveToken = signToken({ kind: 'estimate_approve', estimate_id: est.id }, 7776000);
  const approveUrl = baseUrl ? `${baseUrl}/estimate-approve.html?token=${encodeURIComponent(approveToken)}` : '';
  const { subject, html } = estimateEmail(
    { firstName, serviceLabel: service_label || 'Custom Estimate', description, lineItems: line_items, taxRate: DEFAULT_EST_TAX_RATE, approveUrl, upsells: publicUpsells(upsells) },
    brandFor(biz.slug)
  );

  try {
    await sendEmail({ slug: biz.slug, to: customer_email.trim(), subject, html, throwOnError: true });
    await markEstimateContacted(db, biz.id, est.id, auth.name || adminAuthorName(auth));
  } catch (e) {
    console.warn('[estimate_create] email send failed, but estimate created:', e.message);
    return res.status(201).json({ id: est.id, ok: true, warning: `Estimate created but email failed: ${e.message}` });
  }

  // Also text the customer the estimate + a link to view/approve it, so a
  // phone-first customer can act on the same tap-through the email offers.
  // Best-effort: a texting hiccup must never turn a sent estimate into an
  // error (the email already went out above), so failures are logged only.
  let texted = false;
  if (customer_phone && body.sms_consent !== false && approveUrl) {
    try {
      const { total } = quoteTotals(line_items, DEFAULT_EST_TAX_RATE);
      const greeting = firstName ? `Hi ${firstName}, ` : '';
      const svcTxt = (service_label && service_label !== 'Custom Estimate') ? `${service_label}: ` : '';
      const totalTxt = line_items.length ? `Estimated total $${total.toFixed(2)} (incl. tax). ` : '';
      const msg = `${greeting}here's your estimate. ${svcTxt}${totalTxt}View & approve it here: ${approveUrl}\n\nReply or call with any questions. Reply STOP to opt out.`;
      const r = await sendSMSResult(customer_phone, msg);
      texted = !!r.ok;
      if (!r.ok) console.warn(`[estimate_create] estimate SMS not sent:`, r.skipped || r.error);
    } catch (e) {
      console.warn('[estimate_create] estimate SMS threw:', e.message);
    }
  }

  return res.status(201).json({ id: est.id, ok: true, texted });
}

// Send quote SMS to customer
async function estimateSendSms(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const est = await fetchEstimate(db, body.id, biz.id, 'customer_name, customer_phone, service_label, description, sms_consent');
  if (!est) return res.status(404).json({ error: 'Estimate not found' });
  if (!est.customer_phone) return res.status(400).json({ error: 'Customer phone not available for this estimate.' });
  if (est.sms_consent === false) return res.status(400).json({ error: 'Customer did not consent to receive text messages.' });

  const firstName = (est.customer_name || '').trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName}, ` : '';
  const svcTxt = est.service_label ? `${est.service_label}: ` : '';
  // If the office built priced line items, lead with the total; otherwise fall
  // back to the request description so the text is never empty/meaningless.
  const items = Array.isArray(est.line_items) ? est.line_items : [];
  const { total } = quoteTotals(items, est.tax_rate);
  const body_txt = items.length
    ? `${items.map(it => `${it.qty && it.qty !== 1 ? it.qty + '× ' : ''}${it.description}`).filter(Boolean).slice(0, 4).join('; ')}. Estimated total: $${total.toFixed(2)}${Number(est.tax_rate) > 0 ? ' (incl. tax)' : ''}`
    : (est.description || 'Your estimate request');
  const msg = `${greeting}here's your estimate. ${svcTxt}${body_txt}. Reply or call us to get scheduled.`;

  const r = await sendSMSResult(est.customer_phone, msg);
  if (!r.ok) {
    if (r.skipped === 'notifications_off') return res.status(503).json({ error: 'Texting is turned off until the account is approved.' });
    if (r.skipped === 'not_configured')   return res.status(503).json({ error: 'SMS service (Twilio) is not configured.' });
    if (r.skipped === 'bad_phone')        return res.status(400).json({ error: `"${est.customer_phone}" is not a valid mobile number.` });
    return res.status(502).json({ error: r.error || 'Text message failed to send.' });
  }

  await markEstimateContacted(db, biz.id, body.id, auth.name || adminAuthorName(auth));
  return res.status(200).json({ ok: true });
}

// Send quote email to customer
async function estimateSendEmail(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const est = await fetchEstimate(db, body.id, biz.id, 'customer_name, customer_email, service_label, description, upsells');
  if (!est) return res.status(404).json({ error: 'Estimate not found' });
  if (!est.customer_email) return res.status(400).json({ error: 'Customer email not available for this estimate.' });
  if (!emailNotificationsOn()) return res.status(503).json({ error: 'Email notifications are turned off until the account is approved.' });

  const { apiKey } = emailConfig(biz.slug);
  if (!apiKey) {
    console.warn('[estimate] Resend key not set, cannot send email');
    return res.status(503).json({ error: 'Email service is not configured.' });
  }

  const firstName = (est.customer_name || '').trim().split(/\s+/)[0];
  // 90-day signed link the customer clicks to approve this quote. Verified
  // server-side by estimate_approve — no public token column needed on the row.
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const approveToken = signToken({ kind: 'estimate_approve', estimate_id: body.id }, 7776000); // 90 days
  const approveUrl = baseUrl ? `${baseUrl}/estimate-approve.html?token=${encodeURIComponent(approveToken)}` : '';
  const { subject, html } = estimateEmail(
    { firstName, serviceLabel: est.service_label, description: est.description, lineItems: est.line_items, taxRate: est.tax_rate, approveUrl, upsells: publicUpsells(est.upsells) },
    brandFor(biz.slug)
  );

  try {
    await sendEmail({ slug: biz.slug, to: est.customer_email, subject, html, throwOnError: true });
  } catch (e) {
    return res.status(502).json({ error: `Email failed to send: ${e.message}` });
  }

  await markEstimateContacted(db, biz.id, body.id, auth.name || adminAuthorName(auth));
  return res.status(200).json({ ok: true });
}

// ── Public estimate approval (token-based, no admin auth) ────────────────────
// The "I approve" button in a quote email links to /estimate-approve.html with a
// 90-day signed token (kind=estimate_approve, estimate_id). The page loads a
// read-only quote summary (GET info) and records approval (POST). Mirrors the
// public review flow. Service role bypasses RLS; the estimate id is global.
function approveTokenEstimateId(raw) {
  const t = verifyToken((raw || '').toString());
  if (!t || t.kind !== 'estimate_approve' || !t.estimate_id) return null;
  return t.estimate_id;
}

// Fetch one estimate by id across any business (for the public approve page),
// dropping quote columns the schema may not have yet so it never 500s. The
// business is fetched separately (not via an embed) so the column-drop retry
// can't mangle a comma-containing join.
async function fetchEstimateAnyBiz(db, id) {
  let cols = 'id, business_id, service_id, customer_name, customer_phone, customer_email, customer_zip, customer_address, customer_city, customer_state, service_label, description, line_items, tax_rate, approved_at, preferred_slots, upsells, accepted_upsells, approved_total';
  let data, error;
  for (let i = 0; i < 8; i++) {
    ({ data, error } = await db.from('estimates').select(cols).eq('id', id).maybeSingle());
    if (!error) break;
    const col = missingColumn(error.message);
    if (!col || !cols.includes(col)) break;
    cols = cols.split(',').map(s => s.trim()).filter(c => c !== col).join(', ');
  }
  if (error) throw error;
  if (!data) return null;
  if (!Array.isArray(data.line_items)) data.line_items = [];
  if (data.tax_rate == null) data.tax_rate = 0;
  if (!('approved_at' in data)) data.approved_at = null;
  if (!Array.isArray(data.upsells)) data.upsells = [];
  if (!Array.isArray(data.accepted_upsells)) data.accepted_upsells = null;
  if (!('approved_total' in data)) data.approved_total = null;
  // This lookup's failure used to be silently discarded (data.business = null),
  // and every caller below defaults est.business?.slug to 'handy-andy' when
  // that happens — so a Doms estimate hitting a transient DB hiccup here would
  // tokenize AND attach the customer's card into Handy Andy's Stripe account.
  // Unlike a card-save failure elsewhere, this one has NO error to catch —
  // the attach genuinely succeeds, just in the wrong account, so it would
  // never surface until a Doms charge attempt failed at time of service.
  // Fail loud instead: a customer seeing an error on the approve page is far
  // better than their card silently ending up in the wrong company's account.
  const { data: biz, error: bizErr } = await db.from('businesses').select('id, slug, name, timezone').eq('id', data.business_id).maybeSingle();
  if (bizErr) throw bizErr;
  if (!biz) throw new Error(`Estimate ${id} references a business (${data.business_id}) that could not be found.`);
  data.business = biz;
  return data;
}

// Normalize the customer's preferred appointment times to { date, slot_key, label }.
// Mirrors the widget estimate-request shape (api/estimate.js); caps at 5.
function sanitizePreferredSlots(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 5).map(s => ({
    date: (s && s.date) ? String(s.date).slice(0, 10) : null,
    slot_key: (s && s.slot_key) ? String(s.slot_key).slice(0, 8) : null,
    label: (s && s.label) ? String(s.label).slice(0, 80) : null,
  })).filter(s => s.date && s.slot_key);
}

// Public (token-gated) real availability for the estimate approve page, so the
// customer can pick preferred appointment times that reflect actual open slots.
// Resolves the estimate's metro from its zip (Handy Andy spans metros); falls
// back to all techs when the zip isn't known so slots still show.
async function estimateSlots(req, res) {
  const token = (req.query.token || (req.body && req.body.token) || '').toString();
  const id = approveTokenEstimateId(token);
  if (!id) return res.status(401).json({ error: 'This link is invalid or has expired.' });

  const db = serviceClient();
  const est = await fetchEstimateAnyBiz(db, id);
  if (!est) return res.status(404).json({ error: 'Estimate not found.' });

  const slug = est.business?.slug || 'handy-andy';
  const serviceAreaId = await serviceAreaIdFromPostal(db, est.business_id, est.customer_zip);
  try {
    const result = await publicOpenSlots(db, { businessSlug: slug, days: 45, serviceAreaId });
    return res.status(200).json({ days: result.days || [], timezone: result.timezone || 'America/Denver' });
  } catch (e) {
    console.warn('[estimate_slots] availability lookup failed:', e.message);
    return res.status(200).json({ days: [], timezone: 'America/Denver' });
  }
}

async function estimateApproveInfo(req, res, body) {
  const token = (req.query.token || (body && body.token) || '').toString();
  const id = approveTokenEstimateId(token);
  if (!id) return res.status(401).json({ error: 'This approval link is invalid or has expired.' });

  const db = serviceClient();
  const est = await fetchEstimateAnyBiz(db, id);
  if (!est) return res.status(404).json({ error: 'Estimate not found.' });

  const items = Array.isArray(est.line_items) ? est.line_items : [];
  const totals = quoteTotals(items, est.tax_rate);
  // Public-safe upsell menu (no tech_pay). If already approved, echo back the
  // customer's own selection so a reopened link shows what they chose.
  const menu = publicUpsells(est.upsells);
  const acceptedIds = Array.isArray(est.accepted_upsells) ? est.accepted_upsells.map(u => u && u.id) : null;
  const slug = est.business?.slug || 'handy-andy';
  return res.status(200).json({
    business_slug: slug,
    business_name: est.business?.name || 'Handy Andy',
    customer_name: est.customer_name || '',
    customer_phone: est.customer_phone || '',
    customer_zip: est.customer_zip || '',
    customer_address: est.customer_address || '',
    customer_city: est.customer_city || '',
    customer_state: est.customer_state || '',
    // Publishable key so the approve page can collect a card to hold on file
    // (tokenized client-side; only the business's secret key can charge it).
    stripe_pk: bookingStripePk(slug),
    service_label: est.service_label || '',
    description: est.description || '',
    line_items: items,
    tax_rate: Number(est.tax_rate) || 0,
    totals,
    upsells: menu,
    accepted_ids: acceptedIds,        // non-null once the customer has approved
    approved_total: est.approved_total != null ? Number(est.approved_total) : null,
    already_approved: !!est.approved_at,
    approved_at: est.approved_at || null,
  });
}

// Turn accepted upsells into priced line-item rows so quoteTotals() can fold
// them into the base quote (customer price × qty, tax applied to the combined sum).
function upsellsAsLineItems(accepted) {
  return (Array.isArray(accepted) ? accepted : []).map(u => ({
    description: u.description, qty: u.qty, unit_price: u.unit_price,
  }));
}

// Auto-book the customer's chosen slot the moment they approve an estimate —
// no staffer re-enters their info or re-picks the time. Re-validates
// availability at THIS instant (not just when the page loaded) and picks the
// tech itself, the same way the public widget does. Throws a plain Error with
// `.conflict = true` when the slot is gone, which the caller turns into a 409
// so the customer can pick a different time instead of hitting a dead end.
async function bookEstimateAppointment(db, biz, est, combinedItems, totals, slot, cust, card) {
  const tz = await areaTimezone(db, null, biz.timezone || 'America/Denver').catch(() => biz.timezone || 'America/Denver');
  const bookingAreaId = await serviceAreaIdFromPostal(db, biz.id, cust.zip);
  const areaTz = bookingAreaId ? await areaTimezone(db, bookingAreaId, biz.timezone || 'America/Denver') : tz;

  const slotDef = SLOTS.find(s => s.key === slot.slot_key);
  if (!slotDef) { const e = new Error('That time slot is no longer valid — please pick another.'); e.conflict = true; throw e; }
  const [hh, mm] = slotDef.start.split(':').map(Number);
  const midnight = localDateStartUTC(areaTz, slot.date);
  const scheduled_at = new Date(midnight.getTime() + (hh * 60 + mm) * 60000).toISOString();

  // Re-check availability RIGHT NOW — the page may have loaded minutes ago.
  const technician_id = await pickAvailableTech(db, biz.id, slot.date, slot.slot_key, areaTz);
  if (!technician_id) {
    const e = new Error("That time was just booked by someone else. Please pick another time.");
    e.conflict = true;
    throw e;
  }

  // Reuse an existing customer (by phone, then email) or create one — same
  // lookup order as the dashboard's booking_create.
  let customer_id = null;
  if (cust.phone) {
    const { data } = await db.from('customers').select('id').eq('business_id', biz.id).eq('phone', cust.phone).maybeSingle();
    if (data?.id) customer_id = data.id;
  }
  if (!customer_id && cust.email) {
    const { data } = await db.from('customers').select('id').eq('business_id', biz.id).eq('email', cust.email).maybeSingle();
    if (data?.id) customer_id = data.id;
  }
  if (!customer_id) {
    const { data, error } = await db.from('customers').insert({
      business_id: biz.id, name: cust.name || 'Customer', phone: cust.phone || null, email: cust.email || null,
      address_line1: cust.line1 || null, city: cust.city || null, state: cust.state || null, postal_code: cust.zip || null,
    }).select('id').single();
    if (error) throw error;
    customer_id = data.id;
  } else {
    const patch = {};
    if (cust.email) patch.email = cust.email;
    if (cust.name) patch.name = cust.name;
    if (cust.phone) patch.phone = cust.phone;
    if (cust.line1) patch.address_line1 = cust.line1;
    if (cust.city) patch.city = cust.city;
    if (cust.state) patch.state = cust.state;
    if (cust.zip) patch.postal_code = cust.zip;
    if (Object.keys(patch).length) await db.from('customers').update(patch).eq('id', customer_id).eq('business_id', biz.id);
  }

  const bookingInsert = {
    business_id: biz.id, customer_id, technician_id,
    service_id: est.service_id || null,
    service_area_id: bookingAreaId || null,
    status: 'assigned', source: 'estimate',
    scheduled_at,
    subtotal: totals.subtotal, price: totals.total,
    notes: est.description || null,
    address_line1: cust.line1 || null, city: cust.city || null, state: cust.state || null, postal_code: cust.zip || null,
    payment_required: true, payment_method: 'card',
    sms_consent: true,
    stripe_customer_id: card.customerId, stripe_payment_method_id: card.pmId || null,
    metadata: { booked_by: 'Estimate approval (auto-booked)', source_estimate_id: est.id },
  };
  const OPTIONAL = ['sms_consent'];
  let insertObj = { ...bookingInsert };
  let bRow, bErr;
  for (let attempt = 0; attempt < OPTIONAL.length + 1; attempt++) {
    ({ data: bRow, error: bErr } = await db.from('bookings').insert(insertObj).select('id').single());
    if (!bErr) break;
    if (bErr.code === '23505' && /bookings_tech_slot_unique/.test(bErr.message || '')) {
      const e = new Error('That technician was just booked for this exact time by someone else. Please pick another time.');
      e.conflict = true; throw e;
    }
    const missing = OPTIONAL.find(c => (bErr.message || '').includes(c) && c in insertObj);
    if (!missing) break;
    delete insertObj[missing];
  }
  if (bErr) throw bErr;

  const rows = combinedItems.map(it => ({
    booking_id: bRow.id, business_id: biz.id, kind: 'option', name: it.description || 'Item',
    quantity: Number(it.qty) || 1, unit_price: Number(it.unit_price) || 0,
    line_total: (Number(it.qty) || 1) * (Number(it.unit_price) || 0),
  }));
  if (rows.length) await db.from('booking_line_items').insert(rows).then(({ error }) => { if (error) console.error('[estimate_approve] line items insert failed:', error.message); });
  if (totals.tax > 0) {
    await db.from('booking_line_items').insert({
      booking_id: bRow.id, business_id: biz.id, kind: 'fee', name: 'Tax',
      quantity: 1, unit_price: totals.tax, line_total: totals.tax, taxable: false,
    }).then(({ error }) => { if (error) console.error('[estimate_approve] tax line item insert failed:', error.message); });
  }

  await db.from('booking_status_events').insert({
    booking_id: bRow.id, business_id: biz.id, technician_id,
    status: 'assigned', note: 'Auto-booked from estimate approval',
  });

  const { data: techInfo } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
  notifyTechAssigned(db, biz, technician_id, scheduled_at, areaTz).catch(console.error);

  if (cust.phone) {
    const _d = new Date(scheduled_at);
    const dateStr = _d.toLocaleDateString('en-US', { timeZone: areaTz, weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = _d.toLocaleTimeString('en-US', { timeZone: areaTz, hour: 'numeric', minute: '2-digit' });
    sendSMS(cust.phone, `You're booked! ✅ ${biz.name} will see you ${dateStr} at ${timeStr}. We'll text you when your tech is on the way. Reply STOP to opt out.`).catch(console.error);
  }

  if (cust.email) {
    (async () => {
      try {
        const dateLong = new Date(scheduled_at).toLocaleDateString('en-US', { timeZone: areaTz, weekday: 'long', month: 'short', day: 'numeric' });
        const timeWindow = slotDef.label;
        const startEpoch = Math.floor(new Date(scheduled_at).getTime() / 1000);
        const [sh, sm] = slotDef.start.split(':').map(Number);
        const [eh, em] = slotDef.end.split(':').map(Number);
        const endEpoch = startEpoch + ((eh * 60 + em) - (sh * 60 + sm)) * 60;
        const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
        const emailLines = combinedItems.map(it => ({ label: it.description || 'Item', qty: Number(it.qty) || 1, amount: (Number(it.qty) || 1) * (Number(it.unit_price) || 0) }));
        if (totals.tax > 0) emailLines.push({ label: 'Tax', qty: 1, amount: totals.tax });
        const { subject, html } = bookingConfirmationEmail({
          firstName: (cust.name || '').trim().split(/\s+/)[0] || '',
          dateLong, timeWindow,
          technicianName: techInfo?.name || null, technicianPhotoUrl: techInfo?.photo_url || null,
          technicianBioYears: techInfo?.bio_years || null, technicianBioBlurb: techInfo?.bio_blurb || null,
          address: { line1: cust.line1, city: cust.city, state: cust.state, zip: cust.zip },
          lines: emailLines, total: totals.total, tip: 0, twoTechs: false,
          startEpoch, endEpoch, baseUrl, jobId: bRow.id,
        }, brandFor(biz.slug));
        const { from } = emailConfig(biz.slug);
        await sendEmail({ slug: biz.slug, to: cust.email, subject, html, replyTo: from });
      } catch (e) { console.error('[estimate_approve] confirmation email error:', e.message); }
    })();
  }

  return { bookingId: bRow.id, technicianName: techInfo?.name || null, scheduledAt: scheduled_at, tz: areaTz, slotLabel: slotDef.label };
}

async function estimateApprove(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = ((body && body.token) || req.query.token || '').toString();
  const id = approveTokenEstimateId(token);
  if (!id) return res.status(401).json({ error: 'This approval link is invalid or has expired.' });

  const db = serviceClient();
  const est = await fetchEstimateAnyBiz(db, id);   // tolerates un-applied migrations; loads line_items, tax_rate, upsells, …
  if (!est) return res.status(404).json({ error: 'Estimate not found.' });
  const businessName = est.business?.name || 'Handy Andy';

  // Idempotent: first approval wins. A reopened link returns the stored selection
  // rather than overwriting it.
  if (est.approved_at) {
    const acceptedIds = Array.isArray(est.accepted_upsells) ? est.accepted_upsells.map(u => u && u.id) : [];
    return res.status(200).json({
      ok: true, already: true, approved_at: est.approved_at, business_name: businessName,
      accepted: publicUpsells(est.accepted_upsells || []),
      accepted_ids: acceptedIds,
      approved_total: est.approved_total != null ? Number(est.approved_total) : null,
    });
  }

  // SERVER-AUTHORITATIVE: the client only tells us WHICH add-ons it accepted (ids).
  // We intersect with the stored menu and re-price from our own record — a client
  // can never inject an item or change a price.
  const requested = Array.isArray(body && body.accepted_ids) ? body.accepted_ids.map(x => String(x)) : [];
  const reqSet = new Set(requested);
  const menu = Array.isArray(est.upsells) ? est.upsells : [];
  const accepted = menu.filter(u => u && reqSet.has(String(u.id)))
    .map(u => ({ id: u.id, description: u.description, qty: u.qty, unit_price: u.unit_price, tech_pay: u.tech_pay || 0 }));

  const baseItems = Array.isArray(est.line_items) ? est.line_items : [];
  const combined = baseItems.concat(upsellsAsLineItems(accepted));
  const totals = quoteTotals(combined, est.tax_rate);

  // ── Card + address are REQUIRED to approve (so the office can book) ──────────
  // The customer must give us a card to hold on file and their service address.
  const addr = (body && body.address) || {};
  const line1 = String(addr.line1 || '').trim();
  const city = String(addr.city || '').trim();
  const stateAbbr = String(addr.state || '').trim();
  const zip = String(addr.zip || est.customer_zip || '').trim();
  const pmId = String((body && body.payment_method_id) || '').trim();
  const custName = String((body && body.customer_name) || est.customer_name || '').trim();
  const custPhone = String((body && body.customer_phone) || est.customer_phone || '').trim();
  const custEmail = est.customer_email || null;
  if (!line1 || !city || !stateAbbr || !zip) {
    return res.status(400).json({ error: 'Please enter your full service address (street, city, state, ZIP) to approve.' });
  }
  if (!pmId) {
    return res.status(400).json({ error: 'Please add a card to hold on file to approve.' });
  }
  const prefSlots = sanitizePreferredSlots(body && body.selected_slots);
  const chosenSlot = prefSlots[0] || null;
  if (!chosenSlot) {
    return res.status(400).json({ error: 'Please pick an appointment time to approve.' });
  }
  // Save the card on file in the business's Stripe account (tokenized client-side).
  let card = null;
  try {
    card = await saveCardOnFile(pmId, { name: custName, email: custEmail, phone: custPhone }, est.business?.slug || null);
  } catch (e) {
    return res.status(402).json({ error: `We couldn't save that card: ${e.message}. Please check the number and try again.` });
  }
  if (!card || !card.customerId) {
    return res.status(402).json({ error: 'Card entry is not set up for this business yet — please contact us to book.' });
  }

  // Book the job right now, using the slot the customer picked from live
  // availability. If someone else grabbed that slot in the meantime, this
  // throws a `.conflict` error instead of silently double-booking a tech.
  let booking;
  try {
    booking = await bookEstimateAppointment(
      db, est.business, est, combined, totals, chosenSlot,
      { name: custName, phone: custPhone, email: custEmail, line1, city, state: stateAbbr, zip },
      card
    );
  } catch (e) {
    if (e.conflict) return res.status(409).json({ error: e.message, conflict: true });
    console.error('[estimate_approve] auto-book failed:', e.message);
    return res.status(500).json({ error: 'We saved your approval, but could not book your appointment automatically. We will reach out to schedule you.' });
  }

  const now = new Date().toISOString();
  const patch = {
    approved_at: now, accepted_upsells: accepted, approved_total: totals.total,
    customer_name: custName || est.customer_name, customer_phone: custPhone || est.customer_phone,
    customer_address: line1, customer_city: city, customer_state: stateAbbr, customer_zip: zip,
    stripe_customer_id: card.customerId, card_brand: card.brand, card_last4: card.last4,
    preferred_slots: [chosenSlot], status: 'archived',
  };
  // Strip columns the schema doesn't have yet (0048 not applied) and retry, so an
  // approval is always recorded even if only approved_at exists.
  let error;
  for (let i = 0; i < 4; i++) {
    ({ error } = await db.from('estimates').update(patch).eq('id', est.id));
    if (!error) break;
    const col = missingColumn(error.message);
    if (col === 'approved_at') {
      return res.status(503).json({ error: 'Approvals need a quick database update (migration 0030) before they can be recorded.' });
    }
    if (col && (col in patch)) { console.warn(`[estimate_approve] '${col}' column missing, retrying without it`); delete patch[col]; continue; }
    break;
  }
  if (error) throw error;

  return res.status(200).json({
    ok: true, approved_at: now, business_name: businessName,
    accepted: publicUpsells(accepted),
    accepted_ids: accepted.map(u => u.id),
    approved_total: totals.total,
    booking_id: booking.bookingId,
    scheduled_at: booking.scheduledAt,
    slot_label: booking.slotLabel,
    technician_name: booking.technicianName,
    timezone: booking.tz,
  });
}

// Get email quota from Resend for the current business
async function emailQuota(req, res, auth) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const db = serviceClient();

  let business;
  if (auth.scope === 'all') {
    // For owner, need to specify business via query param
    const slug = (req.query.business || '').toString();
    if (!slug) return res.status(400).json({ error: 'business parameter required for owner' });
    const { data: biz, error } = await db.from('businesses').select('id, slug').eq('slug', slug).eq('active', true).maybeSingle();
    if (error || !biz) return res.status(404).json({ error: 'Business not found' });
    business = biz;
  } else {
    // For secretary, use their scoped business
    const { data: biz, error } = await db.from('businesses').select('id, slug').eq('slug', auth.scope).eq('active', true).maybeSingle();
    if (error || !biz) return res.status(404).json({ error: 'Business not found' });
    business = biz;
  }

  const { apiKey } = emailConfig(business.slug);
  if (!apiKey) {
    return res.status(200).json({ quotaAvailable: null, warning: null });
  }

  try {
    const resendRes = await fetch('https://api.resend.com/account', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resendRes.ok) {
      console.warn(`[email_quota] Resend API error ${resendRes.status} for ${business.slug}`);
      return res.status(200).json({ quotaAvailable: null, warning: null });
    }

    const accountData = await resendRes.json();
    const monthlyQuota = accountData.monthly_quota || 3000;
    const dailyQuota = accountData.daily_quota || 100;
    const monthlyUsed = accountData.monthly_sent || 0;
    const dailyUsed = accountData.daily_sent || 0;

    const monthlyPercent = (monthlyUsed / monthlyQuota) * 100;
    const dailyPercent = (dailyUsed / dailyQuota) * 100;

    let warning = null;
    if (monthlyPercent >= 90) {
      warning = `⚠️ Email quota approaching limit: ${monthlyUsed}/${monthlyQuota} this month (${Math.round(monthlyPercent)}%)`;
    } else if (dailyPercent >= 90) {
      warning = `⚠️ Email quota approaching limit: ${dailyUsed}/${dailyQuota} today (${Math.round(dailyPercent)}%)`;
    }

    return res.status(200).json({
      quotaAvailable: true,
      monthlyQuota,
      monthlyUsed,
      monthlyPercent,
      dailyQuota,
      dailyUsed,
      dailyPercent,
      warning
    });
  } catch (err) {
    console.error('[email_quota]', err);
    return res.status(200).json({ quotaAvailable: null, warning: null });
  }
}

// ── Payroll Report ──────────────────────────────────────────────────────────
// Owner-only: show tech earnings for a week across all technicians in the business.
// Returns per-tech breakdown with job details, flags, and payment states.
async function payroll(req, res, db, auth) {
  if (auth.role !== 'owner') {
    return res.status(403).json({ error: 'Owner only' });
  }

  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }

  const weekStart = (req.query.week_start || '').toString();
  // Always run on a whole Sun–Sat week: take the requested date (or today) and
  // snap it back to that week's Sunday, so a stray weekday can't yield a partial
  // period. addDaysStr(date, -dayOfWeekFor(date)) lands on the preceding Sunday.
  const rawWeek = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? weekStart : startOfWeekUTC(biz.timezone || 'America/Denver').toISOString().split('T')[0];
  const parsedWeek = addDaysStr(rawWeek, -dayOfWeekFor(rawWeek));
  const weekEnd = addDaysStr(parsedWeek, 6);

  // All active technicians for this business
  const { data: techs, error: techErr } = await db.from('technicians')
    .select('id, name').eq('business_id', biz.id).eq('active', true).order('name');
  if (techErr) throw techErr;

  // Completed jobs for all techs in the week with payroll computation
  const { data: jobs, error: jobErr } = await db.from('bookings')
    .select(`
      id, scheduled_at, status, subtotal, price, payment_status, amount_paid,
      tip, notes, customer_notes, zenbooker_job_number, postal_code,
      technician_id, secondary_technician_id,
      customers(name), services(name),
      line_items:booking_line_items(kind, name, unit_price, line_total)
    `)
    .eq('business_id', biz.id)
    .eq('status', 'completed')
    .gte('scheduled_at', parsedWeek + 'T00:00:00Z')
    .lte('scheduled_at', weekEnd + 'T23:59:59Z')
    .order('scheduled_at');
  if (jobErr) throw jobErr;

  // Per-zip travel payout (the "$X paid to the tech" half of the surcharge tier).
  // One batched lookup; tolerant of the tech_payout column not existing yet.
  const travelPayoutByZip = await travelPayoutMap(db, biz.id);

  // Map job_id -> list of techs who worked it (primary or secondary)
  const jobTechs = {};
  for (const b of jobs || []) {
    jobTechs[b.id] = [];
    if (b.technician_id) jobTechs[b.id].push(b.technician_id);
    if (b.secondary_technician_id) jobTechs[b.id].push(b.secondary_technician_id);
  }

  // Compute payroll for each tech
  const techPayroll = {};
  for (const tech of techs || []) {
    techPayroll[tech.id] = { name: tech.name, jobs: [], deferred: [], total: 0 };
  }

  // A job in THIS business can be worked by a technician who belongs to a
  // DIFFERENT business (cross-company helper, e.g. a Handy Andy tech helping
  // on a Dom's job). That tech's own `technicians` row has a different
  // business_id, so the query above never picks them up and their pay would
  // otherwise be silently dropped by the `if (!techPayroll[techId]) continue`
  // check below. Backfill anyone referenced by this week's jobs but missing
  // from techPayroll with a direct by-id lookup (no business_id filter).
  const allTechIds = new Set(Object.values(jobTechs).flat());
  const missingTechIds = [...allTechIds].filter(id => !techPayroll[id]);
  if (missingTechIds.length) {
    const { data: crossTechs, error: crossErr } = await db.from('technicians')
      .select('id, name').in('id', missingTechIds);
    if (crossErr) throw crossErr;
    for (const tech of crossTechs || []) {
      techPayroll[tech.id] = { name: tech.name, jobs: [], deferred: [], total: 0 };
    }
  }

  for (const b of jobs || []) {
    const techList = jobTechs[b.id] || [];
    for (const techId of techList) {
      if (!techPayroll[techId]) continue;

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
        business_slug: biz.slug,
        line_items: b.line_items || [],
        travel_payout: travelPayoutByZip.get(String(b.postal_code || '')) || 0,
        // A 2nd tech is on the job — but it only SPLITS 50/50 when the customer
        // booked a two-person job. On a one-person job the lead keeps full pay and
        // the assigned helper earns $0.
        second_tech: (jobTechs[b.id] || []).length > 1,
        is_secondary: techId === b.secondary_technician_id && techId !== b.technician_id,
      }, techPayroll[techId].name);

      const jobBase = {
        id: b.id,
        customer_name: b.customers?.name || 'Unknown',
        service: b.services?.name || 'Service',
        time: new Date(b.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
        scheduled_at: b.scheduled_at,
      };

      if (result.state === 'deferred') {
        techPayroll[techId].deferred.push({ ...jobBase, customer_due: Math.floor((Number(b.price) || 0) - (Number(b.amount_paid) || 0)) });
      } else if (result.state !== 'excluded') {
        techPayroll[techId].jobs.push({
          ...jobBase,
          tech_pay: result.pay,
          breakdown: result.breakdown,
          flags: result.flags,
          needs_review: result.flags.length > 0 || result.state === 'partial',
        });
        techPayroll[techId].total += result.pay;
      }
    }
  }

  // Format response
  const data = Object.values(techPayroll).filter(t => t.jobs.length > 0 || t.deferred.length > 0);
  const payDate = addDaysStr(weekEnd, PAY_DATE_OFFSET_DAYS);

  // Owner-only "actual profit" — one row per pay date with three hand-entered
  // figures (Dom's Stripe payout, Handy Andy Stripe payout, total tech pay
  // across both businesses) plus a computed 4th: what the owner actually
  // made. Same row shown on both businesses' payroll pages. This function is
  // already gated to auth.role === 'owner' above, so it's never sent to a
  // secretary or tech — no extra check needed here.
  const { data: profitRow } = await db.from('actual_profit_weekly')
    .select('doms_stripe_payout, handy_andy_stripe_payout, tech_pay').eq('pay_date', payDate).maybeSingle();
  const domsStripe = profitRow?.doms_stripe_payout != null ? Number(profitRow.doms_stripe_payout) : null;
  const haStripe = profitRow?.handy_andy_stripe_payout != null ? Number(profitRow.handy_andy_stripe_payout) : null;
  const techPay = profitRow?.tech_pay != null ? Number(profitRow.tech_pay) : null;
  const allThreeSet = domsStripe != null && haStripe != null && techPay != null;

  return res.status(200).json({
    week_start: parsedWeek,
    week_end: weekEnd,
    pay_date: payDate,
    techs: data,
    total: data.reduce((sum, t) => sum + t.total, 0),
    actual_profit: {
      doms_stripe_payout: domsStripe,
      handy_andy_stripe_payout: haStripe,
      tech_pay: techPay,
      total_made: allThreeSet ? (domsStripe + haStripe - techPay) : null,
    },
  });
}

// Owner-only: hand-enter one of the three actual-profit fields for a given
// pay date (upsert — Sunday-night entry can be corrected Monday). Merges
// with whatever the OTHER two fields already have for that date instead of
// clobbering them, since all three share one row per pay_date.
async function actualProfitSave(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { pay_date, field, amount } = req.body || {};
  const validFields = ['doms_stripe_payout', 'handy_andy_stripe_payout', 'tech_pay'];
  if (!pay_date || !/^\d{4}-\d{2}-\d{2}$/.test(pay_date)) return res.status(400).json({ error: 'pay_date (YYYY-MM-DD) required' });
  if (!validFields.includes(field)) return res.status(400).json({ error: `field must be one of ${validFields.join(', ')}` });
  if (amount == null || isNaN(Number(amount))) return res.status(400).json({ error: 'amount required' });

  const { data: existing } = await db.from('actual_profit_weekly')
    .select('doms_stripe_payout, handy_andy_stripe_payout, tech_pay').eq('pay_date', pay_date).maybeSingle();

  const row = {
    pay_date,
    doms_stripe_payout: existing?.doms_stripe_payout ?? null,
    handy_andy_stripe_payout: existing?.handy_andy_stripe_payout ?? null,
    tech_pay: existing?.tech_pay ?? null,
    [field]: Number(amount),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from('actual_profit_weekly').upsert(row, { onConflict: 'pay_date' });
  if (error) throw error;

  return res.status(200).json({ ok: true, pay_date, field, amount: Number(amount) });
}

// ── Bracket Inventory ────────────────────────────────────────────────────────
// Get current bracket inventory for all technicians in the business
async function bracketInventory(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const bizId = biz.id;

  let { data: inv, error } = await db.from('bracket_inventory')
    .select(`id, technician_id, flat_qty, tilting_qty, full_motion_qty, wire_plate_qty, updated_at,
             technician:technicians ( id, name )`)
    .eq('business_id', bizId);
  // wire_plate_qty arrives with migration 0039; degrade gracefully if not applied yet.
  if (error && /wire_plate_qty/.test(error.message || '')) {
    ({ data: inv, error } = await db.from('bracket_inventory')
      .select(`id, technician_id, flat_qty, tilting_qty, full_motion_qty, updated_at,
               technician:technicians ( id, name )`)
      .eq('business_id', bizId));
  }
  if (error) throw error;

  // Ensure every active tech has an inventory row (create if missing)
  const { data: techs } = await db.from('technicians')
    .select('id, name').eq('business_id', bizId).eq('active', true).order('name');

  const invByTech = new Map((inv || []).map(i => [i.technician_id, i]));
  const missing = (techs || []).filter(t => !invByTech.has(t.id));

  if (missing.length) {
    const toInsert = missing.map(t => ({
      business_id: bizId,
      technician_id: t.id,
      flat_qty: 0,
      tilting_qty: 0,
      full_motion_qty: 0,
    }));
    await db.from('bracket_inventory').insert(toInsert);
  }

  const final = (inv || []).concat(
    missing.map(t => ({
      id: null,
      technician_id: t.id,
      flat_qty: 0,
      tilting_qty: 0,
      full_motion_qty: 0,
      updated_at: new Date().toISOString(),
      technician: { id: t.id, name: t.name },
    }))
  );

  // Which techs actually STOCK wire-concealment plates? The wire_plate_qty
  // column is `not null default 0`, so a 0 can mean either "ran out" or "never
  // tracked". Businesses that don't do behind-the-wall wire concealment (e.g.
  // Handy Andy) sit at 0 forever, so a blanket "0 <= 3 = low" fires a permanent
  // false alarm. Distinguish via purchase history: a business is plate-tracked
  // if it has ever ordered plates; a tech is plate-tracked if their business is
  // OR they currently hold >0. Untracked techs are excluded from plate low-stock
  // warnings; a tracked tech who genuinely burns to 0 STILL warns (real shortage).
  let bizPlateTracked = false;
  try {
    const { count } = await db.from('wire_plate_purchases')
      .select('id', { count: 'exact', head: true }).eq('business_id', bizId);
    bizPlateTracked = (count || 0) > 0;
  } catch { /* table missing on older deploys → treat as untracked (no false alarms) */ }

  return res.status(200).json({
    inventory: final.map(i => ({
      technician_id: i.technician_id,
      technician_name: i.technician?.name || 'Unknown',
      flat: i.flat_qty || 0,
      tilting: i.tilting_qty || 0,
      full_motion: i.full_motion_qty || 0,
      total: (i.flat_qty || 0) + (i.tilting_qty || 0) + (i.full_motion_qty || 0),
      wire_plate: i.wire_plate_qty || 0,
      wire_plate_tracked: bizPlateTracked || (i.wire_plate_qty || 0) > 0,
      updated_at: i.updated_at,
    })).sort((a, b) => a.technician_name.localeCompare(b.technician_name)),
  });
}

// Get purchase history (Walmart orders)
async function bracketPurchases(req, res, db, auth) {
  // Brackets are a SHARED resource — every order is shown on BOTH platforms.
  // Resolve the requested business only to enforce the token scope, then read
  // across all active businesses and dedupe by Walmart order number (the sync
  // mirrors each order to both businesses).
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const limit = Math.min(parseInt(req.query.limit) || 50, 1000);

  const { data: bizes } = await db.from('businesses').select('id, slug').eq('active', true);
  const slugById = new Map((bizes || []).map(b => [b.id, b.slug]));
  const ids = (bizes || []).map(b => b.id);

  const baseCols = `id, business_id, walmart_order_num, flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url, {TOTAL}created_at,
             technician:technicians ( id, name )`;
  let { data: purch, error } = await db.from('bracket_purchases')
    .select(baseCols.replace('{TOTAL}', 'order_total, '))
    .in('business_id', ids).order('created_at', { ascending: false }).limit(limit * 2);
  // order_total arrives with its migration; degrade gracefully if not applied yet.
  if (error && /order_total/.test(error.message || '')) {
    ({ data: purch, error } = await db.from('bracket_purchases')
      .select(baseCols.replace('{TOTAL}', ''))
      .in('business_id', ids).order('created_at', { ascending: false }).limit(limit * 2));
  }
  if (error) throw error;

  // Dedupe by order number. Prefer the ASSIGNED row (shows who has it); among
  // unassigned rows prefer THIS platform's business so its Assign button works.
  const score = (r) => (r.technician ? 2 : 0) + (r.business_id === biz.id ? 1 : 0);
  const byOrder = new Map();
  for (const p of (purch || [])) {
    const key = p.walmart_order_num || p.id;
    const cur = byOrder.get(key);
    if (!cur || score(p) > score(cur)) byOrder.set(key, p);
  }
  const rows = [...byOrder.values()].slice(0, limit);

  return res.status(200).json({
    purchases: rows.map(p => ({
      id: p.id,
      walmart_order_num: p.walmart_order_num,
      technician_name: p.technician?.name || 'Unassigned',
      business: slugById.get(p.business_id) || null,
      flat_qty: p.flat_qty || 0,
      tilting_qty: p.tilting_qty || 0,
      full_motion_qty: p.full_motion_qty || 0,
      total_qty: (p.flat_qty || 0) + (p.tilting_qty || 0) + (p.full_motion_qty || 0),
      status: p.status,
      order_date: p.order_date,
      delivered_date: p.delivered_date,
      order_url: p.order_url || null,
      // Owner-only: what brackets cost stays private from secretaries (same
      // rule as bracket_cost in computeJobEconomics).
      order_total: (auth.role === 'owner' && p.order_total != null) ? Number(p.order_total) : null,
      created_at: p.created_at,
    })),
  });
}

// Manually set an order's delivery status (in_route | delivered | canceled).
// Applies to EVERY row of that Walmart order across businesses so both
// platforms stay in sync. Owner-only.
async function bracketSetStatus(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change bracket status.' });
  const orderNum = (body.walmart_order_num || '').toString().trim();
  const id = (body.id || '').toString().trim();
  const status = (body.status || '').toString().trim();
  if (!['in_route', 'delivered', 'canceled'].includes(status)) {
    return res.status(400).json({ error: 'status must be in_route, delivered, or canceled' });
  }
  if (!orderNum && !id) return res.status(400).json({ error: 'walmart_order_num or id required' });

  const patch = { status, delivered_date: status === 'delivered' ? new Date().toISOString().slice(0, 10) : null };
  let q = db.from('bracket_purchases').update(patch);
  q = orderNum ? q.eq('walmart_order_num', orderNum) : q.eq('id', id);
  const { error } = await q;
  if (error) throw error;
  return res.status(200).json({ ok: true, status });
}

// Update bracket inventory (manual adjustment or usage logging)
// Owner-only: secretaries (Heather/Joey) get read-only access to inventory.
async function bracketUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can edit bracket inventory.' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const bizId = biz.id;

  const techId = (body.technician_id || '').toString();
  const action = (body.action || 'adjust').toString(); // 'adjust' | 'set' | 'usage'

  if (!techId) return res.status(400).json({ error: 'technician_id required' });

  // Verify tech belongs to the business
  const { data: tech } = await db.from('technicians').select('id').eq('id', techId).eq('business_id', bizId).single();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  // Get or create inventory row
  let { data: inv } = await db.from('bracket_inventory')
    .select('*').eq('technician_id', techId).eq('business_id', bizId).maybeSingle();

  if (!inv) {
    await db.from('bracket_inventory').insert({
      business_id: bizId,
      technician_id: techId,
      flat_qty: 0,
      tilting_qty: 0,
      full_motion_qty: 0,
    });
    inv = { flat_qty: 0, tilting_qty: 0, full_motion_qty: 0 };
  }

  // Calculate new quantities. 'set' writes the EXACT counts the owner typed (can
  // go up or down); 'adjust'/'usage' apply a +/- delta to the current count.
  const isSet = action === 'set';
  const flat = isSet ? Math.max(0, Math.round(Number(body.flat) || 0)) : (inv.flat_qty || 0) + (body.flat_delta || 0);
  const tilting = isSet ? Math.max(0, Math.round(Number(body.tilting) || 0)) : (inv.tilting_qty || 0) + (body.tilting_delta || 0);
  const fullMotion = isSet ? Math.max(0, Math.round(Number(body.full_motion) || 0)) : (inv.full_motion_qty || 0) + (body.full_motion_delta || 0);
  // Wire concealment plates (migration 0039). Only touch the column when a
  // delta is supplied AND the column exists, so the action still works on a DB
  // where 0039 hasn't run yet.
  const wantsWirePlate = body.wire_plate_delta != null && body.wire_plate_delta !== 0;
  const hasWirePlateCol = Object.prototype.hasOwnProperty.call(inv, 'wire_plate_qty');
  const wirePlate = (inv.wire_plate_qty || 0) + (body.wire_plate_delta || 0);

  // Ensure no negative inventory
  if (flat < 0 || tilting < 0 || fullMotion < 0 || (wantsWirePlate && wirePlate < 0)) {
    return res.status(400).json({ error: 'Insufficient inventory for this operation' });
  }

  // Update inventory
  const patch = {
    flat_qty: flat,
    tilting_qty: tilting,
    full_motion_qty: fullMotion,
  };
  if (wantsWirePlate && hasWirePlateCol) patch.wire_plate_qty = wirePlate;
  const { error: e1 } = await db.from('bracket_inventory').update(patch)
    .eq('technician_id', techId).eq('business_id', bizId);
  if (e1) throw e1;

  // Log usage if applicable
  if (action === 'usage' && (body.flat_delta || body.tilting_delta || body.full_motion_delta || wantsWirePlate)) {
    const log = {
      business_id: bizId,
      booking_id: body.booking_id || null,
      technician_id: techId,
      flat_used: Math.abs(body.flat_delta || 0),
      tilting_used: Math.abs(body.tilting_delta || 0),
      full_motion_used: Math.abs(body.full_motion_delta || 0),
      logged_by_kind: 'admin',
      notes: body.notes || null,
    };
    if (wantsWirePlate && hasWirePlateCol) log.wire_plate_used = Math.abs(body.wire_plate_delta || 0);
    await db.from('bracket_usage_logs').insert(log);
  }

  return res.status(200).json({
    ok: true,
    inventory: {
      flat_qty: flat,
      tilting_qty: tilting,
      full_motion_qty: fullMotion,
      wire_plate_qty: hasWirePlateCol ? wirePlate : 0,
      total: flat + tilting + fullMotion,
    },
  });
}

// Wire concealment plates used on a job: one per unit of the "Hide wires BEHIND
// the wall" service. Mirrors the same detection used in the tech app so admin-
// completed jobs deduct identically.
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

// Company BRACKETS a job uses, by type (skips customer-supplied / own brackets).
// Mirror of tech.js detectBracketQtys so the dashboard completion path deducts
// the same way the tech app does.
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

// Subtract (sign -1) or add (sign +1) brackets from a tech's inventory (floor 0),
// creating the row if missing. Best-effort; never throws into completion.
//
// Inventory is tracked per TECH, not per job — a tech carries one physical
// stock of brackets in their truck regardless of which company's customer
// they're serving that day. Since Denver cross-hire (a tech can now complete
// a job for the OTHER company), `businessId` here may be the JOB's business,
// which can differ from the tech's own. Always resolve+use the tech's real
// home business_id, so a cross-hire job deducts from the tech's actual stock
// instead of creating a phantom always-zero row under the other company (the
// bug that made TK show a false "reorder" alert under Handy Andy's table).
async function adjustBracketInventory(db, businessId, techId, qtys, sign) {
  if (!techId || bracketTotal(qtys) <= 0) return;
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

// Subtract wire concealment plates from a tech's inventory (floor 0) and log it.
// No-ops gracefully if migration 0039 isn't applied; never throws into the
// completion path. Same cross-hire fix as adjustBracketInventory above: the
// STOCK row lives under the tech's own home business, never the job's.
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
      logged_by_kind: 'admin', notes: 'Behind-the-wall wire concealment',
    });
  } catch (_) { /* usage log is best-effort */ }
}

// Parse Walmart email to create bracket purchase record
// Called by: scheduled email watcher or manual submission
async function bracketParseEmail(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can record bracket orders.' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const bizId = biz.id;

  const emailBody = (body.email_body || '').toString().trim();
  const techName = (body.technician_name || '').toString().trim();
  const walmartOrderNum = (body.walmart_order_num || '').toString().trim();
  const flatQty = parseInt(body.flat_qty) || 0;
  const tiltingQty = parseInt(body.tilting_qty) || 0;
  const fullMotionQty = parseInt(body.full_motion_qty) || 0;

  if (!techName) return res.status(400).json({ error: 'technician_name required' });
  if (!walmartOrderNum && !emailBody) return res.status(400).json({ error: 'walmart_order_num or email_body required' });

  // Find technician by name (case-insensitive, partial match)
  const { data: techs } = await db.from('technicians')
    .select('id, name').eq('business_id', bizId).eq('active', true);

  const tech = (techs || []).find(t => t.name.toLowerCase().includes(techName.toLowerCase()));
  if (!tech) return res.status(404).json({ error: `Technician "${techName}" not found` });

  // Check if we already have this order
  let existing = null;
  if (walmartOrderNum) {
    const { data: e } = await db.from('bracket_purchases')
      .select('id, status').eq('walmart_order_num', walmartOrderNum).eq('business_id', bizId).maybeSingle();
    existing = e;
  }

  // Extract order date from email or use today
  let orderDate = new Date().toISOString().slice(0, 10);
  const dateMatch = emailBody.match(/order\s+(?:number|#|date)?[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (dateMatch) {
    const parts = dateMatch[1].split(/[\/\-]/);
    const m = parseInt(parts[0]);
    const d = parseInt(parts[1]);
    const y = parts[2].length === 4 ? parts[2] : `20${parts[2]}`;
    orderDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const totalQty = flatQty + tiltingQty + fullMotionQty;
  if (totalQty <= 0) return res.status(400).json({ error: 'At least one bracket qty required' });

  let result;
  if (existing) {
    // Update existing order
    const { error: e } = await db.from('bracket_purchases').update({
      flat_qty: flatQty,
      tilting_qty: tiltingQty,
      full_motion_qty: fullMotionQty,
    }).eq('id', existing.id);
    if (e) throw e;
    result = { id: existing.id, action: 'updated' };
  } else {
    // Create new purchase record
    const { data: p, error: e } = await db.from('bracket_purchases').insert({
      business_id: bizId,
      technician_id: tech.id,
      walmart_order_num: walmartOrderNum || `manual-${Date.now()}`,
      flat_qty: flatQty,
      tilting_qty: tiltingQty,
      full_motion_qty: fullMotionQty,
      order_date: orderDate,
    }).select('id').single();
    if (e) throw e;
    result = { id: p.id, action: 'created' };
  }

  // Update inventory: read current, add purchased qty, write back. (Supabase JS
  // has no atomic increment, so we read-then-write.)
  const { data: inv } = await db.from('bracket_inventory')
    .select('id, flat_qty, tilting_qty, full_motion_qty')
    .eq('technician_id', tech.id).eq('business_id', bizId).maybeSingle();
  if (inv) {
    await db.from('bracket_inventory').update({
      flat_qty: (inv.flat_qty || 0) + flatQty,
      tilting_qty: (inv.tilting_qty || 0) + tiltingQty,
      full_motion_qty: (inv.full_motion_qty || 0) + fullMotionQty,
    }).eq('id', inv.id);
  } else {
    await db.from('bracket_inventory').insert({
      business_id: bizId,
      technician_id: tech.id,
      flat_qty: flatQty,
      tilting_qty: tiltingQty,
      full_motion_qty: fullMotionQty,
    });
  }

  return res.status(200).json({
    ok: true,
    purchase: result,
    inventory_updated: {
      flat: flatQty,
      tilting: tiltingQty,
      full_motion: fullMotionQty,
      total: totalQty,
    },
  });
}

// ── Pending deliveries: brackets that arrived but aren't assigned to a tech yet
// A bracket_purchases row with technician_id IS NULL is a "just delivered, not
// yet assigned" delivery (recorded by the email watcher or seeded manually).
async function bracketPending(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const bizId = biz.id;

  const { data: pending, error } = await db.from('bracket_purchases')
    .select('id, walmart_order_num, flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url, created_at')
    .eq('business_id', bizId)
    .is('technician_id', null)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return res.status(200).json({
    pending: (pending || []).map(p => ({
      id: p.id,
      walmart_order_num: p.walmart_order_num,
      flat: p.flat_qty || 0,
      tilting: p.tilting_qty || 0,
      full_motion: p.full_motion_qty || 0,
      total: (p.flat_qty || 0) + (p.tilting_qty || 0) + (p.full_motion_qty || 0),
      status: p.status || 'in_route',
      order_date: p.order_date,
      delivered_date: p.delivered_date,
      order_url: p.order_url || null,
      created_at: p.created_at,
    })),
  });
}

// Assign a pending delivery to a technician: stamp the purchase with the tech
// and add the delivered quantities to that tech's bracket_inventory. Owner-only.
async function bracketAssign(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can assign brackets.' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const bizId = biz.id;

  const purchaseId = (body.purchase_id || '').toString().trim();
  const techId = (body.technician_id || '').toString().trim();
  if (!purchaseId || !techId) return res.status(400).json({ error: 'purchase_id and technician_id required' });

  // Fetch the pending purchase (must belong to this business and be unassigned).
  const { data: purchase } = await db.from('bracket_purchases')
    .select('id, flat_qty, tilting_qty, full_motion_qty, technician_id, walmart_order_num, status')
    .eq('id', purchaseId).eq('business_id', bizId).maybeSingle();
  if (!purchase) return res.status(404).json({ error: 'Delivery not found' });
  if (purchase.technician_id) return res.status(400).json({ error: 'This delivery is already assigned.' });

  // Verify tech belongs to the business.
  const { data: tech } = await db.from('technicians')
    .select('id, name').eq('id', techId).eq('business_id', bizId).maybeSingle();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  const flat = purchase.flat_qty || 0;
  const tilting = purchase.tilting_qty || 0;
  const full_motion = purchase.full_motion_qty || 0;

  // Stamp the order with the tech. Do NOT touch status — an order can be
  // assigned while it's still in route; its delivery status updates on its own
  // when the delivery email arrives.
  const { error: stampErr } = await db.from('bracket_purchases')
    .update({ technician_id: techId })
    .eq('id', purchaseId);
  if (stampErr) throw stampErr;

  // The sync mirrors every Walmart order to BOTH businesses as unassigned
  // twins. Now that this one is assigned to a specific tech, drop the still-
  // unassigned duplicate(s) of the same order in other businesses so the same
  // physical delivery isn't shown or counted twice.
  if (purchase.walmart_order_num) {
    await db.from('bracket_purchases')
      .delete()
      .eq('walmart_order_num', purchase.walmart_order_num)
      .is('technician_id', null)
      .neq('business_id', bizId);
  }

  // Inventory moves ONLY on delivery. If the owner assigns an order that's still
  // in route, we just reserve it to the tech — the brackets are added to the
  // count when the delivery email arrives. Assigning an already-delivered order
  // credits it now (read-then-write; no atomic increment).
  const credited = purchase.status === 'delivered';
  if (credited) {
    const { data: inv } = await db.from('bracket_inventory')
      .select('id, flat_qty, tilting_qty, full_motion_qty')
      .eq('technician_id', techId).eq('business_id', bizId).maybeSingle();
    if (inv) {
      const { error: upErr } = await db.from('bracket_inventory').update({
        flat_qty: (inv.flat_qty || 0) + flat,
        tilting_qty: (inv.tilting_qty || 0) + tilting,
        full_motion_qty: (inv.full_motion_qty || 0) + full_motion,
      }).eq('id', inv.id);
      if (upErr) throw upErr;
    } else {
      const { error: insErr } = await db.from('bracket_inventory').insert({
        business_id: bizId,
        technician_id: techId,
        flat_qty: flat,
        tilting_qty: tilting,
        full_motion_qty: full_motion,
      });
      if (insErr) throw insErr;
    }
  }

  return res.status(200).json({
    ok: true,
    technician_name: tech.name,
    reserved: !credited,
    assigned: { flat, tilting, full_motion, total: flat + tilting + full_motion },
  });
}

// Unassigned Amazon plate deliveries for this business (mirror of bracketPending).
async function wirePlatePending(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data: pending, error } = await db.from('wire_plate_purchases')
    .select('id, amazon_order_num, units, plates, status, order_date, delivered_date, order_url, created_at')
    .eq('business_id', biz.id)
    .is('technician_id', null)
    .order('created_at', { ascending: false });
  // Table arrives with migration 0040; degrade to empty if not applied yet.
  if (error) {
    if (/wire_plate_purchases/.test(error.message || '')) return res.status(200).json({ pending: [] });
    throw error;
  }
  return res.status(200).json({
    pending: (pending || []).map(p => ({
      id: p.id,
      amazon_order_num: p.amazon_order_num,
      units: p.units || 0,
      plates: p.plates || 0,
      status: p.status || 'in_route',
      order_date: p.order_date,
      delivered_date: p.delivered_date,
      order_url: p.order_url || null,
      created_at: p.created_at,
    })),
  });
}

// All Amazon plate orders for the dashboard's "Recent Amazon Orders" list —
// across businesses, deduped by order number (like bracketPurchases), with
// status + assigned tech + whether the plates have been counted on-hand yet.
async function wirePlateOrders(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const limit = Math.min(parseInt(req.query.limit) || 30, 500);

  const { data: bizes } = await db.from('businesses').select('id, slug').eq('active', true);
  const ids = (bizes || []).map(b => b.id);

  // `credited` arrives with 0041; degrade without it.
  const cols = 'id, business_id, amazon_order_num, units, plates, status, order_date, delivered_date, order_url, created_at, technician:technicians ( id, name )';
  let { data: rows, error } = await db.from('wire_plate_purchases')
    .select(cols + ', credited').in('business_id', ids)
    .order('created_at', { ascending: false }).limit(limit * 2);
  if (error && /credited/.test(error.message || '')) {
    ({ data: rows, error } = await db.from('wire_plate_purchases')
      .select(cols).in('business_id', ids)
      .order('created_at', { ascending: false }).limit(limit * 2));
  }
  if (error) {
    if (/wire_plate_purchases/.test(error.message || '')) return res.status(200).json({ orders: [] });
    throw error;
  }

  // Dedupe by order number; prefer the assigned row, then this platform's row.
  const score = (r) => (r.technician ? 2 : 0) + (r.business_id === biz.id ? 1 : 0);
  const byOrder = new Map();
  for (const r of (rows || [])) {
    const key = r.amazon_order_num || r.id;
    const cur = byOrder.get(key);
    if (!cur || score(r) > score(cur)) byOrder.set(key, r);
  }
  const list = [...byOrder.values()].slice(0, limit);

  return res.status(200).json({
    orders: list.map(p => ({
      id: p.id,
      amazon_order_num: p.amazon_order_num,
      units: p.units || 0,
      plates: p.plates || 0,
      status: p.status || 'in_route',
      credited: !!p.credited,
      technician_name: p.technician?.name || null,
      technician_id: p.technician?.id || null,
      order_date: p.order_date,
      delivered_date: p.delivered_date,
      order_url: p.order_url || null,
      created_at: p.created_at,
    })),
  });
}

// Assign (reserve) an Amazon plate order to a technician. The plates are added to
// the tech's ON-HAND count only if the order is already DELIVERED; for an
// en-route order this just reserves it, and the delivery sync credits the plates
// when it actually arrives. Owner-only.
async function wirePlateAssign(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can assign plates.' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const bizId = biz.id;

  const purchaseId = (body.purchase_id || '').toString().trim();
  const techId = (body.technician_id || '').toString().trim();
  if (!purchaseId || !techId) return res.status(400).json({ error: 'purchase_id and technician_id required' });

  // `credited` arrives with 0041; degrade (reserve only, never credit) without it.
  let hasCredited = true;
  let { data: purchase, error: pErr } = await db.from('wire_plate_purchases')
    .select('id, plates, status, technician_id, amazon_order_num, credited')
    .eq('id', purchaseId).eq('business_id', bizId).maybeSingle();
  if (pErr && /credited/.test(pErr.message || '')) {
    hasCredited = false;
    ({ data: purchase, error: pErr } = await db.from('wire_plate_purchases')
      .select('id, plates, status, technician_id, amazon_order_num')
      .eq('id', purchaseId).eq('business_id', bizId).maybeSingle());
  }
  if (pErr && /wire_plate_purchases/.test(pErr.message || '')) {
    return res.status(400).json({ error: "Plate tracking isn't set up yet (run migration 0040)." });
  }
  if (!purchase) return res.status(404).json({ error: 'Delivery not found' });
  if (purchase.technician_id) return res.status(400).json({ error: 'This order is already assigned.' });

  const { data: tech } = await db.from('technicians')
    .select('id, name').eq('id', techId).eq('business_id', bizId).maybeSingle();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });

  const plates = purchase.plates || 0;
  // Only count plates on-hand when the order is actually delivered AND we can
  // record that it was counted (credited). Otherwise this is just a reservation.
  const credit = hasCredited && (purchase.status === 'delivered');

  const stamp = { technician_id: techId };
  if (credit) stamp.credited = true;
  const { error: stampErr } = await db.from('wire_plate_purchases').update(stamp).eq('id', purchaseId);
  if (stampErr) throw stampErr;

  // Drop the unassigned twin(s) of the same order mirrored to other businesses.
  if (purchase.amazon_order_num) {
    await db.from('wire_plate_purchases')
      .delete()
      .eq('amazon_order_num', purchase.amazon_order_num)
      .is('technician_id', null)
      .neq('business_id', bizId);
  }

  if (credit) {
    // Add plates to the tech's on-hand inventory (graceful if 0039 not applied).
    let { data: inv, error: invErr } = await db.from('bracket_inventory')
      .select('id, wire_plate_qty').eq('technician_id', techId).eq('business_id', bizId).maybeSingle();
    if (invErr && /wire_plate_qty/.test(invErr.message || '')) {
      return res.status(400).json({ error: "Plate inventory isn't set up yet (run migration 0039)." });
    }
    if (inv) {
      const { error: upErr } = await db.from('bracket_inventory')
        .update({ wire_plate_qty: (inv.wire_plate_qty || 0) + plates }).eq('id', inv.id);
      if (upErr) throw upErr;
    } else {
      const { error: insErr } = await db.from('bracket_inventory')
        .insert({ business_id: bizId, technician_id: techId, wire_plate_qty: plates });
      if (insErr) throw insErr;
    }
  }

  return res.status(200).json({
    ok: true,
    technician_name: tech.name,
    reserved: !credit,
    credited: credit,
    status: purchase.status,
    assigned: { plates: credit ? plates : 0 },
  });
}

// Owner-only: remove a wire-plate order from tracking (e.g. a phantom/duplicate
// the email parser mis-created). Deletes every row for the order number across
// businesses; if a row was already CREDITED to a tech, subtract those plates back
// out of that tech's on-hand count so the inventory stays honest.
async function wirePlateRemove(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove orders.' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const purchaseId = (body.purchase_id || '').toString().trim();
  const orderNum   = (body.amazon_order_num || '').toString().trim();
  if (!purchaseId && !orderNum) return res.status(400).json({ error: 'purchase_id or amazon_order_num required' });

  // Resolve the order number (so we can clean up its twins in every business).
  const cols = (withCredited) => `id, business_id, technician_id, plates, amazon_order_num${withCredited ? ', credited' : ''}`;
  let hasCredited = true;
  let on = orderNum;
  if (!on && purchaseId) {
    const { data: one } = await db.from('wire_plate_purchases').select('amazon_order_num').eq('id', purchaseId).maybeSingle();
    on = one?.amazon_order_num || '';
  }

  // Gather every matching row (by order number when known, else the single id).
  const fetchRows = async () => {
    let q = db.from('wire_plate_purchases').select(cols(hasCredited));
    q = on ? q.eq('amazon_order_num', on) : q.eq('id', purchaseId);
    return q;
  };
  let { data: rows, error } = await fetchRows();
  if (error && /credited/.test(error.message || '')) { hasCredited = false; ({ data: rows, error } = await fetchRows()); }
  if (error && /wire_plate_purchases/.test(error.message || '')) return res.status(400).json({ error: "Plate tracking isn't set up yet." });
  if (error) throw error;
  if (!rows || !rows.length) return res.status(404).json({ error: 'Order not found' });

  let removed = 0;
  for (const r of rows) {
    // Reverse any inventory credit so removing a counted order doesn't leave phantom plates.
    if (hasCredited && r.credited && r.technician_id && (r.plates || 0) > 0) {
      const { data: inv } = await db.from('bracket_inventory')
        .select('id, wire_plate_qty').eq('technician_id', r.technician_id).eq('business_id', r.business_id).maybeSingle();
      if (inv) await db.from('bracket_inventory')
        .update({ wire_plate_qty: Math.max(0, (inv.wire_plate_qty || 0) - (r.plates || 0)) }).eq('id', inv.id);
    }
    const { error: delErr } = await db.from('wire_plate_purchases').delete().eq('id', r.id);
    if (!delErr) removed++;
  }
  // Deleting the row alone doesn't stop the email scanner from re-adding this
  // order next pass — the confirmation email is still sitting in the inbox,
  // and the row itself was the only "already handled" signal. Recording the
  // order number here so wirePlateSync (api/_lib migrate.js) skips it forever.
  if (on) {
    const { error: ignoreErr } = await db.from('wire_plate_ignored_orders')
      .upsert({ amazon_order_num: on }, { onConflict: 'amazon_order_num' });
    if (ignoreErr) console.warn('[wire_plate_remove] failed to record ignore for', on, ignoreErr.message);
  }
  return res.status(200).json({ ok: true, removed, amazon_order_num: on || null });
}
