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
import { serviceClient, serviceClientPublic } from './_lib/supabase.js';
import { signToken, verifyToken, getBearer, applyCors, safeEqual } from './_lib/auth.js';
import { emailNotificationsOn, smsNotificationsOn } from './_lib/notify.js';
import { demoMode } from './_lib/demo.js';
import { toE164, sendSMS, sendSMSResult, smsConfigured } from './_lib/sms.js';
import { emailConfig, sendEmail, bookingConfirmationEmail, brandFor, reviewEmail, estimateEmail, outOfScopeEmail, receiptEmail, EMAIL_BRANDS } from './_lib/email.js';
import { sendOwnerBookingAlert, maybeSendBigBracketAlert, maybeSendZeroOrLowProfitAlert, gdsUpsellUrlFor, rescheduleUrlFor, sendReviewCallComplaintAlert } from './_lib/owner-notify.js';
import { notifyTechAssigned } from './_lib/tech-notify.js';
import { enRouteMessage, DEFAULT_ETA_MINUTES } from './_lib/en-route.js';
import { sendDailyBookingDigest } from './_lib/daily-digest.js';
import { localDayStartUTC, localDateStartUTC, startOfWeekUTC, startOfMonthUTC, addDaysStr } from './_lib/time.js';
import { SLOTS, SLOT_KEYS, DAYS, normalizeSlots, assertDate, dayOfWeekFor, computeExceptionRows, publicOpenSlots, parseSlotId, slotStartUTC, slotEndUTC, pickOpenTech } from './_lib/availability.js';
import { formatAddress, isLikelyStreetAddress } from './_lib/address.js';
import { stripe, stripeConfigured, findCardOnFileByEmail, defaultPaymentMethod, businessSecretKey, saveCardOnFile as saveCardOnFileAcct, retrieveCard, resolveChargeablePm, stripeUploadFile, listOpenDisputes, submitDisputeEvidence, findLandedCharge } from './_lib/stripe.js';
import { saveAuthorization, buildDisputeEvidence } from './_lib/authorization.js';
import { gscQuery } from './_lib/gsc.js';
import { resolveServiceArea, unstaffedZipMatcher } from './_lib/service-area-resolve.js';
import { parseMoney, minSellPrice, checkSellPrice } from './_lib/broker-pricing.js';
import { BROKER_SECTIONS, brokerResolveSpec, brokerQuoteLineItems, normalizeCustomLines, customLinesOf, brokerRequiredLines } from './_lib/broker-spec.js';
import { digitsOf, prettyPhone } from './_lib/grasshopper.js';
import { SECRETARY_EXTRA_BUSINESSES, allowedSlugsFor, mayUseBusiness } from './_lib/staff-access.js';
import { canonicalizeLineItems, recalcTaxLine, isTaxLine, casBumpLiRev, bumpLiRev, clampBracketQtysToTvCount, LI_CONFLICT_CODE } from './_lib/line-items.js';
import { bracketTotal as bracketMoveTotal, debitForJob, reconcileJobEdit, creditDelivery as ledgerCreditDelivery, adjustDelivery as ledgerAdjustDelivery, recount as ledgerRecount, adjust as ledgerAdjust } from './_lib/bracket-moves.js';

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
// Each business's own Stripe publishable key, so New Booking's card entry
// tokenizes against the RIGHT account. Without a slug's own branch here it
// silently falls through to STRIPE_PK_GLOBAL (Handy Andy's) — which would
// tokenize a Mile High job's card into Handy Andy's Stripe account, so it
// would appear to save fine but be uncharge-able from Mile High's own key.
function bookingStripePk(slug) {
  if (demoMode()) return STRIPE_PK_GLOBAL;
  if (slug === 'doms') return process.env.DOMS_STRIPE_PUBLISHABLE_KEY || null;
  if (slug === 'mile-high') return process.env.MILE_HIGH_STRIPE_PUBLISHABLE_KEY || null;
  // The four Austin lead-gen brands charge on the shared 'austin' Stripe
  // account (see LEGACY_SLUG_ACCOUNT in api/_lib/stripe.js), so they tokenize
  // with austin's publishable key too.
  if (slug === 'austin' || slug === 'atxmountpros' || slug === 'atxtvmount' || slug === 'austinmountingpros' || slug === 'austintvinstall') {
    return process.env.AUSTIN_STRIPE_PUBLISHABLE_KEY || null;
  }
  if (slug === 'precision') return process.env.PRECISION_STRIPE_PUBLISHABLE_KEY || null;
  if (slug === 'houstonmounting' || slug === 'houstontvinstallation' || slug === 'tvhanginghouston' || slug === 'htvmounting') {
    return process.env.Publishable_key_houston_mounting || null;
  }
  return STRIPE_PK_GLOBAL;
}
import { uploadImage, deleteImage } from './_lib/storage.js';
import { computeJobPay, paymentState, PAY_DATE_OFFSET_DAYS, isJuan, JUAN_BRACKET_ZERO_FROM } from './_lib/payroll.js';
import { isHoustonBooking } from './_lib/houston-bonus.js';
import { couponAmountFor, couponCodesFor, couponCacheClear, multiTvDiscountConfigFor, multiTvDiscountConfigCacheClear } from './book.js';

const ACTIVE_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed'];
// What the office is allowed to SET a booking to. ACTIVE_STATUSES above still
// lists arrived/in_progress because imported Zenbooker rows sit on them and
// must keep showing up in queries; this list is narrower on purpose so nothing
// new can be created there. See TECH_STATUS in api/tech.js for the tech side.
const SETTABLE_STATUSES = ['pending', 'confirmed', 'assigned', 'on_the_way', 'completed', 'cancelled', 'no_show'];

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
// Per-slug lookup, not a symmetric pairing — see the matching comment in
// api/_lib/availability.js. Mile High borrows Handy Andy's Denver techs
// one-directionally; Handy Andy's own overflow still only ever falls to Doms.
const PARTNER_SLUG = {
  'handy-andy': 'doms', 'doms': 'handy-andy', 'mile-high': 'handy-andy', 'austin': 'handy-andy', 'precision': 'handy-andy',
  // Austin lead-gen quad — one-directional like the other micro-brands: each
  // books Handy Andy's (Austin) techs, never the reverse.
  'atxmountpros': 'handy-andy', 'atxtvmount': 'handy-andy', 'austinmountingpros': 'handy-andy', 'austintvinstall': 'handy-andy',
  // Denver + Houston lead-gen brands — same one-directional pattern, just
  // missing from this copy of the table (api/_lib/availability.js's own
  // PARTNER_SLUG already had all five; this one drifted out of sync). None of
  // these five have any technicians of their own, so "Any Technician" on any
  // of them was silently returning zero availability with no partner
  // fallback (found 2026-09-03 — a TV Hanging Houston auto-pick came back
  // with no open dates in a real zip its own service_area_zips covers fine).
  'tvmountingdenver': 'handy-andy',
  'houstonmounting': 'handy-andy', 'houstontvinstallation': 'handy-andy', 'tvhanginghouston': 'handy-andy', 'htvmounting': 'handy-andy',
};

// The partner business row for a host slug, or null when there isn't one.
async function partnerBusiness(db, hostSlug) {
  const pslug = PARTNER_SLUG[hostSlug];
  if (!pslug) return null;
  const { data } = await db.from('businesses')
    .select('id, slug, name, timezone').eq('slug', pslug).eq('active', true).maybeSingle();
  return data || null;
}

// Which technician rosters an "Any Technician" / auto-pick may scan, as an
// ORDERED array of scopes [{ bizId, serviceAreaId }] — host first, partner
// (pool 'partner'/'cross') after. Every scope is pinned to that business's
// OWN service area for the booking's zip, so an auto-pick can never hand a
// Denver job to the Austin/Houston tech: slot keys (s1–s5) carry no location,
// which once let Zach's Austin schedule satisfy a Denver 2 PM check.
// serviceAreaId is null whenever the zip is blank OR unknown to that
// business — scopedRosterTechs() treats ANY null-area scope as contributing
// zero candidates (never an unfiltered whole-company fallback), so this
// function doesn't need to special-case "unmapped zip" itself: a host that
// can't resolve an area yields no host candidates, a partner that can't
// yields no partner candidates, symmetrically, whether that's because the zip
// is blank, unmapped for everyone, or a real zip the partner just doesn't
// serve. Consumers: pickAvailableTech, availableSlotKeys, freeSlotTechMap,
// pickAvailableTechPair, and availableDates' local rosterIds.
// hostAreaOverride: a precomputed service_area_id for hostBiz+postalCode, when
// the caller already looked it up (availableSlots does, for its own tz lookup)
// — skips repeating the exact same service_area_zips query.
async function rosterScopes(db, hostBiz, pool, postalCode, hostAreaOverride) {
  const zip = (postalCode || '').toString().trim();
  const hostArea = hostAreaOverride !== undefined
    ? hostAreaOverride
    : (zip ? await serviceAreaIdFromPostal(db, hostBiz.id, zip) : null);
  const host = { bizId: hostBiz.id, serviceAreaId: hostArea };
  if (pool !== 'cross' && pool !== 'partner') return [host];
  const p = await partnerBusiness(db, hostBiz.slug);
  if (!p) return [host];
  const partnerArea = zip ? await serviceAreaIdFromPostal(db, p.id, zip) : null;
  const partnerScope = { bizId: p.id, serviceAreaId: partnerArea };
  if (pool === 'partner') return [partnerScope];
  return [host, partnerScope];
}

// Look up the service_area_id for a postal code in a given business.
// Returns null if postal_code is not provided or not found.
//
// The table stores bare 5-digit zips, but the office form accepts whatever the
// customer read out, and a ZIP+4 slipped through at least once ("80220-1032",
// Jul 2026): the exact-match lookup missed, the booking resolved to NO metro,
// and every downstream guard weakened at once (calendar dead, roster dropdown
// unfiltered, auto-pick refused). Normalize to the leading 5 digits before the
// lookup so a ZIP+4 or stray whitespace can never unmap a real metro again.
//
// STRICT shape on purpose: only a bare 5-digit zip or a real ZIP+4 tail
// ("80220-1032", "80220 1032") normalizes. A 6-digit typo like "800122" must
// NOT silently become the different-but-real zip 80012; it stays as typed,
// misses the lookup, and fails closed for a human to fix, exactly as before.
function zip5(postalCode) {
  const s = String(postalCode || '').trim();
  const m = s.match(/^(\d{5})(?:[-\s]\d{1,4})?$/);
  return m ? m[1] : s;
}
async function serviceAreaIdFromPostal(db, businessId, postalCode) {
  if (!postalCode) return null;
  const { data } = await db.from('service_area_zips')
    .select('service_area_id')
    .eq('business_id', businessId)
    .eq('postal_code', zip5(postalCode))
    .maybeSingle();
  return data?.service_area_id || null;
}

// Cross-metro assignment backstop (the Zach-on-a-Denver-job mistake, Jul 2026:
// five bookings created with the Austin tech on Denver-area jobs before the
// roster scoping fix landed, each caught and reassigned by hand). The scoped
// "any" auto-pick can no longer produce one, so this guards the paths that
// still legitimately CAN: an explicit dropdown pick, or any future code path
// that slips a concrete tech id into a write. Metros are compared by AREA
// NAME, not id, because a cross-company assignment is normal (Handy Andy's
// Denver and Dom's Denver are different area rows that both read "Denver").
// Returns null when nothing is provably wrong: an unmapped zip or an untagged
// tech stays permissive, since the point is to catch a provable mismatch, not
// to block bookings the data can't judge. Callers turn a hit into a 409 with
// code 'cross_metro_confirm' + tech_id that the office can confirm through,
// so a real cross-market drive (e.g. covering an unstaffed metro) is one
// extra click per tech, never impossible.
//
// `confirmedIds` is the per-TECH confirm list (body.confirm_cross_metro_ids),
// deliberately NOT a request-wide boolean: confirming Zach must never also
// silently wave through a second, never-shown mismatched tech in the same
// request. Same doctrine as force_unavailable_ids below. Each remaining
// unconfirmed mismatch surfaces as its own 409 on the next attempt.
async function crossMetroMismatch(db, bookingAreaId, techIds, confirmedIds) {
  const confirmed = new Set((confirmedIds || []).map(String));
  const ids = (techIds || []).filter(id => id && id !== 'any' && !confirmed.has(String(id)));
  if (!bookingAreaId || !ids.length) return null;
  const { data: techs } = await db.from('technicians')
    .select('id, name, service_area_id').in('id', ids);
  const areaIds = [...new Set([bookingAreaId, ...(techs || []).map(t => t.service_area_id).filter(Boolean)])];
  const { data: areas } = await db.from('service_areas').select('id, name').in('id', areaIds);
  const byId = new Map((areas || []).map(a => [a.id, a]));
  const norm = (id) => String(byId.get(id)?.name || '').trim().toLowerCase();
  const bookingMetro = norm(bookingAreaId);
  if (!bookingMetro) return null;
  for (const t of techs || []) {
    if (!t.service_area_id) continue;
    const techMetro = norm(t.service_area_id);
    if (techMetro && techMetro !== bookingMetro) {
      return {
        techId: t.id, techName: t.name,
        techMetro: byId.get(t.service_area_id)?.name || 'another metro',
        bookingMetro: byId.get(bookingAreaId)?.name || 'this metro',
      };
    }
  }
  return null;
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

// notifyTechAssigned now lives in api/_lib/tech-notify.js (imported at the top
// of this file). It used to be private to admin.js, which is exactly why the
// PUBLIC booking endpoint (api/book.js) never texted the tech it auto-assigned:
// the function was physically unimportable from there. It is also now AWAITED
// at every call site below and records each attempt in app.tech_sms_log — the
// old fire-and-forget version could be frozen by Vercel before Twilio was ever
// called, and left no trace when it failed.

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
    // Public "what we do" page (services.html) — no login, not customer-specific,
    // so it skips the auth gate the same way estimate_approve_info does.
    if (action === 'services_public') return await servicesPublic(req, res, body);
    if (action === 'gds_upsell_info') return await gdsUpsellInfo(req, res, body);
    if (action === 'gds_upsell_add') return await gdsUpsellAdd(req, res, body);
    if (action === 'reschedule_info') return await rescheduleInfo(req, res, body);
    if (action === 'reschedule_submit') return await rescheduleSubmit(req, res, body);
    if (action === 'review_email_preview') return await reviewEmailPreview(req, res);
    if (action === 'send_test_review_email') return await sendTestReviewEmail(req, res, body);
    if (action === 'session_status') return await sessionStatus(req, res);
    // Posted by the Gmail forwarder script, which has no dashboard session —
    // authenticates with GRASSHOPPER_INGEST_SECRET instead of a login token.
    if (action === 'call_ingest') return await callIngest(req, res, body);

    // Everything below requires a valid admin token. call_recording is the one
    // exception to "Bearer header only": it's loaded by a plain <audio src>,
    // which can't attach a custom header, so it also accepts the exact same
    // signed token via ?token= — same verifyToken() check, just carried the
    // way a browser media request actually can.
    const auth = verifyToken(action === 'call_recording' ? (getBearer(req) || req.query.token) : getBearer(req));
    if (!auth || auth.kind !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();

    switch (action) {
      case 'send_spam_notice':  return await sendSpamNotice(req, res);
      case 'send_gds_rate_update': return await sendGdsRateUpdate(req, res, db);
      // Owner-triggered digest (re)send for a specific day — exists because the
      // cron path (api/migrate.js) is gated on CRON_SECRET, which is a
      // sensitive Vercel env var nobody can read back, so the owner had no way
      // to resend a digest after the Jul 30 2026 import-pollution incident.
      // offset: 0=today, -1=yesterday. dry=1 counts without sending.
      case 'daily_digest_resend': {
        if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
        const offset = (req.query.offset != null && req.query.offset !== '') ? parseInt(req.query.offset, 10) : 0;
        const dryRun = req.query.dry === '1';
        const out = await sendDailyBookingDigest({ force: true, dryRun, offset });
        return res.status(200).json({ ok: true, ...out });
      }
      case 'launch_status':        return await launchStatus(req, res, db, auth);
      case 'launch_checklist_set': return await launchChecklistSet(req, res, db, auth, body);
      case 'launch_market_checklist_set': return await launchMarketChecklistSet(req, res, db, auth, body);
      case 'zb_import':         return await zbImport(req, res, db, body);
      case 'summary':           return await summary(req, res, db, auth);
      case 'services':          return await services(req, res, db, auth);
      case 'service_options':   return await serviceOptions(req, res, db, auth);
      case 'widget_prices_list': return await widgetPricesList(req, res, db, auth);
      case 'widget_prices_save': return await widgetPricesSave(req, res, db, auth, body);
      case 'travel_fees_list':  return await travelFeesList(req, res, db, auth);
      case 'travel_fees_save':  return await travelFeesSave(req, res, db, auth, body);
      case 'travel_distance_preview': return await travelDistancePreview(req, res, db, auth, body);
      case 'coupons_list':      return await couponsList(req, res, db, auth);
      case 'coupons_save':      return await couponsSave(req, res, db, auth, body);
      case 'coupons_delete':    return await couponsDelete(req, res, db, auth, body);
      case 'multi_tv_discount_get':  return await multiTvDiscountGet(req, res, db, auth);
      case 'multi_tv_discount_save': return await multiTvDiscountSave(req, res, db, auth, body);
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
      case 'photo_logo_scan':      return await photoLogoScan(req, res, db, auth, body);
      case 'customers':         return await customers(req, res, db, auth);
      case 'customer_update':   return await customerUpdate(req, res, db, auth, body);
      case 'customer_detail':   return await customerDetail(req, res, db, auth);
      case 'profit_range':      return await profitRange(req, res, db, auth);
      case 'net_daily_range':   return await netDailyRange(req, res, db, auth);
      case 'technicians':       return await technicians(req, res, db, auth);
      case 'zip_area':          return await zipArea(req, res, db, auth);
      case 'partner_technicians': return await partnerTechnicians(req, res, db, auth);
      case 'technician_update': return await technicianUpdate(req, res, db, auth, body);
      case 'review_invite_send': return await reviewInviteSend(req, res, db, auth, body);
      case 'technician_photo_upload': return await technicianPhotoUpload(req, res, db, auth, body);
      case 'tech_availability':     return await techAvailability(req, res, db, auth);
      case 'tech_availability_set': return await techAvailabilitySet(req, res, db, auth, body);
      case 'tech_availability_exception_set': return await techAvailabilityExceptionSet(req, res, db, auth, body);
      case 'reviews':           return await reviews(req, res, db, auth);
      case 'review_requests':   return await reviewRequests(req, res, db, auth);
      case 'review_resend':     return await reviewResend(req, res, db, auth, body);
      case 'notification_resend': return await notificationResend(req, res, db, auth, body);
      case 'receipt_send':      return await receiptSend(req, res, db, auth, body);
      case 'invoice_send':      return await invoiceSend(req, res, db, auth, body);
      case 'calls':             return await calls(req, res, db, auth);
      case 'call_recording':    return await callRecording(req, res, db, auth);
      case 'call_update':       return await callUpdate(req, res, db, auth, body);
      case 'call_claim':        return await callClaim(req, res, db, auth, body);
      case 'call_block':        return await callBlock(req, res, db, auth, body);
      case 'call_delete':       return await callDelete(req, res, db, auth, body);
      case 'call_live_start':   return await callLiveStart(req, res, db, auth, body);
      case 'review_calls':      return await reviewCalls(req, res, db, auth);
      case 'review_call_log':   return await reviewCallLog(req, res, db, auth, body);
      case 'review_call_report': return await reviewCallReport(req, res, db, auth);
      case 'bad_reviews':       return await badReviews(req, res, db, auth);
      case 'google_reviews':       return await googleReviews(req, res, db, auth);
      case 'google_review_update': return await googleReviewUpdate(req, res, db, auth, body);
      case 'avg_ticket':        return await avgTicketRange(req, res, db, auth);
      case 'gsc_queries':       return await gscQueries(req, res, db, auth);
      case 'dfw_pages_analytics': return await dfwPagesAnalytics(req, res, auth);
      case 'estimates':         return await estimates(req, res, db, auth);
      case 'estimate_update':   return await estimateUpdate(req, res, db, auth, body);
      case 'estimate_create':   return await estimateCreate(req, res, db, auth, body);
      case 'estimate_send_sms': return await estimateSendSms(req, res, db, auth, body);
      case 'estimate_send_email': return await estimateSendEmail(req, res, db, auth, body);
      case 'estimate_decline':  return await estimateDecline(req, res, db, auth, body);
      case 'estimate_broker':          return await estimateBroker(req, res, db, auth, body);
      case 'estimate_broker_save_spec': return await estimateBrokerSaveSpec(req, res, db, auth, body);
      case 'estimate_broker_save_bid': return await estimateBrokerSaveBid(req, res, db, auth, body);
      case 'estimate_broker_book':     return await estimateBrokerBook(req, res, db, auth, body);
      case 'quote_economics':   return await quoteEconomics(req, res, db, auth, body);
      case 'quote_coupon':      return await quoteCoupon(req, res, db, auth, body);
      case 'call_event':        return await callEvent(req, res, db, auth, body);
      case 'call_analytics':    return await callAnalytics(req, res, db, auth);
      case 'audit_report':      return await auditReport(req, res, db, auth);
      case 'call_numbers':      return await callNumbers(req, res, db, auth);
      case 'my_call_performance': return await myCallPerformance(req, res, db, auth);
      case 'call_day_detail':   return await callDayDetail(req, res, db, auth);
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
      case 'wire_plate_set_status': return await wirePlateSetStatus(req, res, db, auth, body);
      case 'wire_plate_remove': return await wirePlateRemove(req, res, db, auth, body);
      case 'bracket_set_status': return await bracketSetStatus(req, res, db, auth, body);
      case 'payroll': return await payroll(req, res, db, auth);
      case 'payroll_combined': return await payrollCombined(req, res, db, auth);
      case 'actual_profit_save': return await actualProfitSave(req, res, db, auth);
      case 'office_pay_save': return await officePaySave(req, res, db, auth);
      case 'office_pay_rate_save': return await officePayRateSave(req, res, db, auth);
      case 'view_as': return await viewAs(req, res, db, auth);
      case 'secretary_availability': return await secretaryAvailability(req, res, db, auth);
      case 'secretary_availability_set': return await secretaryAvailabilitySet(req, res, db, auth, body);
      case 'secretary_availability_exception_set': return await secretaryAvailabilityExceptionSet(req, res, db, auth, body);
      case 'secretary_changes':      return await secretaryChanges(req, res, db, auth);
      case 'secretary_changes_seen': return await secretaryChangesSeen(req, res, db, auth, body);
      case 'secretaries_list': return await secretariesList(req, res, db, auth);
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
// The secretary who actually runs each business day-to-day (Heather/Handy
// Andy, Joey/Dom's) — office alerts (e.g. a failed estimate-approval booking)
// go to WHICHEVER company the job belongs to, never a single shared owner
// number, since the two businesses are staffed by different people.
// Confirmed mobiles (owner, 2026-08-25/26). Also on staff_users.phone (what
// puts a NAME on a call card instead of ten digits) and on each person's
// tracking rows (what actually rings them). Written here too so a missing
// *_SECRETARY_PHONE env var can't silently stop an alert — an unset var used
// to mean "text nobody", the quietest possible failure for a waiting customer.
const JOEY_MOBILE = '3032190118';
const HEATHER_MOBILE = '7203711561';

function secretaryPhoneFor(scope) {
  // Driven off the SAME map that grants access (api/_lib/staff-access.js), so
  // "who answers this brand's phone" and "who can see this brand's calls" can
  // never drift apart the way they did before this shared: the Austin four
  // once texted Heather after Joey had already taken those lines, and the
  // Houston four matched nothing at all and texted NOBODY.
  if (scope === 'doms' || (SECRETARY_EXTRA_BUSINESSES.doms || []).includes(scope)) {
    // The env var still wins when set, so a number can change without a deploy
    // — but it is no longer the only thing standing between a voicemail and
    // an alert.
    return process.env.DOMS_SECRETARY_PHONE || JOEY_MOBILE;
  }
  if (scope === 'handy-andy' || (SECRETARY_EXTRA_BUSINESSES['handy-andy'] || []).includes(scope)) {
    return process.env.HANDY_ANDY_SECRETARY_PHONE || HEATHER_MOBILE || '';
  }
  return '';
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
  // The switcher is driven entirely by this list, so a secretary with extra
  // brands gets them here (they land in its "Lead Gen" dropdown automatically).
  const loginExtra = scope === 'all' ? [] : (SECRETARY_EXTRA_BUSINESSES[scope] || []);
  let q = db.from('businesses').select('id, slug, name, timezone, brand_navy, brand_orange').eq('active', true).order('name');
  if (scope !== 'all') q = q.in('slug', [scope, ...loginExtra]);
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
  // `scope` stays the ONE primary business (every company-specific tool keys
  // off it); `allowed` is the extra brands this person also answers for.
  const token = signToken({ kind: 'admin', role, scope, name, ...(loginExtra.length ? { allowed: loginExtra } : {}) });
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

// Owner-only "View As" — mints a REAL secretary session token, identical in
// shape to what login() gives Heather/Joey when they enter their own business
// password, so the owner can see the dashboard exactly as one of them does
// (their nav items, their own business scope) without ever knowing or typing
// that password. Every existing role/scope check downstream (nav visibility,
// business-scoped queries, "My Availability" gating) treats this token no
// differently from a real secretary login — there's no separate
// impersonation code path to keep in sync or get wrong.
async function viewAs(req, res, db, auth) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  // Deliberately Heather/Joey only, not every business slug: this impersonates
  // a SECRETARY LOGIN (viewAs's whole purpose is showing the owner exactly what
  // a real secretary password unlocks — see login() above), and Mile High has
  // no secretary of its own to view as. The owner sees Mile High via the normal
  // business switcher instead (unfiltered by slug for scope:'all' — see the
  // businesses query in login()/sessionStatus()).
  const slug = (req.body?.business || '').toString();
  if (!['handy-andy', 'doms'].includes(slug)) return res.status(400).json({ error: 'business must be handy-andy or doms' });

  // Mirror the real login exactly, extra brands included — the whole point of
  // View As is showing the owner what that secretary actually sees, and Joey's
  // login now carries the Austin/Houston lead-gen brands.
  const viewAsExtra = SECRETARY_EXTRA_BUSINESSES[slug] || [];
  const { data: businesses, error } = await db.from('businesses')
    .select('id, slug, name, timezone, brand_navy, brand_orange').eq('active', true)
    .in('slug', [slug, ...viewAsExtra]).order('name');
  if (error) throw error;
  for (const b of (businesses || [])) b.stripe_pk = bookingStripePk(b.slug);

  const name = displayNameFor(slug);
  const token = signToken({ kind: 'admin', role: 'secretary', scope: slug, name, ...(viewAsExtra.length ? { allowed: viewAsExtra } : {}) });
  const config = {
    email: demoMode() || !!process.env.RESEND_API_KEY,
    sms: smsConfigured(),
    demo: demoMode(),
    maps_key: process.env.GOOGLE_MAPS_API_KEY || null,
    maps_autocomplete: process.env.MAPS_AUTOCOMPLETE === '1' && !!process.env.GOOGLE_MAPS_API_KEY,
  };
  return res.status(200).json({ token, role: 'secretary', scope: slug, name, config, businesses: businesses || [] });
}

// Validate the current session token and return user data. Called by tryAutoLogin()
// to restore a session without requiring a new password entry. If the token is
// invalid or expired, returns 401 and the frontend shows the login screen.
async function sessionStatus(req, res) {
  const auth = verifyToken(getBearer(req));
  if (!auth || auth.kind !== 'admin') return res.status(401).json({ error: 'Unauthorized' });

  const db = serviceClient();
  let q = db.from('businesses').select('id, slug, name, timezone, brand_navy, brand_orange').eq('active', true).order('name');
  const sessionAllowed = allowedSlugsFor(auth);
  if (sessionAllowed) q = q.in('slug', sessionAllowed);
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
// Module-scope, short-TTL memo: resolveBusiness runs 4-5x on a single New
// Booking open (services, TV options, calendar, partner roster, …), all for
// the same slug, and only survives across requests on a warm serverless
// container — never a substitute for a real cache layer. The scope check
// still runs on every call BEFORE the memo lookup, so a memo hit can never
// leak a business the caller isn't authorized for. Errors/not-found are
// never cached, and the 60s TTL keeps a renamed business or changed
// timezone from staying stale for more than a minute.
const _bizCache = new Map(); // slug -> { biz, at }
const BIZ_CACHE_TTL_MS = 60_000;
async function resolveBusiness(db, auth, slug) {
  if (!slug) { const e = new Error('business is required'); e.status = 400; throw e; }
  if (!mayUseBusiness(auth, slug)) { const e = new Error('Forbidden for this business'); e.status = 403; throw e; }
  const cached = _bizCache.get(slug);
  if (cached && (Date.now() - cached.at) < BIZ_CACHE_TTL_MS) return cached.biz;
  const { data, error } = await db.from('businesses').select('id, slug, name, timezone').eq('slug', slug).single();
  if (error || !data) { const e = new Error('Business not found'); e.status = 404; throw e; }
  _bizCache.set(slug, { biz: data, at: Date.now() });
  return data;
}

function bail(res, err) { return res.status(err.status || 500).json({ error: err.message }); }

// Best-effort record of whether the confirmation email actually sent, so the
// booking detail card can show real status instead of nothing at all. Never
// allowed to affect the booking itself — swallow a missing-column error the
// same way every other optimistic-column write in this codebase does
// (migration 0075 not applied yet). Mirrors the identical helper in book.js.
async function persistConfirmationEmailStatus(db, bookingId, status) {
  try {
    await db.from('bookings')
      .update({ confirmation_email_status: status, confirmation_email_sent_at: new Date().toISOString() })
      .eq('id', bookingId);
  } catch (e) { /* migration 0075 not applied yet — status just won't show */ }
}

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

    const earned = (rows) => (rows || []).filter(countsTowardProfit);
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
        const paidDone = (rows || []).filter(countsTowardProfit);
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
    // fields filled in have a real total_made. Fetches up to 2 years of weekly
    // entries; the box itself only PLOTS the last dozen or so raw weeks, but
    // its Monthly/3-month tabs sum these into coarser buckets client-side, so
    // they need real history behind them as it accumulates, not just enough
    // for the weekly view alone.
    {
      const { data: apRows } = await db.from('actual_profit_weekly')
        .select('pay_date, doms_stripe_payout, handy_andy_stripe_payout, tech_pay')
        .not('doms_stripe_payout', 'is', null)
        .not('handy_andy_stripe_payout', 'is', null)
        .not('tech_pay', 'is', null)
        .order('pay_date', { ascending: false })
        .limit(104);
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
      // Cancelled jobs are NOT "on the schedule": the calendar's day columns
      // hide them (passFilters), so counting them here made the greeting say
      // "There is 1 job on the schedule today" over a day the calendar
      // correctly showed as empty (Dom's, Aug 11 2026: the only booking that
      // day was cancelled the night before, and the secretary reported the
      // mismatch as a glitch). Same exclusion `unassigned` below always had.
      todayTotal: (today || []).filter(b => b.status !== 'cancelled').length,
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

  // Ghost bookings: a cross-hired tech keeps ONE technician row, referenced
  // directly by technician_id/secondary_technician_id on bookings that belong
  // to an OTHER business (e.g. Kregg — a Handy Andy tech — picking up a Dom's
  // or Mile High job). So the match is by id, not name: this business's own
  // tech ids, looked up against every OTHER active business's bookings — not
  // just the single PARTNER_SLUG pairing, since Handy Andy's techs get
  // borrowed by Doms, Mile High, Austin, AND Precision all at once, and every
  // one of those needs to show up faded on Handy Andy's own schedule so the
  // office can see where its techs are actually busy. Surface it as a
  // separate read-only list, never merged into `bookings`, so it can never be
  // double-counted in payroll or job counts.
  let ghostBookings = [];
  try {
    const ownTechIds = (techs || []).map(t => t.id);
    const { data: otherBiz } = await db.from('businesses')
      .select('id, name, slug').eq('active', true).neq('id', biz.id);
    const otherBizById = {};
    for (const ob of (otherBiz || [])) otherBizById[ob.id] = ob;
    const otherBizIds = Object.keys(otherBizById);
    // Ghosts already added for a booking, so the lead-gen sweep below can't
    // repeat one that source 1 surfaced through a shared tech.
    const ghostedBookingIds = new Set();
    if (ownTechIds.length && otherBizIds.length) {
      const { data: pbk, error: pbkErr } = await db.from('bookings')
        .select('id, business_id, technician_id, secondary_technician_id, scheduled_at, duration_minutes, status, customer:customers ( name )')
        .in('business_id', otherBizIds)
        .or(`technician_id.in.(${ownTechIds.join(',')}),secondary_technician_id.in.(${ownTechIds.join(',')})`)
        .not('status', 'in', '(cancelled,no_show)')
        .gte('scheduled_at', from).lt('scheduled_at', to)
        .limit(2000);
      if (pbkErr) throw pbkErr;
      const ownTechIdSet = new Set(ownTechIds);
      for (const b of (pbk || [])) {
        const companyName = otherBizById[b.business_id]?.name || 'Partner';
        const customerName = b.customer?.name || null;
        if (ownTechIdSet.has(b.technician_id)) {
          ghostBookings.push({ technician_id: b.technician_id, scheduled_at: b.scheduled_at, duration_minutes: b.duration_minutes || 60, partner_company: companyName, customer_name: customerName });
          ghostedBookingIds.add(b.id);
        }
        if (b.secondary_technician_id && ownTechIdSet.has(b.secondary_technician_id)) {
          ghostBookings.push({ technician_id: b.secondary_technician_id, scheduled_at: b.scheduled_at, duration_minutes: b.duration_minutes || 60, partner_company: companyName, customer_name: customerName });
          ghostedBookingIds.add(b.id);
        }
      }
    }

    // Source 2 (owner rule, 2026-08-25): EVERY lead-gen booking shows as a
    // ghost on BOTH staffed dashboards, no matter whose tech works it. Heather
    // and Joey each answer phones for brands the other one books for, so a
    // Mile High job booked by Heather has to be visible to Joey (and vice
    // versa) or the two of them are working blind to half the calendar.
    // Only on the handy-andy/doms views — a lead-gen brand's own view is that
    // brand's real schedule and needs no ghosts of itself. Still read-only and
    // still a separate list, so it can never leak into payroll or job counts.
    if (['handy-andy', 'doms'].includes(biz.slug)) {
      const leadGenIds = otherBizIds.filter(id => !['handy-andy', 'doms'].includes(otherBizById[id].slug));
      if (leadGenIds.length) {
        const { data: lgbk, error: lgErr } = await db.from('bookings')
          .select('id, business_id, technician_id, scheduled_at, duration_minutes, status, customer:customers ( name )')
          .in('business_id', leadGenIds)
          .not('status', 'in', '(cancelled,no_show)')
          .gte('scheduled_at', from).lt('scheduled_at', to)
          .limit(2000);
        if (lgErr) throw lgErr;
        const fresh = (lgbk || []).filter(b => !ghostedBookingIds.has(b.id));
        // The assigned tech usually isn't on THIS dashboard's roster (Zach and
        // Juan are Handy Andy techs viewed from Dom's, say), so carry the name
        // along rather than leaving the card to shrug "Tech busy".
        const techIds = [...new Set(fresh.map(b => b.technician_id).filter(Boolean))];
        const techNameById = {};
        if (techIds.length) {
          const { data: ts } = await db.from('technicians').select('id, name').in('id', techIds);
          for (const t of (ts || [])) techNameById[t.id] = t.name;
        }
        for (const b of fresh) {
          ghostBookings.push({
            technician_id: b.technician_id || null,
            tech_name: techNameById[b.technician_id] || null,
            scheduled_at: b.scheduled_at,
            duration_minutes: b.duration_minutes || 60,
            partner_company: otherBizById[b.business_id]?.name || 'Lead gen',
            customer_name: b.customer?.name || null,
          });
        }
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
  // Attach tech-notification status. The detail panel shows a "Tech notified"
  // row for every job, and without tech_sms it falls back to "No record" — so
  // every job opened from the SCHEDULE (which is how the office opens nearly
  // all of them) claimed the tech was never texted even when the text was
  // delivered. Only the bookings-list endpoint attached this before.
  await withTechSms(db, bookings);

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
// profit. Customer-supplied / in-the-box brackets cost the business nothing.
//
// Juan is a special case, gated on the SAME cutoff as his payroll rate
// (JUAN_BRACKET_ZERO_FROM, imported from payroll.js): before 2026-08-16 he
// bought his own brackets and was reimbursed through an elevated payout rate,
// so counting the hardware cost here too would have double-deducted it. From
// that date on the owner buys the brackets and ships them to Juan directly —
// a real out-of-pocket cost — while his payout reimbursement was zeroed at
// the same time, so it now needs to be counted here exactly like every other
// tech's bracket, or it's an invisible cost that silently overstates profit
// on every one of his jobs. (Found 2026-09-02: profit had been overstated on
// every Juan job with a paid bracket since the 8/16 change.)
const BRACKET_HW_COST = [
  { test: /full\s*motion/i, cost: 60 },
  { test: /tilting/i,       cost: 28 },
  { test: /\bflat\b/i,      cost: 20 },
];
function bracketHardwareCost(lineItems, hasJuan, scheduledAt) {
  if (hasJuan) {
    const t = scheduledAt ? new Date(scheduledAt) : null;
    const ownBracket = t && !isNaN(t) && t < JUAN_BRACKET_ZERO_FROM;
    if (ownBracket) return 0;
  }
  let total = 0;
  for (const li of lineItems || []) {
    const n = String(li.name || '');
    if (/own bracket|in the box|customer supplied/i.test(n)) continue;
    const hit = BRACKET_HW_COST.find(b => b.test.test(n));
    if (hit) total += hit.cost * (Number(li.quantity) || 1);
  }
  return total;
}

// Realized profit over an arbitrary window, both companies combined, with the
// per-business split the Profit box shows underneath.
//
// Lives in its OWN action rather than being folded into the greeting payload on
// purpose: "this year" can span several thousand jobs and every one of them
// needs a computeJobEconomics pass, so precomputing it would put seconds onto
// EVERY dashboard load to serve a tab most opens never touch. The dashboard
// fetches it the first time the tab is clicked and caches the answer.
//
// Same definition of profit as the week figure it sits next to: completed AND
// paid only, so the numbers are comparable rather than three different ideas of
// "profit" in one card.
async function profitRange(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const range = (req.query.range || '').toString();
  if (!['30d', 'year'].includes(range)) return res.status(400).json({ error: 'range must be 30d or year' });

  const { data: allBiz } = await db.from('businesses').select('id, slug, name, timezone').eq('active', true);
  const tz = biz.timezone || 'America/Denver';

  // Anchored on the VIEWED business's local day so "this year" means the year
  // the office is actually living in, not UTC's.
  const end = localDayStartUTC(tz, 1);            // include everything up to end of today
  let start;
  if (range === '30d') {
    start = localDayStartUTC(tz, -29);            // 30 calendar days including today
  } else {
    // Jan 1 of the year the office is currently living in, converted to the
    // right UTC instant by the shared helper rather than by hand.
    const localYear = new Date().toLocaleString('en-US', { timeZone: tz, year: 'numeric' });
    start = localDateStartUTC(tz, `${localYear}-01-01`);
  }

  const travelCache = new Map();
  const travelMapFor = async (bb) => {
    if (travelCache.has(bb.id)) return travelCache.get(bb.id);
    const m = await travelPayoutMap(db, bb.id);
    travelCache.set(bb.id, m);
    return m;
  };

  const parts = await Promise.all((allBiz || []).map(async (bb) => {
    const { data: rows } = await fetchEconomicsRows(sel => db.from('bookings').select(sel)
      .eq('business_id', bb.id)
      .gte('scheduled_at', start.toISOString())
      .lt('scheduled_at', end.toISOString()));
    const paid = (rows || []).filter(countsTowardProfit);
    if (!paid.length) return [bb.slug, 0];
    const e = await computeJobEconomics(db, bb, paid, true, await travelMapFor(bb));
    return [bb.slug, Math.round(paid.reduce((n, j) => n + (Number(e[j.id]?.profit) || 0), 0))];
  }));

  const by_slug = Object.fromEntries(parts);
  const total = Math.round(parts.reduce((a, [, v]) => a + v, 0));
  return res.status(200).json({ range, total, by_slug, from: start.toISOString(), to: end.toISOString() });
}

// Daily net-profit trend for the "Net Daily Profit" chart (7d / 30d). ONE
// query per business over the whole window, economics computed once, then
// bucketed per job into its LOCAL day, the same per-business day boundary the
// single-day today/yesterday figure above the chart already uses (netDailyFor
// in the greeting handler), so the chart's rightmost point always agrees with
// that headline number instead of drifting from a different day definition.
// Bucketing walks explicit localDayStartUTC() boundaries rather than dividing
// by 86400000ms, since a day spans 23 or 25 hours across a DST transition and
// naive division would misfile a job on those days.
async function netDailyRange(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const range = (req.query.range || '').toString();
  if (!['7d', '30d'].includes(range)) return res.status(400).json({ error: 'range must be 7d or 30d' });
  const days = range === '7d' ? 7 : 30;

  const { data: allBiz } = await db.from('businesses').select('id, slug, name, timezone').eq('active', true);

  const travelCache = new Map();
  const travelMapFor = async (bb) => {
    if (travelCache.has(bb.id)) return travelCache.get(bb.id);
    const m = await travelPayoutMap(db, bb.id);
    travelCache.set(bb.id, m);
    return m;
  };

  // index 0 = oldest day in the window, index days-1 = today. Combined across
  // every active business.
  const totals = new Array(days).fill(0);

  await Promise.all((allBiz || []).map(async (bb) => {
    const tz = bb.timezone || 'America/Denver';
    const oldestStart = localDayStartUTC(tz, -(days - 1));
    const end = localDayStartUTC(tz, 1);
    const { data: rows } = await fetchEconomicsRows(sel => db.from('bookings').select(sel)
      .eq('business_id', bb.id)
      .gte('scheduled_at', oldestStart.toISOString())
      .lt('scheduled_at', end.toISOString()));
    const paid = (rows || []).filter(countsTowardProfit);
    if (!paid.length) return;
    const e = await computeJobEconomics(db, bb, paid, true, await travelMapFor(bb));
    // Precompute this business's day boundaries once, then a cheap per-job scan.
    const bounds = Array.from({ length: days }, (_, d) => localDayStartUTC(tz, -(days - 1) + d).getTime());
    for (const b of paid) {
      const t = new Date(b.scheduled_at).getTime();
      let idx = -1;
      for (let d = days - 1; d >= 0; d--) { if (t >= bounds[d]) { idx = d; break; } }
      if (idx < 0) continue;   // scheduled before the window (shouldn't happen given the query bound, but never miscount)
      totals[idx] += Number(e[b.id]?.profit) || 0;
    }
  }));

  // Labels use the VIEWED business's own tz, display only; the bucketing
  // above already happened per-business.
  const tz = biz.timezone || 'America/Denver';
  const series = totals.map((v, i) => ({
    date: localDayStartUTC(tz, -(days - 1) + i).toISOString().slice(0, 10),
    total: Math.round(v),
  }));
  return res.status(200).json({ range, days: series });
}

// Which completed jobs count toward REALIZED profit.
//
// Profit now uses the payroll engine's own settled/deferred rule instead of a
// bare payment_status check, so profit and payroll can never disagree about
// whether a job has happened yet. paymentState() treats a $0 ticket as settled
// and an unpaid job that still owes a balance as deferred, which is exactly the
// distinction profit wants:
//
//   $0 redeemed GDS   the customer owes nothing and never will, but the tech IS
//                     paid ($50-60) this week, so the job is real and its cost
//                     belongs in today's profit. The old check excluded it
//                     forever, because a $0 job can never become "paid": 7
//                     redemptions and $380 of tech pay had gone out since July
//                     12 without appearing in any profit figure (owner spotted
//                     it as "Aug 11 says $105 but should be $55").
//   unpaid, owes $215 payroll defers the tech's pay until the customer pays, so
//                     profit keeps deferring it too. Unchanged behaviour.
function countsTowardProfit(b) {
  return b.status === 'completed' && paymentState(b) !== 'deferred';
}

async function computeJobEconomics(db, biz, rows, includePay, travelMap = null) {
  // Callers that compute economics for many row sets of the SAME business pass a
  // pre-fetched travel-payout map so we don't re-query it every time.
  const travelPayoutByZip = includePay ? (travelMap || await travelPayoutMap(db, biz.id)) : null;
  const out = {};
  for (const b of rows) {
    // Revenue for profit is what the business actually KEPT: the ticket price
    // less anything refunded to the customer. A refund never decrements
    // amount_paid anywhere in this codebase (bookingPayment writes only
    // payment_status + amount_refunded), and nothing here used to read that
    // column at all — so every refunded job counted its full pre-refund price
    // as revenue and overstated profit by exactly the refund. Found 2026-09-05
    // on Hannah Kelarek's 9/2 job: $80 service-area surcharge refunded, still
    // booked as revenue. 8 completed jobs were affected, $873.84 total.
    //
    // customer_cost stays GROSS so the job card keeps matching the ticket and
    // the receipt; the refund is surfaced separately as econ.refunded.
    //
    // Not clamped at zero: refunding more than the service price is a real loss
    // and should read as one. (Tips are excluded from profit on both sides, so a
    // refund that included a tip nets slightly conservative here — rare enough,
    // and erring toward understating profit, that it isn't worth guessing which
    // part of a flat refund amount was tip.)
    const gross = Number(b.price) || 0;
    const refunded = Number(b.amount_refunded) || 0;
    const cost = Math.round((gross - refunded) * 100) / 100;
    const econ = { service_cat: classifyService(b), customer_cost: gross, refunded };
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
        scheduled_at: b.scheduled_at,
        travel_payout: travelPayoutByZip.get(String(b.postal_code || '')) || 0,
        // Two assigned techs split the job 50/50 even without a "lift help" line.
        second_tech: techNames.length > 1,
        is_houston: await isHoustonBooking(db, biz.id, biz.slug, b.service_area_id),
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
      // Bracket hardware the business bought (Juan's own-bracket exemption
      // ended 2026-08-16 — see bracketHardwareCost).
      const bracketCost = bracketHardwareCost(b.line_items, techNames.some(isJuan), b.scheduled_at);
      // Tips are 100% the tech's and pass straight through (customer -> tech), so
      // they RAISE the tech's payout but never touch business profit — profit is
      // computed from the service price and base pay only, with the tip excluded
      // on both sides.
      const tip = Number(b.tip) || 0;
      econ.tech_payout = Math.round(payout + tip);
      econ.bracket_cost = Math.round(bracketCost);
      econ.profit = Math.round(cost - payout - bracketCost);
      econ.assigned = techNames.length > 0;
      // Cash job: the tech kept the customer's money, so what actually gets PAID
      // on payroll is their earnings minus the cash they're holding (usually
      // negative — the business's share comes back out of their pay). Profit
      // above is deliberately unchanged: the job's economics are the same, only
      // the direction the money moves is different. Surfaced so the schedule
      // card can't imply the tech is owed money they've already taken.
      if (b.payment_method === 'cash') {
        const collected = Math.round(Number(b.amount_paid) || Number(b.price) || 0);
        econ.cash_collected = collected;
        econ.net_tech_pay = Math.round(payout + tip) - collected;
      }
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
  const bizList = (allBiz || []).map(b => ({ slug: b.slug, name: b.name }));
  // business=all: ONE board with every active tech across every company —
  // the owner asked for this after the per-company pills turned out to be 11
  // empty boards (only Handy Andy and Doms actually employ techs). Each tech
  // carries business_slug so the client can decide per-tech editability (the
  // set/exception endpoints still verify tech∈business server-side).
  const wantAll = slug === 'all';
  const biz = wantAll ? null : (allBiz || []).find(b => b.slug === slug);
  if (!wantAll && !biz) return res.status(404).json({ error: 'Business not found' });
  const bizById = new Map((allBiz || []).map(b => [b.id, b]));
  let techQ = db.from('technicians')
    .select('id, name, color, business_id, status').eq('active', true).order('name');
  if (!wantAll) techQ = techQ.eq('business_id', biz.id);
  const { data: techRows } = await techQ;
  const techs = (techRows || []).map(t => ({
    id: t.id, name: t.name, color: t.color, status: t.status,
    business_slug: bizById.get(t.business_id)?.slug || null,
  }));
  const ids = techs.map(t => t.id);
  // Per-tech tz fallback for occupancy: a booking with no service-area tz
  // falls back to ITS TECH's own business tz (in single-business mode that is
  // the same `tz` as before).
  const techTz = new Map((techRows || []).map(t => [t.id, bizById.get(t.business_id)?.timezone || 'America/Denver']));

  const tz = (biz && biz.timezone) || 'America/Denver';
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
    // Bounded to yesterday-onward (one day of slack covers every US metro's
    // offset from the business tz). This query used to have NO lower bound
    // while sorting oldest-first with limit(2000) -- once the July 2026
    // Zenbooker import pushed these techs past 2000 historical rows, the
    // whole window sat in 2022-2025 and NO current booking ever occupied a
    // chip (Kregg showed free at 11a while standing in Debbie Mulqueen's
    // living room). The grid only renders today-forward (exceptions are
    // already fetched today-forward), so the past contributes nothing.
    const occSince = localDayStartUTC(tz, -1).toISOString();
    const runBk = (withSecond) => {
      let q = db.from('bookings')
        .select((withSecond ? 'technician_id, secondary_technician_id, scheduled_at, service_area_id' : 'technician_id, scheduled_at, service_area_id') + esCol())
        .neq('status', 'cancelled').not('scheduled_at', 'is', null)
        .gte('scheduled_at', occSince)
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
    // Each booking's slot is derived in ITS OWN metro's timezone, not the
    // business's. Handy Andy spans Mountain and Central: a 5 PM Houston job
    // read in Denver time is 4 PM, which falls in the gap between the fixed
    // slots and mapped to NO slot at all -- so Juan's (and any Central) jobs
    // never occupied a chip, and an 8 PM Central job landed on the 5p chip.
    // All areas are fetched (no business filter) because the occupancy query
    // itself is cross-company on purpose. Falls back to the business tz for
    // bookings with no service area, same as areaTimezone() does.
    const areaTzMap = new Map();
    try {
      const { data: saRows } = await db.from('service_areas').select('id, timezone');
      for (const sa of (saRows || [])) if (sa.timezone) areaTzMap.set(sa.id, sa.timezone);
    } catch { /* fall back to business tz below */ }
    const idSet = new Set(ids);
    const occRows = [];
    for (const b of (bk || [])) {
      const btz = areaTzMap.get(b.service_area_id) || techTz.get(b.technician_id) || tz;
      const slot_key = slotKeyForLocalTime(localHHMM(btz, b.scheduled_at));
      if (!slot_key) continue;
      const date = localDateStr(btz, b.scheduled_at);
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
  return res.status(200).json({ slots: SLOTS, days: DAYS, technicians: techs, availability, exceptions, bookings, businesses: bizList, business: wantAll ? { slug: 'all', name: 'All technicians' } : { slug: biz.slug, name: biz.name } });
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
    return res.status(200).json({ bookings: await withTechSms(db, (data || []).map(shapeBooking)) });
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
  return res.status(200).json({ bookings: await withTechSms(db, (data || []).map(shapeBooking)) });
}

// Attach each booking's technician-notification status (app.tech_sms_log) so the
// schedule/detail UI can show whether the assigned tech was actually TOLD about
// the job. One batched query for the whole page — never per booking. Entirely
// best-effort: if the table isn't there yet (migration not applied) the
// bookings still render, just without the badge.
async function withTechSms(db, rows) {
  const ids = rows.map(r => r.id).filter(Boolean);
  if (!ids.length) return rows;
  try {
    const { data, error } = await db.from('tech_sms_log')
      .select('booking_id, technician_id, kind, status, skip_reason, error, sent_at, delivered_at, technician:technicians ( name )')
      .in('booking_id', ids)
      .order('sent_at', { ascending: false });
    if (error) throw error;
    const byBooking = new Map();
    for (const r of (data || [])) {
      const row = { ...r, tech_name: r.technician?.name || null };
      delete row.technician;
      if (!byBooking.has(row.booking_id)) byBooking.set(row.booking_id, []);
      byBooking.get(row.booking_id).push(row);
    }
    for (const b of rows) b.tech_sms = byBooking.get(b.id) || [];
  } catch (e) {
    console.warn('[tech_sms_log] attach skipped:', e.message);
  }
  return rows;
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
  const forcedIds = new Set((body && body.force_unavailable_ids || []).map(String));
  const dow = dayOfWeekFor(dateStr);
  // Every tech on this job must have ALREADY marked an extra slot available —
  // reserving it just because the main slot is theirs would silently extend
  // the job into hours they never agreed to work. Per-tech override only
  // (never bypasses the "already booked by someone else" conflict above).
  const techSlotKeys = {};
  for (const tid of techIds) techSlotKeys[tid] = await singleTechSlotKeys(db, tid, dateStr, dow);
  const clean = [];
  for (const sk of requested) {
    if (!SLOT_KEYS.has(sk)) return res.status(400).json({ error: `Invalid time slot: ${sk}` });
    if (sk === mainSlot) continue;                       // the main slot is implied, never an extra
    if (takenByOthers.has(sk)) {
      const lab = (SLOTS.find(s => s.key === sk) || {}).label || sk;
      return res.status(409).json({ error: `${lab} is already booked for this technician — can't add it.` });
    }
    for (const tid of techIds) {
      if (forcedIds.has(tid)) continue;
      if (!techSlotKeys[tid].has(sk)) {
        const { data: t } = await db.from('technicians').select('name').eq('id', tid).maybeSingle();
        const lab = (SLOTS.find(s => s.key === sk) || {}).label || sk;
        return res.status(409).json({ error: `${t?.name || 'This technician'} isn't scheduled to work ${lab} — they may have requested it off. Confirm to add it anyway.`, code: 'tech_unavailable', tech_id: tid });
      }
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

// ── Public widget pricing (Other -> Widget Pricing) ──────────────────────────
// Every price the customer-facing booking widget (public/widget.js) charges,
// self-serve editable here instead of requiring a code change + deploy. See
// api/book.js's widgetPricesPublic() for how the widget actually consumes
// these at load time — this is just the admin read/write side.
const WIDGET_PRICE_CEILING = 2000;   // dollars — a fat-fingered price never silently saves
async function widgetPricesList(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data, error } = await db.from('widget_prices')
    .select('id, city_key, section_key, option_id, label, price, sort_order, row_key')
    .eq('business_id', biz.id)
    .order('city_key').order('sort_order');
  if (error) throw error;
  return res.status(200).json({ prices: data || [] });
}
async function widgetPricesSave(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return res.status(400).json({ error: 'updates required' });
  for (const u of updates) {
    const price = Number(u.price);
    if (!u.id || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Each update needs a valid id and a non-negative price' });
    if (price > WIDGET_PRICE_CEILING) return res.status(400).json({ error: `$${price} is above the $${WIDGET_PRICE_CEILING} sanity ceiling for a single widget price — double-check this isn't a typo.` });
  }
  // One update at a time (small list, correctness over round-trip count) so a
  // bad id in the middle of a batch can't half-save silently. business_id in
  // the WHERE clause is a belt-and-suspenders scope check — the id itself is
  // already a random uuid, but this ensures a row can never be updated across
  // businesses even given a stale/forged id.
  for (const u of updates) {
    const { error } = await db.from('widget_prices')
      .update({ price: Number(u.price), updated_at: new Date().toISOString() })
      .eq('id', u.id).eq('business_id', biz.id);
    if (error) throw error;
  }
  return res.status(200).json({ ok: true, updated: updates.length });
}

// ── Travel fees (Other -> Travel Fees) ───────────────────────────────────────
// Per-zip travel pricing, grouped into the tiers the office actually thinks in
// ("Houston 1/2/3/4"). A tier is just every zip in an area sharing the same
// (surcharge, tech_payout) pair — there is no tier table, which is why editing
// a tier writes to all of its zips at once.
//
// Only two columns here are live: `surcharge` is what the CUSTOMER is charged
// (api/book.js and api/service-area.js read it) and `tech_payout` is what the
// TECH is paid for the drive (payroll's travelPayoutMap reads it). The older
// travel_fee/travel_payout columns are vestigial — nothing reads them — so this
// tool deliberately ignores them rather than writing numbers that do nothing.
const TRAVEL_FEE_CEILING = 500;    // dollars — a fat-fingered fee never silently saves
async function travelFeesList(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data: areas, error: aErr } = await db.from('service_areas')
    .select('id, name, unstaffed, active').eq('business_id', biz.id).order('name');
  if (aErr) throw aErr;
  const { data: zips, error: zErr } = await db.from('service_area_zips')
    .select('id, postal_code, service_area_id, surcharge, tech_payout')
    .eq('business_id', biz.id).order('postal_code');
  if (zErr) throw zErr;
  return res.status(200).json({ areas: areas || [], zips: zips || [] });
}
async function travelFeesSave(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // Travel pricing moves both customer revenue and tech pay, so it stays with
  // the owner rather than whoever is covering the phones.
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change travel fees' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const ids = Array.isArray(body.zip_ids) ? body.zip_ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'zip_ids required' });
  const surcharge = Number(body.surcharge);
  const payout = Number(body.tech_payout);
  if (!Number.isFinite(surcharge) || surcharge < 0) return res.status(400).json({ error: 'Customer fee must be a number of $0 or more' });
  if (!Number.isFinite(payout) || payout < 0) return res.status(400).json({ error: 'Tech payout must be a number of $0 or more' });
  if (surcharge > TRAVEL_FEE_CEILING || payout > TRAVEL_FEE_CEILING) {
    return res.status(400).json({ error: `$${Math.max(surcharge, payout)} is above the $${TRAVEL_FEE_CEILING} sanity ceiling for a travel fee — double-check this isn't a typo.` });
  }
  // Paying the tech more for the drive than the customer is charged for it is
  // nearly always a slip, and it silently loses money on every job in the tier.
  // Allowed only when explicitly confirmed, so a deliberate loss-leader is still
  // possible.
  if (payout > surcharge && body.confirm_negative !== true) {
    return res.status(409).json({
      code: 'travel_fee_negative',
      error: `That pays the tech $${(payout - surcharge).toFixed(2)} more per job than the customer is charged. Save it anyway?`,
    });
  }
  // business_id in the WHERE clause scopes the write even given a stale id.
  const { data, error } = await db.from('service_area_zips')
    .update({ surcharge, tech_payout: payout })
    .in('id', ids).eq('business_id', biz.id).select('id');
  if (error) throw error;
  return res.status(200).json({ ok: true, updated: (data || []).length });
}

// ── Travel distance preview (Other -> Travel Fees -> Check drive distances) ──
// Real driving distance/time from the tech's home zip to every zip in a
// service area, via Google's Distance Matrix API (same GOOGLE_MAPS_API_KEY
// that already powers address autocomplete and the job-detail map). READ-ONLY:
// it changes no pricing, it exists so the owner can see today's fee next to
// the actual drive and re-tier with real numbers instead of guessing. Cost is
// about half a cent per zip checked, so a full Houston run is under a dollar.
async function travelDistancePreview(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const areaId = (body.area_id || '').toString();
  const originZip = (body.origin_zip || '').toString().replace(/\D/g, '').slice(0, 5);
  if (!areaId) return res.status(400).json({ error: 'area_id required' });
  if (originZip.length !== 5) return res.status(400).json({ error: 'A 5-digit origin zip (where the tech lives) is required.' });

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Google Maps key is not configured.' });

  const { data: zips, error: zErr } = await db.from('service_area_zips')
    .select('postal_code, surcharge, tech_payout')
    .eq('business_id', biz.id).eq('service_area_id', areaId).order('postal_code');
  if (zErr) throw zErr;
  if (!zips || !zips.length) return res.status(404).json({ error: 'No zips in that service area.' });

  // Distance Matrix caps destinations at 25 per request; batch and stitch.
  // Zips are sent as "zip, USA" strings -- for a within-metro run the state is
  // unambiguous, and the same shortcut is how the office already thinks.
  const out = [];
  for (let i = 0; i < zips.length; i += 25) {
    const batch = zips.slice(i, i + 25);
    const u = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
    u.searchParams.set('origins', `${originZip}, USA`);
    u.searchParams.set('destinations', batch.map(z => `${z.postal_code}, USA`).join('|'));
    u.searchParams.set('units', 'imperial');
    u.searchParams.set('key', key);
    const r = await fetch(u).then(x => x.json()).catch(e => ({ status: 'FETCH_ERROR', error_message: e.message }));
    if (r.status !== 'OK') {
      return res.status(502).json({ error: `Distance lookup failed: ${r.error_message || r.status}. If this says the API isn't enabled, turn on "Distance Matrix API" for this key in the Google Cloud console.` });
    }
    const row = (r.rows && r.rows[0] && r.rows[0].elements) || [];
    batch.forEach((z, j) => {
      const el = row[j] || {};
      out.push({
        postal_code: z.postal_code,
        surcharge: Number(z.surcharge) || 0,
        tech_payout: Number(z.tech_payout) || 0,
        miles: el.status === 'OK' ? Math.round((el.distance.value / 1609.34) * 10) / 10 : null,
        minutes: el.status === 'OK' ? Math.round(el.duration.value / 60) : null,
      });
    });
  }
  out.sort((a, b) => (a.minutes ?? 9999) - (b.minutes ?? 9999));
  return res.status(200).json({ origin_zip: originZip, zips: out });
}

// ── Multi-TV discount (Other -> Multi-TV Discount) ──────────────────────────
// One global row (see supabase/migrations/0088), read through the same
// cached getter api/book.js uses for the live discount so this always shows
// what a booking would actually get. multiTvDiscountConfigFor() already
// falls back to the pre-2026-08 hardcoded defaults if the table or row is
// somehow missing, so this never 500s even on a fresh/unmigrated database.
const MULTI_TV_FEE_CEILING = 100;   // dollars per TV, a fat-fingered number never silently saves
const MULTI_TV_PRICE_TIER_CEILING = 200; // dollars per TV on the price side
async function multiTvDiscountGet(req, res, db, auth) {
  const cfg = await multiTvDiscountConfigFor(db);
  return res.status(200).json({ config: cfg });
}
async function multiTvDiscountSave(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // This changes what every multi-TV job is charged going forward, owner only.
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change the multi-TV discount' });

  const threshold = parseInt(body.tv_threshold, 10);
  if (!Number.isFinite(threshold) || threshold < 2 || threshold > 10) {
    return res.status(400).json({ error: 'TV threshold must be a whole number between 2 and 10' });
  }
  const zeroFeePerTv = Number(body.zero_fee_per_tv);
  const fullCutFee = Number(body.full_cut_fee);
  const partialCutPct = Number(body.partial_cut_pct);
  const tier3 = Number(body.price_tier3);
  const tier4 = Number(body.price_tier4);
  const tier5plus = Number(body.price_tier5plus);
  for (const [label, val, ceiling] of [
    ['Zero-fee-per-TV amount', zeroFeePerTv, MULTI_TV_FEE_CEILING],
    ['Full-cut fee', fullCutFee, MULTI_TV_FEE_CEILING],
    ['3rd-TV price credit', tier3, MULTI_TV_PRICE_TIER_CEILING],
    ['4th-TV price credit', tier4, MULTI_TV_PRICE_TIER_CEILING],
    ['5th-TV+ price credit', tier5plus, MULTI_TV_PRICE_TIER_CEILING],
  ]) {
    if (!Number.isFinite(val) || val < 0) return res.status(400).json({ error: `${label} must be a number of $0 or more` });
    if (val > ceiling) return res.status(400).json({ error: `$${val} is above the $${ceiling} sanity ceiling for ${label.toLowerCase()}, double-check this isn't a typo.` });
  }
  if (!Number.isFinite(partialCutPct) || partialCutPct < 0 || partialCutPct > 1) {
    return res.status(400).json({ error: 'Partial-cut percent must be between 0 and 1 (e.g. 0.60 for 60%)' });
  }
  const partialFees = String(body.partial_cut_fees || '')
    .split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (!partialFees.length || partialFees.some(n => !Number.isFinite(n) || n < 0)) {
    return res.status(400).json({ error: 'Partial-cut fees must be a comma-separated list of dollar amounts, e.g. 65, 100' });
  }

  const patch = {
    tv_threshold: threshold,
    zero_fee_per_tv: zeroFeePerTv,
    full_cut_fee: fullCutFee,
    partial_cut_pct: partialCutPct,
    partial_cut_fees: partialFees,
    price_discount_enabled: body.price_discount_enabled !== false,
    price_tier3: tier3,
    price_tier4: tier4,
    price_tier5plus: tier5plus,
    updated_at: new Date().toISOString(),
    updated_by: auth.name || auth.role || 'office',
  };
  const existing = await multiTvDiscountConfigFor(db);
  let error;
  if (existing && existing.id) {
    ({ error } = await db.from('multi_tv_discount_config').update(patch).eq('id', existing.id));
  } else {
    ({ error } = await db.from('multi_tv_discount_config').insert(patch));
  }
  if (error) throw error;
  multiTvDiscountConfigCacheClear();
  return res.status(200).json({ ok: true });
}

// ── Launch checklist (Other -> Launch) ───────────────────────────────────────
// One page answering "what did I forget" across every business in the CRM,
// built after Precision TV shipped with no Stripe/Resend keys and Mile High's
// live site turned out to have no booking widget on it at all (its nav "Book"
// link 404s) — both went unnoticed for weeks because nothing surfaced them.
// Reads the `businesses` table directly, so the next business added here shows
// up automatically with no code change; the manual items (GBP, GSC, etc.) are
// exactly the things no API can check, so they're a checklist, not a report.
//
// Real-checkable stuff is checked live on every load, not cached:
//   - stripeWired / stripeReady: is the slug in ACCOUNT_KEY_ENV at all, and if
//     so, is the secret key env var actually set. stripeConfigured() throws for
//     an unmapped slug (by design, see stripe.js) — that throw IS the "not
//     wired in code yet" signal.
//   - emailWired / emailReady: same shape for Resend. A slug missing from
//     EMAIL_BRANDS is dangerous, not just incomplete: emailConfig() silently
//     falls back to Handy Andy's own account for any unrecognized slug, so a
//     new business's confirmation emails would go out looking like Handy
//     Andy's until someone notices. Flagged as a hard warning, not just unchecked.
//   - site.ok: a live fetch of the business's own `url`, checking HTTP status.
//     Reliable regardless of how the site is built, since it's just the status
//     code, so this one counts toward the score/blocked logic below.
//
// site.hasWidget is INFORMATIONAL ONLY, never a blocker — it does a best-effort
// text search for widget.js in the fetched HTML, which only works when the
// widget tag is present in the server-rendered markup (Austin's Next.js
// build, Precision's LandingSite embed). ihandyandy.com and domstvmounting.com
// insert the widget with client-side JavaScript after the page loads, so a
// plain server-side fetch — which never runs JS — can't see it at all, even
// though both have booked real jobs daily for months. Real incident: this
// used to feed the same red "NOT FOUND" line as everything else and told the
// owner his two oldest, most active businesses had no booking widget. The
// authoritative signal is the "widget_embedded" manual item below, which the
// owner ticks once he's actually looked at the page himself; the live check
// only ever shows a soft "confirmed via scan" bonus when it finds something,
// never an accusation when it doesn't.
// Deliberately NO "website is live" item here — the automated site.ok check
// (below) already covers that reliably (it's just an HTTP status, unaffected
// by the client-JS-rendering problem above), so a redundant manual copy would
// default to false for every already-working business and bury the real gap
// under a stale checkbox nobody remembered to tick.
// `auto` marks the three items that ALSO have a live automated check behind
// them (stripe / email / site). They are still ordinary, clickable checklist
// items: the owner can tick or untick them like anything else, and his answer
// wins for scoring. The automated result is shown underneath as a cross-check,
// and loudly when the two disagree, so a stale tick can't quietly hide "this
// business takes no card" the way Precision's missing Stripe keys did.
//
// An item the owner has NEVER touched has no stored value at all, and falls
// back to the automated answer rather than to false — otherwise adding these
// three rows would have instantly knocked 3 points off every business that has
// been working fine for months, which is exactly the regression the
// widget_embedded scan caused when it was first added.
const LAUNCH_CHECKLIST_ITEMS = [
  { key: 'stripe_keys',  label: 'Stripe live keys set',   auto: 'stripe' },
  { key: 'email_keys',   label: 'Resend live keys set',   auto: 'email' },
  { key: 'website_live', label: 'Website is live',        auto: 'site' },
  { key: 'widget_embedded',    label: 'Booking widget confirmed on the page' },
  // The five below verify the funnel actually fires end to end, not just that
  // the booking itself saves — added after finding Mile High's and Precision's
  // post-booking thank-you links both pointed at a real 404 (a customer who
  // just paid landed on "page not found"), and Dom's had no thank-you URL
  // wired in code AT ALL, silently sending its customers to Handy Andy's page.
  { key: 'thank_you_popup',    label: 'Thank-you page shows after booking' },
  { key: 'confirmation_email', label: 'Confirmation email sends' },
  { key: 'on_the_way_text',    label: 'On-the-way text sends' },
  { key: 'review_text',        label: 'Review request text sends' },
  { key: 'tech_alert_correct_business', label: 'Technician alert names the correct business' },
  { key: 'phone_live',     label: 'Dedicated phone number receiving calls/texts' },
  { key: 'gbp_created',    label: 'Google Business Profile created' },
  { key: 'gbp_verified',   label: 'GBP verified (postcard/video)' },
  { key: 'gsc_verified',   label: 'Search Console verified + sitemap submitted' },
  { key: 'techs_staffed',  label: 'At least one tech can actually be booked' },
];

// ── Markets: a location page inside an EXISTING business, not a new company.
// LA is the first one (a page cluster on ihandyandy.com, unstaffed, no Stripe
// or Resend of its own — it deliberately shares Handy Andy's) and DFW/Phoenix/
// San Antonio work the same way (see [[estimate-brokering-project]]), so this
// lives in its own `app.markets` table rather than being forced into
// `businesses`. Every OTHER part of the app reads `businesses` and assumes
// each row is a fully independent company (its own Stripe account, EMAIL_
// BRANDS entry, cross-hire mapping, review emails, ...) — inserting a market
// there would make it eligible for all of that by accident, when the whole
// point is that it deliberately has none of it. Same jsonb-checklist pattern
// as businesses.settings.launch_checklist, just a separate table + item set.
const MARKET_CHECKLIST_ITEMS = [
  { key: 'llc_formed',              label: 'LLC formed' },
  { key: 'gbp_done',                label: 'Google Business Profile done' },
  { key: 'url_chosen_and_directed', label: 'URL chosen and live' },
  { key: 'has_address',             label: 'Page shows a real address' },
  { key: 'can_book',                label: 'Can book a real appointment or an estimate' },
];

async function launchMarketRows(db) {
  const { data: markets, error } = await db.from('markets')
    .select('id, slug, name, parent_business_slug, url, active, settings, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;

  return Promise.all((markets || []).map(async (m) => {
    let site = { checked: false, ok: null, status: null, error: null };
    if (m.url) {
      site.checked = true;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(m.url, { signal: ctrl.signal, redirect: 'follow' });
        clearTimeout(t);
        site.status = r.status;
        site.ok = r.ok;
      } catch (e) {
        site.error = String((e && e.message) || e).slice(0, 120);
      }
    }
    const checklist = (m.settings && m.settings.launch_checklist) || {};
    return {
      id: m.id, slug: m.slug, name: m.name, parentSlug: m.parent_business_slug,
      url: m.url, active: m.active, created_at: m.created_at, site, checklist,
    };
  }));
}

async function launchStatus(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { data: businesses, error } = await db.from('businesses')
    .select('id, slug, name, url, support_phone, active, settings, created_at')
    .order('created_at', { ascending: true });
  if (error) throw error;

  const markets = await launchMarketRows(db);

  const results = await Promise.all((businesses || []).map(async (biz) => {
    let stripeWired = true, stripeReady = false;
    try { stripeReady = stripeConfigured(biz.slug); }
    catch (_) { stripeWired = false; }

    const emailWired = !!EMAIL_BRANDS[biz.slug];
    const emailReady = emailWired && !!emailConfig(biz.slug).apiKey;

    let site = { checked: false, ok: null, status: null, hasWidget: null, error: null };
    if (biz.url) {
      site.checked = true;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(biz.url, { signal: ctrl.signal, redirect: 'follow' });
        clearTimeout(t);
        site.status = r.status;
        site.ok = r.ok;
        const html = await r.text();
        site.hasWidget = html.includes('handy-andy-booking.vercel.app/widget.js')
          && html.includes(`data-business="${biz.slug}"`);
      } catch (e) {
        site.error = String((e && e.message) || e).slice(0, 120);
      }
    }

    const checklist = (biz.settings && biz.settings.launch_checklist) || {};

    return {
      id: biz.id, slug: biz.slug, name: biz.name, url: biz.url,
      phone: biz.support_phone || null, active: biz.active,
      created_at: biz.created_at,
      stripe: { wired: stripeWired, ready: stripeReady },
      email: { wired: emailWired, ready: emailReady },
      site,
      checklist,
    };
  }));

  return res.status(200).json({
    items: LAUNCH_CHECKLIST_ITEMS, businesses: results,
    marketItems: MARKET_CHECKLIST_ITEMS, markets,
  });
}

async function launchMarketChecklistSet(req, res, db, auth, body) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const marketId = String(body.market_id || '').trim();
  const key = String(body.key || '').trim();
  if (!marketId || !MARKET_CHECKLIST_ITEMS.some(i => i.key === key)) {
    return res.status(400).json({ error: 'market_id and a known checklist key are required' });
  }
  const { data: m, error: readErr } = await db.from('markets').select('id, settings').eq('id', marketId).maybeSingle();
  if (readErr) throw readErr;
  if (!m) return res.status(404).json({ error: 'Market not found' });

  const settings = m.settings || {};
  const checklist = { ...(settings.launch_checklist || {}), [key]: !!body.value };
  const { error: writeErr } = await db.from('markets')
    .update({ settings: { ...settings, launch_checklist: checklist }, updated_at: new Date().toISOString() })
    .eq('id', marketId);
  if (writeErr) throw writeErr;

  return res.status(200).json({ ok: true, checklist });
}

async function launchChecklistSet(req, res, db, auth, body) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const bizId = String(body.business_id || '').trim();
  const key = String(body.key || '').trim();
  if (!bizId || !LAUNCH_CHECKLIST_ITEMS.some(i => i.key === key)) {
    return res.status(400).json({ error: 'business_id and a known checklist key are required' });
  }
  const { data: biz, error: readErr } = await db.from('businesses').select('id, settings').eq('id', bizId).maybeSingle();
  if (readErr) throw readErr;
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  const settings = biz.settings || {};
  const checklist = { ...(settings.launch_checklist || {}), [key]: !!body.value };
  const { error: writeErr } = await db.from('businesses')
    .update({ settings: { ...settings, launch_checklist: checklist }, updated_at: new Date().toISOString() })
    .eq('id', bizId);
  if (writeErr) throw writeErr;

  return res.status(200).json({ ok: true, checklist });
}

// ── Coupons (Other -> Coupons) ───────────────────────────────────────────────
// The live promo-code list. Previously three hardcoded copies (api/book.js's
// HA_COUPONS/DOMS_COUPONS plus public/widget.js's own COUPONS) that had already
// drifted apart, so the website could call a code invalid that the server would
// have honored. This is now the single source; book.js reads it and the widget
// fetches it, with the old maps left only as a fallback.
//
// Usage is counted off the bookings themselves: a redeemed code is stored as a
// "Coupon <CODE>" line item, so the count is real redemptions, not clicks.
const COUPON_MAX = 500;   // dollars — a fat-fingered code never silently saves
async function couponsList(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const { data, error } = await db.from('coupons')
    .select('id, code, amount, active, note, expires_on, created_at')
    .eq('business_id', biz.id).order('code');
  if (error) {
    if (/coupons/.test(error.message || '')) return res.status(200).json({ coupons: [], usage: {} });
    throw error;
  }
  // Redemption counts + what each code has actually given away. Line items live
  // in their OWN table (app.booking_line_items) — bookings has no line_items
  // column at all, so reading it there silently returned nothing and every code
  // reported "never used" while 16 real redemptions sat in the database.
  const usage = {};
  try {
    const { data: lis } = await db.from('booking_line_items')
      .select('name, line_total, booking_id, created_at')
      .eq('business_id', biz.id).ilike('name', 'coupon%')
      .limit(20000);
    // Exclude cancelled bookings: a cancelled job's coupon was never really
    // given away, and counting it overstates what the code has cost.
    const ids = [...new Set((lis || []).map(l => l.booking_id).filter(Boolean))];
    const cancelled = new Set();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: bk } = await db.from('bookings')
        .select('id, status').in('id', ids.slice(i, i + 200)).eq('status', 'cancelled');
      for (const b of bk || []) cancelled.add(b.id);
    }
    for (const li of lis || []) {
      if (li.booking_id && cancelled.has(li.booking_id)) continue;
      // "Coupon TV2026" -> TV2026. A bare "Coupon" line (one exists, from an
      // early booking) has no code to attribute, so it's counted nowhere
      // rather than being guessed onto some code that didn't earn it.
      const m = String(li.name || '').match(/^coupon\s+([A-Z0-9_-]+)/i);
      if (!m) continue;
      const k = m[1].toUpperCase();
      const u = usage[k] || (usage[k] = { count: 0, total: 0, last: null });
      u.count++;
      u.total += Math.abs(Number(li.line_total) || 0);
      if (li.created_at && (!u.last || li.created_at > u.last)) u.last = li.created_at;
    }
  } catch { /* usage is a nice-to-have; never fail the list over it */ }
  return res.status(200).json({ coupons: data || [], usage });
}
async function couponsSave(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // A promo code is money off every job that uses it — owner only.
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change coupons' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'A code is required' });
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
    return res.status(400).json({ error: 'Codes can only use letters, numbers, dashes and underscores (2-32 characters) — a code with a space or symbol cannot be typed reliably by a customer.' });
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Amount must be $0 or more' });
  if (amount > COUPON_MAX) return res.status(400).json({ error: `$${amount} is above the $${COUPON_MAX} sanity ceiling for a coupon — double-check this isn't a typo.` });

  const patch = {
    business_id: biz.id, code, amount,
    active: body.active !== false,
    note: body.note ? String(body.note).slice(0, 200) : null,
    expires_on: body.expires_on || null,
    updated_at: new Date().toISOString(),
  };
  let out;
  if (body.id) {
    const { data, error } = await db.from('coupons').update(patch)
      .eq('id', body.id).eq('business_id', biz.id).select('id').maybeSingle();
    if (error) {
      if (/duplicate key|unique/i.test(error.message || '')) return res.status(409).json({ error: `${code} already exists for this business.` });
      throw error;
    }
    out = data;
  } else {
    const { data, error } = await db.from('coupons').insert(patch).select('id').maybeSingle();
    if (error) {
      if (/duplicate key|unique/i.test(error.message || '')) return res.status(409).json({ error: `${code} already exists for this business.` });
      throw error;
    }
    out = data;
  }
  couponCacheClear(biz.slug);   // so a repriced code takes effect on the very next booking
  return res.status(200).json({ ok: true, id: out?.id || null });
}
async function couponsDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change coupons' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });
  const { error } = await db.from('coupons').delete().eq('id', body.id).eq('business_id', biz.id);
  if (error) throw error;
  couponCacheClear(biz.slug);
  return res.status(200).json({ ok: true });
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
    { label: '2 technicians',                        price: 70, zbk: '1685657521270x264421370121691100', sort: 3 },
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
  const postalCode = (req.query.postal_code || '').toString().trim();
  if (!dateStr) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

  const dow = dayOfWeekFor(dateStr);
  // Slots + occupancy are computed in the customer's METRO timezone (from the
  // zip), so a Central booking's slots line up with how its jobs are stored —
  // not the single business (Mountain) clock.
  const bookingAreaId = await serviceAreaIdFromPostal(db, biz.id, postalCode);
  const tz = await areaTimezone(db, bookingAreaId, biz.timezone || 'America/Denver');
  // Each technician can come from a different company pool: pool drives the
  // primary, pool2 the second tech. 'partner' scans the OTHER company's roster.
  // Every scope is pinned to that company's own metro for this zip — an "any"
  // side must never offer (or later book) a slot only an out-of-metro tech has.
  // bookingAreaId is passed through as the host area — rosterScopes would
  // otherwise repeat the exact same business+zip lookup we just did above.
  const scopesPrimary = await rosterScopes(db, biz, (req.query.pool || '').toString(), postalCode, bookingAreaId);
  // Want a two-tech pair whenever a second tech is requested — unless it's the
  // SAME concrete person as the primary (not a real pair). Two "any" sides ARE
  // a pair: we look for two DISTINCT free techs below.
  const wantPair = !!techId2 && !(techId2 === techId && techId2 !== 'any');
  const primaryAny = !techId || techId === 'any';

  // The primary side's full roster + per-tech slot state, fetched ONCE. It's
  // needed to answer "is anyone free" whenever the primary is "any" tech, AND
  // to build the "who's free" circles below (always the full roster,
  // regardless of which concrete tech is picked) — one query round now
  // answers both instead of two separate ones (this used to be computed, then
  // thrown away, then recomputed from scratch a few lines later — the actual
  // cost behind every slow date-click on "Any Technician"). Resolved alongside
  // the secondary scope (independent lookup) instead of after it.
  const [primaryRSS, scopesSecondary] = await Promise.all([
    rosterSlotState(db, scopesPrimary, dateStr, dow, tz)
      .catch(e => { console.warn('[available_slots] roster/slot-state lookup failed:', e.message); return null; }),
    wantPair ? rosterScopes(db, biz, (req.query.pool2 || '').toString(), postalCode) : Promise.resolve(null),
  ]);

  let keys;
  if (!wantPair) {
    keys = (primaryAny && primaryRSS) ? freeKeysFromState(primaryRSS)
      : await availableSlotKeys(db, scopesPrimary, techId, dateStr, dow, tz);
  } else {
    // Two-technician job (e.g. a large-TV lift): only offer slots where a
    // DISTINCT pair is free — one tech from the primary side and a different
    // tech from the second side. Each side may be a concrete person OR "any" of
    // a (possibly different) company pool. The two sides are unrelated, so
    // fetch them concurrently rather than one after the other.
    const [pMap, sMap] = await Promise.all([
      (primaryAny && primaryRSS) ? Promise.resolve(freeMapFromState(primaryRSS))
        : freeSlotTechMap(db, scopesPrimary, techId, dateStr, dow, tz),
      // Ineligible-secondary filter on the SECOND-tech side so an "Any <company>"
      // pick never offers a slot only Juan/Zach can cover.
      freeSlotTechMap(db, scopesSecondary, techId2, dateStr, dow, tz, true),
    ]);
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
  // Who's actually free for each offered slot — purely informational (shown as
  // small circles next to the slot button); always the PRIMARY side's full
  // roster regardless of which concrete tech is currently picked, so the
  // office can see at a glance who else is around before committing. If the
  // shared primaryRSS fetch above hit a transient failure, this gets its own
  // independent retry rather than silently going blank — the bookability
  // check (`keys`) already had its own fallback fetch when primaryRSS failed,
  // so the circles deserve the same second chance instead of riding on that
  // one failed attempt.
  let freeTechsByKey = {};
  if (primaryRSS) {
    freeTechsByKey = freeTechsByKeyFromState(primaryRSS);
  } else {
    try { freeTechsByKey = freeTechsByKeyFromState(await rosterSlotState(db, scopesPrimary, dateStr, dow, tz)); }
    catch (e) { console.warn('[available_slots] free-techs lookup failed:', e.message); }
  }
  const available = SLOTS.filter(s => keys.has(s.key))
    .filter(s => !isToday || s.start > nowHHMM)
    .map(s => ({ slot_key: s.key, label: s.label, start: s.start, end: s.end, free_techs: freeTechsByKey[s.key] || [] }));
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
  // A genuinely unexpected error must THROW, not silently read as "this tech
  // has no bookings today" — that would fail the double-booking guard OPEN.
  if (error) throw error;
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

// Roster + per-tech slot state for a scope, in ONE round of queries (a
// technicians fetch plus the batched availability/exceptions/bookings read) —
// the shared foundation for every "who's free" computation over the same
// scope+date: whether anyone is bookable, a two-tech pair match, and the
// informational "who's free" circles all derive from this same result instead
// of each re-fetching the roster and re-running batchTechSlotState.
async function rosterSlotState(db, scopes, dateStr, dow, tz) {
  const lists = await scopedRosterTechs(db, scopes, 'id, name, color');
  const techs = lists.flat();
  const state = await batchTechSlotState(db, techs.map(t => t.id), dateStr, dow, tz);
  return { techs, state };
}
// Set of slot keys where at least one tech in a precomputed rosterSlotState is free.
function freeKeysFromState({ techs, state }) {
  const keys = new Set();
  for (const t of techs) {
    const s = state.get(t.id); if (!s) continue;
    for (const k of s.keys) if (!s.booked.has(k)) keys.add(k);
  }
  return keys;
}
// Map slot_key -> Set(techId) of every free tech, from a precomputed rosterSlotState.
function freeMapFromState({ techs, state }) {
  const map = new Map();
  for (const t of techs) {
    const s = state.get(t.id); if (!s) continue;
    for (const k of s.keys) {
      if (s.booked.has(k)) continue;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(t.id);
    }
  }
  return map;
}
// slot_key -> [{ id, name, color }] of every tech genuinely free that slot
// (scheduled + not booked), roster order (host company first), from a
// precomputed rosterSlotState. Purely informational for the New Booking slot
// list's "who's free" circles — never used to decide bookability, so it can't
// introduce a new booking path.
function freeTechsByKeyFromState({ techs, state }) {
  const byKey = {};
  for (const t of techs) {
    const s = state.get(t.id);
    if (!s) continue;
    for (const k of s.keys) {
      if (s.booked.has(k)) continue;
      (byKey[k] || (byKey[k] = [])).push({ id: t.id, name: t.name, color: t.color || null });
    }
  }
  return byKey;
}

// Set of slot keys a tech (or ANY tech) is available for on an exact date,
// honouring recurring availability, one-time exceptions, AND existing bookings
// (a slot a tech is already booked for is no longer offered — no double-booking).
// excludeTechId drops one tech from the "ANY" union, so the SAME person can't be
// counted as both the primary and the second technician on a two-tech job.
// Normalize a roster argument to [{ bizId, serviceAreaId }] scopes — accepts
// the rosterScopes() shape or (unused today, kept for shape safety) a bare
// biz id, which normalizes to serviceAreaId:null and is therefore dropped
// entirely by scopedRosterTechs() — there is no unscoped path anymore.
function normalizeRosterScopes(bizIdOrScopes) {
  const arr = Array.isArray(bizIdOrScopes) ? bizIdOrScopes : [bizIdOrScopes];
  return arr.filter(Boolean).map(s => (typeof s === 'object' ? s : { bizId: s, serviceAreaId: null }));
}
// All active tech ids across the given scopes, each scope filtered to its own
// service area (metro) when one is known — the shared guard that keeps every
// "any"-side availability scan and auto-pick inside the booking's metro.
async function scopedRosterTechs(db, scopes, cols = 'id') {
  const lists = [];
  for (const sc of normalizeRosterScopes(scopes)) {
    // A scope with NO resolvable service area contributes NOTHING — it must
    // never fall back to an unfiltered scan of the whole company. That
    // "legacy leniency" fallback was the actual bug: an unmapped/blank ZIP
    // left the scope unfiltered, so Zach's (Austin) genuine recurring
    // availability satisfied a Denver slot check purely because slot keys
    // (s1-s5) carry no location. The safe failure mode for "we don't know
    // this booking's metro" is "nobody is a candidate" (the auto-pick then
    // comes back null and the job lands UNASSIGNED with a loud warning for a
    // human to place) — never "everybody in the company is a candidate".
    if (!sc.serviceAreaId) continue;
    const { data } = await db.from('technicians').select(cols)
      .eq('business_id', sc.bizId).eq('active', true).eq('service_area_id', sc.serviceAreaId)
      .order('created_at', { ascending: true });
    lists.push(data || []);
  }
  return lists;
}

async function availableSlotKeys(db, bizIdOrScopes, techId, dateStr, dow, tz, excludeTechId = null) {
  if (!techId || techId === 'any') {
    const lists = await scopedRosterTechs(db, bizIdOrScopes);
    const ids = lists.flat().map(t => t.id).filter(id => !excludeTechId || id !== excludeTechId);
    const state = await batchTechSlotState(db, ids, dateStr, dow, tz);
    const union = new Set();
    for (const [, s] of state) s.keys.forEach(k => { if (!s.booked.has(k)) union.add(k); });
    return union;
  }
  const ks = await singleTechSlotKeys(db, techId, dateStr, dow);
  const booked = await bookedSlotKeysForTech(db, null, techId, dateStr, tz);
  booked.forEach(k => ks.delete(k));
  return ks;
}

// Map slot_key -> Set(techId) of techs FREE at that slot on a date, for a side
// that is either a concrete tech or "any" of a roster (recurring ± exceptions −
// existing bookings). Used to match a DISTINCT two-tech pair for big-TV jobs:
// the union of the two sides' free techs in a slot must be ≥ 2 distinct people.
async function freeSlotTechMap(db, bizIdOrScopes, techId, dateStr, dow, tz, excludeIneligibleSecondary = false) {
  let techIds;
  if (!techId || techId === 'any') {
    const lists = await scopedRosterTechs(db, bizIdOrScopes, 'id, name');
    let pool = lists.flat();
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
// excludeIneligibleSecondary drops techs who can never be a second tech (Juan/Zach).
// bizIdOrScopes is the rosterScopes() shape ([{ bizId, serviceAreaId }], ORDERED
// host-first for the cross-company "Any Technician" pool) — each scope is tried
// to exhaustion before falling to the next, so "Any Technician" prefers keeping
// the job in-house and only reaches into the partner company when nobody home
// is free. Each scope is filtered to its own metro (service area); a scope
// with no resolvable area contributes zero candidates (see scopedRosterTechs)
// rather than an unfiltered whole-company scan — an Austin tech's schedule
// must never satisfy a Denver job's slot check just because slot keys carry
// no location.
// strict=true skips the off-schedule "second choice" fallback entirely — for
// callers with no human in the loop to confirm an override (e.g. a customer's
// own estimate-approval auto-book), silently handing the job to someone who
// never marked that slot available is never acceptable; better to come back
// null and tell the customer to pick another time.
async function pickAvailableTech(db, bizIdOrScopes, dateStr, slotKey, tz, excludeTechId = null, excludeIneligibleSecondary = false, strict = false) {
  const rawLists = await scopedRosterTechs(db, bizIdOrScopes, 'id, name');
  const scopeLists = rawLists.map(techs => {
    let list = techs.filter(t => !excludeTechId || t.id !== excludeTechId);
    if (excludeIneligibleSecondary) list = list.filter(t => !isSecondaryIneligibleName(t.name));
    return list;
  });
  if (!scopeLists.some(l => l.length)) return null;
  if (dateStr && slotKey) {
    const dow = dayOfWeekFor(dateStr);
    // First choice: scheduled-available AND free in this slot — scope by
    // scope, in priority order.
    for (const list of scopeLists) {
      for (const t of list) {
        const keys = await singleTechSlotKeys(db, t.id, dateStr, dow);
        if (!keys.has(slotKey)) continue;
        const booked = await bookedSlotKeysForTech(db, null, t.id, dateStr, tz);
        if (!booked.has(slotKey)) return t.id;
      }
    }
    // Second choice: any active tech who is at least free in this slot, even if
    // not on their normal schedule — still never returns an already-booked tech.
    // Same scope priority order as above. Skipped entirely in strict mode.
    if (!strict) {
      for (const list of scopeLists) {
        for (const t of list) {
          const booked = await bookedSlotKeysForTech(db, null, t.id, dateStr, tz);
          if (!booked.has(slotKey)) return t.id;
        }
      }
    }
    // Everyone is booked for this slot — leave unassigned rather than stack a
    // second job on a tech. bookingCreate will create it as 'confirmed'/unassigned.
    return null;
  }
  // No date/slot to check against — we can't verify anyone's actual schedule,
  // so leave the job unassigned rather than gamble on a blind pick who might be
  // busy or off that day. The office (or a follow-up guard) assigns explicitly.
  return null;
}

// Pair-aware auto-pick for a two-tech job where BOTH primary and secondary are
// 'any'. Picking the primary alone first (pickAvailableTech, greedily) can
// consume the secondary pool's only scheduled-and-free tech and leave no valid
// secondary — even when availableSlots had just offered this exact slot as
// bookable because a DIFFERENT pairing exists (e.g. TK+Steve are both free;
// greedily taking TK as primary leaves no HA-Denver secondary, when Steve
// primary + TK secondary works). Mirrors availableSlots' own pair-matching
// (freeSlotTechMap union) so "offered" and "actually bookable" always agree.
// excludeIneligibleSecondary is implicit on the secondary side (Juan/Zach can
// never be a second tech). Returns { primaryId, secondaryId }, both null if no
// distinct pair exists for this exact date+slot.
async function pickAvailableTechPair(db, scopesPrimary, scopesSecondary, dateStr, slotKey, tz) {
  if (!dateStr || !slotKey) return { primaryId: null, secondaryId: null };
  const dow = dayOfWeekFor(dateStr);
  const pMap = await freeSlotTechMap(db, scopesPrimary, 'any', dateStr, dow, tz);
  const sMap = await freeSlotTechMap(db, scopesSecondary, 'any', dateStr, dow, tz, true);
  const pSet = pMap.get(slotKey) || new Set();
  const sSet = sMap.get(slotKey) || new Set();
  for (const p of pSet) {
    for (const s of sSet) {
      if (s !== p) return { primaryId: p, secondaryId: s };
    }
  }
  return { primaryId: null, secondaryId: null };
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
  // Each scope carries its own business's area id for this zip (the old code
  // applied the HOST's area id to the PARTNER roster, which matches nobody —
  // partner techs carry the partner's own area ids — silently killing the
  // pool-based partner auto-pick). strict: a silently off-schedule SECOND tech
  // is never acceptable — same doctrine as the Dom's branch above.
  const scopes2 = await rosterScopes(db, biz, (pool2 || '').toString(), postalCode);
  return await pickAvailableTech(db, scopes2, dateStr, slotKey, tz, primaryTechId, true, true);
}

async function singleTechSlotKeys(db, techId, dateStr, dow) {
  // Errors THROW rather than silently reading as "zero availability" — a
  // transient DB hiccup here must never look identical to a real day off (that
  // would train the office to reflexively force-override past real conflicts).
  const { data: av, error: avErr } = await db.from('technician_availability')
    .select('slot_key').eq('technician_id', techId).eq('day_of_week', dow);
  if (avErr) throw avErr;
  const slots = new Set((av || []).map(x => x.slot_key));
  const { data: exc, error: excErr } = await db.from('technician_availability_exceptions')
    .select('slot_key, is_available').eq('technician_id', techId).eq('exception_date', dateStr);
  if (excErr) throw excErr;
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
  // pool's active roster, scoped to each company's own metro for the booking's
  // zip — otherwise the date picker lights up days only an out-of-metro tech
  // has open, which the slot/booking steps would then (rightly) refuse.
  const postalCode = (req.query.postal_code || '').toString();
  // Resolved up front so an empty roster below can explain ITSELF (unknown zip
  // vs. a known metro we simply don't staff). Reused for the timezone lookup
  // further down rather than resolved twice.
  const bookingAreaIdEarly = await serviceAreaIdFromPostal(db, biz.id, postalCode);
  const rosterIds = async (pool) => {
    const scopes = await rosterScopes(db, biz, pool, postalCode);
    const lists = await scopedRosterTechs(db, scopes);
    return lists.flat().map(t => t.id);
  };
  const primaryIds = (techId && techId !== 'any')
    ? [techId]
    : await rosterIds((req.query.pool || '').toString());
  // Want a two-tech pair whenever a second tech is requested — unless it's the
  // SAME concrete person as the primary (not a real pair). Two "any" sides ARE
  // a pair: distinctness is enforced per-slot below, not by filtering rosters.
  const wantPair = !!techId2 && !(techId2 === techId && techId2 !== 'any');
  let secondaryIds = [];
  if (wantPair) {
    secondaryIds = (techId2 && techId2 !== 'any')
      ? [techId2]
      : await rosterIds((req.query.pool2 || '').toString());
  }
  // An empty roster is not "no open days" — it's "nobody covers this address",
  // and the two look identical on a greyed-out calendar. Say which, so the
  // office isn't left staring at a dead month wondering if it's a bug (it read
  // as one on the phone script: every August date greyed with no explanation).
  if (!primaryIds.length || (wantPair && !secondaryIds.length)) {
    let reason = 'no_roster', areaName = null, unstaffed = false;
    if (postalCode) {
      if (!bookingAreaIdEarly) reason = 'zip_not_covered';
      else {
        const { data: sa } = await db.from('service_areas')
          .select('name, unstaffed').eq('id', bookingAreaIdEarly).maybeSingle();
        areaName = sa?.name || null;
        unstaffed = !!sa?.unstaffed;
        reason = unstaffed ? 'area_unstaffed' : 'no_techs_in_area';
      }
    }
    return res.status(200).json({ dates: [], month, reason, area: areaName, unstaffed });
  }
  const techIds = [...new Set([...primaryIds, ...secondaryIds])];

  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  // Existing bookings this month so fully-booked days don't show as available.
  // Bucketed in the booking's METRO tz (from the zip), same as availableSlots —
  // the single business tz drifts a Central (Houston/Austin) evening booking
  // onto the wrong slot key (and near-midnight ones onto the wrong date),
  // which can light up a day whose only slot is actually taken.
  const bookingAreaId = bookingAreaIdEarly;   // resolved once, up top
  const tz = await areaTimezone(db, bookingAreaId, biz.timezone || 'America/Denver');
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
  // The three reads below (recurring availability, one-off exceptions, this
  // month's bookings) are mutually independent — nothing here reads a result
  // from another — so run them concurrently instead of one-at-a-time. The
  // bookings query keeps its own retry-on-schema-error self-contained inside
  // its promise so the Promise.all still resolves once every branch is done.
  const [{ data: av }, { data: exc }, bkResult] = await Promise.all([
    db.from('technician_availability').select('technician_id, day_of_week, slot_key').in('technician_id', techIds),
    db.from('technician_availability_exceptions')
      .select('technician_id, exception_date, slot_key, is_available')
      .in('technician_id', techIds).gte('exception_date', monthStart).lte('exception_date', monthEnd),
    (async () => {
      let { data: bk, error: bkErr } = await runBk(bookingLiftCols);
      if (bkErr && (/secondary_technician_id/.test(bkErr.message || '') || isExtraSlotsErr(bkErr))) {
        if (/secondary_technician_id/.test(bkErr.message || '')) bookingLiftCols = false;
        if (isExtraSlotsErr(bkErr)) extraSlotsCol = false;
        ({ data: bk } = await runBk(bookingLiftCols));
      }
      return bk;
    })(),
  ]);
  const bk = bkResult;
  const recurring = {};   // `${techId}:${dow}` -> Set(slot_key)
  for (const r of (av || [])) {
    const k = `${r.technician_id}:${r.day_of_week}`;
    (recurring[k] = recurring[k] || new Set()).add(r.slot_key);
  }
  const excByDate = {};   // `${date}` -> [{tech,slot,is_available}]
  for (const e of (exc || [])) (excByDate[e.exception_date] = excByDate[e.exception_date] || []).push(e);
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

// ── Price sanity ceiling (circuit breaker against absurd amounts) ──────────
// Added after a real incident: a browser's own address-autofill matched the
// word "zip" in the Travel Fee field's placeholder and silently stuffed a
// 5-digit ZIP code into it as a dollar amount, creating an $86,889 booking
// nobody had typed. No real job at either business has ever run more than a
// few hundred dollars. These ceilings are generous relative to that reality
// specifically so a genuinely large one-off job still goes through — with an
// explicit, unmissable confirmation — while a stray 5-figure number from a
// typo, paste, or autofill bug can never silently become a real booking,
// estimate, or (most importantly) an actual card charge.
const PRICE_SANITY_LINE_CEILING = 2000;   // per line item / per fee, in dollars
const PRICE_SANITY_TOTAL_CEILING = 5000;  // whole booking / estimate / charge

// Owner rule (2026-08-31): flat $139 minimum on every normal paid job, every
// business, every metro — no per-metro exception (Austin used to be $119).
// GDS, Assurion, No Charge/Callback (all $0), and Handyman Labor (hourly) are
// exempt. Mirrors MIN_TICKET_PRICE in api/book.js (the public widget).
const MIN_TICKET_PRICE = 139;

// Returns null when everything is within the sane range; otherwise a short,
// specific message naming the exact absurd number and line — reused as both
// the 409 error text and (verbatim) the client's confirmation-dialog text, so
// what the office sees exactly matches what would have gotten billed.
// `lines` accepts either shape used across this file: { unit_price } (booking
// line items, estimate line items) or { price } (New Booking's `selections`).
function priceSanityIssue({ lines, total } = {}) {
  if (Array.isArray(lines)) {
    for (const l of lines) {
      if (!l) continue;
      const amt = Math.abs(Number(l.unit_price ?? l.price) || 0);
      if (amt > PRICE_SANITY_LINE_CEILING) {
        const label = (l.name || l.label || l.description || 'A line item').toString().slice(0, 60);
        return `"${label}" is $${amt.toFixed(2)} — that's far outside any real charge for this business. Double-check the amount before continuing.`;
      }
    }
  }
  const t = Math.abs(Number(total) || 0);
  if (t > PRICE_SANITY_TOTAL_CEILING) {
    return `This total is $${t.toFixed(2)} — that's far outside any real job for this business. Double-check the amount before continuing.`;
  }
  return null;
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
    // A CANCELLED booking must never satisfy this check. Every slot-occupancy
    // query already excludes cancelled rows, so one matching here would hand the
    // caller back a dead booking as if it were live: nobody scheduled, customer
    // told they're confirmed. Re-booking is a real new booking.
    const { data: dupe } = await db.from('bookings')
      .select('id').eq('business_id', biz.id).eq('idempotency_key', idempotencyKey)
      .neq('status', 'cancelled').maybeSingle();
    if (dupe?.id) return res.status(200).json({ id: dupe.id, duplicate: true });
  }

  // Reuse an existing customer (by phone, then email) or create one. Also pull
  // back their ZIP on file: a repeat customer booked by phone lookup often has
  // the address field left blank on THIS submission even though a real one is
  // already stored — without this, the metro-scoped auto-pick below sees a
  // blank zip and (correctly, per the hard rule) refuses to guess a metro,
  // leaving an otherwise-routine repeat booking UNASSIGNED for no real reason.
  let customer_id = c.id || null;
  let matchedExisting = !!c.id;
  let matchedPostalCode = null;
  if (!customer_id && c.phone) {
    const { data } = await db.from('customers').select('id, postal_code').eq('business_id', biz.id).eq('phone', c.phone).maybeSingle();
    if (data?.id) { customer_id = data.id; matchedExisting = true; matchedPostalCode = data.postal_code || null; }
  }
  if (!customer_id && c.email) {
    const { data } = await db.from('customers').select('id, postal_code').eq('business_id', biz.id).eq('email', c.email).maybeSingle();
    if (data?.id) { customer_id = data.id; matchedExisting = true; matchedPostalCode = data.postal_code || null; }
  }
  const effectivePostalCode = (c.postal_code || '').toString().trim() || matchedPostalCode || null;
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
  const bookingAreaId = await serviceAreaIdFromPostal(db, biz.id, effectivePostalCode);
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
  // Read the secondary request now (before the primary pick) — a mandatory
  // two-tech job needs the PAIR resolved together, not the primary greedily
  // assigned first and the secondary left to pick over the leftovers.
  const secondaryRaw = body.secondary_technician_id || null;
  const secondaryConcreteId = (secondaryRaw && secondaryRaw !== 'any') ? secondaryRaw : null;
  if (technician_id === 'any') {
    // Scoped to each company's own metro for this zip (the unscoped roster
    // once handed a Denver Dom's job to Zach in Austin), and strict: never
    // silently book a tech who didn't mark the slot available — if nobody
    // scheduled is free, the job lands UNASSIGNED with the loud warning
    // below instead of on someone who never opted into that time.
    const scopes = await rosterScopes(db, biz, (body.pool || '').toString(), effectivePostalCode);
    if (secondaryRaw === 'any') {
      // BOTH sides need auto-resolving. Picking the primary alone first (the
      // old behavior) could greedily consume the secondary pool's only
      // scheduled tech and then refuse the booking outright, even though
      // availableSlots had just offered this exact slot as a valid pair (e.g.
      // TK+Steve both free — picking TK primary first leaves no HA-Denver
      // secondary, when Steve-primary+TK-secondary would have worked). Match
      // the offered pair, not just the first primary candidate.
      const scopesSecondary = await rosterScopes(db, biz, (body.pool2 || '').toString(), effectivePostalCode);
      const pair = await pickAvailableTechPair(db, scopes, scopesSecondary, body.scheduled_date, body.scheduled_slot, tz);
      technician_id = pair.primaryId;
      if (pair.secondaryId) body.secondary_technician_id = pair.secondaryId; // resolved below; skips the redundant 'any' branch
      if (!technician_id) {
        // No valid pair — still try to staff SOMEONE for the primary role
        // alone rather than losing the booking entirely; the needs_lifting
        // check further down still refuses if a second tech is mandatory.
        technician_id = await pickAvailableTech(db, scopes, body.scheduled_date, body.scheduled_slot, tz, null, false, true);
      }
    } else {
      // excludeTechId=secondaryConcreteId so an 'any' primary can never land
      // on the exact person the office already picked as the second tech
      // (which used to trip the "must be different" refusal on a slot that
      // was, in fact, bookable with a different primary).
      technician_id = await pickAvailableTech(db, scopes, body.scheduled_date, body.scheduled_slot, tz, secondaryConcreteId, false, true);
    }
    // The slot showed as available when the office picked it, but every tech
    // got booked in the meantime (a two-secretary race), or no ZIP/metro
    // could be resolved for this booking. The booking is still created —
    // losing the customer over a race would be worse — but it lands
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
      db, biz, effectivePostalCode, body.scheduled_date, body.scheduled_slot, tz, technician_id, body.pool2);
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

  // Cross-metro backstop: a tech tagged to a DIFFERENT metro than this
  // booking's zip must be explicitly confirmed, never silently saved (see
  // crossMetroMismatch above for the Jul 2026 Zach/Denver incident this
  // exists for). Auto-picked techs pass trivially, they came from the scoped
  // roster; this catches explicit picks and anything a stale client sends.
  // Confirmation is per-TECH (confirm_cross_metro_ids); two mismatched techs
  // on one booking each get their own named 409 rather than one confirm
  // silently blessing both.
  {
    const mm = await crossMetroMismatch(db, bookingAreaId,
      [technician_id, secondary_technician_id], body.confirm_cross_metro_ids);
    if (mm) {
      return res.status(409).json({
        code: 'cross_metro_confirm',
        tech_id: mm.techId,
        error: `${mm.techName} works ${mm.techMetro}, but this job is in ${mm.bookingMetro}. Book ${mm.techName} on it anyway?`,
      });
    }
  }

  // Guard against double-booking AND against booking a tech during a time
  // they've marked unavailable (a requested day off, or off their recurring
  // schedule). Picking a CONCRETE tech from the dropdown used to skip the
  // availability half entirely — only the 'any'-pick path (pickAvailableTech)
  // ever consulted the exceptions table. Double-booking can never be
  // overridden (a tech can't be in two places at once); the availability half
  // can be, per-technician, via force_unavailable_ids (the office confirming
  // "book them anyway" for THAT specific person only — not a blanket bypass
  // that would also silently wave through an unrelated conflict on the OTHER
  // tech in the same request).
  if (scheduled_at && (technician_id || secondary_technician_id)) {
    const conflictDate = body.scheduled_date || localDateStr(tz, scheduled_at);
    const conflictSlot = body.scheduled_slot || slotKeyForLocalTime(localHHMM(tz, scheduled_at));
    const forcedIds = new Set((body.force_unavailable_ids || []).map(String));
    if (!conflictSlot) {
      // Can't place this time inside one of the 5 fixed slots, so nothing below
      // can be verified — fail CLOSED (require an explicit override) instead of
      // silently skipping every check for an off-grid time.
      const uncheckedId = technician_id && !forcedIds.has(String(technician_id)) ? technician_id
        : (secondary_technician_id && !forcedIds.has(String(secondary_technician_id)) ? secondary_technician_id : null);
      if (uncheckedId) {
        const { data: t } = await db.from('technicians').select('name').eq('id', uncheckedId).maybeSingle();
        return res.status(409).json({ error: `Couldn't verify ${t?.name || 'this technician'}'s schedule for this time — it doesn't line up with one of the standard time slots. Confirm to book anyway.`, code: 'tech_unavailable', tech_id: uncheckedId });
      }
    } else {
      const dow = dayOfWeekFor(conflictDate);
      if (technician_id) {
        const taken = await bookedSlotKeysForTech(db, biz.id, technician_id, conflictDate, tz);
        if (taken.has(conflictSlot)) {
          return res.status(409).json({ error: 'That technician is already booked for this time slot. Choose another time or technician.' });
        }
        if (!forcedIds.has(String(technician_id))) {
          const keys = await singleTechSlotKeys(db, technician_id, conflictDate, dow);
          if (!keys.has(conflictSlot)) {
            const { data: t } = await db.from('technicians').select('name').eq('id', technician_id).maybeSingle();
            return res.status(409).json({ error: `${t?.name || 'This technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable', tech_id: technician_id });
          }
        }
      }
      if (secondary_technician_id) {
        const taken2 = await bookedSlotKeysForTech(db, biz.id, secondary_technician_id, conflictDate, tz);
        if (taken2.has(conflictSlot)) {
          return res.status(409).json({ error: 'The second technician is already booked for this time slot. Choose another time or technician.' });
        }
        if (!forcedIds.has(String(secondary_technician_id))) {
          const keys2 = await singleTechSlotKeys(db, secondary_technician_id, conflictDate, dow);
          if (!keys2.has(conflictSlot)) {
            const { data: t2 } = await db.from('technicians').select('name').eq('id', secondary_technician_id).maybeSingle();
            return res.status(409).json({ error: `${t2?.name || 'The second technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable', tech_id: secondary_technician_id });
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

  // Reject a completely bare booking — no service, no selections, no notes at
  // all. Every legitimate flow (TV Mounting, Handyman, Assurion, GDS) always
  // supplies at least ONE of these three; a booking with none of them means
  // nothing was actually chosen before the office hit Create. Client-side
  // validation (admin.html) should already stop this, but the server is the
  // authoritative check — this codebase's whole pattern is that money/data
  // guards never rely on the client alone. (Lucinda Simpson job, Jul 2026:
  // created exactly this way — no service_id, no line items, $0 — sat
  // invisible for a week and read as "the line items got removed" when they
  // had never actually been entered.)
  const hasSelections = Array.isArray(body.selections) && body.selections.length > 0;
  if (!body.service_id && !hasSelections && !(body.notes || '').toString().trim()) {
    return res.status(400).json({ error: 'Choose a service category and at least one option before creating this booking — nothing was selected.' });
  }

  // Sanity ceiling on the price BEFORE any row is created (real incident: a
  // browser autofilled a 5-digit ZIP into the Travel Fee box and an $86,889
  // booking was created with nobody having typed that number). See
  // priceSanityIssue() for the thresholds and rationale.
  if (body.confirm_high_price !== true) {
    const issue = priceSanityIssue({ lines: body.selections, total: body.price });
    if (issue) return res.status(409).json({ error: issue, code: 'high_price_confirm_required' });
  }

  // Hard $139 minimum ticket (owner rule 2026-08-31): "if it's not 139 then I
  // don't want it." Mirrors the same floor in api/book.js — this is the office
  // New Booking tool's server-side backstop, since the client-side warn/topup
  // in admin.html can be bypassed by anyone calling this endpoint directly.
  // GDS, Assurion, and No Charge/Callback are intentionally $0 (the office UI
  // sends price:0 for all three), and Handyman Labor is hourly, not a TV
  // mounting ticket — none of those are subject to this floor. Everything
  // else — any normal paid job, any business, any metro — is a hard reject,
  // not a topup: the office must add more service or the booking doesn't happen.
  {
    const _price = Number(body.price) || 0;
    const _isHandyman = Array.isArray(body.selections) && body.selections.some(s => /^Handyman Labor:/i.test((s && s.label) || ''));
    if (_price > 0 && _price < MIN_TICKET_PRICE && !_isHandyman) {
      return res.status(400).json({ error: `Jobs must total at least $${MIN_TICKET_PRICE}. Add another service or add-on before saving.`, below_minimum: true });
    }
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
        .select('id').eq('business_id', biz.id).eq('idempotency_key', idempotencyKey)
        .neq('status', 'cancelled').maybeSingle();   // a cancelled row is not a winner
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
  const selectionCount = selections.length;
  if (selections.length) {
    // Canonical ticket order from birth (TVs smallest-first, then work, then
    // travel fee / discounts; tax is appended after, so it lands last).
    const rows = canonicalizeLineItems(selections.map(s => {
      const qty = Number(s.quantity) || 1;
      const unit = Number(s.price) || 0;
      const kind = s.label === 'Travel' ? 'addon' : 'option';
      return {
        booking_id: bRow.id, business_id: biz.id,
        kind, name: s.label || 'Option',
        quantity: qty, unit_price: unit, line_total: unit * qty,
        service_id: body.service_id || null, option_id: s.option_id || null,
      };
    })).map((r, i) => ({ ...r, sort_order: i }));
    let { error: liErr } = await db.from('booking_line_items').insert(rows);
    if (liErr && isSortOrderErr(liErr)) {
      ({ error: liErr } = await db.from('booking_line_items').insert(rows.map(({ sort_order, ...r }) => r)));
    }
    if (liErr) {
      console.error('[admin] line-items insert failed (booking exists):', liErr.message);
      // `||`, never a plain assignment — a prior card-save warning (money-
      // relevant) must never be silently discarded just because line items
      // ALSO failed to save in the same request. Matches the tax-line warning
      // below, which already gets this right.
      postInsertWarning = postInsertWarning || 'Booking was created, but its line items could not be saved — open the job and re-add them.';
    }
  }

  // Add tax as a line item — sort_order after every selection, so tax is the
  // very last line on the ticket (owner rule: tax always at the bottom).
  if (Number(body.tax) > 0) {
    const taxRow = {
      booking_id: bRow.id, business_id: biz.id,
      kind: 'fee', name: 'Tax (8.25%)',
      quantity: 1, unit_price: Number(body.tax), line_total: Number(body.tax),
      service_id: null, option_id: null, taxable: false, sort_order: selectionCount,
    };
    let { error: taxErr } = await db.from('booking_line_items').insert(taxRow);
    if (taxErr && isSortOrderErr(taxErr)) {
      const { sort_order, ...bare } = taxRow;
      ({ error: taxErr } = await db.from('booking_line_items').insert(bare));
    }
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
    // "He" is a simplification (a technician could be any gender) — matches
    // the exact wording requested; revisit if the roster ever needs it neutral.
    const techLine = primaryTechInfo?.name
      ? `${primaryTechInfo.name} will text you when he's on the way.`
      : `We'll text you when your tech is on the way.`;
    const msg = `You're booked! ✅ We will see you ${dateStr} at ${timeStr}. ${techLine} Reply STOP to opt out.`;
    sendSMS(c.phone, msg).catch(console.error);
  }

  // Notify the technician if one was assigned at creation time (job-local tz).
  // AWAITED: unawaited, Vercel can freeze the lambda when the response goes out
  // and the Twilio call never happens.
  if (technician_id) {
    await notifyTechAssigned(db, biz, technician_id, scheduled_at, tz, { bookingId: bRow.id })
      .catch(e => console.error('[tech-notify]', e.message));
  }
  if (secondary_technician_id) {
    await notifyTechAssigned(db, biz, secondary_technician_id, scheduled_at, tz, { bookingId: bRow.id })
      .catch(e => console.error('[tech-notify]', e.message));
  }

  // Owner SMS when this ticket carries 4+ brackets (same alert as widget bookings).
  maybeSendBigBracketAlert({
    lines: selections,
    customerName: c.name || '',
    whenStr: (() => {
      try { return scheduled_at ? new Date(scheduled_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }) : null; }
      catch { return body.scheduled_date || null; }
    })(),
  });

  // Owner SMS when this ticket is $0 and not GDS, or its estimated profit is under $20.
  maybeSendZeroOrLowProfitAlert({
    price: Number(body.price) || 0,
    lines: selections,
    techName: primaryTechInfo?.name || '',
    customerName: c.name || '',
    scheduled_at,
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
        if (emailLines.length && Number(body.tax) > 0) emailLines.push({ label: 'Tax', qty: 1, amount: Number(body.tax) });
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
        gdsUpsellUrl: gdsUpsellUrlFor({
          lines: selections, bookingId: bRow.id, baseUrl,
          eligible: selections.some(s => /^tv size\s*:/i.test((s.label || s.name || '').toString())),
        }),
        rescheduleUrl: rescheduleUrlFor({ bookingId: bRow.id, baseUrl }),
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
      await persistConfirmationEmailStatus(db, bRow.id, result.sent ? 'sent' : 'failed');
    } catch (e) {
      console.error('[admin] confirmation email error:', e.message);
      await persistConfirmationEmailStatus(db, bRow.id, 'failed');
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
      if (Number(body.tax) > 0) lineItems.push({ name: 'Tax', quantity: 1, line_total: Number(body.tax) });
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
      // Optional technician change riding along with the reschedule — the office
      // asked to do both in one step (e.g. the customer requested a different
      // tech at the new time). Same undefined-check as 'assign' so omitting it
      // leaves the existing tech untouched.
      if (body.technician_id !== undefined) patch.technician_id = body.technician_id || null;
      // A big job's extra slots were reserved for the OLD time — drop them on a
      // reschedule so they can't silently land on another job at the new time.
      // (Also correct when only the tech changed: the extra slots belong to the
      // OLD tech's schedule and must be re-validated for the new one.)
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
        // Andrew wants a visible record on the job card when a customer's time
        // changes, not just buried in the notes list. Stamp the time being
        // REPLACED so the card can show "rescheduled from <old time>", only
        // when the time is actually moving, so a reschedule that only swaps
        // the tech doesn't paint a false history.
        if (existing.scheduled_at && existing.scheduled_at !== patch.scheduled_at) {
          restMetaResched.rescheduled_from = existing.scheduled_at;
        }
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
          // METRO tz (Central for Houston/Austin), not the single business tz —
          // see the guard block below for why this distinction matters.
          const aTz = await areaTimezone(db, await serviceAreaIdFromPostal(db, biz.id, existing.postal_code), biz.timezone || 'America/Denver');
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
      // Validated, and deliberately WITHOUT 'arrived'/'in_progress'. We don't
      // track on-site arrival, the tech app has no button for either, and a job
      // parked on one of them used to render the tech no advance button at all.
      // The DB enum still allows them so imported Zenbooker rows stay valid;
      // this just stops anything new landing there. Previously this accepted any
      // string, so a typo became a 500 from the enum column instead of a 400.
      if (!SETTABLE_STATUSES.includes(body.status)) {
        return res.status(400).json({ error: `Unknown status "${body.status}". Allowed: ${SETTABLE_STATUSES.join(', ')}` });
      }
      patch.status = newStatus = body.status; break;
    default:
      return res.status(400).json({ error: `Unknown booking action "${body.action}"` });
  }

  // Double-booking guard for reschedule / reassign, PLUS a guard against
  // dropping a tech onto a time they've marked unavailable. Double-booking can
  // never be overridden; the availability half can be, per-technician, via
  // force_unavailable_ids — see the matching comment in bookingCreate.
  if (body.action === 'reschedule' || body.action === 'assign') {
    // METRO tz (Central for Houston/Austin), not the single business tz — a
    // booking's wall-clock time is always anchored in the metro it's in (see
    // bookingCreate / the reschedule branch above), so slot-key math here must
    // match or it silently computes the WRONG slot (or none at all, which used
    // to make every guard below no-op for every Houston/Austin booking).
    const tz = await areaTimezone(db, await serviceAreaIdFromPostal(db, biz.id, existing.postal_code), biz.timezone || 'America/Denver');
    const effTech = ('technician_id' in patch) ? patch.technician_id : existing.technician_id;
    const effSecondTech = ('secondary_technician_id' in patch) ? patch.secondary_technician_id : existing.secondary_technician_id;
    // The same person can't be both technicians on one job.
    if (effTech && effSecondTech && effTech === effSecondTech) {
      return res.status(400).json({ error: 'The two technicians must be different.' });
    }
    // Cross-metro backstop, same as bookingCreate: a NEWLY assigned tech tagged
    // to a different metro than this booking's zip needs an explicit per-tech
    // confirm (confirm_cross_metro_ids). Only techs actually CHANGING in this
    // request are checked, so a booking that already carries a confirmed
    // cross-metro tech can still be rescheduled to a new time without
    // re-answering the same question.
    {
      const changedIds = [
        ('technician_id' in patch) && patch.technician_id !== existing.technician_id ? patch.technician_id : null,
        ('secondary_technician_id' in patch) && patch.secondary_technician_id !== existing.secondary_technician_id ? patch.secondary_technician_id : null,
      ];
      const mmArea = await serviceAreaIdFromPostal(db, biz.id, existing.postal_code);
      const mm = await crossMetroMismatch(db, mmArea, changedIds, body.confirm_cross_metro_ids);
      if (mm) {
        return res.status(409).json({
          code: 'cross_metro_confirm',
          tech_id: mm.techId,
          error: `${mm.techName} works ${mm.techMetro}, but this job is in ${mm.bookingMetro}. Assign ${mm.techName} anyway?`,
        });
      }
    }
    const effAt = patch.scheduled_at || existing.scheduled_at;
    if (effAt && (effTech || effSecondTech)) {
      const slotKey = slotKeyForLocalTime(localHHMM(tz, effAt));
      const effDate = localDateStr(tz, effAt);
      const forcedIds = new Set((body.force_unavailable_ids || []).map(String));
      if (!slotKey) {
        // Can't place this time inside one of the 5 fixed slots — fail CLOSED
        // (require an explicit override) instead of silently skipping every
        // check for an off-grid time.
        const uncheckedId = effTech && !forcedIds.has(String(effTech)) ? effTech
          : (effSecondTech && !forcedIds.has(String(effSecondTech)) ? effSecondTech : null);
        if (uncheckedId) {
          const { data: t } = await db.from('technicians').select('name').eq('id', uncheckedId).maybeSingle();
          return res.status(409).json({ error: `Couldn't verify ${t?.name || 'this technician'}'s schedule for this time — it doesn't line up with one of the standard time slots. Confirm to book anyway.`, code: 'tech_unavailable', tech_id: uncheckedId });
        }
      } else {
        const dow = dayOfWeekFor(effDate);
        if (effTech) {
          const taken = await bookedSlotKeysForTech(db, biz.id, effTech, effDate, tz, id);
          if (taken.has(slotKey)) {
            return res.status(409).json({ error: 'That technician is already booked for this time slot. Choose another time or technician.' });
          }
          if (!forcedIds.has(String(effTech))) {
            const keys = await singleTechSlotKeys(db, effTech, effDate, dow);
            if (!keys.has(slotKey)) {
              const { data: t } = await db.from('technicians').select('name').eq('id', effTech).maybeSingle();
              return res.status(409).json({ error: `${t?.name || 'This technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable', tech_id: effTech });
            }
          }
        }
        if (effSecondTech) {
          const taken2 = await bookedSlotKeysForTech(db, biz.id, effSecondTech, effDate, tz, id);
          if (taken2.has(slotKey)) {
            return res.status(409).json({ error: 'The second technician is already booked for this time slot. Choose another time or technician.' });
          }
          if (!forcedIds.has(String(effSecondTech))) {
            const keys2 = await singleTechSlotKeys(db, effSecondTech, effDate, dow);
            if (!keys2.has(slotKey)) {
              const { data: t2 } = await db.from('technicians').select('name').eq('id', effSecondTech).maybeSingle();
              return res.status(409).json({ error: `${t2?.name || 'The second technician'} isn't scheduled to work that day/time — they may have requested it off. Pick another technician or time, or confirm to book anyway.`, code: 'tech_unavailable', tech_id: effSecondTech });
            }
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
            // debitForJob is keyed on the booking id (migration 0088's
            // bracket_moves ledger) — calling it twice for the same job is a
            // no-op, so this is now safe even if the metadata stamp below is
            // ever lost or raced. The stamp stays as a fast bailout only.
            await debitForJob(db, {
              businessId: biz.id, technicianId: supplier, qtys: need, bookingId: id,
              reason: 'job completion (office)', actor: auth.name || auth.role || 'office',
            });
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            await db.from('bookings').update({
              metadata: { ...(cur?.metadata || existing.metadata || {}), bracket_deducted_at: now },
            }).eq('id', id);
          } else {
            // No technician/supplier on file at completion — can't charge a
            // specific truck's stock, but the brackets really were used and
            // must not vanish silently (found 2026-09-02 auditing bracket
            // inventory drift). Log it unattributed and deliberately leave
            // bracket_deducted_at UNSET, so once a technician/supplier IS on
            // file, a future reopen->recomplete (or the line-item-edit
            // reconciliation in bookingLineItemsSave) still performs the
            // real deduction instead of skipping it forever.
            try {
              await db.from('bracket_usage_logs').insert({
                business_id: biz.id, booking_id: id, technician_id: null,
                flat_used: need.flat || 0, tilting_used: need.tilting || 0, full_motion_used: need.full_motion || 0,
                logged_by_kind: 'system',
                notes: 'job completion (office) — no supplier on file at completion; inventory NOT deducted, needs manual attribution',
              });
            } catch (e2) { console.error(`[bracket] unattributed log failed for booking ${id}:`, e2.message); }
          }
        }
      } catch (e) {
        console.error(`[bracket] decrement failed for booking ${id}:`, e.message);
      }
    }

    // Auto-decrement Apple TV brackets when this job used one -- same rule as
    // the tech app. Stamped (appletv_bracket_deducted_at) so completing/
    // reopening never double-deducts.
    if (newStatus === 'completed' && !existing.metadata?.appletv_bracket_deducted_at) {
      try {
        const { data: liRows } = await db.from('booking_line_items')
          .select('name, quantity').eq('booking_id', id);
        const qty = detectAppleTvBracketQty(liRows || []);
        if (qty > 0) {
          let chargeTech = existing.technician_id || null;
          try {
            const { data: sup } = await db.from('bookings')
              .select('bracket_supplied_by').eq('id', id).maybeSingle();
            if (sup?.bracket_supplied_by) chargeTech = sup.bracket_supplied_by;
          } catch (_) { /* column may not exist; fall back to assigned tech */ }
          if (chargeTech) {
            await adjustAppleTvBracketInventory(db, biz.id, chargeTech, qty, id);
            const { data: cur } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
            await db.from('bookings').update({
              metadata: { ...(cur?.metadata || existing.metadata || {}), appletv_bracket_deducted_at: now },
            }).eq('id', id);
          }
        }
      } catch (e) {
        console.error(`[appletv_bracket] decrement failed for booking ${id}:`, e.message);
      }
    }
  }

  // Notify the technician when they are newly assigned to this job (only when the
  // tech actually changed, so re-saving the same assignment doesn't re-text them).
  // Resolve the JOB's local tz from its zip so the texted time is the job's local
  // time (an Austin job is Central), not the business's Mountain time.
  // AWAITED (not fire-and-forget): unawaited, the `return res.json()` on the
  // very next line lets Vercel freeze the lambda before Twilio is ever called.
  const notifyTz = (body.action === 'assign' || body.action === 'reschedule')
    ? await areaTimezone(db, await serviceAreaIdFromPostal(db, biz.id, existing.postal_code), biz.timezone || 'America/Denver')
    : (biz.timezone || 'America/Denver');
  if (body.action === 'assign' && patch.technician_id && patch.technician_id !== existing.technician_id) {
    await notifyTechAssigned(db, biz, patch.technician_id, existing.scheduled_at, notifyTz, { bookingId: id })
      .catch(e => console.error('[tech-notify]', e.message));
  }
  // Also notify secondary technician if assigned
  if (body.action === 'assign' && 'secondary_technician_id' in patch && patch.secondary_technician_id && patch.secondary_technician_id !== existing.secondary_technician_id) {
    await notifyTechAssigned(db, biz, patch.secondary_technician_id, existing.scheduled_at, notifyTz, { bookingId: id })
      .catch(e => console.error('[tech-notify]', e.message));
  }
  // A RESCHEDULE moves an already-assigned tech's job to a new time but used to
  // notify nobody — the notify above was gated on action==='assign' only, so a
  // tech kept the old time in their head and showed up wrong (or not at all).
  // patch.scheduled_at is the new time; existing.technician_id is unchanged by
  // this action, which is exactly why it needs telling.
  if (body.action === 'reschedule') {
    // The primary tech changed alongside the reschedule (office does both in
    // one step) — text the OLD tech that the job left them, and the NEW tech
    // that they've got it, both at the (possibly also new) time. Distinct from
    // the plain time-move notify below, which fires for whoever is STILL on
    // the job.
    const primaryChanged = 'technician_id' in patch && (patch.technician_id || null) !== (existing.technician_id || null);
    if (primaryChanged) {
      if (existing.technician_id) {
        await notifyTechAssigned(db, biz, existing.technician_id, existing.scheduled_at, notifyTz, { bookingId: id, kind: 'unassigned' })
          .catch(e => console.error('[tech-notify]', e.message));
      }
      if (patch.technician_id) {
        await notifyTechAssigned(db, biz, patch.technician_id, patch.scheduled_at || existing.scheduled_at, notifyTz, { bookingId: id })
          .catch(e => console.error('[tech-notify]', e.message));
      }
    }
    // Plain time move: notify whoever is (still) on the job — the primary,
    // unless they were JUST reassigned away above, plus the secondary.
    if (patch.scheduled_at && patch.scheduled_at !== existing.scheduled_at) {
      const stillPrimary = primaryChanged ? null : existing.technician_id;
      for (const techId of [stillPrimary, existing.secondary_technician_id]) {
        if (!techId) continue;
        await notifyTechAssigned(db, biz, techId, patch.scheduled_at, notifyTz, { bookingId: id, kind: 'rescheduled' })
          .catch(e => console.error('[tech-notify]', e.message));
      }
    }
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

// Tax constants + recalcTaxLine + isTaxLine now live in api/_lib/line-items.js
// (shared with api/tech.js so the tech-side save applies the same tax rule —
// see the Boohaker/Bland stale-tax notes there).

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
    .select('id, metadata').eq('id', id).eq('business_id', biz.id).single();
  if (e0 || !existing) return res.status(404).json({ error: 'Booking not found' });

  // ── Optimistic lock (the Throckmorton incident, 2026-08-21) ───────────────
  // The office and the tech edited this same ticket from two stale copies and
  // silently clobbered each other five times in four minutes — the customer
  // ended up charged for the same brackets twice. Every editor now loads
  // li_rev with the ticket and must hand it back; a save whose li_rev no
  // longer matches is refused instead of applied.
  const curRev = Number(existing.metadata?.li_rev) || 0;
  if (body.li_rev == null) {
    return res.status(409).json({
      error: 'This dashboard tab is out of date and could overwrite someone else\'s edit — refresh the page (Ctrl+R), reopen the job, and redo the change.',
      code: LI_CONFLICT_CODE,
    });
  }
  if (Number(body.li_rev) !== curRev) {
    return res.status(409).json({
      error: 'This ticket was changed by someone else (another office member or the tech) after you opened it. Close the job, reopen it to see the latest items, then redo your edit.',
      code: LI_CONFLICT_CODE,
    });
  }

  // Tax is re-derived from the submitted lines on every save, so changing a
  // quantity can no longer leave the ticket taxed on a stale amount — and the
  // whole set is rewritten into the canonical ticket order (TVs smallest-first,
  // then work, then travel fee, discounts, tax last — owner rule, 2026-08-24).
  const items = canonicalizeLineItems(recalcTaxLine(sanitizeBookingLineItems(body.items)));

  // Same sanity ceiling as booking_create — an edit can introduce an absurd
  // line item just as easily as the original create (see priceSanityIssue).
  if (body.confirm_high_price !== true) {
    const issue = priceSanityIssue({ lines: items });
    if (issue) return res.status(409).json({ error: issue, code: 'high_price_confirm_required' });
  }

  // Current rows: the snapshot source AND the exact ids we'll delete after the
  // new rows are safely in.
  const { data: oldRows, error: oldErr } = await db.from('booking_line_items')
    .select('id, kind, name, quantity, unit_price, line_total, taxable')
    .eq('booking_id', id).eq('business_id', biz.id);
  if (oldErr) throw oldErr;

  // A save that would EMPTY a ticket that currently has items is almost always
  // a client-side bug (a modal that rendered before its data arrived), not an
  // office intention — require an explicit confirmation flag the UI only sends
  // after a typed-out warning. (Lucinda Simpson incident, Jul 2026.)
  if (!items.length && (oldRows || []).length && body.confirm_empty !== true) {
    return res.status(400).json({
      error: 'This would remove EVERY line item from the ticket. If that is really what you want, confirm it in the dialog.',
      code: 'confirm_empty_required',
    });
  }

  console.log(`[line_items] save booking=${id} by=${auth.name || auth.role || 'office'} before=${(oldRows || []).length} after=${items.length}`);

  // Claim the ticket with a compare-and-swap on li_rev, folding the snapshot
  // (ring buffer of the last 5 item sets — the Lucinda Simpson undo trail)
  // into the SAME metadata write. If another save slipped in between our rev
  // check above and this write, the CAS matches zero rows and we refuse —
  // that's the whole point: two blind full-replaces can never both land.
  const backups = Array.isArray(existing.metadata?.li_backups) ? existing.metadata.li_backups.slice() : [];
  backups.push({
    at: new Date().toISOString(), by: `office:${auth.name || auth.role || '?'}`,
    items: (oldRows || []).map(r => ({
      kind: r.kind, name: r.name, quantity: r.quantity,
      unit_price: r.unit_price, line_total: r.line_total, taxable: r.taxable,
    })),
  });
  let newRev;
  try {
    const cas = await casBumpLiRev(db, id, existing.metadata, { li_backups: backups.slice(-5) });
    if (!cas.ok) {
      return res.status(409).json({
        error: 'Someone else saved this ticket at the same moment. Close the job, reopen it to see the latest items, then redo your edit.',
        code: LI_CONFLICT_CODE,
      });
    }
    newRev = cas.rev;
  } catch (e) {
    // The lock write itself failed (transient DB error) — do NOT proceed to a
    // blind replace without it; that's the unguarded path this lock exists to
    // close. Surface the error so the office just retries.
    console.error(`[line_items] li_rev CAS failed for booking ${id}:`, e.message);
    return res.status(500).json({ error: 'Could not lock the ticket for saving — try again in a moment.' });
  }

  // INSERT the new rows FIRST, then delete the old ones BY ID. The two steps
  // are separate transactions (PostgREST), so this order is what makes failure
  // non-destructive: if the insert dies, the old ticket is untouched; if the
  // delete dies, the ticket briefly shows duplicates — annoying, visible, and
  // fixable, unlike the old delete-first order where an insert failure had
  // already destroyed every row with nothing to recover from.
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

  const oldIds = (oldRows || []).map(r => r.id);
  if (oldIds.length) {
    const { error: delErr } = await db.from('booking_line_items').delete().in('id', oldIds);
    if (delErr) {
      console.error(`[line_items] delete-after-insert failed for booking ${id} — ticket has duplicate rows, resave to fix:`, delErr.message);
      throw delErr;
    }
  }

  const price = Math.round(items.reduce((t, it) => t + it.line_total, 0) * 100) / 100;
  // subtotal is the PRE-TAX total (same meaning it carries everywhere else that
  // writes it, e.g. the estimate->booking path). It used to be left untouched by
  // an edit, so it drifted away from the lines the moment a quantity changed.
  const subtotal = Math.round(items.reduce((t, it) => t + (isTaxLine(it) ? 0 : it.line_total), 0) * 100) / 100;
  const { error: upErr } = await db.from('bookings')
    .update({ price, subtotal }).eq('id', id).eq('business_id', biz.id);
  if (upErr) throw upErr;

  // If real company brackets were already deducted for this booking
  // (bracket_deducted_at stamped — the job completed and the deduction ran),
  // an edit that changes which/how-many bracket-type lines are on the ticket
  // must reconcile the supplier's physical stock too, or the inventory and
  // ledger silently diverge from what the ticket now actually says (found
  // 2026-09-02 auditing bracket inventory — this was the one LIVE gap behind
  // an otherwise-historical drift, since bookingLineItemsSave never touched
  // bracket accounting at all). Mirrors the "restore old supplier, charge new
  // supplier" pattern in api/tech.js's jobBracketSetSupplier — same idea, just
  // keyed on a QUANTITY change instead of a supplier change.
  if (existing.metadata?.bracket_deducted_at) {
    try {
      const oldQtys = detectBracketQtys(oldRows || []);
      const newQtys = detectBracketQtys(items);
      if (oldQtys.flat !== newQtys.flat || oldQtys.tilting !== newQtys.tilting || oldQtys.full_motion !== newQtys.full_motion) {
        let supplier = null;
        try {
          const { data: sup } = await db.from('bookings')
            .select('bracket_supplied_by, technician_id').eq('id', id).maybeSingle();
          supplier = sup?.bracket_supplied_by || sup?.technician_id || null;
        } catch (_) { /* pre-0035: bracket_supplied_by column absent */ }
        if (supplier) {
          // Keyed per li_rev (migration 0088) so this exact edit reconciles
          // exactly once — a retry or a race with another save is a no-op
          // instead of re-applying the same restore-and-recharge twice.
          await reconcileJobEdit(db, {
            businessId: biz.id, technicianId: supplier, oldQtys, newQtys, bookingId: id, liRev: newRev,
            reason: 'line items edited after completion', actor: auth.name || auth.role || 'office',
          });
        } else {
          console.warn(`[bracket] line-item edit changed bracket qty on completed booking ${id} but no supplier on file — inventory NOT reconciled`);
        }
      }
    } catch (e) {
      console.error(`[bracket] reconcile-on-edit failed for booking ${id}:`, e.message);
    }
  }

  // SEAL the rewrite with a second CAS bump. The claim above happens BEFORE
  // the insert/delete land (separate PostgREST transactions), so a fetch in
  // that window can capture the claimed rev alongside stale or duplicated
  // rows — and a save built minutes later from that poisoned snapshot would
  // pass the lock. Bumping again once the rows are final invalidates every
  // snapshot taken mid-rewrite. The still-open modal gets THIS rev back; if
  // the seal fails we return no li_rev at all, so that modal's next save
  // fails closed (409) instead of trusting a rev the DB may not hold.
  let sealedRev = null;
  try {
    // FRESH read, never the claim-time copy: the claim-to-seal window spans
    // the whole rewrite, and completion stamps (bracket_deducted_at etc.)
    // written in it don't touch li_rev — sealing with the stale object would
    // silently revert them (and re-completing would double-deduct inventory).
    // If li_rev moved off our claim, someone else already invalidated the
    // ticket — skip the seal and fail closed (no li_rev in the response).
    const { data: freshRow } = await db.from('bookings').select('metadata').eq('id', id).maybeSingle();
    if (Number(freshRow?.metadata?.li_rev) === newRev) {
      const seal = await casBumpLiRev(db, id, freshRow.metadata);
      if (seal.ok) sealedRev = seal.rev;
    }
  } catch (e) { console.warn(`[line_items] seal bump failed for booking ${id}:`, e.message); }

  return res.status(200).json({ ok: true, price, subtotal, count: items.length,
    ...(sealedRev != null && { li_rev: sealedRev }) });
}

// Rewrite a booking's stored line items into the canonical ticket order (TVs
// smallest-first, work, travel fee, discounts, tax last) without touching
// their content — for paths that APPEND a row outside the full editors (GDS
// upsell, Zenbooker GDS backfill) and would otherwise leave it stranded at
// sort_order 0/99. Best-effort: an ordering failure never blocks the caller.
async function recanonicalizeBookingRows(db, bookingId) {
  try {
    const { data: rows, error } = await db.from('booking_line_items')
      .select('id, kind, name, quantity, line_total, taxable, sort_order')
      .eq('booking_id', bookingId).order('sort_order', { ascending: true });
    if (error) { if (!isSortOrderErr(error)) throw error; return; }   // no column yet — nothing to order
    const ordered = canonicalizeLineItems(rows || []);
    for (let i = 0; i < ordered.length; i++) {
      if (Number(ordered[i].sort_order) === i) continue;
      const { error: soErr } = await db.from('booking_line_items')
        .update({ sort_order: i }).eq('id', ordered[i].id);
      if (soErr) { console.warn(`[line_items] recanonicalize write failed for booking ${bookingId}:`, soErr.message); break; }
    }
  } catch (e) { console.warn(`[line_items] recanonicalize failed for booking ${bookingId}:`, e.message); }
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

  let card = { brand: null, last4: null, customer: null };
  let lookupOk = false;
  try { card = await retrieveCard(pmId, acct); lookupOk = true; } catch (_) { /* Stripe hiccup — just show nothing */ }
  // A PaymentMethod object exists in Stripe the instant the widget tokenizes
  // the card — even when the attach was DECLINED and nothing was saved (the
  // booking row still carries the dead pm id; see the Caplan booking,
  // 2026-08-20). An unattached pm is not chargeable and must not render the
  // "Card on file" chip. If the customer has a real attached default (e.g.
  // added later via "Change card" against the customer record), show that —
  // resolveChargeablePm below applies the SAME swap at charge time, so the
  // chip and the Charge button stay on the same card. Only a CONFIRMED
  // unattached pm falls back; a lookup that merely errored keeps the old
  // "show nothing" behavior rather than asserting a card the charge path
  // might not use.
  if (lookupOk && !card.customer) {
    let fallbackPm = null;
    try { if (custId) fallbackPm = await defaultPaymentMethod(custId, acct); } catch (_) { /* no card */ }
    if (!fallbackPm || fallbackPm === pmId) return res.status(200).json({ has_card: false });
    card = { brand: null, last4: null, customer: null };
    try { card = await retrieveCard(fallbackPm, acct); } catch (_) { /* Stripe hiccup */ }
    if (!card.customer) return res.status(200).json({ has_card: false });
  }
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
    // Sanity ceiling — this is the step that actually moves real money, so it
    // gets the same circuit breaker as booking_create/line_items_save (see
    // priceSanityIssue) with the highest stakes of any of them.
    if (body.confirm_high_price !== true) {
      const issue = priceSanityIssue({ total: ticketAmount });
      if (issue) { const e = new Error(issue); e.status = 409; e.code = 'high_price_confirm_required'; throw e; }
    }
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

    // Verify the pm is actually attached before charging — a dead
    // tokenized-but-declined pm can linger on old rows, and Stripe would
    // reject it with a raw error instead of the friendly no-card message.
    // Also yields brand/last4 for the receipt + dispute evidence.
    const resolved = await resolveChargeablePm({ customerId: custId, paymentMethodId: pmId, ...acct });
    if (!resolved.pmId) { const e = new Error('No card on file for this customer. Use “Mark paid (cash)” instead.'); e.status = 400; throw e; }
    pmId = resolved.pmId;
    const card = resolved.card;

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
    const payload = { error: e.message };
    if (e.code) payload.code = e.code;
    return res.status(e.status || 500).json(payload);
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
  if (slug === 'handy-andy') return ['global', 'handy-andy'];   // HA transitioned off the global account, so old charges may live in either
  if (slug === 'mile-high') return ['mile-high'];               // always its own account, never global -- it never existed pre-split
  if (slug === 'austin') return ['austin'];                     // same: born after the split
  if (slug === 'precision') return ['precision'];               // same
  // Austin lead-gen quad — all four charge on the shared 'austin' account
  // (see LEGACY_SLUG_ACCOUNT in api/_lib/stripe.js), so that is the one
  // account their disputes can live in.
  if (slug === 'atxmountpros' || slug === 'atxtvmount' || slug === 'austinmountingpros' || slug === 'austintvinstall') return ['austin'];
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

// Joey (Dom's secretary) also handles Handy Andy's social posting, so she
// needs the Handy Andy "To Post" bucket specifically -- nothing else of
// Handy Andy's. resolveBusiness() would 403 her for any slug but her own
// scope, which is correct for everything else; this is the one deliberate,
// narrow hole in that rule. Returns { biz, crossBusinessToPostOnly } so
// callers can clamp what a cross-business caller is allowed to see/do.
async function resolveBusinessForPhotos(db, auth, slug) {
  try {
    return { biz: await resolveBusiness(db, auth, slug), crossBusinessToPostOnly: false };
  } catch (e) {
    if (auth.role === 'secretary' && auth.scope === 'doms' && slug === 'handy-andy') {
      const { data, error } = await db.from('businesses').select('id, slug, name, timezone').eq('slug', slug).single();
      if (error || !data) throw e;
      return { biz: data, crossBusinessToPostOnly: true };
    }
    throw e;
  }
}

// ── Photo gallery (every job photo for the business, newest first) ───────────
async function photoGallery(req, res, db, auth) {
  let biz, crossBusinessToPostOnly;
  try { ({ biz, crossBusinessToPostOnly } = await resolveBusinessForPhotos(db, auth, req.query.business)); } catch (e) { return bail(res, e); }
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const offset = Number(req.query.offset) || 0;
  // ?logo=1 narrows to the logo shots (migration 0105) — a finished mount with
  // the company logo up on the customer's TV.
  const logoOnly = req.query.logo === '1' || req.query.logo === 'true';

  // ?status=<bucket> filters the folder SERVER-side.
  //
  // This used to be done in the client, over whatever the newest 200 photos
  // happened to be, which quietly became a bug as the table grew: by Sep 2026
  // Handy Andy had 148 photos in Posted but only 6 of them fell inside that
  // 200-row window, so the Posted folder looked nearly empty and older photos
  // appeared to have vanished. Nothing was ever deleted — they were simply
  // past the edge of what got loaded. Filtering here means a folder shows its
  // own newest N regardless of how much sits in the other folders.
  //
  // 'new' is the catch-all: legacy 'private' rows and any null fold into the
  // inbox, matching photoCat() in admin.html.
  const statusFilter = (req.query.status || '').toString();
  const sel = (withStatus, withLogo) => {
    let q = db.from('booking_photos')
      .select(`id, url, caption, uploader_name, created_at, booking_id${withStatus ? ', status' : ''}${withLogo ? ', logo_shot, logo_note' : ''},
             booking:bookings ( id, scheduled_at, status, customer:customers ( name ), technician:technicians!technician_id ( name ) )`)
      .eq('business_id', biz.id);
    if (withLogo && logoOnly) q = q.is('logo_shot', true);
    if (withStatus && statusFilter && PHOTO_CATEGORIES.includes(statusFilter)) {
      q = statusFilter === 'new'
        ? q.or('status.is.null,status.eq.new,status.eq.private')
        : q.eq('status', statusFilter);
    }
    // The cross-business hole above only ever opens the To Post bucket -- New,
    // Posted, Records, and anything private-to-New-Booking stays invisible to
    // her from the other company, enforced here rather than trusted from the
    // client. Only reachable when withStatus is true (status column exists);
    // the no-status fallback below already treats everything as 'new', which
    // this caller must never see, so it's short-circuited to empty instead.
    if (crossBusinessToPostOnly) q = withStatus ? q.eq('status', 'to_post') : q.eq('id', '00000000-0000-0000-0000-000000000000');
    return q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  };
  // Try selecting the photo category (status) and the logo-shot tag. If either
  // migration hasn't been applied yet the column is missing — fall back so the
  // gallery still loads: no status means treat everything as 'new' (the inbox),
  // no logo column means the Logo tab is simply empty rather than an error.
  let hasStatus = true;
  let hasLogo = true;
  let { data, error } = await sel(true, true);
  if (error && /logo_shot|logo_note/i.test(error.message || '')) {
    hasLogo = false;
    ({ data, error } = await sel(true, false));
  }
  if (error && /status/i.test(error.message || '')) {
    hasStatus = false;
    ({ data, error } = await sel(false, hasLogo));
  }
  if (error) throw error;
  const photos = (data || []).map(p => ({
    id: p.id, url: p.url, caption: p.caption, uploader_name: p.uploader_name, created_at: p.created_at,
    booking_id: p.booking_id,
    logo_shot: hasLogo ? !!p.logo_shot : false,
    logo_note: hasLogo ? (p.logo_note || null) : null,
    status: hasStatus ? (p.status || 'new') : 'new',
    customer_name: p.booking?.customer?.name || 'Customer',
    technician_name: p.booking?.technician?.name || null,
    scheduled_at: p.booking?.scheduled_at || null,
    status_booking: p.booking?.status || null,
  }));
  // True per-folder totals. The tab badges used to count only what was loaded,
  // so they under-reported for exactly the same reason the folders did. These
  // are head-only counts (no rows fetched) against the existing status index,
  // so five of them cost far less than the page of photos above.
  let counts = null;
  if (hasStatus && !crossBusinessToPostOnly) {
    const countFor = (apply) => {
      let q = db.from('booking_photos').select('id', { count: 'exact', head: true }).eq('business_id', biz.id);
      return apply(q);
    };
    try {
      const [cNew, cToPost, cPosted, cRecords, cLogo, cUnscanned] = await Promise.all([
        countFor(q => q.or('status.is.null,status.eq.new,status.eq.private')),
        countFor(q => q.eq('status', 'to_post')),
        countFor(q => q.eq('status', 'posted')),
        countFor(q => q.eq('status', 'records')),
        hasLogo ? countFor(q => q.is('logo_shot', true)) : Promise.resolve({ count: 0 }),
        hasLogo ? countFor(q => q.is('logo_scanned_at', null)) : Promise.resolve({ count: 0 }),
      ]);
      counts = {
        new: cNew.count || 0, to_post: cToPost.count || 0, posted: cPosted.count || 0,
        records: cRecords.count || 0, logo: cLogo.count || 0,
        // How many are still waiting on the vision pass — drives the "Scan now"
        // button's label so the owner can see the backfill draining.
        unscanned: cUnscanned.count || 0,
      };
    } catch (e) { console.warn('[photo_gallery] counts failed:', e.message); }
  }
  return res.status(200).json({
    photos, limit, offset, has_more: photos.length === limit,
    status_supported: hasStatus, logo_supported: hasLogo, counts,
  });
}

// Run the logo-shot vision scan on demand, from the Photos tab, instead of
// waiting for the twice-a-day cron to work through the backlog 40 at a time.
// Owner-only: it spends money on API calls, and it is the owner's tagging
// decision to re-run, not the office's. Same underlying pass as the cron, so
// it stays idempotent — an already-scanned photo is never looked at twice.
async function photoLogoScan(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { scanLogoPhotos } = await import('./_lib/photo-logo-scan.js');
  // Capped well under the function timeout: at ~5 concurrent and a couple of
  // seconds each, 120 is roughly 45s of work. The client loops until the
  // unscanned count reaches zero, so a big backfill just takes a few passes.
  const limit = Math.min(Number(body.limit) || 120, 200);
  const summary = await scanLogoPhotos({ limit });
  return res.status(200).json({ ok: true, ...summary });
}

// Move a photo between categories (New / To Post / Posted / Records). No-op-safe:
// validates the target category and that the photo belongs to this business.
// 'private' stays accepted so legacy photos can still be re-filed.
const PHOTO_CATEGORIES = ['new', 'to_post', 'posted', 'records', 'private'];
async function bookingPhotoSetStatus(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz, crossBusinessToPostOnly;
  try { ({ biz, crossBusinessToPostOnly } = await resolveBusinessForPhotos(db, auth, body.business)); } catch (e) { return bail(res, e); }
  if (!body.photo_id) return res.status(400).json({ error: 'photo_id required' });
  const status = (body.status || '').toString();
  if (!PHOTO_CATEGORIES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${PHOTO_CATEGORIES.join(', ')}` });
  }
  // Cross-business (Joey on Handy Andy): the only move she's allowed is
  // marking a To Post photo as Posted once she's actually posted it -- never
  // New/Records/private, and never a photo that wasn't already in To Post
  // (both directions checked: the target here, the current status below).
  if (crossBusinessToPostOnly && status !== 'posted') {
    return res.status(403).json({ error: 'Only marking a photo Posted is allowed here.' });
  }
  let q = db.from('booking_photos').update({ status }).eq('id', body.photo_id).eq('business_id', biz.id);
  if (crossBusinessToPostOnly) q = q.eq('status', 'to_post');
  const { data, error } = await q
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
// A booking counts toward "purchased GDS" if any of its line items is the
// Guaranteed Dismount Service upsell — same name the confirmation-email
// upsell button and gds_upsell_add() write (see GDS_LINE_NAME below).
function jobHasGds(lineItems) {
  return (lineItems || []).some(li => /guaranteed dismount/i.test(li.name || li.description || ''));
}

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
  // Alphabetical by name. Newest-first stopped being useful once the Zenbooker
  // history landed: 7,000+ customers all created in the same import batch have
  // no meaningful recency order, so the office could never find anyone.
  const { data, error } = await q.order('name', { ascending: true }).limit(200);
  if (error) throw error;
  const customerRows = data || [];

  // One extra query for every customer's job history, aggregated here in JS
  // (no per-customer round-trip) — this is what turns the list from a bare
  // contact book into an actual CRM: jobs count, lifetime spend, GDS flag, and
  // last-seen date shown right in the table, before ever opening a detail view.
  if (customerRows.length) {
    // Paged fetch: PostgREST silently caps un-ranged selects at its max-rows
    // setting (1000 by default), which would quietly undercount every stat
    // once the 200 listed customers collectively pass that many bookings.
    const jobRows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: page, error: pageErr } = await db.from('bookings')
        .select('customer_id, price, status, scheduled_at, review_rating, line_items:booking_line_items ( name )')
        .eq('business_id', biz.id)
        .in('customer_id', customerRows.map(c => c.id))
        .range(from, from + PAGE - 1);
      if (pageErr) { console.warn('[customers] job aggregate failed:', pageErr.message); break; }
      jobRows.push(...(page || []));
      if (!page || page.length < PAGE) break;
    }
    const byCust = {};
    jobRows.forEach(j => {
      const b = byCust[j.customer_id] || (byCust[j.customer_id] = {
        jobs: 0, completed: 0, cancelled: 0, lifetime_value: 0, last_job_at: null, has_gds: false, ratings: [],
      });
      b.jobs += 1;
      if (j.status === 'cancelled') b.cancelled += 1;
      if (j.status === 'completed') { b.completed += 1; b.lifetime_value += Number(j.price) || 0; }
      if (j.scheduled_at && (!b.last_job_at || j.scheduled_at > b.last_job_at)) b.last_job_at = j.scheduled_at;
      // "Purchased" must mean a sale that actually stands — a GDS line on a
      // job the customer cancelled (or no-showed) never happened.
      if (!['cancelled', 'no_show'].includes(j.status) && jobHasGds(j.line_items)) b.has_gds = true;
      if (j.review_rating) b.ratings.push(j.review_rating);
    });
    customerRows.forEach(c => {
      const b = byCust[c.id];
      c.jobs_count = b ? b.jobs : 0;
      c.completed_count = b ? b.completed : 0;
      c.cancelled_count = b ? b.cancelled : 0;
      c.lifetime_value = b ? Math.round(b.lifetime_value * 100) / 100 : 0;
      c.last_job_at = b ? b.last_job_at : null;
      c.has_gds = b ? b.has_gds : false;
      c.avg_rating = b && b.ratings.length ? Math.round((b.ratings.reduce((s, r) => s + r, 0) / b.ratings.length) * 10) / 10 : null;
    });
  }
  return res.status(200).json({ customers: customerRows });
}

// Full history for one customer: every job (with tech/service/pay/review/GDS),
// every estimate ever sent to them (matched by email or phone, since an
// estimate is created before a customers row may even exist), and rollup
// stats — the actual point of a CRM's customer tab.
async function customerDetail(req, res, db, auth) {
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  const { data: customer, error: custErr } = await db.from('customers')
    .select('id, name, phone, email, address_line1, city, state, postal_code, created_at')
    .eq('id', id).eq('business_id', biz.id).maybeSingle();
  if (custErr) throw custErr;
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { data: jobRows, error: jobsErr } = await db.from('bookings')
    .select(`id, status, payment_status, scheduled_at, completed_at, cancelled_at, price, subtotal, tip,
              amount_paid, amount_refunded, review_rating, review_text, address_line1, city, state, postal_code,
              service:services ( name ),
              technician:technicians!technician_id ( name ),
              line_items:booking_line_items ( name, kind, quantity, unit_price, line_total )`)
    .eq('business_id', biz.id).eq('customer_id', id)
    // nullsFirst:false — Postgres puts NULLs first on DESC by default, which
    // would float a dateless draft booking to the top and null out last_job_at.
    .order('scheduled_at', { ascending: false, nullsFirst: false });
  if (jobsErr) throw jobsErr;
  const jobs = (jobRows || []).map(j => ({
    id: j.id,
    status: j.status,
    payment_status: j.payment_status,
    scheduled_at: j.scheduled_at,
    completed_at: j.completed_at,
    cancelled_at: j.cancelled_at,
    price: j.price,
    amount_paid: j.amount_paid,
    amount_refunded: j.amount_refunded,
    service_name: j.service?.name || null,
    technician_name: j.technician?.name || null,
    review_rating: j.review_rating,
    review_text: j.review_text,
    address: [j.address_line1, j.city, j.state, j.postal_code].filter(Boolean).join(', ') || null,
    has_gds: jobHasGds(j.line_items),
    line_items: (j.line_items || []).map(li => ({ name: li.name, quantity: li.quantity, unit_price: li.unit_price, line_total: li.line_total })),
  }));

  // Estimates aren't linked by customer_id (an estimate can predate the
  // customers row, or never convert into one) — match by email/phone instead,
  // same identity signal the rest of the app uses for this customer. Two
  // separate .eq() queries rather than one .or(): PostgREST's or= parser
  // treats , ( ) as syntax, and phones are stored as "(303) 555-1234" — an
  // interpolated .or() string would 400 on every such customer and silently
  // show "No estimates on file". .eq() values are URL-encoded, so they're safe.
  const estSelect = 'id, status, service_label, line_items, approved_total, tax_rate, created_at, approved_at, contacted_at';
  const estQueries = [];
  if (customer.email) estQueries.push(db.from('estimates').select(estSelect).eq('business_id', biz.id).eq('customer_email', customer.email));
  if (customer.phone) estQueries.push(db.from('estimates').select(estSelect).eq('business_id', biz.id).eq('customer_phone', customer.phone));
  let estimates = [];
  if (estQueries.length) {
    const settled = await Promise.all(estQueries);
    const seen = new Set();
    const estRows = [];
    for (const r of settled) {
      if (r.error) { console.warn('[customer_detail] estimates lookup failed:', r.error.message); continue; }
      for (const row of (r.data || [])) {
        if (!seen.has(row.id)) { seen.add(row.id); estRows.push(row); }
      }
    }
    estRows.sort((a, b2) => (b2.created_at || '').localeCompare(a.created_at || ''));
    estimates = estRows.map(e => {
      const subtotal = (e.line_items || []).reduce((s, li) => s + (Number(li.unit_price) || 0) * (Number(li.qty) || 1), 0);
      return {
        id: e.id, status: e.status, service_label: e.service_label,
        subtotal: Math.round(subtotal * 100) / 100,
        approved_total: e.approved_total,
        created_at: e.created_at, approved_at: e.approved_at, contacted_at: e.contacted_at,
        has_gds: (e.line_items || []).some(li => /guaranteed dismount/i.test(li.description || '')),
      };
    });
  }

  const completedJobs = jobs.filter(j => j.status === 'completed');
  const cancelledJobs = jobs.filter(j => j.status === 'cancelled');
  const ratings = jobs.map(j => j.review_rating).filter(Boolean);
  const datedJobs = jobs.filter(j => j.scheduled_at);
  const stats = {
    jobs_count: jobs.length,
    completed_count: completedJobs.length,
    cancelled_count: cancelledJobs.length,
    lifetime_value: Math.round(completedJobs.reduce((s, j) => s + (Number(j.price) || 0), 0) * 100) / 100,
    first_job_at: datedJobs.length ? datedJobs[datedJobs.length - 1].scheduled_at : null,
    last_job_at: datedJobs.length ? datedJobs[0].scheduled_at : null,
    // "Purchased" = a GDS line on a job that actually stands. A cancelled/
    // no-show job's GDS never happened, and an estimate merely OFFERING it
    // (the detail view's own column is labeled "GDS Offered") isn't a sale.
    has_gds: jobs.some(j => j.has_gds && !['cancelled', 'no_show'].includes(j.status)),
    avg_rating: ratings.length ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 : null,
    reviews_count: ratings.length,
  };

  return res.status(200).json({ customer, jobs, estimates, stats });
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
  let cols = 'id, name, phone, email, status, active, service_area_id, max_jobs_per_day, pin_hash, photo_url, bio_years, bio_blurb, review_invite_sent_at';
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

  // Each tech's metro NAME rides along so every dropdown can read "Zach
  // (Austin)" instead of a bare name. Before a zip is typed, the New Booking
  // tech picker legitimately lists the whole roster (the metro isn't known
  // yet), and an unlabeled list is how an Austin tech reads as pickable for a
  // Denver caller. Best-effort: on any error the names just don't show.
  try {
    const areaIds = [...new Set(techs.map(t => t.service_area_id).filter(Boolean))];
    if (areaIds.length) {
      const { data: areas } = await db.from('service_areas').select('id, name').in('id', areaIds);
      const nameOf = new Map((areas || []).map(a => [a.id, a.name]));
      for (const t of techs) t.area_name = nameOf.get(t.service_area_id) || null;
    }
  } catch { /* labels are cosmetic, never fail the roster over them */ }

  // $100 review-program progress per tech, so the Technicians screen shows how
  // far each one has got instead of only whether an invite went out. Counts
  // only listings currently IN the program (an old 'doms' checkin from before
  // Dom's was pulled must not inflate the count), matching the same rule the
  // award itself uses in api/tech.js. Best-effort: on any error the roster
  // still renders, just without progress.
  const REVIEW_PROGRAM_KEYS = ['ha-houston-1', 'ha-houston-2', 'ha-austin', 'ha-denver-1', 'ha-denver-2'];
  for (const t of techs) { t.review_done = 0; t.review_total = REVIEW_PROGRAM_KEYS.length; t.review_bonus_at = null; }
  try {
    const ids = techs.map(t => t.id);
    if (ids.length) {
      const byId = new Map(techs.map(t => [t.id, t]));
      const { data: cks } = await db.from('tech_review_checkins')
        .select('technician_id, listing_key').in('technician_id', ids);
      for (const c of cks || []) {
        if (!REVIEW_PROGRAM_KEYS.includes(c.listing_key)) continue;
        const t = byId.get(c.technician_id); if (t) t.review_done++;
      }
      const { data: bns } = await db.from('tech_review_bonus')
        .select('technician_id, completed_at').in('technician_id', ids);
      for (const b of bns || []) {
        const t = byId.get(b.technician_id); if (t) t.review_bonus_at = b.completed_at;
      }
    }
  } catch { /* migrations 0089/0090 not applied yet */ }

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
  const slug = (req.query.business || '').toString();
  // Same scope check resolveBusiness does, run BEFORE either query fires — so
  // an unauthorized caller can't trigger the partner lookup by racing it
  // alongside resolveBusiness in Promise.all below.
  if (!slug) return bail(res, Object.assign(new Error('business is required'), { status: 400 }));
  if (!mayUseBusiness(auth, slug)) return bail(res, Object.assign(new Error('Forbidden for this business'), { status: 403 }));
  let partner;
  try {
    // resolveBusiness still runs (confirms the business actually exists) but
    // partnerBusiness only needs the slug string itself, not biz's DB row, so
    // it doesn't have to wait for resolveBusiness to finish first.
    [, partner] = await Promise.all([resolveBusiness(db, auth, slug), partnerBusiness(db, slug)]);
  } catch (e) { return bail(res, e); }
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
    .select('id, name, service_area_id').eq('business_id', partner.id).eq('active', true).neq('status', 'off');
  if (serviceAreaId) query = query.eq('service_area_id', serviceAreaId);
  const { data, error } = await query.order('name');
  if (error) throw error;
  // Metro name per tech, same as the own-roster technicians endpoint: when no
  // zip is entered yet this list is the partner's WHOLE roster, and unlabeled
  // names are how an out-of-metro tech reads as a valid pick. Best-effort.
  const partnerTechs = data || [];
  try {
    const areaIds = [...new Set(partnerTechs.map(t => t.service_area_id).filter(Boolean))];
    if (areaIds.length) {
      const { data: areas } = await db.from('service_areas').select('id, name').in('id', areaIds);
      const nameOf = new Map((areas || []).map(a => [a.id, a.name]));
      for (const t of partnerTechs) t.area_name = nameOf.get(t.service_area_id) || null;
    }
  } catch { /* labels are cosmetic */ }
  return res.status(200).json({
    partner: { slug: partner.slug, name: partner.name },
    technicians: partnerTechs,
  });
}

// ── Send a receipt (or invoice) for one job ─────────────────────────────────
// Secretary-facing: the booking modal's "Send receipt" button. One template
// serves both documents (see receiptEmail in _lib/email.js) and WHICH one goes
// out is decided here from the booking's real payment state, never from the
// caller -- a client can't talk us into telling a customer they paid when they
// haven't. Works on any job at any age, including a call months later asking
// for a copy for taxes or an insurance claim.
async function receiptSend(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = (body.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  // stripe_account is optional (older DBs); degrade rather than fail the send.
  const cols = (withAcct) => `id, scheduled_at, price, tip, amount_paid, amount_refunded, payment_status,
      payment_method, paid_at, ${withAcct ? 'stripe_account, ' : ''}stripe_payment_method_id, stripe_payment_intent_id,
      address_line1, city, state, postal_code,
      customer:customers ( name, email ),
      technician:technicians!technician_id ( name ),
      service_area:service_areas ( timezone ),
      line_items:booking_line_items ( name, kind, quantity, line_total )`;
  let { data: b, error } = await db.from('bookings').select(cols(true)).eq('id', id).eq('business_id', biz.id).maybeSingle();
  if (error && missingColumn(error.message) === 'stripe_account') {
    ({ data: b, error } = await db.from('bookings').select(cols(false)).eq('id', id).eq('business_id', biz.id).maybeSingle());
  }
  if (error) throw error;
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.customer?.email) return res.status(400).json({ error: 'No customer email on file for this job.' });
  if (!emailNotificationsOn()) return res.status(503).json({ error: 'Email notifications are turned off.' });

  const total = Number(b.price) || 0;
  const tip = Number(b.tip) || 0;
  const paid = Number(b.amount_paid) || 0;
  const refunded = Number(b.amount_refunded) || 0;
  const netPaid = Math.max(0, Math.round((paid - refunded) * 100) / 100);
  const amountDue = Math.max(0, Math.round((total + tip - netPaid) * 100) / 100);

  // WHICH document to send is decided by payment_status, the same field the
  // rest of the dashboard trusts (it gates the Charge / Refund buttons), NOT
  // by comparing amount_paid to price. That arithmetic looks stricter but is
  // wrong on real data: 7 live bookings are marked paid while amount_paid is
  // short of price+tip, almost all because a tip was recorded on the booking
  // without being charged through Stripe. Deciding by arithmetic would have
  // emailed those already-paid customers a dunning invoice for the tip.
  //
  // Refunds are folded in separately because a refund never decrements
  // amount_paid anywhere in this codebase (bookingPayment writes only
  // payment_status + amount_refunded), so a fully refunded job would
  // otherwise still satisfy any "was it paid" test and print a green PAID.
  const status = String(b.payment_status || '').toLowerCase();
  // Everything that was collected has gone back to the customer.
  const allCollectedReturned = refunded > 0.005 && refunded + 0.005 >= paid;
  // ...and the bill had actually been settled before that refund. Both must be
  // true to call a job "refunded, nothing owed": a customer who paid only half
  // and then got that half back still owes the whole bill, so that case has to
  // fall through to an invoice for the full amount rather than a reassuring
  // "nothing is owed" document.
  const wasSettled = paid > 0 && paid + 0.005 >= total + tip;
  const kind = (allCollectedReturned && wasSettled) ? 'refunded'
    : allCollectedReturned ? 'invoice'
    : (status === 'paid' ? 'receipt' : 'invoice');

  // Never bill someone $0.00. A price-less job is a data problem, not a
  // document, and an invoice for nothing only generates a confused phone call.
  if (kind === 'invoice' && total + tip <= 0) {
    return res.status(400).json({ error: 'This job has no price set, so there is nothing to invoice. Add the line items first.' });
  }

  // Tax rides in the line items as its own row; split it out so the receipt
  // shows a true subtotal + tax rather than burying tax among the services.
  const allLines = b.line_items || [];
  const isTax = (li) => /^tax\b/i.test(String(li.name || ''));
  const explicitTax = allLines.filter(isTax).reduce((s, li) => s + (Number(li.line_total) || 0), 0);
  const lines = allLines.filter(li => !isTax(li))
    .map(li => ({ label: li.name, qty: li.quantity, amount: li.line_total }));

  // Make the document reconcile BY CONSTRUCTION. `price` is authoritative (it
  // is what the customer was actually charged), but the itemization does not
  // always sum to it: measured across every non-imported booking, 226 of 226
  // jobs WITH a stored tax row reconcile exactly, while 29 jobs WITHOUT one
  // sit ~8.96% under price -- that gap is tax that was folded into price and
  // never written as its own line. So a positive gap is tax; a negative gap
  // (an un-itemized discount, seen only on imported jobs) becomes a neutral
  // "Adjustment" rather than being guessed at. Either way the customer never
  // receives a receipt whose subtotal + tax does not equal its total.
  const subtotal = lines.reduce((s, li) => s + (Number(li.amount) || 0), 0);
  const gap = Math.round((total - (subtotal + explicitTax)) * 100) / 100;
  // A positive gap is only callable "tax" when there is something to have
  // taxed; with no itemization at all (not present in any live booking, but
  // cheap to guard) it falls to the neutral Adjustment row instead of
  // labelling the entire charge as tax.
  const gapIsTax = gap > 0 && subtotal > 0;
  const tax = explicitTax + (gapIsTax ? gap : 0);
  const adjustment = gapIsTax ? 0 : gap;

  // Metro timezone, so the dates read correctly for a Houston/Austin job.
  const tz = b.service_area?.timezone || biz.timezone || 'America/Denver';
  const longDate = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' }); }
    catch { return ''; }
  };

  // How they paid, for the PAID stamp. The card claim is driven by
  // stripe_payment_intent_id (an actual captured charge), NOT by the presence
  // of a saved payment method: most card jobs leave payment_method null (122
  // of 124 null-method paid jobs carry a real charge), while a cash job can
  // still have a card sitting on file from booking time. Keying off the card
  // on file would print "Visa ending 4242" on a job the customer paid in cash.
  // When neither signal is present we say nothing rather than guess.
  let paymentLabel = '';
  if (kind === 'receipt') {
    const method = String(b.payment_method || '').toLowerCase();
    if (method === 'cash') paymentLabel = 'Cash';
    else if (b.stripe_payment_intent_id) {
      paymentLabel = 'Card';
      if (b.stripe_payment_method_id) {
        try {
          const card = await retrieveCard(b.stripe_payment_method_id, { account: b.stripe_account || null, slug: biz.slug });
          if (card.brand || card.last4) {
            const brandName = card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card';
            paymentLabel = card.last4 ? `${brandName} ending ${card.last4}` : brandName;
          }
        } catch (_) { /* a Stripe hiccup degrades to plain "Card" */ }
      }
    } else if (method && method !== 'quote') {
      paymentLabel = method.charAt(0).toUpperCase() + method.slice(1);
    }
  }

  const { subject, html } = receiptEmail({
    kind,
    receiptNo: String(b.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
    customerName: b.customer.name || 'Customer',
    serviceDate: longDate(b.scheduled_at),
    paidDate: longDate(b.paid_at),
    technicianName: b.technician?.name || null,
    address: { line1: b.address_line1, city: b.city, state: b.state, zip: b.postal_code },
    lines, tax, adjustment, tip, total,
    netPaid, amountDue,
    amountRefunded: refunded,
    paymentLabel,
  }, brandFor(biz.slug));

  const { from } = emailConfig(biz.slug);
  const result = await sendEmail({ slug: biz.slug, to: b.customer.email, subject, html, replyTo: from });
  if (!result.sent) return res.status(502).json({ error: 'Email failed to send: ' + (result.skipped || result.error || 'unknown error') });
  // Leave a record on the job itself. A financial document going to a customer
  // should be answerable later ("did anyone already send this?", "who sent
  // it?"), and a booking note is the one place the office already looks.
  // Best-effort: the document HAS been delivered by this point, so a failure
  // to log it must never turn a successful send into an error.
  try {
    await db.from('booking_notes').insert({
      booking_id: b.id, business_id: biz.id,
      body: `${kind === 'invoice' ? 'Invoice' : kind === 'refunded' ? 'Refund receipt' : 'Receipt'} emailed to ${b.customer.email}`,
      author_kind: auth.role === 'owner' ? 'owner' : 'secretary', author_id: null,
      author_name: adminAuthorName(auth),
    });
  } catch (e) { console.warn('[receipt] note log failed:', e.message); }
  console.log(`[receipt] ${kind} for ${id} sent by ${auth.name || auth.role} to ${b.customer.email}`);
  return res.status(200).json({ ok: true, kind, to: b.customer.email });
}

// ── Invoice send: email + SMS with a payable Stripe Checkout link ────────────
// Distinct from receipt_send just above (which auto-detects receipt vs invoice
// from payment state and only emails). This is the explicit "bill the
// customer" action from the Line items card: it always sends an INVOICE
// (refused only when nothing is actually owed), creates a real Stripe
// Checkout Session so the customer can pay by card straight from the
// email/text with no login, and sends BOTH channels the office has on file —
// email is required, SMS is best-effort when there's a phone number.
async function invoiceSend(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = (body.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });

  const cols = (withAcct) => `id, scheduled_at, price, tip, amount_paid, amount_refunded, payment_status,
      ${withAcct ? 'stripe_account, ' : ''}
      address_line1, city, state, postal_code,
      customer:customers ( name, email, phone ),
      technician:technicians!technician_id ( name ),
      service_area:service_areas ( timezone ),
      line_items:booking_line_items ( name, kind, quantity, line_total )`;
  let { data: b, error } = await db.from('bookings').select(cols(true)).eq('id', id).eq('business_id', biz.id).maybeSingle();
  if (error && missingColumn(error.message) === 'stripe_account') {
    ({ data: b, error } = await db.from('bookings').select(cols(false)).eq('id', id).eq('business_id', biz.id).maybeSingle());
  }
  if (error) throw error;
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.customer?.email) return res.status(400).json({ error: 'No customer email on file for this job.' });
  if (!emailNotificationsOn()) return res.status(503).json({ error: 'Email notifications are turned off.' });

  const total = Number(b.price) || 0;
  const tip = Number(b.tip) || 0;
  const paid = Number(b.amount_paid) || 0;
  const refunded = Number(b.amount_refunded) || 0;
  const netPaid = Math.max(0, Math.round((paid - refunded) * 100) / 100);
  const amountDue = Math.max(0, Math.round((total + tip - netPaid) * 100) / 100);
  // Never generate a payable link (or a text demanding money) for a job that
  // doesn't actually owe anything — same guard as receipt_send's $0 invoice check.
  if (amountDue <= 0) return res.status(400).json({ error: 'Nothing is owed on this job — there is no balance to invoice.' });

  // Same tax/adjustment reconciliation as receipt_send, so the itemization on
  // an invoice always sums to the total actually billed. See the long comment
  // in receiptSend above for why this can't just trust the stored line items.
  const allLines = b.line_items || [];
  const isTax = (li) => /^tax\b/i.test(String(li.name || ''));
  const explicitTax = allLines.filter(isTax).reduce((s, li) => s + (Number(li.line_total) || 0), 0);
  const lines = allLines.filter(li => !isTax(li)).map(li => ({ label: li.name, qty: li.quantity, amount: li.line_total }));
  const subtotal = lines.reduce((s, li) => s + (Number(li.amount) || 0), 0);
  const gap = Math.round((total - (subtotal + explicitTax)) * 100) / 100;
  const gapIsTax = gap > 0 && subtotal > 0;
  const tax = explicitTax + (gapIsTax ? gap : 0);
  const adjustment = gapIsTax ? 0 : gap;

  const tz = b.service_area?.timezone || biz.timezone || 'America/Denver';
  const longDate = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', { timeZone: tz, month: 'long', day: 'numeric', year: 'numeric' }); }
    catch { return ''; }
  };

  const acct = { account: b.stripe_account || null, slug: biz.slug };
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  const brand = brandFor(biz.slug);
  const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

  // The pay link is best-effort: a business with no Stripe account configured
  // (or a live Stripe hiccup) must still be able to send the invoice itself —
  // it just won't carry a "pay now" button, same as any invoice mailed before
  // online payment existed.
  let payUrl = null;
  if (stripeConfigured(acct)) {
    try {
      const session = await stripe('/checkout/sessions', {
        method: 'POST', ...acct,
        body: {
          mode: 'payment',
          customer_email: b.customer.email,
          'payment_method_types[0]': 'card',
          'line_items[0][quantity]': 1,
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][unit_amount]': Math.round(amountDue * 100),
          'line_items[0][price_data][product_data][name]': `Invoice — ${brand.name}`,
          success_url: `${baseUrl}/pay.html?booking=${encodeURIComponent(b.id)}&business=${encodeURIComponent(biz.slug)}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${baseUrl}/pay.html?booking=${encodeURIComponent(b.id)}&business=${encodeURIComponent(biz.slug)}&canceled=1`,
          'metadata[booking_id]': b.id,
          'metadata[business_slug]': biz.slug,
        },
      });
      payUrl = session.url;
    } catch (e) {
      console.warn('[invoice] Stripe Checkout session failed, sending invoice without a pay link:', e.message);
    }
  }

  const { subject, html } = receiptEmail({
    kind: 'invoice',
    receiptNo: String(b.id).replace(/-/g, '').slice(0, 8).toUpperCase(),
    customerName: b.customer.name || 'Customer',
    serviceDate: longDate(b.scheduled_at),
    technicianName: b.technician?.name || null,
    address: { line1: b.address_line1, city: b.city, state: b.state, zip: b.postal_code },
    lines, tax, adjustment, tip, total,
    netPaid, amountDue,
    amountRefunded: refunded,
    payUrl,
  }, brand);

  const { from } = emailConfig(biz.slug);
  const emailResult = await sendEmail({ slug: biz.slug, to: b.customer.email, subject, html, replyTo: from });
  if (!emailResult.sent) return res.status(502).json({ error: 'Email failed to send: ' + (emailResult.skipped || emailResult.error || 'unknown error') });

  let smsResult = { ok: false, skipped: 'no_phone' };
  if (b.customer.phone) {
    const text = payUrl
      ? `${brand.name}: You have an invoice for ${money(amountDue)}. Pay securely here: ${payUrl}`
      : `${brand.name}: You have an invoice for ${money(amountDue)}. Check your email for details, or call us to pay.`;
    smsResult = await sendSMSResult(b.customer.phone, text);
  }

  // Best-effort audit note, same pattern as receipt_send — a financial
  // document going out must be answerable later without breaking the send.
  try {
    await db.from('booking_notes').insert({
      booking_id: b.id, business_id: biz.id,
      body: `Invoice sent to ${b.customer.email}${smsResult.ok ? ' + text' : ''} — ${money(amountDue)} due${payUrl ? ' (with pay link)' : ''}`,
      author_kind: auth.role === 'owner' ? 'owner' : 'secretary', author_id: null,
      author_name: adminAuthorName(auth),
    });
  } catch (e) { console.warn('[invoice] note log failed:', e.message); }

  console.log(`[invoice] sent for ${id} by ${auth.name || auth.role} to ${b.customer.email}${smsResult.ok ? ' + sms' : ''}`);
  return res.status(200).json({
    ok: true, to: b.customer.email, amountDue,
    sms: smsResult.ok ? 'sent' : (smsResult.skipped || smsResult.error || 'not_sent'),
    payUrl: !!payUrl,
  });
}

// ── "$100 review invite" text (Technicians screen) ───────────────────────────
// Owner-only: texts a technician the review-program pitch with a magic link
// that signs them into the tech app and lands directly on the Reviews tab.
// The link carries a standard signed tech token (the exact shape login
// issues), 14-day expiry. Same trust model as texting the tech their PIN,
// since it goes only to the phone number on their own record. Stamps
// technicians.review_invite_sent_at so the button shows who has been asked
// and when; the owner sends these a few techs at a time on purpose.
async function reviewInviteSend(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can send review invites' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = (body.technician_id || '').toString();
  if (!id) return res.status(400).json({ error: 'technician_id required' });
  const { data: t, error } = await db.from('technicians')
    .select('id, name, phone, business_id, active').eq('id', id).eq('business_id', biz.id).maybeSingle();
  if (error) throw error;
  if (!t) return res.status(404).json({ error: 'Technician not found' });
  if (t.active === false) return res.status(400).json({ error: `${t.name} is deactivated. Reactivate them before sending a review invite.` });
  if (!t.phone) return res.status(400).json({ error: `${t.name} has no phone number set` });

  const token = signToken({ kind: 'tech', tech_id: t.id, business_id: t.business_id }, 14 * 24 * 3600);
  const base = process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://handy-andy-booking.vercel.app');
  const link = `${base}/tech.html?login=${encodeURIComponent(token)}#reviews`;
  const message = `Want a FREE $100 added to your payroll? Leave us a review. Tap the link, it signs you in and shows you exactly what to do: ${link}`;
  const r = await sendSMSResult(t.phone, message);
  if (!r.ok) {
    const why = r.error ? `: ${r.error}` : (r.skipped ? ` (${r.skipped})` : '');
    return res.status(502).json({ error: `Text did not send${why}` });
  }
  const sentAt = new Date().toISOString();
  // Stamp is cosmetic bookkeeping; never fail a sent text over it.
  try { await db.from('technicians').update({ review_invite_sent_at: sentAt }).eq('id', t.id); } catch { /* column may predate 0090 */ }
  return res.status(200).json({ ok: true, sent_at: sentAt });
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
// Migration 0075 — same optimistic pattern as every other column above: assume
// present, flip false and retry without it the first time a read reports it
// missing. review_sms_*/review_email_* (migration 0063) are already selected
// unconditionally elsewhere in this file (reviewCalls), so those are treated
// as long-since-applied and don't need their own flag.
let confirmationEmailCol = true;
const isConfirmationEmailErr = (e) => /confirmation_email_status|confirmation_email_sent_at/.test((e && e.message) || '');
function bookingSelect() {
  // The technician embeds are disambiguated by FK column (technician_id /
  // secondary_technician_id) because bookings has TWO foreign keys to
  // technicians once migration 0019 is applied; without the hint PostgREST
  // can't tell which relationship to follow and the read errors.
  const base = `id, status, source, metadata, scheduled_at, scheduled_end, duration_minutes, price, subtotal, tip, payment_status, paid_at,
          notes, customer_notes, review_rating, review_text, technician_id, service_area_id, business_id, updated_at, zenbooker_job_number${esCol()}${arCol()},
          on_the_way_sms_status, on_the_way_sms_sent_at, on_the_way_sms_delivered_at,
          review_sms_status, review_sms_sent_at, review_sms_delivered_at,
          review_email_sent_at, review_email_delivered_at, review_email_clicked_at${confirmationEmailCol ? ', confirmation_email_status, confirmation_email_sent_at' : ''},
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
  if (error && isConfirmationEmailErr(error)) { confirmationEmailCol = false; ({ data, error } = await run()); }
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
  const base = `id, status, payment_status, payment_method, amount_paid, price, subtotal, tip, notes, customer_notes${arCol()},
          zenbooker_job_number, scheduled_at, postal_code, service_area_id,
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
  // amount_refunded (migration 0061) is optional here for the same reason it is
  // everywhere else: degrade to the pre-0061 shape rather than break the whole
  // dashboard. Profit then reads gross (the old behaviour) instead of net.
  if (error && codeOk(error) && isAmountRefundedErr(error)) {
    amountRefundedCol = false;
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
    // Optimistic-lock revision for the line-items editor — the editor sends it
    // back on save so two people can never blindly overwrite each other's
    // ticket edits (see bookingLineItemsSave).
    li_rev: Number(b.metadata?.li_rev) || 0,
    // Set when a reschedule (office or customer self-service) actually moved
    // the time. Shown as a small note under Date & time on the job card.
    rescheduled_from: b.metadata?.rescheduled_from || null,
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
    // Full notification timeline — admin/secretary dashboard only, never sent to
    // the tech app's own booking read (that's a separate query in tech.js).
    confirmation_email_status: b.confirmation_email_status || null,
    confirmation_email_sent_at: b.confirmation_email_sent_at || null,
    on_the_way_sms_status: b.on_the_way_sms_status || null,
    on_the_way_sms_sent_at: b.on_the_way_sms_sent_at || null,
    on_the_way_sms_delivered_at: b.on_the_way_sms_delivered_at || null,
    review_sms_status: b.review_sms_status || null,
    review_sms_sent_at: b.review_sms_sent_at || null,
    review_sms_delivered_at: b.review_sms_delivered_at || null,
    review_email_sent_at: b.review_email_sent_at || null,
    review_email_delivered_at: b.review_email_delivered_at || null,
    review_email_clicked_at: b.review_email_clicked_at || null,
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

  // Review-email tester (public/review-email-tester.html): a real, fully-live
  // token that carries the sentinel booking_id 'TEST' instead of a real
  // booking, so clicking the button/stars in a test email exercises the
  // ACTUAL review_click -> review.html -> review flow end to end, without
  // ever touching (or requiring) a real booking row.
  if (reviewToken.booking_id === 'TEST') {
    const slug = reviewToken.business_slug === 'doms' ? 'doms' : 'handy-andy';
    const reviewUrl = resolveGoogleReviewUrl({ slug, techName: 'Kregg', areaName: '', bookingId: 'TEST' });
    return res.status(200).json({
      booking_id: 'TEST', already_reviewed: false, review_url: reviewUrl,
      business_slug: slug, business_name: slug === 'doms' ? "Dom's TV Mounting" : 'Handy Andy',
    });
  }

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

  // Review-email tester — see the matching branch in reviewCheck. A no-op
  // "success" so the test flow completes end to end, but nothing is ever
  // written anywhere (there's no real booking to write to).
  if (reviewToken.booking_id === 'TEST') return res.status(200).json({ ok: true, test: true });

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

  // Send SMS to technician: a poor review warns them, a 5-star congratulates
  // them. The 5-star text existed once, was removed, and is back by owner
  // request (Aug 2026): a tech who earns a perfect rating should hear about it,
  // not only the bad ones. Applies to every tech with a phone on file, both
  // businesses (this handler is shared). This covers the CRM review itself;
  // if the customer then also posts to Google, the review-email sync
  // (migrate.js googleReviewSync, fed by the bracket-tracker Action every 15
  // minutes) sends its own separate text when that lands, by design.
  if (booking.technician?.phone && rating <= 4) {
    const techName = booking.technician.name || 'Technician';
    const msg = `${techName} you just received a bad review... Please check your profile to view.`;
    await sendSMS(booking.technician.phone, msg).catch(err => console.warn('[review] tech SMS send failed:', err));
  } else if (booking.technician?.phone && rating === 5) {
    const techName = booking.technician.name || 'Technician';
    const who = booking.customer?.name || 'A customer';
    // "5-star" spelled out, not the star glyph: the glyph forces the whole SMS
    // into UCS-2 encoding (70 chars/segment instead of 160) for no benefit.
    const msg = `${techName}, ${who} just left you a 5-star review on ${booking.business?.name || 'the CRM'}! Nice work.`;
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
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });

  // Review Calls is deliberately CROSS-BUSINESS: Joey follows up with customers
  // from both companies. Her token is scoped to 'doms' though, so resolving the
  // business from body.business made resolveBusiness throw 403 on every Handy
  // Andy card — the review request, which is the entire point of the call,
  // could never be sent for half the queue.
  //
  // When the request comes from that queue, the business is resolved FROM THE
  // BOOKING instead. That is strictly TIGHTER than the normal path, because the
  // client no longer gets to name the business at all; it only names a booking
  // it was already shown. The gate is the same one reviewCallLog uses, so
  // exactly the accounts that can work the queue can send from it.
  let biz;
  if (body.from_review_call) {
    if (auth.scope === 'handy-andy') return res.status(403).json({ error: 'Review Calls is not available on this account.' });
    const { data: row } = await db.from('bookings')
      .select('id, business:businesses ( id, slug, name )').eq('id', id).maybeSingle();
    if (!row || !row.business) return res.status(404).json({ error: 'Booking not found' });
    biz = row.business;
  } else {
    try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  }
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

// ── Resend a customer notification from the booking detail's notification log ──
// Covers the notifications review_resend doesn't: the initial booking-confirmation
// email, a technician's "you got a job" text, and the "on the way" text. Each
// rebuilds the exact same message the customer originally got, from the booking's
// current saved state (so an edited address/price/tech is reflected) — never
// creates a new booking or changes the appointment itself.
async function notificationResend(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const id = body.id, kind = body.kind;
  if (!id || !kind) return res.status(400).json({ error: 'id and kind required' });

  const { data: b, error } = await db.from('bookings')
    .select(`id, scheduled_at, price, tip, needs_lifting, technician_id, sms_consent,
      address_line1, city, state, postal_code,
      customer:customers ( name, phone, email ),
      technician:technicians!technician_id ( id, name, photo_url, bio_years, bio_blurb ),
      line_items:booking_line_items ( name, quantity, unit_price, line_total )`)
    .eq('id', id).eq('business_id', biz.id).single();
  if (error || !b) return res.status(404).json({ error: 'Booking not found' });
  const tz = biz.timezone || 'America/Denver';

  if (kind === 'confirmation_email') {
    if (!b.customer?.email) return res.status(400).json({ error: 'No customer email on file for this job.' });
    if (!emailNotificationsOn()) return res.status(503).json({ error: 'Email notifications are turned off.' });
    const firstName = (b.customer.name || '').trim().split(/\s+/)[0] || '';
    let dateLong = '', timeWindow = '', startEpoch = null, endEpoch = null;
    if (b.scheduled_at) {
      try { dateLong = new Date(b.scheduled_at).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { /* keep blank */ }
      const slotDef = SLOTS.find(s => s.key === slotKeyForLocalTime(localHHMM(tz, b.scheduled_at)));
      timeWindow = slotDef ? slotDef.label : '';
      startEpoch = Math.floor(new Date(b.scheduled_at).getTime() / 1000);
      endEpoch = startEpoch + 2 * 3600;
    }
    const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
    const lineItems = b.line_items || [];
    const emailLines = lineItems.map(l => ({ label: l.name, qty: l.quantity, amount: l.line_total }));
    const { subject, html } = bookingConfirmationEmail({
      firstName, dateLong, timeWindow,
      serviceName: biz.slug === 'doms' ? "Dom's TV Mounting" : 'TV Mounting',
      technicianName: b.technician?.name || null,
      technicianPhotoUrl: b.technician?.photo_url || null,
      technicianBioYears: b.technician?.bio_years || null,
      technicianBioBlurb: b.technician?.bio_blurb || null,
      address: { line1: b.address_line1, city: b.city, state: b.state, zip: b.postal_code },
      lines: emailLines.length ? emailLines : null,
      total: b.price != null ? Number(b.price) : null,
      tip: Number(b.tip) || 0,
      twoTechs: !!b.needs_lifting,
      startEpoch, endEpoch, baseUrl, jobId: b.id,
      gdsUpsellUrl: gdsUpsellUrlFor({ lines: lineItems, bookingId: b.id, baseUrl }),
      rescheduleUrl: rescheduleUrlFor({ bookingId: b.id, baseUrl }),
    }, brandFor(biz.slug));
    const { from } = emailConfig(biz.slug);
    const result = await sendEmail({ slug: biz.slug, to: b.customer.email, subject, html, replyTo: from });
    if (!result.sent) return res.status(502).json({ error: 'Email failed to send: ' + (result.skipped || result.error || 'unknown error') });
    try {
      await db.from('bookings').update({ confirmation_email_status: 'sent', confirmation_email_sent_at: new Date().toISOString() }).eq('id', id);
    } catch (e) { /* migration 0075 not applied yet — status just won't show */ }
    return res.status(200).json({ ok: true });
  }

  if (kind === 'tech_new_job') {
    const techId = body.technician_id || b.technician_id;
    if (!techId) return res.status(400).json({ error: 'No technician assigned to this job.' });
    if (!smsNotificationsOn()) return res.status(503).json({ error: 'Text notifications are turned off.' });
    await notifyTechAssigned(db, biz, techId, b.scheduled_at, tz, { bookingId: id });
    return res.status(200).json({ ok: true });
  }

  if (kind === 'on_the_way_sms') {
    if (!b.customer?.phone || !b.sms_consent) return res.status(400).json({ error: 'No SMS consent on file for this job.' });
    if (!smsNotificationsOn()) return res.status(503).json({ error: 'Text notifications are turned off.' });
    // Wording comes from _lib/en-route.js so this manual resend, the tech app's
    // "On My Way" button and the one-tap nudge link all say the same thing.
    const etaMinutes = Number(body.eta_minutes) || DEFAULT_ETA_MINUTES;
    const msg = enRouteMessage(b.technician?.name, biz.name, etaMinutes);
    const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const otwToken = signToken({ kind: 'on_the_way', booking_id: id }, 3600);
    const statusCallback = `${baseUrl}/api/analytics?action=sms_status&token=${encodeURIComponent(otwToken)}`;
    const r = await sendSMSResult(b.customer.phone, msg, { statusCallback });
    if (!r.ok) return res.status(502).json({ error: 'Text failed to send: ' + (r.error || 'unknown error') });
    try {
      await db.from('bookings').update({
        on_the_way_sms_status: 'pending', on_the_way_sms_sent_at: new Date().toISOString(), on_the_way_sms_delivered_at: null,
      }).eq('id', id);
    } catch (e) { /* column absent */ }
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'Unknown notification kind.' });
}

// ── Inbound calls: the office's Calls tab ───────────────────────────────────
// Cross-business like the review-call queue: the phone system is shared, and a
// secretary needs to see the voicemails on THEIR extensions regardless of which
// company the caller was asking about.
const CALL_OPEN_STATUSES = ['new', 'calling', 'called_back'];
// How long a claim ("I am ringing this person now") stays hot. Long enough to
// cover dialing, a conversation and writing a note; short enough that a claim
// someone forgot to close does not hide a customer forever. After this the card
// goes back to being freely callable, with the stale claim still shown.
const CALL_CLAIM_MINUTES = 15;
function claimIsHot(row) {
  if (!row.claimed_at || !row.claimed_by) return false;
  return (Date.now() - new Date(row.claimed_at).getTime()) < CALL_CLAIM_MINUTES * 60000;
}
async function calls(req, res, db, auth) {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
  // Optional date window for the "organized by number" view on the Calls
  // tab (Today/Yesterday/Last 7 days) — the plain "Needs callback" queue
  // still calls this with neither set, unchanged from before.
  const from = (req.query.from || '').toString().trim();
  const to = (req.query.to || '').toString().trim();
  let q = db.from('calls')
    .select(`id, kind, caller_phone, grasshopper_number, extension, extension_no, service, market,
             occurred_at, transcript, has_recording, status, handled_by, handled_at, notes, warnings,
             claimed_by, claimed_at,
             source, tracking_label, answered, duration_sec, recording_url, forwarded_to, called_back_at,
             customer_id, booking_id,
             customer:customers ( id, name, phone, business:businesses ( slug ) ),
             booking:bookings ( id, scheduled_at, status, price, technician:technicians!technician_id ( name ) ),
             business:businesses ( slug, name )`)
    .order('occurred_at', { ascending: false }).limit(limit);
  if (from) q = q.gte('occurred_at', from);
  if (to) q = q.lt('occurred_at', to);
  // Grasshopper tracking was retired (owner call, 2026-08-26) — its rows
  // (kind 'voicemail'/'missed', from the now-disabled call_ingest) stay in the
  // table as history but never surface anywhere again. Twilio rows are kind
  // 'inbound'; the Take a Call wizard's own rows are kind 'live'.
  q = q.not('kind', 'in', '(voicemail,missed)');
  // Owner rule (2026-08-26): the WHOLE list — business names, missed calls,
  // history — is scoped to the businesses this person actually runs, not just
  // the interruption banner (which was fixed first, separately, below). Joey
  // and Heather each see their own home business plus their six assigned
  // lead-gen brands (api/_lib/staff-access.js). Review Calls is untouched —
  // it lives in a different action (reviewCalls/renderReviewCalls) with its
  // own cross-company-by-design query, never this one.
  const viewerSlugs = allowedSlugsFor(auth);   // null = owner, no filter
  if (viewerSlugs) {
    const { data: viewerBiz } = await db.from('businesses').select('id').in('slug', viewerSlugs);
    const viewerBizIds = (viewerBiz || []).map(b => b.id);
    // No matching business rows would mean an unfiltered query (Supabase
    // treats an empty .in() array as "no restriction"), which is exactly
    // backwards for an access boundary — an empty allow-list must return
    // nothing, never everything.
    q = q.in('business_id', viewerBizIds.length ? viewerBizIds : ['00000000-0000-0000-0000-000000000000']);
  }
  const { data: rows, error } = await q;
  if (error) throw error;

  // Self-healing "did this call become a job?": a booking made AFTER ingest
  // cannot have been linked at ingest time. Rather than coupling booking
  // creation to the call log, unlinked calls are re-checked on read, in ONE
  // batched query for the whole page.
  const needLink = (rows || []).filter(r => r.customer_id && !r.booking_id);
  if (needLink.length) {
    const oldest = needLink.reduce((m, r) => (r.occurred_at < m ? r.occurred_at : m), needLink[0].occurred_at);
    const { data: bks } = await db.from('bookings')
      .select('id, customer_id, created_at, scheduled_at, status, price, technician:technicians!technician_id ( name )')
      .in('customer_id', [...new Set(needLink.map(r => r.customer_id))])
      .gte('created_at', oldest)
      .order('created_at', { ascending: true });
    const patch = [];
    for (const r of needLink) {
      const until = new Date(new Date(r.occurred_at).getTime() + 14 * 86400000).toISOString();
      const hit = (bks || []).find(b => b.customer_id === r.customer_id && b.created_at >= r.occurred_at && b.created_at <= until);
      if (hit) {
        r.booking_id = hit.id;
        r.booking = { id: hit.id, scheduled_at: hit.scheduled_at, status: hit.status, price: hit.price, technician: hit.technician };
        patch.push({ id: r.id, booking_id: hit.id, wasOpen: CALL_OPEN_STATUSES.includes(r.status) });
        // Booking the customer IS the follow-up. Once a job exists there is
        // nothing left to return, and leaving it in the queue is exactly how a
        // second person ends up ringing someone who already booked. Clear it.
        if (CALL_OPEN_STATUSES.includes(r.status)) {
          r.status = 'resolved';
          r.handled_by = 'Booked';
          r.handled_at = hit.created_at || new Date().toISOString();
          r.auto_resolved = true;
        }
      }
    }
    // Persist so the next read does not repeat the work. Best-effort: the list
    // is already correct in memory either way.
    for (const p of patch) {
      const upd = { booking_id: p.booking_id };
      if (p.wasOpen) { upd.status = 'resolved'; upd.handled_by = 'Booked'; upd.handled_at = new Date().toISOString(); }
      await db.from('calls').update(upd).eq('id', p.id).then(null, () => {});
    }
  }

  const me = auth.name || auth.role || 'office';

  // Who answers each forwarding number, so a card can say "routed to Joey"
  // instead of ten digits nobody memorises. Matched on digits alone: the
  // tracking rows store E.164 (+1XXXXXXXXXX) while staff_users stores bare
  // 10-digit numbers, and neither is worth normalising in the database for
  // this. One small read per request; an unknown number simply keeps showing
  // as a number rather than guessing at a name.
  const staffByPhone = new Map();
  try {
    const { data: staffRows } = await db.from('staff_users').select('name, phone').eq('active', true);
    for (const s of staffRows || []) {
      const d = String(s.phone || '').replace(/\D/g, '').slice(-10);
      if (d.length === 10 && s.name) staffByPhone.set(d, s.name);
    }
  } catch (e) { /* names are a nicety — never fail the call list over them */ }

  const mapped = (rows || []).map(r => ({
    ...r,
    caller_display: r.customer?.name || prettyPhone(r.caller_phone),
    caller_pretty: prettyPhone(r.caller_phone),
    is_new_caller: !r.customer_id,
    // The person behind forwarded_to, when we know them. null keeps the client
    // on the formatted number.
    routed_to_name: staffByPhone.get(String(r.forwarded_to || '').replace(/\D/g, '').slice(-10)) || null,
    // Someone is on this call right now. `claimed_by_me` lets the UI show "you
    // are on this" rather than warning a person about their own claim.
    claim_active: claimIsHot(r),
    claimed_by_me: claimIsHot(r) && r.claimed_by === me,
    // The four streamlined-card indicators (owner spec, 2026-08-26). Computed
    // once here so the client stays dumb and every reader (card, Missed tab,
    // any future report) agrees on the same definition.
    //   contacted: we answered the call live, or we called back (durable —
    //     see called_back_at / migration 0100, NOT the live `status` field,
    //     which gets overwritten the moment the row is later marked Done).
    //     A Take a Call wizard row (kind 'live') is always contacted by
    //     definition — it exists because a secretary is on the phone with the
    //     customer right now, or was.
    //   left_voicemail: the caller reached voicemail AND actually said
    //     something — an unanswered call where they hung up with no message
    //     did not "leave a voicemail" in any useful sense.
    //   recorded_message: there is audio to play, full stop — this is
    //     broader than left_voicemail on purpose: with record_calls on, an
    //     ANSWERED conversation is recorded too (record-from-answer-dual in
    //     api/analytics.js handleVoiceInbound), and that recording is exactly
    //     as real as a voicemail's.
    contacted: r.kind === 'live' || r.answered === true || r.called_back_at != null,
    left_voicemail: r.answered === false && !!(r.recording_url || r.transcript),
    recorded_message: !!r.recording_url,
  }));
  const open = mapped.filter(r => CALL_OPEN_STATUSES.includes(r.status));
  // A live-call row is created the INSTANT "Take a Call" opens (callLiveStart),
  // before anything about the customer is known, on purpose, so an abandoned
  // call still shows up here instead of vanishing. But if the secretary never
  // reaches the resolution step, it sits at status:'new' forever with no
  // caller_phone and no transcript — nothing was ever left, and there is no
  // number to return. The banner/badge previously could not tell that apart
  // from a real customer voicemail, so an abandoned intake screen could
  // permanently occupy the interruptive banner announcing "X left a voicemail,
  // return their call" with no X and no number to call. It still appears in
  // the Calls tab's own open list (with Booked/Estimate/Declined to close it
  // out) — only the banner and badge, which exist to interrupt someone about a
  // WAITING CUSTOMER, exclude it.
  const openVoicemails = open.filter(r => r.kind !== 'live');
  // Whether THIS viewer should be interrupted (banner/red badge) about a call,
  // layered on top of the business scoping above. Every row already belongs to
  // a business this person is allowed to see, but for a TRACKING-NUMBER call
  // that isn't enough: several people can share access to the same lead-gen
  // brand's calls while only one of them holds the ringing phone, and only
  // that person should be interrupted about it. Heather started getting "you
  // missed a call" nags for tracking lines that ring Joey's phone before this.
  //   - Tracking-number calls interrupt only whoever's handset the call was
  //     actually routed to (forwarded_to matched to staff_users.phone). A line
  //     pointing at a phone no staff row owns interrupts nobody — nobody was
  //     supposed to answer it, so nobody should be yanked to it.
  //   - Grasshopper voicemails interrupt anyone who can see them — the query
  //     above already means that's only people covering that business.
  //   - The owner is never filtered: 'all' scope sees every interruption.
  const interruptsMe = (r) => {
    if (viewerSlugs === null) return true;
    if (r.source === 'twilio') {
      const routedName = staffByPhone.get(String(r.forwarded_to || '').replace(/\D/g, '').slice(-10)) || null;
      return routedName != null && routedName === me;
    }
    return true;
  };
  const interrupting = openVoicemails.filter(r => r.status === 'new' && !claimIsHot(r) && interruptsMe(r));
  return res.status(200).json({
    open,
    handled: mapped.filter(r => !CALL_OPEN_STATUSES.includes(r.status)),
    // The sidebar badge and the banner both count only what is genuinely
    // waiting on THIS person: not the ones someone is already ringing, not the
    // ones that already turned into a booking, not an abandoned live-call
    // session with no customer to call back, and not another secretary's lines.
    open_count: interrupting.length,
    // The newest thing worth interrupting someone about, for the banner.
    banner: interrupting.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))[0] || null,
    me,
  });
}

// Proxies one Twilio call recording so it can be played from the browser.
// Twilio's Recording media URLs require HTTP Basic Auth (Account SID +
// Auth Token) — dropping recording_url straight into <audio src> 401s, so
// this fetches server-side with the same credentials analytics.js already
// uses for signature verification and streams the bytes back.
async function callRecording(req, res, db, auth) {
  const id = (req.query.id || '').toString();
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const { data: row, error } = await db.from('calls').select('recording_url').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row || !row.recording_url) return res.status(404).json({ error: 'No recording for this call' });

  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return res.status(500).json({ error: 'Twilio credentials not configured' });
  const mediaUrl = row.recording_url.endsWith('.mp3') ? row.recording_url : `${row.recording_url}.mp3`;
  const upstream = await fetch(mediaUrl, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') },
  });
  if (!upstream.ok || !upstream.body) return res.status(upstream.status || 502).json({ error: 'Could not fetch recording from Twilio' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.status(200).send(buf);
}

// Claim a voicemail ("I am ringing this person now") so nobody else rings them
// too. Returns 409 with who holds it when someone else got there first — the UI
// turns that into a "call anyway?" confirmation rather than a hard block, since
// there are legitimate reasons to double up and the office should decide.
async function callClaim(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const me = auth.name || auth.role || 'office';

  const { data: cur, error: e0 } = await db.from('calls')
    .select('id, status, claimed_by, claimed_at, booking_id').eq('id', id).single();
  if (e0 || !cur) return res.status(404).json({ error: 'Call not found' });

  // Someone else already claimed this callback. Report it instead of silently
  // stealing the claim.
  if (!body.force && claimIsHot(cur) && cur.claimed_by !== me) {
    const mins = Math.max(1, Math.round((Date.now() - new Date(cur.claimed_at).getTime()) / 60000));
    return res.status(409).json({
      error: `${cur.claimed_by} claimed this ${mins} minute${mins === 1 ? '' : 's'} ago.`,
      claimed_by: cur.claimed_by, minutes_ago: mins, code: 'already_claimed',
    });
  }

  const now = new Date().toISOString();
  const { error } = await db.from('calls')
    .update({ claimed_by: me, claimed_at: now, status: 'calling', updated_at: now })
    .eq('id', id);
  if (error) throw error;
  return res.status(200).json({ ok: true, claimed_by: me });
}

// Mark a call called-back / resolved / ignored, or attach a note. Also used by
// the "Take a Call" wizard (kind='live') to fill in what a voicemail row gets
// for free at ingest — service/market/caller_phone as the secretary learns
// them, then a resolution once the call is over.
const CALL_RESOLUTIONS = ['booked', 'estimate_sent', 'refused', 'other'];
async function callUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const patch = { updated_at: new Date().toISOString() };
  if (body.status) {
    if (!['new', 'calling', 'called_back', 'resolved', 'ignored'].includes(body.status)) {
      return res.status(400).json({ error: 'Unknown status' });
    }
    patch.status = body.status;
    // Closing or reopening a call releases the claim, so a card never sits
    // showing "Heather is calling" after Heather already finished with it.
    if (body.status !== 'calling') { patch.claimed_by = null; patch.claimed_at = null; }
    // Stamp WHO handled it and when, so the follow-up list is auditable the
    // same way the review-call queue is.
    if (body.status !== 'new') {
      patch.handled_by = auth.name || auth.role || 'office';
      patch.handled_at = new Date().toISOString();
    } else {
      patch.handled_by = null; patch.handled_at = null;
    }
    // Durable "we called back" marker (migration 0100) — stamped once and
    // never overwritten by a LATER status change. `status` itself gets
    // overwritten the moment this row is next marked "Done" (-> 'resolved'),
    // so deriving Contacted from "status is currently 'called_back'" would
    // flip the badge back off the instant the call is closed out. Reopening
    // (status -> 'new') clears it, matching handled_at's own reset — a
    // reopened call is meant to be dealt with fresh.
    if (body.status === 'called_back') patch.called_back_at = new Date().toISOString();
    else if (body.status === 'new') patch.called_back_at = null;
  }
  if (body.notes !== undefined) patch.notes = String(body.notes || '').slice(0, 2000) || null;
  if (body.service !== undefined) patch.service = String(body.service || '').slice(0, 60) || null;
  if (body.market !== undefined) patch.market = String(body.market || '').slice(0, 60) || null;
  if (body.caller_phone !== undefined) patch.caller_phone = String(body.caller_phone || '').replace(/\D/g, '').slice(0, 10) || null;
  if (body.customer_id !== undefined) patch.customer_id = body.customer_id || null;
  if (body.booking_id !== undefined) patch.booking_id = body.booking_id || null;
  // Resolution ends the call: "how did it end" IS the terminal status, so
  // resolving always also closes it out, same stamping as any other close.
  if (body.resolution !== undefined) {
    const r = String(body.resolution || '').trim();
    if (r && !CALL_RESOLUTIONS.includes(r)) return res.status(400).json({ error: 'Unknown resolution' });
    patch.resolution = r || null;
    if (r) {
      patch.status = 'resolved';
      patch.claimed_by = null; patch.claimed_at = null;
      patch.handled_by = auth.name || auth.role || 'office';
      patch.handled_at = new Date().toISOString();
    }
  }
  const { error } = await db.from('calls').update(patch).eq('id', id);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

// Block a caller number business-wide (owner call, 2026-08-29 — scammer/
// robocall volume on the tracking lines). Blocks by NUMBER, not by call row,
// so it also covers every other tracking line the same scammer tries next —
// see handleVoiceInbound in api/analytics.js, which rejects a blocked number
// before it ever rings anyone. Same auth model as callUpdate/callClaim above
// (any signed-in office login, no extra business gate) since every call this
// screen shows is already scoped to businesses that login can see.
async function callBlock(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data: call, error: e0 } = await db.from('calls').select('id, caller_phone').eq('id', id).single();
  if (e0 || !call) return res.status(404).json({ error: 'Call not found' });
  const phone = (call.caller_phone || '').replace(/\D/g, '').slice(-10);
  if (!phone || phone.length !== 10) return res.status(400).json({ error: 'This call has no caller number to block' });
  const { error } = await db.from('blocked_numbers').upsert({
    phone, call_id: id, blocked_by: auth.name || auth.role || 'office', reason: (body.reason || '').toString().slice(0, 200) || null,
  }, { onConflict: 'phone', ignoreDuplicates: false });
  if (error) throw error;
  return res.status(200).json({ ok: true, phone });
}

// Permanently remove a call row from the log (owner call, 2026-08-29 — cleaning
// up spam/scam entries, not something a normal missed-call resolution covers).
// Owner-only: unlike blocking (reversible, additive) this is destructive and
// every secretary shares the same Calls tab, so a wider gate here matters.
async function callDelete(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const id = body.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  const { error } = await db.from('calls').delete().eq('id', id);
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

// Start a "Take a Call" live intake: logs the call the moment the secretary
// picks up, before anything about the customer is known, so an abandoned or
// interrupted call still shows up in the Calls tab instead of vanishing.
async function callLiveStart(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  // The owner is not on the phones -- when he opens the script it is to check
  // that it still works, and those runs were landing in Call Performance as a
  // person with a 0% booking rate, dragging the real conversion number down
  // (21 of 43 calls in one week were his). Logging nothing at all, rather than
  // logging-then-filtering, means there is no test data to keep excluding
  // later. The wizard itself is unaffected: every call-logging path on the
  // client already no-ops when there is no id (cwTrack returns early, the
  // call_update calls are .catch()'d), so the script runs start to finish and
  // can still open a real booking -- it just leaves no call record behind.
  if (auth.role === 'owner') {
    return res.status(200).json({ ok: true, id: null, untracked: true });
  }
  const now = new Date().toISOString();
  const { data, error } = await db.from('calls').insert({
    business_id: biz.id,
    kind: 'live',
    occurred_at: now,
    status: 'new',
    handled_by: auth.name || auth.role || 'office',
  }).select('id').single();
  if (error) throw error;
  return res.status(200).json({ ok: true, id: data.id });
}

// ── Inbound calls: Grasshopper ingestion — RETIRED 2026-08-26 ───────────────
// Owner call: stop tracking Grasshopper calls entirely. The Gmail Apps Script
// (docs/grasshopper-gmail-script.md) still POSTs here once a minute from the
// owner's own Google account — turning THAT off requires deleting its
// time-driven trigger in Google Apps Script directly; nothing server-side can
// reach it. Until it's turned off there, every run now gets a fast, clear 410
// instead of writing a row, which is strictly better than a 404/500 for
// whoever eventually reads that script's execution log.
async function callIngest(req, res) {
  return res.status(410).json({ error: 'Grasshopper call tracking has been retired. Delete the syncNow trigger in the Apps Script project to stop these requests.' });
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
// Statuses that resolve a customer OFF the queue: they promised a review, said
// no thanks to one ('declined' — the guided card's "They said no thanks"
// button; without it here a customer who declined REAPPEARED on every reload
// and got the same call again), raised a complaint (handled + logged), or
// asked not to be contacted. 'voicemail' / 'callback' stay on the list so Joey
// tries again. ('reviewed' kept for old data.)
const REVIEW_CALL_RESOLVED = ['reviewed', 'declined', 'do_not_contact', 'promised_review', 'complaint'];
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
function rcMapRow(row, b, zipTzMap) {
  const zip = row.postal_code || row.customer?.postal_code || null;
  // Where THIS customer actually is, for "is it a good time to call them right
  // now"; separate from business_timezone below, which is about the job's own
  // calendar day, not the live clock. Falls back to the business default (Denver
  // for both companies) when the zip isn't in service_area_zips, e.g. an
  // imported job with no address on file.
  const zoned = (zip && zipTzMap && zipTzMap.get(zip)) || null;
  return {
    id: row.id,
    business_slug: b.slug,
    business_name: b.name,
    // The card SPEAKS this job's day out loud ("...how your installation went
    // yesterday"), and "yesterday" is only true in the job's own timezone. Sent
    // so the browser stops computing it in whatever zone the office happens to
    // be sitting in.
    business_timezone: b.timezone || RC_TZ,
    call_timezone: zoned ? zoned.tz : (b.timezone || RC_TZ),
    call_area: zoned ? zoned.area : null,
    customer_name: row.customer?.name || '—',
    phone: row.customer?.phone || null,
    zip,   // booking zip first; imported customers often have it only on the booking
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
const RC_STATUS_TO_FOLDER = { complaint: 'complaint', promised_review: 'promised_review', voicemail: 'voicemail', callback: 'voicemail', do_not_contact: 'do_not_contact', declined: 'declined' };

// Zip -> {tz, area} for one business, batched (two queries total, not one per
// row). Handy Andy spans Mountain (Denver) and Central (Houston/Austin/DFW/San
// Antonio) under a SINGLE business.timezone value, which is why Joey calling a
// Houston customer at "2pm" by the office clock was actually reaching them at
// 3pm; the real per-metro zone lives on service_areas, keyed to a zip through
// service_area_zips, so this reads the same two tables the booking flow itself
// uses to price a job by zip (serviceAreaIdFromPostal / areaTimezone above),
// just batched instead of looked up one row at a time.
async function zipTimezoneMap(db, businessId) {
  const map = new Map();
  const { data: areas } = await db.from('service_areas').select('id, name, timezone').eq('business_id', businessId);
  const areaById = new Map((areas || []).map(a => [a.id, { area: a.name, tz: a.timezone }]));
  const { data: zips } = await db.from('service_area_zips').select('postal_code, service_area_id').eq('business_id', businessId);
  for (const z of (zips || [])) {
    const a = areaById.get(z.service_area_id);
    if (a && a.tz) map.set(String(z.postal_code), a);
  }
  return map;
}

async function reviewCalls(req, res, db, auth) {
  // Joey's (Doms) outreach tool — not part of Heather's (Handy Andy) platform.
  if (auth.scope === 'handy-andy') return res.status(403).json({ error: 'Review Calls is not available on this account.' });
  const folder = (req.query.folder || 'to_call').toString();
  const { data: bizs } = await db.from('businesses').select('id, slug, name, timezone').eq('active', true);
  const warnings = [];
  // One zipTimezoneMap() per business for the whole request, not per row; both
  // branches below (folder browsing and the to_call queue) share it.
  const zipTzCache = new Map();
  const zipTzFor = async (bb) => {
    if (zipTzCache.has(bb.id)) return zipTzCache.get(bb.id);
    const m = await zipTimezoneMap(db, bb.id);
    zipTzCache.set(bb.id, m);
    return m;
  };

  if (folder !== 'to_call') {
    // Folder browsing (Complaints / Promised review / Voicemail / Do not
    // contact) — grouped by the calendar week (Sun–Sat) the call was LOGGED
    // (review_call_at), not the job's scheduled date, so resolved calls are
    // still reachable weeks later instead of disappearing once handled.
    if (!['complaint', 'promised_review', 'voicemail', 'do_not_contact', 'declined'].includes(folder)) {
      return res.status(400).json({ error: 'Invalid folder' });
    }
    let weekOffset = parseInt(req.query.week_offset);
    if (!isFinite(weekOffset)) weekOffset = 0;
    weekOffset = Math.max(-520, Math.min(0, weekOffset));   // up to ~10 years back, never the future
    const weekBase = new Date(Date.now() + weekOffset * 7 * 86400000);
    const weekStart = startOfWeekUTC(RC_TZ, weekBase);
    const weekEnd = localDayStartUTC(RC_TZ, 7, weekStart);

    const out = [];
    const folderCounts = { complaint: 0, promised_review: 0, voicemail: 0, do_not_contact: 0, declined: 0 };
    for (const b of (bizs || [])) {
      const { data, error } = await db.from('bookings').select(rcSelFor(RC_CALL_COLS))
        .eq('business_id', b.id)
        .gte('review_call_at', weekStart.toISOString()).lt('review_call_at', weekEnd.toISOString())
        .order('review_call_at', { ascending: false }).limit(500);
      if (error) { console.warn('[review_calls:folder]', b.slug, error.message); warnings.push(`${b.name}: ${error.message}`); continue; }
      const tzMap = await zipTzFor(b);
      for (const row of (data || [])) {
        const fkey = RC_STATUS_TO_FOLDER[row.review_call_status];
        if (!fkey) continue;
        folderCounts[fkey]++;
        if (fkey === folder) out.push(rcMapRow(row, b, tzMap));
      }
    }
    out.sort((a, c) => new Date(c.call_at || 0) - new Date(a.call_at || 0));
    const fmtMD = (d) => new Intl.DateTimeFormat('en-US', { timeZone: RC_TZ, month: 'short', day: 'numeric' }).format(d);
    const weekLastDay = new Date(weekEnd.getTime() - 86400000);
    await attachInboundVoicemails(db, out);
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
    const tzMap = await zipTzFor(b);
    for (const row of (data || [])) {
      // Skip anyone who already left us a rating through our review filter:
      // reviewed_at is stamped whenever a customer submits ANY 1–5★ (Google-routed
      // 4–5★ or private 1–3★), so it's the precise "they rated us in the CRM"
      // signal. Plus a >= 4 backstop. A job that merely carries a stale imported
      // rating (no submission → no reviewed_at) stays callable.
      if (row.reviewed_at != null || Number(row.review_rating) >= 4) continue;
      if (REVIEW_CALL_RESOLVED.includes(row.review_call_status)) continue;   // handled by Joey — find it under its folder tab now
      out.push(rcMapRow(row, b, tzMap));
    }
  }
  // Not-yet-called first, then most-recently-completed first.
  out.sort((a, c) => {
    const au = a.call_status ? 1 : 0, cu = c.call_status ? 1 : 0;
    if (au !== cu) return au - cu;
    return new Date(c.when || 0) - new Date(a.when || 0);
  });
  await attachInboundVoicemails(db, out);
  return res.status(200).json({
    calls: out,
    warning: warnings.length ? warnings.join(' · ') : null,
    counts: {
      total: out.length,
      to_call: out.filter(x => !x.call_status).length,
      called: out.filter(x => x.call_status).length,
    },
    today_stats: await rcTodayStats(db, (bizs || []).map(b => b.id)),
  });
}

// Owner's view of the review-call program: what Joey actually logged, not the
// queue she works from. Reads the same review_call_* columns the queue writes,
// rolled up by day, by person, by outcome and by complaint tag, plus the full
// list of calls so the owner can read every note. 'Backlog' is how many
// customers from the last 7 days still have no outcome at all, which is the
// one number that says whether the calls are being made.
async function reviewCallReport(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const days = Math.max(1, Math.min(Number(req.query.days) || 7, 90));
  const { data: bizs } = await db.from('businesses').select('id, slug, name, timezone').eq('active', true);
  const bizIds = (bizs || []).map(b => b.id);
  const bizById = new Map((bizs || []).map(b => [b.id, b]));
  const winStart = localDayStartUTC(RC_TZ, -(days - 1));   // today counts as day 1
  const winEnd = localDayStartUTC(RC_TZ, 1);
  const sel = `id, business_id, scheduled_at, review_call_status, review_call_at, review_call_by, review_call_notes, review_rating, reviewed_at,
    customer:customers ( name, phone ),
    technician:technicians!technician_id ( name ),
    service:services ( name )`;
  const run = (extra) => db.from('bookings').select(sel + extra)
    .in('business_id', bizIds)
    .gte('review_call_at', winStart.toISOString()).lt('review_call_at', winEnd.toISOString())
    .not('review_call_status', 'is', null)
    .order('review_call_at', { ascending: false }).limit(2000);
  let { data, error } = await run(', review_call_tags');
  if (error && /review_call_tags/.test(error.message || '')) ({ data, error } = await run(''));
  if (error) return res.status(500).json({ error: error.message });

  const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: RC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const isReached = (s) => s !== 'voicemail' && s !== 'callback';
  const isGood = (s) => s === 'promised_review' || s === 'declined' || s === 'reviewed' || s === 'called';
  const summary = { logged: 0, reached: 0, good: 0, complaints: 0, promised: 0, voicemail: 0, declined: 0, dnc: 0 };
  const byPerson = new Map(), byDay = new Map(), tagCount = new Map();
  const calls = [];
  for (const row of (data || [])) {
    const s = row.review_call_status;
    const who = row.review_call_by || 'Unknown';
    summary.logged++;
    if (isReached(s)) summary.reached++;
    if (isGood(s)) summary.good++;
    if (s === 'complaint') summary.complaints++;
    if (s === 'promised_review') summary.promised++;
    if (s === 'voicemail' || s === 'callback') summary.voicemail++;
    if (s === 'declined') summary.declined++;
    if (s === 'do_not_contact') summary.dnc++;
    const p = byPerson.get(who) || { name: who, logged: 0, reached: 0, good: 0, complaints: 0, last_at: null };
    p.logged++; if (isReached(s)) p.reached++; if (isGood(s)) p.good++; if (s === 'complaint') p.complaints++;
    if (!p.last_at || row.review_call_at > p.last_at) p.last_at = row.review_call_at;
    byPerson.set(who, p);
    const dk = dayKey(row.review_call_at);
    const d = byDay.get(dk) || { day: dk, logged: 0, reached: 0, complaints: 0 };
    d.logged++; if (isReached(s)) d.reached++; if (s === 'complaint') d.complaints++;
    byDay.set(dk, d);
    for (const t of (Array.isArray(row.review_call_tags) ? row.review_call_tags : [])) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    const b = bizById.get(row.business_id) || {};
    calls.push({
      id: row.id, business_slug: b.slug || null, business_name: b.name || null,
      customer_name: row.customer?.name || '—', phone: row.customer?.phone || null,
      technician_name: row.technician?.name || '—', service_name: row.service?.name || 'Service',
      job_at: row.scheduled_at, status: s, at: row.review_call_at, by: who,
      notes: row.review_call_notes || null, tags: Array.isArray(row.review_call_tags) ? row.review_call_tags : [],
      rating: row.review_rating || null, reviewed: row.reviewed_at != null || Number(row.review_rating) >= 4,
    });
  }
  // Every day in the window, zero-filled, oldest first, so a day Joey made no
  // calls shows as an empty bar instead of silently vanishing.
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const dk = dayKey(localDayStartUTC(RC_TZ, -i).getTime() + 12 * 3600000);
    const d = byDay.get(dk) || { day: dk, logged: 0, reached: 0, complaints: 0 };
    d.label = new Intl.DateTimeFormat('en-US', { timeZone: RC_TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(dk + 'T12:00:00Z'));
    daily.push(d);
  }

  // Backlog: finished jobs from the last 7 days with no outcome logged at all.
  // Same filter as the queue so the number matches what Joey sees.
  let backlog = 0;
  for (const b of (bizs || [])) {
    const tz = b.timezone || RC_TZ;
    const { data: q } = await db.from('bookings').select('id, review_call_status, reviewed_at, review_rating')
      .eq('business_id', b.id)
      .in('status', ['confirmed', 'assigned', 'on_the_way', 'arrived', 'in_progress', 'completed'])
      .gte('scheduled_at', localDayStartUTC(tz, -7).toISOString()).lt('scheduled_at', localDayStartUTC(tz, 0).toISOString())
      .limit(1000);
    for (const r of (q || [])) {
      if (r.reviewed_at != null || Number(r.review_rating) >= 4) continue;
      if (r.review_call_status) continue;
      backlog++;
    }
  }
  return res.status(200).json({
    days, summary, backlog, calls,
    by_person: [...byPerson.values()].sort((a, c) => c.logged - a.logged),
    daily,
    tags: [...tagCount.entries()].map(([tag, count]) => ({ tag, count })).sort((a, c) => c.count - a.count),
  });
}

// What Joey has actually logged TODAY, across both businesses — real history,
// not a browser-session counter. The old hero stats reset to zero on every
// page load, so a morning's worth of real calls looked like "nothing was
// recorded" the moment the tab was refreshed. 'Reached' excludes voicemail
// (nobody picked up); 'good' is promised_review or declined, since 'declined'
// only exists as the "no thanks" button on an already-great call, never a
// bad one. Best-effort: an error here degrades to zeros, never fails the page.
async function rcTodayStats(db, bizIds) {
  const stats = { today: 0, reached: 0, good: 0, issues: 0 };
  if (!bizIds.length) return stats;
  try {
    const todayStart = localDayStartUTC(RC_TZ, 0);
    const todayEnd = localDayStartUTC(RC_TZ, 1);
    const { data, error } = await db.from('bookings')
      .select('review_call_status')
      .in('business_id', bizIds)
      .gte('review_call_at', todayStart.toISOString())
      .lt('review_call_at', todayEnd.toISOString())
      .not('review_call_status', 'is', null)
      .limit(2000);
    if (error) return stats;
    for (const row of (data || [])) {
      stats.today++;
      if (row.review_call_status !== 'voicemail') {
        stats.reached++;
        if (row.review_call_status === 'promised_review' || row.review_call_status === 'declined') stats.good++;
      }
      if (row.review_call_status === 'complaint') stats.issues++;
    }
  } catch (e) { console.warn('[review_calls] today_stats failed:', e.message); }
  return stats;
}

// Attach any voicemail THE CUSTOMER left us to their review-call card, so
// whoever is about to ring them can read what they said first. Someone chasing
// a review should not be the last to know the customer already called asking
// about a problem. One batched query for the whole page, keyed on the phone
// number (the review-call rows and the call log share no id).
async function attachInboundVoicemails(db, rows) {
  try {
    const byPhone = new Map();
    for (const r of rows) {
      const d = digitsOf(r.phone || r.customer_phone || '');
      if (d.length === 10) {
        if (!byPhone.has(d)) byPhone.set(d, []);
        byPhone.get(d).push(r);
      }
    }
    if (!byPhone.size) return;
    const { data } = await db.from('calls')
      .select('caller_phone, transcript, occurred_at, market, status')
      .in('caller_phone', [...byPhone.keys()])
      .order('occurred_at', { ascending: false });
    for (const c of (data || [])) {
      for (const r of (byPhone.get(c.caller_phone) || [])) {
        // Newest voicemail only — the list is already sorted, so the first one
        // seen for a number wins.
        if (!r.inbound_voicemail) {
          r.inbound_voicemail = {
            transcript: c.transcript, occurred_at: c.occurred_at, market: c.market, status: c.status,
          };
        }
      }
    }
  } catch (e) {
    // The calls table may not exist on an older deploy — the review-call queue
    // must keep working regardless.
    console.warn('[review_calls] voicemail attach skipped:', e.message);
  }
}

// Log the outcome of a review call (Joey). Cross-business: resolve by id.
async function reviewCallLog(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.scope === 'handy-andy') return res.status(403).json({ error: 'Review Calls is not available on this account.' });
  const id = body && body.id;
  const status = ((body && body.status) || '').toString().trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  if (status && !REVIEW_CALL_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  // Enough of the job to describe it in the owner's complaint alert below. The
  // read is the same round trip that already had to happen to prove the booking
  // exists, so this costs nothing on the calls that are not complaints.
  const { data: bk } = await db.from('bookings')
    .select(`id, scheduled_at,
      business:businesses ( slug, name ),
      customer:customers ( name, phone, email ),
      technician:technicians!technician_id ( name ),
      service:services ( name )`)
    .eq('id', id).maybeSingle();
  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  const patch = {
    review_call_status: status || null,
    review_call_at: status ? new Date().toISOString() : null,
    review_call_by: status ? displayNameFor(auth.scope) : null,
  };
  if (typeof body.notes === 'string') patch.review_call_notes = body.notes.trim().slice(0, 500) || null;
  // What the customer actually said, as countable tags. Free text cannot be
  // rolled up into "how did we do"; these can (unnest over review_call_tags).
  // Bounded and de-duplicated so a stuck client can never write an unbounded array.
  if (Array.isArray(body.tags)) {
    const tags = [...new Set(body.tags
      .map(t => String(t == null ? '' : t).trim().slice(0, 60))
      .filter(Boolean))].slice(0, 12);
    patch.review_call_tags = tags.length ? tags : null;
  }

  let { error } = await db.from('bookings').update(patch).eq('id', id);
  // The tags column is newer than the rest of the review-call columns, so a
  // database that has 0049 but not the tags migration must still be able to log
  // an outcome — the tags are dropped and the call is saved, rather than the
  // whole outcome failing because of the one newest field.
  if (error && /review_call_tags/.test(error.message || '')) {
    delete patch.review_call_tags;
    ({ error } = await db.from('bookings').update(patch).eq('id', id));
    if (!error) return res.status(200).json({ ok: true, tags_skipped: true });
  }
  if (error && /review_call_/.test(error.message || '')) {
    return res.status(503).json({ error: 'The review-call queue needs a quick database update (migration 0049) before outcomes can be saved.' });
  }
  if (error) throw error;

  // A complaint is the one outcome the owner has to hear about the same day.
  // Awaited, not fire-and-forget: on Vercel an un-awaited send is killed the
  // moment this handler responds, and it would fail silently with no log line.
  // Never allowed to fail the save — the complaint is already recorded.
  if (status === 'complaint') {
    const when = (() => {
      try { return new Date(bk.scheduled_at).toLocaleDateString('en-US', { timeZone: RC_TZ, weekday: 'long', month: 'short', day: 'numeric' }); }
      catch { return ''; }
    })();
    await sendReviewCallComplaintAlert({
      slug: bk.business?.slug,
      businessName: bk.business?.name,
      customerName: bk.customer?.name,
      phone: bk.customer?.phone,
      email: bk.customer?.email,
      serviceName: bk.service?.name,
      techName: bk.technician?.name,
      whenStr: when,
      note: patch.review_call_notes,
      tags: patch.review_call_tags || [],
      loggedBy: patch.review_call_by,
      bookingId: id,
    }).catch(e => console.warn('[review_call_log] complaint alert failed:', e.message));
  }
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
    .order('reviewed_at', { ascending: false, nullsFirst: false })
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
  // Kept from the assignment branch so a NEWLY attributed tech can be texted
  // after the update lands (owner's rule: a tech hears about every review of
  // theirs, however it reaches them). `newTech` carries name+phone; `priorTid`
  // is who held the review before, so re-saving the same tech, or a plain
  // seen/dismiss tap, never re-texts anyone.
  let newTech = null, priorTid;
  if (body.technician_id !== undefined) {
    const tid = (body.technician_id || '').toString() || null;
    if (tid) {
      let { data: t } = await db.from('technicians').select('id, name, phone').eq('id', tid).eq('business_id', biz.id).maybeSingle();
      // A review can legitimately credit a cross-hire tech from the partner
      // company (e.g. a Dom's tech who helped on a Handy Andy job) — the
      // dropdown already offers them (public/admin.html renderReviews), so
      // the same id must be accepted here instead of 404ing.
      if (!t) {
        const partner = await partnerBusiness(db, biz.slug);
        if (partner) {
          ({ data: t } = await db.from('technicians').select('id, name, phone').eq('id', tid).eq('business_id', partner.id).maybeSingle());
        }
      }
      if (!t) return res.status(404).json({ error: 'Technician not found' });
      newTech = t;
      const { data: prior } = await db.from('google_reviews')
        .select('technician_id').eq('id', id).eq('business_id', biz.id).maybeSingle();
      priorTid = prior?.technician_id || null;
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

  // Text a NEWLY attributed tech about the review they just got credited with.
  // The auto-match at ingest (migrate.js googleReviewSync) only texts when the
  // reviewer's name matched a booking; a review that arrived unmatched and was
  // hand-assigned here later would otherwise reach the tech's profile without
  // the tech ever hearing about it. Same message rule as everywhere else:
  // every rating texts, only a 5 congratulates. Best-effort, after the update
  // has already succeeded, so a Twilio hiccup can never fail the attribution.
  if (newTech && newTech.phone && newTech.id !== priorTid) {
    try {
      const { data: rev } = await db.from('google_reviews')
        .select('rating, reviewer_name').eq('id', id).eq('business_id', biz.id).maybeSingle();
      if (rev && rev.rating) {
        const from = rev.reviewer_name ? ` from ${rev.reviewer_name}` : '';
        const msg = rev.rating === 5
          ? `${newTech.name || 'Hey'}, you just got a 5-star Google review${from}! Nice work.`
          : `${newTech.name || 'Hey'}, a ${rev.rating}-star Google review came in${from}. Check your profile to view it.`;
        await sendSMS(newTech.phone, msg).catch(e => console.warn('[google_review_update] tech SMS failed:', e.message));
      }
    } catch (e) { console.warn('[google_review_update] tech SMS non-fatal:', e.message); }
  }
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
  const badReviewAllowed = allowedSlugsFor(auth);
  if (badReviewAllowed) bizQ = bizQ.in('slug', badReviewAllowed);
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
// Avg ticket per business over a fixed preset window: 7 days (matches the
// dashboard's own default avg_by_slug computation, so that preset never needs
// a fetch — see avgTicketBoxHtml on the client), 30 days, or all time (no
// lower bound at all, every completed ticket the business has ever had).
// Same underlying math as the dashboard's avg_by_slug either way. Owner-only.
async function avgTicketRange(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const tz = biz.timezone || 'America/Denver';
  const range = (req.query.range || '7d').toString();
  const RANGE_DAYS = { '7d': 7, '30d': 30 };
  const days = RANGE_DAYS[range] || null;   // null = all time, no lower bound
  const end = localDayStartUTC(tz, 1);
  const start = days ? localDayStartUTC(tz, -(days - 1)) : null;
  const { data: allBiz } = await db.from('businesses').select('id, slug').eq('active', true);
  const bySlug = {};
  await Promise.all((allBiz || []).map(async (bb) => {
    let q = db.from('bookings').select('price')
      .eq('business_id', bb.id)
      .lt('scheduled_at', end.toISOString())
      .eq('status', 'completed');
    if (start) q = q.gte('scheduled_at', start.toISOString());
    const { data: rows } = await q;
    const real = (rows || []).filter(x => Number(x.price) > 0);   // drop $0/free tickets
    const count = real.length;
    const total = Math.round(real.reduce((n, x) => n + Number(x.price || 0), 0) * 100) / 100;
    bySlug[bb.slug] = { avg: count ? Math.round(total / count) : null, count, total };
  }));
  const rangeLabel = range === '30d' ? '30 days' : range === 'all' ? 'all time' : '7 days';
  return res.status(200).json({ avg_by_slug: bySlug, range_label: rangeLabel, range });
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

// ── DFW location-page monitoring ────────────────────────────────────────────
// The 6 new Dallas/Arlington/Fort Worth landing pages the owner wants watched
// closely. Reads directly from public.web_events (the same table the external
// website-analytics backend itself reads — see WEB_ANA_ORIGIN in admin.html)
// rather than adding a 7th endpoint over there, since these pages need per-path
// filtering the existing site-wide endpoints don't offer.
const DFW_LOCATION_PAGES = [
  '/frametvmounting-dallas', '/frametvmounting-arlington', '/frametvmounting-fortworth',
  '/tvmounting-dallas', '/tvmounting-arlington', '/tvmounting-fortworth',
];
// A visit to a DFW page from outside US timezones is unusual enough to flag —
// not proof of a bot, but worth a second look. Kept intentionally short (just
// the zones real US visitors would plausibly show) rather than an exhaustive
// exclude-list, so anything odd defaults to "flagged", not "trusted".
const US_TIMEZONES = new Set(['America/Chicago', 'America/New_York', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu']);

function dfwPagePath(url) {
  try { return new URL(url).pathname.replace(/\/$/, '') || '/'; } catch { return (url || '').split('?')[0]; }
}

async function dfwPagesAnalytics(req, res, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const db = serviceClientPublic();
  // Pulled unfiltered-by-path and filtered in JS below (small volume — these
  // pages are brand new) so session-level math (dwell time, bounce, referrer
  // chains) can be computed once from one dataset instead of N round trips.
  const { data, error } = await db.from('web_events')
    .select('event_type, page_url, session_id, referrer, metadata, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(8000);
  if (error) throw error;

  const rows = (data || [])
    .map(r => ({ ...r, path: dfwPagePath(r.page_url) }))
    .filter(r => DFW_LOCATION_PAGES.includes(r.path));

  // Per-page rollup.
  const perPage = {};
  for (const p of DFW_LOCATION_PAGES) perPage[p] = { path: p, views: 0, sessions: new Set(), clicks: 0, dwellBySession: {}, scrollBySession: {}, devices: {}, referrers: {} };
  for (const r of rows) {
    const bucket = perPage[r.path];
    if (r.event_type === 'page_view') {
      bucket.views++;
      bucket.sessions.add(r.session_id);
      const ref = (r.referrer || '').trim();
      const refKey = !ref ? '(direct)' : (dfwPagePath(ref).startsWith('/') && ref.includes('ihandyandy.com')) ? `internal: ${dfwPagePath(ref)}` : (() => { try { return new URL(ref).hostname.replace(/^www\./, ''); } catch { return ref.slice(0, 60); } })();
      bucket.referrers[refKey] = (bucket.referrers[refKey] || 0) + 1;
      const dev = (r.metadata && r.metadata.device) || 'unknown';
      bucket.devices[dev] = (bucket.devices[dev] || 0) + 1;
    } else if (r.event_type === 'click') {
      bucket.clicks++;
    } else if (r.event_type === 'time_on_page') {
      // Fires repeatedly (30s ticks) per session — keep the MAX per session as
      // that session's real dwell time on this page, not the sum of every tick.
      // Capped at 10 minutes: an idle tab left open in the background keeps
      // ticking indefinitely with zero real engagement (confirmed against real
      // data — one session pinged for 5.5 hours straight, which would otherwise
      // blow the page's average dwell time out to something meaningless).
      const MAX_DWELL_SECS = 600;
      const secs = Math.min(MAX_DWELL_SECS, Number(r.metadata && r.metadata.seconds) || 0);
      bucket.dwellBySession[r.session_id] = Math.max(bucket.dwellBySession[r.session_id] || 0, secs);
    } else if (r.event_type === 'page_exit') {
      const depth = Number(r.metadata && r.metadata.max_scroll_depth) || 0;
      bucket.scrollBySession[r.session_id] = Math.max(bucket.scrollBySession[r.session_id] || 0, depth);
    }
  }
  const avg = (obj) => { const v = Object.values(obj); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0; };
  const topEntries = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ label: k, count: v }));
  const pages = DFW_LOCATION_PAGES.map(p => {
    const b = perPage[p];
    return {
      path: p,
      views: b.views,
      sessions: b.sessions.size,
      clicks: b.clicks,
      avg_dwell_seconds: avg(b.dwellBySession),
      avg_scroll_depth: avg(b.scrollBySession),
      devices: topEntries(b.devices, 5),
      referrers: topEntries(b.referrers, 5),
    };
  });

  // Per-session summary across ALL 6 pages, for the "who's actually visiting"
  // feed and the non-US-timezone flag — grouped independently of the per-page
  // rollup above since one session can touch multiple pages.
  const bySession = {};
  for (const r of rows) {
    if (!bySession[r.session_id]) {
      bySession[r.session_id] = {
        session_id: r.session_id, pages: new Set(), events: 0,
        first_seen: r.created_at, last_seen: r.created_at,
        timezone: (r.metadata && r.metadata.timezone) || null,
        device: (r.metadata && r.metadata.device) || null,
        browser: (r.metadata && r.metadata.browser) || null,
        entry_referrer: null,
      };
    }
    const s = bySession[r.session_id];
    s.events++;
    if (r.event_type === 'page_view') s.pages.add(r.path);
    if (r.created_at < s.first_seen) { s.first_seen = r.created_at; s.entry_referrer = r.referrer || null; }
    if (r.created_at > s.last_seen) s.last_seen = r.created_at;
  }
  const sessions = Object.values(bySession)
    .map(s => ({
      session_id: s.session_id,
      pages_visited: s.pages.size,
      pages: [...s.pages],
      events: s.events,
      first_seen: s.first_seen,
      last_seen: s.last_seen,
      timezone: s.timezone,
      device: s.device,
      browser: s.browser,
      entry_referrer: s.entry_referrer,
      flagged: !s.timezone || !US_TIMEZONES.has(s.timezone),
    }))
    .sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))
    .slice(0, 100);

  const totalSessions = sessions.length;
  const flaggedSessions = sessions.filter(s => s.flagged).length;

  return res.status(200).json({ days, pages, sessions, totalSessions, flaggedSessions, generatedAt: new Date().toISOString() });
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

  // customer_address/city/state: shown on the card and carried into convert-to-job.
  // source: distinguishes a website contact-form lead from a real estimate request.
  let cols = 'id, service_label, customer_name, customer_phone, customer_email, customer_zip, customer_address, customer_city, customer_state, description, photo_url, preferred_slots, status, sms_consent, notes, source, line_items, tax_rate, upsells, accepted_upsells, approved_total, approved_at, created_at, contacted_at, contacted_by, broker_company_name, broker_sub_price, broker_sell_price, broker_booked_at, broker_spread';
  const runQuery = () => {
    let q = db.from('estimates').select(cols)
      .eq('business_id', biz.id)
      .order('created_at', { ascending: false })
      .limit(200);
    // 'website' is a SOURCE filter, not a status: the Website messages tab shows
    // every contact-form lead regardless of how far the office has worked it.
    if (status === 'website') return q.eq('source', 'website_form').neq('status', 'archived');
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

  // Flag which rows get the "Get this estimate filled" button. Keyed off
  // service_areas.unstaffed (DFW / Los Angeles / Phoenix / San Antonio today),
  // never a city list, so staffing a market removes the button by itself.
  // Best-effort: a lookup failure must not take down the Estimates screen.
  try {
    const isUnstaffed = await unstaffedZipMatcher(db, biz.id, biz.slug);
    for (const e of (data || [])) e.broker_eligible = isUnstaffed(e.customer_zip);
  } catch (e) { console.warn("[admin] estimates: unstaffed check failed:", e.message); }

  return res.status(200).json({ estimates: data || [] });
}

async function estimateUpdate(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  // Confirm the estimate belongs to this business before touching it.
  const { data: existing } = await db.from('estimates')
    .select('id, photo_path, customer_email, approved_at').eq('id', body.id).eq('business_id', biz.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Estimate not found' });

  if (body.op === 'delete') {
    await db.from('estimates').delete().eq('id', body.id).eq('business_id', biz.id);
    if (existing.photo_path) deleteImage(existing.photo_path).catch(() => {});
    return res.status(200).json({ ok: true, deleted: true });
  }

  const patch = {};
  if (body.status) {
    const VALID = ['new', 'contacted', 'scheduled', 'closed', 'archived', 'declined'];
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
    // Same real-world event as estimate_approve's own approved_at stamp (a
    // phone approval converted via "Convert to job" or a secretary manually
    // picking "Estimate approved" from the dropdown) -- don't overwrite an
    // approval that already happened through the customer's own approve link.
    if (body.status === 'scheduled' && !existing.approved_at) {
      patch.approved_at = new Date().toISOString();
    }
  }
  if (typeof body.notes === 'string') patch.notes = body.notes.trim() || null;
  if (typeof body.service_label === 'string') patch.service_label = body.service_label.trim() || null;
  if (typeof body.description === 'string') patch.description = body.description.trim();
  // The address the quote gets emailed to. Editable because the office often
  // has to create the estimate BEFORE the full scope is known (Joey typed a
  // placeholder so she could add a TV dismount, then had no way to correct it
  // before sending). estimate_send_email re-reads this column at send time, so
  // fixing it here is genuinely enough -- there is no cached copy to miss.
  // Validated rather than trusted: a malformed address fails silently at the
  // provider, and the office would think the quote went out when it never did.
  if (typeof body.customer_email === 'string') {
    const em = body.customer_email.trim();
    // The modal posts this field on EVERY save, prefilled from the row, so an
    // unchanged value must never be able to fail. Nothing has ever validated
    // this column on the way in (the public widget, estimateCreate and the
    // legacy importer all store it raw), so addresses like "mikeb@gmail" with
    // no TLD are already sitting in the table. Validating those on save would
    // 400 the whole request -- losing the line items and price the office just
    // typed -- over a field they never touched. Only a CHANGED value is
    // checked; leaving a bad one alone is not an error.
    if (em !== ((existing.customer_email || '').trim())) {
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        return res.status(400).json({ error: 'That does not look like a valid email address.' });
      }
      patch.customer_email = em || null;
    }
  }
  if (Array.isArray(body.line_items)) patch.line_items = sanitizeLineItems(body.line_items);
  if (Array.isArray(body.upsells)) patch.upsells = sanitizeUpsells(body.upsells);
  if (body.tax_rate !== undefined) patch.tax_rate = normalizeTaxRate(body.tax_rate);
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  // Same sanity ceiling as booking_create/line_items_save — an estimate a
  // customer approves converts straight into a real booking (see
  // estimate_approve), so an absurd quoted line here has the same real-world
  // consequence as an absurd booking price.
  if (patch.line_items && body.confirm_high_price !== true) {
    const issue = priceSanityIssue({ lines: patch.line_items });
    if (issue) return res.status(409).json({ error: issue, code: 'high_price_confirm_required' });
  }

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
// bloat a row. qty is coerced non-negative; unit_price may be NEGATIVE (discount/
// coupon lines like "Multi-TV discount" are legitimate here — this list only
// ever comes from an authenticated office user's own nb selections, never raw
// public input) but is clamped to a sane floor so a typo can't wipe out a quote.
function sanitizeLineItems(items) {
  return (Array.isArray(items) ? items : [])
    .slice(0, 50)
    .map(it => {
      const description = String((it && it.description) || '').trim().slice(0, 300);
      let qty = Number(it && it.qty);
      let unit_price = Number(it && it.unit_price);
      if (!Number.isFinite(qty) || qty < 0) qty = 0;
      if (!Number.isFinite(unit_price)) unit_price = 0;
      if (unit_price < -5000) unit_price = -5000;
      // round qty to 2 decimals (allows "1.5 hrs"), price to cents
      qty = Math.round(qty * 100) / 100;
      unit_price = Math.round(unit_price * 100) / 100;
      return { description, qty, unit_price };
    })
    .filter(it => it.description || it.unit_price !== 0);
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
  // One way to reach them is all that's required. A customer who has already
  // said no to booking often will not hand over a name and both contact
  // details just to hear a number, and refusing to send anything without all
  // three loses the estimate entirely. Whichever channel they gave is the one
  // it goes out on.
  const estEmail = (customer_email || '').trim();
  const estPhone = (customer_phone || '').trim();
  const estName  = (customer_name || '').trim();
  if (!estEmail && !estPhone) {
    return res.status(400).json({ error: 'A phone number or an email address is required to send an estimate' });
  }
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
  // Same sanity ceiling as booking_create — an estimate the customer approves
  // converts straight into a real booking (estimate_approve).
  if (body.confirm_high_price !== true) {
    const issue = priceSanityIssue({ lines: line_items });
    if (issue) return res.status(409).json({ error: issue, code: 'high_price_confirm_required' });
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
    // No name given: label the row by whichever contact detail they did give,
    // so the estimates list still has something recognisable to show.
    customer_name: estName || estPhone || estEmail,
    customer_phone: estPhone || null,
    customer_email: estEmail || null,
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

  // Email is no longer mandatory, so its unavailability can't short-circuit the
  // whole send — a phone-only customer still gets their estimate by text below.
  const emailOff = !emailNotificationsOn() ? 'Email notifications are turned off'
    : !emailConfig(biz.slug).apiKey ? 'Email service not configured'
    : null;

  // Only greet by name when a real one was given — with no name the stored
  // customer_name is their phone number, and "Hi 5125550134," is worse than
  // no greeting at all.
  const firstName = estName ? estName.split(/\s+/)[0] : '';
  // 90-day signed approve link (same as the Estimates-tab "send" flow), so the
  // New Booking estimate email also gets an "I approve this estimate" button.
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const approveToken = signToken({ kind: 'estimate_approve', estimate_id: est.id }, 7776000);
  const approveUrl = baseUrl ? `${baseUrl}/estimate-approve.html?token=${encodeURIComponent(approveToken)}` : '';
  let emailed = false, emailWarning = emailOff;
  if (estEmail && !emailOff) {
    const { subject, html } = estimateEmail(
      { firstName, serviceLabel: service_label || 'Custom Estimate', description, lineItems: line_items, taxRate: DEFAULT_EST_TAX_RATE, approveUrl, upsells: publicUpsells(upsells) },
      brandFor(biz.slug)
    );
    try {
      await sendEmail({ slug: biz.slug, to: estEmail, subject, html, throwOnError: true });
      emailed = true;
      await markEstimateContacted(db, biz.id, est.id, auth.name || adminAuthorName(auth));
    } catch (e) {
      console.warn('[estimate_create] email send failed, but estimate created:', e.message);
      emailWarning = `email failed: ${e.message}`;
    }
  }

  // Text the customer the estimate + a link to view/approve it. For a customer
  // who only gave a phone number this IS the delivery, not a bonus copy.
  let texted = false;
  if (estPhone && body.sms_consent !== false && approveUrl) {
    try {
      const { total } = quoteTotals(line_items, DEFAULT_EST_TAX_RATE);
      const greeting = firstName ? `Hi ${firstName}, ` : '';
      const svcTxt = (service_label && service_label !== 'Custom Estimate') ? `${service_label}: ` : '';
      const totalTxt = line_items.length ? `Estimated total $${total.toFixed(2)} (incl. tax). ` : '';
      const msg = `${greeting}here's your estimate. ${svcTxt}${totalTxt}View & approve it here: ${approveUrl}\n\nReply or call with any questions. Reply STOP to opt out.`;
      const r = await sendSMSResult(estPhone, msg);
      texted = !!r.ok;
      if (texted && !emailed) await markEstimateContacted(db, biz.id, est.id, auth.name || adminAuthorName(auth));
      if (!r.ok) console.warn(`[estimate_create] estimate SMS not sent:`, r.skipped || r.error);
    } catch (e) {
      console.warn('[estimate_create] estimate SMS threw:', e.message);
    }
  }

  // The estimate exists either way, but the office needs to know when nothing
  // actually left the building — otherwise "Estimate sent ✓" is a lie and the
  // customer is waiting on something that never arrived.
  let warning = null;
  if (!emailed && !texted) {
    warning = estEmail
      ? `Estimate saved but nothing could be sent (${emailWarning || 'no delivery channel available'}) — reach out manually.`
      : 'Estimate saved but the text could not be sent — reach out manually.';
  } else if (estEmail && !emailed && emailWarning) {
    warning = `Sent by text. Email did not go out (${emailWarning}).`;
  }
  return res.status(201).json({ id: est.id, ok: true, texted, emailed, warning });
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

// Decline an estimate as outside what the business does (a request for work
// that isn't TV mounting or handyman repairs) — tells the customer directly
// rather than letting the request silently age out, and points them at a
// public "what we do" page instead of the priced-quote approve flow. Sends
// both channels the estimate has (best-effort — a failed SMS must not block
// the email, and vice versa), then marks the estimate declined either way so
// it stops showing as "Needs Response".
// ---------------------------------------------------------------------------
// Subcontractor brokering (migrations 0092 + 0093). Only for estimates whose
// zip lands in an UNSTAFFED service area (DFW / Los Angeles / Phoenix / San
// Antonio as of Aug 2026). The gate is service_areas.unstaffed via the shared
// resolver -- NOT a city list -- so staffing a market turns this off by itself.
//
// A TV mount is priced off three things: the size tier, the bracket, and the
// wire concealment. Those three are picked ONCE per estimate (so all three
// companies quote the same scope), and each company's price for them lives on
// that company's rate card, keyed by the same (section_key, row_key) the
// booking widget uses. Fill a company's card once and every later estimate
// prices itself.
// ---------------------------------------------------------------------------

// The option catalog the booking widget already uses. city_key 'default' is the
// canonical option list; per-city rows only differ in OUR price, which is not
// what a subcontractor charges.
async function brokerCatalog(db, businessId) {
  const { data, error } = await db.from('widget_prices')
    .select('section_key, row_key, label, price, sort_order')
    .eq('business_id', businessId).eq('city_key', 'default')
    .in('section_key', ['size', 'bracket', 'wires'])
    .order('sort_order');
  if (error) throw error;
  const out = {};
  for (const s of BROKER_SECTIONS) out[s.key] = [];
  for (const r of (data || [])) {
    if (out[r.section_key]) out[r.section_key].push({ row_key: r.row_key, label: r.label, our_price: Number(r.price) || 0 });
  }
  return out;
}

// Shared by every broker action: load the estimate, resolve its zip, and refuse
// to broker anything in a staffed market. Returns { est, area }.
async function brokerContext(db, biz, estimateId) {
  const est = await fetchEstimate(db, estimateId, biz.id,
    'id, customer_zip, customer_name, service_label, broker_sub_price, broker_sell_price, broker_company_name, broker_spec');
  if (!est) return { error: { code: 404, msg: 'Estimate not found' } };
  const area = await resolveServiceArea(db, biz.id, biz.slug, est.customer_zip);
  if (!area || !area.unstaffed) {
    return { error: { code: 400, msg: 'This estimate is in a staffed market, so it is not brokered out.' } };
  }
  return { est, area };
}

// Panel load: the job's three options, the three bid slots with each company's
// rates for exactly those options, and the directory for the dropdown.
async function estimateBroker(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const ctx = await brokerContext(db, biz, body.id);
  if (ctx.error) return res.status(ctx.error.code).json({ error: ctx.error.msg });

  const catalog = await brokerCatalog(db, biz.id);
  const spec = brokerResolveSpec(ctx.est, catalog);

  const { data: bids, error: bErr } = await db.from('estimate_broker_bids')
    .select('slot, subcontractor_id, company_name, phone, sub_price, breakdown')
    .eq('estimate_id', body.id).eq('business_id', biz.id).order('slot');
  if (bErr) throw bErr;

  const { data: directory, error: dErr } = await db.from('subcontractors')
    .select('id, company_name, phone').eq('business_id', biz.id).eq('active', true).order('company_name');
  if (dErr) throw dErr;

  // Every rate any of these companies has for the three options this job needs.
  const subIds = (bids || []).map(b => b.subcontractor_id).filter(Boolean);
  let rates = [];
  if (subIds.length) {
    const { data: r, error: rErr } = await db.from('subcontractor_rates')
      .select('subcontractor_id, section_key, row_key, price')
      .eq('business_id', biz.id).in('subcontractor_id', subIds);
    if (rErr) throw rErr;
    rates = r || [];
  }
  const rateFor = (subId, section) => {
    const wanted = spec[section];
    if (!subId || !wanted) return null;
    const hit = rates.find(x => x.subcontractor_id === subId && x.section_key === section && x.row_key === wanted);
    return hit ? Number(hit.price) : null;
  };

  // A custom line's price is job-specific, so it lives on the BID's breakdown
  // rather than on the company's reusable rate card.
  const customPriceFor = (bid, id) => {
    const rows = Array.isArray(bid && bid.breakdown) ? bid.breakdown : [];
    const hit = rows.find(r => r && r.section_key === 'custom' && r.row_key === id);
    return hit && hit.price !== null && hit.price !== undefined ? Number(hit.price) : null;
  };

  const required = brokerRequiredLines(spec);
  const bySlot = new Map((bids || []).map(b => [b.slot, b]));
  const slots = [1, 2, 3].map(n => {
    const b = bySlot.get(n) || { slot: n, subcontractor_id: null, company_name: '', phone: '', sub_price: null, breakdown: null };
    const lines = required.map(l => ({
      section_key: l.key, label: l.label, custom: l.custom,
      price: l.custom ? customPriceFor(b, l.key) : rateFor(b.subcontractor_id, l.key),
    }));
    // Their total is the sum of EVERY required line, and only counts once all
    // of them are filled in -- a partial card must not read as a cheap bid.
    const complete = lines.length > 0 && lines.every(l => l.price !== null);
    const total = complete ? Math.round(lines.reduce((t, l) => t + l.price, 0) * 100) / 100 : null;
    return { slot: n, subcontractor_id: b.subcontractor_id, company_name: b.company_name, phone: b.phone,
             lines, sub_price: total, min_sell: minSellPrice(total) };
  });

  return res.status(200).json({
    ok: true,
    area: { name: ctx.area.name, unstaffed: true },
    catalog, spec, sections: BROKER_SECTIONS.map(s => ({ key: s.key, label: s.label })),
    custom: customLinesOf(spec),
    slots, directory: directory || [],
    booked: ctx.est.broker_company_name ? {
      company_name: ctx.est.broker_company_name,
      sub_price: ctx.est.broker_sub_price,
      sell_price: ctx.est.broker_sell_price,
    } : null,
  });
}

// The office correcting which size/bracket/wires this job actually is. Shared
// by all three bids, so everyone quotes the same scope.
async function estimateBrokerSaveSpec(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const ctx = await brokerContext(db, biz, body.id);
  if (ctx.error) return res.status(ctx.error.code).json({ error: ctx.error.msg });

  const catalog = await brokerCatalog(db, biz.id);
  const spec = {};
  for (const s of BROKER_SECTIONS) {
    const v = body.spec && body.spec[s.key];
    if (!v) { spec[s.key] = null; continue; }
    if (!(catalog[s.key] || []).some(o => o.row_key === v)) {
      return res.status(400).json({ error: `"${v}" is not a valid ${s.label} option.` });
    }
    spec[s.key] = v;
  }
  // Free-text scope lines. Blank labels are dropped, which is how the UI
  // deletes one; ids are preserved so typed prices stay with their line.
  spec.custom = normalizeCustomLines(body.spec && body.spec.custom);

  const { error } = await db.from('estimates').update({ broker_spec: spec }).eq('id', body.id).eq('business_id', biz.id);
  if (error) throw error;
  return res.status(200).json({ ok: true, spec });
}

// Save one bid slot. The three prices are written to the COMPANY'S rate card
// (keyed by this job's row_keys), so the next estimate needing the same options
// fills itself in. Blank everything clears the slot.
async function estimateBrokerSaveBid(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const slot = Number(body.slot);
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'slot must be 1, 2 or 3' });

  const ctx = await brokerContext(db, biz, body.id);
  if (ctx.error) return res.status(ctx.error.code).json({ error: ctx.error.msg });

  const catalog = await brokerCatalog(db, biz.id);
  const spec = brokerResolveSpec(ctx.est, catalog);

  const company = String(body.company_name || '').trim().slice(0, 200);
  const phone   = String(body.phone || '').trim().slice(0, 40);
  const prices  = (body.prices && typeof body.prices === 'object') ? body.prices : {};
  const required = brokerRequiredLines(spec);
  const anyPrice = required.some(l => parseMoney(prices[l.key]) !== null);

  if (!company && !phone && !anyPrice) {
    const { error } = await db.from('estimate_broker_bids').delete()
      .eq('estimate_id', body.id).eq('business_id', biz.id).eq('slot', slot);
    if (error) throw error;
    return res.status(200).json({ ok: true, cleared: true, slot });
  }
  if (!company) return res.status(400).json({ error: 'Enter the company name for this slot.' });

  // Directory upsert, matched case-insensitively against the unique index.
  let subId = body.subcontractor_id || null;
  if (!subId) {
    const { data: existing } = await db.from('subcontractors')
      .select('id, phone').eq('business_id', biz.id).ilike('company_name', company).maybeSingle();
    if (existing) {
      subId = existing.id;
      if (phone && !existing.phone) {
        await db.from('subcontractors').update({ phone, updated_at: new Date().toISOString() }).eq('id', subId);
      }
    } else {
      const { data: created, error: cErr } = await db.from('subcontractors')
        .insert({ business_id: biz.id, company_name: company, phone: phone || null })
        .select('id').single();
      if (cErr) throw cErr;
      subId = created.id;
    }
  }

  // Write each typed price onto the company's rate card.
  const breakdown = [];
  for (const l of required) {
    const price = parseMoney(prices[l.key]);
    if (price === null) continue;
    if (l.custom) {
      // Job-specific: recorded on this bid only, never on the rate card.
      breakdown.push({ section_key: 'custom', row_key: l.key, label: l.label, price });
      continue;
    }
    if (!l.row_key) continue;   // section not chosen yet
    const opt = (catalog[l.key] || []).find(o => o.row_key === l.row_key);
    const { error: upErr } = await db.from('subcontractor_rates').upsert({
      business_id: biz.id, subcontractor_id: subId,
      section_key: l.key, row_key: l.row_key, price,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'subcontractor_id,section_key,row_key' });
    if (upErr) throw upErr;
    breakdown.push({ section_key: l.key, row_key: l.row_key, label: opt ? opt.label : l.row_key, price });
  }

  // Their price only counts when all three lines are in.
  const complete = breakdown.length === required.length;
  const subPrice = complete ? Math.round(breakdown.reduce((t, l) => t + l.price, 0) * 100) / 100 : null;

  const { error } = await db.from('estimate_broker_bids').upsert({
    estimate_id: body.id, business_id: biz.id, slot,
    subcontractor_id: subId, company_name: company, phone: phone || null,
    sub_price: subPrice, breakdown: breakdown.length ? breakdown : null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'estimate_id,slot' });
  if (error) throw error;

  return res.status(200).json({ ok: true, slot, sub_price: subPrice, min_sell: minSellPrice(subPrice) });
}

// Pick a winning bid and set the price we sell at. The sell price is validated
// against the 20 percent minimum, recorded for profit reporting, and written
// into line_items as the SINGLE line the customer sees, so the EXISTING
// estimate_send_sms / estimate_send_email actions quote exactly that number.
// The customer never sees the subcontractor, the breakdown, or the spread.
async function estimateBrokerBook(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const slot = Number(body.slot);
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'slot must be 1, 2 or 3' });

  const ctx = await brokerContext(db, biz, body.id);
  if (ctx.error) return res.status(ctx.error.code).json({ error: ctx.error.msg });

  const { data: bid, error: bErr } = await db.from('estimate_broker_bids')
    .select('subcontractor_id, company_name, phone, sub_price, breakdown')
    .eq('estimate_id', body.id).eq('business_id', biz.id).eq('slot', slot).maybeSingle();
  if (bErr) throw bErr;
  if (!bid) return res.status(400).json({ error: 'That bid slot is empty.' });
  if (parseMoney(bid.sub_price) === null) {
    return res.status(400).json({ error: 'That company still needs a price for all three lines.' });
  }

  const check = checkSellPrice(bid.sub_price, body.sell_price, !!body.override_below_min);
  if (!check.ok) return res.status(400).json({ error: check.error, below_min: !!check.belowMin, min_sell: check.min });

  // ONE line at the sell price, replacing whatever was there. The estimate's
  // own itemization is OUR pricing for a job we are not doing ourselves, and
  // leaving it in place would add to the brokered price rather than replace it
  // (a 254 dollar itemized LA quote plus a 652 dollar brokered line quoted the
  // customer 906). The breakdown stays on the bid row for reporting.
  const items = brokerQuoteLineItems(ctx.est.service_label, check.sell);

  const patch = {
    broker_subcontractor_id: bid.subcontractor_id || null,
    broker_company_name:     bid.company_name,
    broker_sub_price:        check.sub,
    broker_sell_price:       check.sell,
    broker_below_min:        !!check.belowMin,
    broker_booked_at:        new Date().toISOString(),
    line_items:              items,
    // broker_spread is a GENERATED column -- never written here on purpose.
  };
  const { error } = await db.from('estimates').update(patch).eq('id', body.id).eq('business_id', biz.id);
  if (error) throw error;

  return res.status(200).json({
    ok: true,
    company_name: bid.company_name,
    sub_price: check.sub, sell_price: check.sell, min_sell: check.min,
    below_min: !!check.belowMin, spread: check.spread,
    breakdown: bid.breakdown || [],
  });
}

async function estimateDecline(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  if (!body.id) return res.status(400).json({ error: 'id required' });

  const est = await fetchEstimate(db, body.id, biz.id, 'customer_name, customer_phone, customer_email, sms_consent, notes');
  if (!est) return res.status(404).json({ error: 'Estimate not found' });

  const firstName = (est.customer_name || '').trim().split(/\s+/)[0];
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const servicesUrl = baseUrl ? `${baseUrl}/services.html?business=${encodeURIComponent(biz.slug)}` : '';
  const brand = brandFor(biz.slug);

  let smsResult = null, emailResult = null;

  if (est.customer_phone && est.sms_consent !== false) {
    const greeting = firstName ? `Hi ${firstName}, ` : '';
    const msg = `${greeting}this is ${brand.name}. We're sorry, but it looks like your request is outside of what we're able to help with. Here's what we do handle: ${servicesUrl}`;
    smsResult = await sendSMSResult(est.customer_phone, msg);
  }

  if (est.customer_email) {
    const { subject, html } = outOfScopeEmail({ firstName, servicesUrl }, brand);
    emailResult = await sendEmail({ slug: biz.slug, to: est.customer_email, subject, html });
  }

  const patch = {
    status: 'declined',
    notes: [est.notes, `Declined as outside scope — notified via ${[smsResult && smsResult.ok && 'SMS', emailResult && emailResult.sent && 'email'].filter(Boolean).join(' + ') || 'no channel (no phone/email on file)'}.`]
      .filter(Boolean).join('\n').slice(0, 2000),
  };
  const { error } = await db.from('estimates').update(patch).eq('id', body.id).eq('business_id', biz.id);
  if (error) throw error;

  return res.status(200).json({
    ok: true,
    sms_sent: !!(smsResult && smsResult.ok),
    email_sent: !!(emailResult && emailResult.sent),
  });
}

// ── How much can we discount this quote without losing money? ────────────────
// The owner's rule: never take a job below $50 of profit. Profit here is NOT a
// percentage guess — the quote's line items are run through the SAME payroll
// engine that pays the techs (computeJobPay), so the TV base rates, bracket
// rates, wire/fireplace add-ons, travel tiers and the after-hours bonus are all
// priced exactly as they will be on payday. Bracket hardware the business buys
// is subtracted too, same as the Profit card does.
//
// No tech is assigned yet at quote time, so this prices the job for a standard
// tech rather than guessing who it'll land on. Juan's own rates differ (higher
// base pay on some sizes, no bracket reimbursement since 2026-08-16 — see
// bracketHardwareCost), but standard-rate is the conservative default here.
const QUOTE_PROFIT_FLOOR = 50;
// A second, independent ceiling: a share of the ticket. The profit floor alone
// scales with the job, so a fat multi-TV ticket would have permitted several
// hundred off and still cleared $50, technically profitable but not a
// discount anyone meant to authorize. Whichever limit is TIGHTER wins, so a
// thin job is protected by the floor and a big one by this.
//
// Measured against 1,566 completed jobs (Aug 2025 - Aug 2026, priced through
// the real payroll engine): margin sits at a near-constant 31-35% at EVERY
// ticket size, so this cap, not the floor, is what actually binds on anything
// over ~$450 -- 100% of the time up there. The floor does its work at the low
// end instead, binding on ~61% of $150-249 jobs. Raised 10% -> 15% so the
// office has real room to close a mid-size job; worst case (every call maxed)
// still leaves $51 on a small ticket and $140 on an $800 one.
const QUOTE_MAX_DISCOUNT_PCT = 0.15;
async function quoteEconomics(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const lines = (Array.isArray(body.line_items) ? body.line_items : []).map(li => ({
    name: String(li.name || li.label || ''),
    quantity: Number(li.quantity) || 1,
    line_total: Number(li.line_total != null ? li.line_total : (Number(li.price) || 0) * (Number(li.quantity) || 1)) || 0,
    kind: li.kind || null,
  }));
  const price = Math.round(lines.reduce((t, li) => t + li.line_total, 0) * 100) / 100;

  // Same projection shape computeJobEconomics builds for an upcoming job: force
  // completed + paid so the payment gate doesn't zero out a job that hasn't
  // happened yet.
  const projJob = {
    status: 'completed',
    payment_status: 'paid',
    price,
    subtotal: price,
    notes: '',
    customer_notes: '',
    service_name: '',
    business_slug: biz.slug,
    line_items: lines,
    scheduled_at: body.scheduled_at || new Date().toISOString(),
    travel_payout: 0,   // derived from the ticket's own surcharge line by the engine
    second_tech: false,
    // No real booking yet, so only a zip on the quote (if the office entered one)
    // can resolve the metro beyond the Houston-exclusive brands.
    is_houston: await isHoustonBooking(db, biz.id, biz.slug, await serviceAreaIdFromPostal(db, biz.id, body.postal_code)),
  };
  const { pay, flags } = computeJobPay(projJob, 'Office Quote');
  const payout = Number(pay) || 0;
  const bracketCost = bracketHardwareCost(lines, false);
  const profit = Math.round(price - payout - bracketCost);
  const floorRoom = Math.max(0, profit - QUOTE_PROFIT_FLOOR);
  const pctRoom = Math.floor(price * QUOTE_MAX_DISCOUNT_PCT);
  const maxDiscount = Math.min(floorRoom, pctRoom);

  return res.status(200).json({
    price,
    // Only the owner sees the raw economics; a secretary gets the ceiling they
    // are allowed to work within, which is all they need to close the call.
    ...(auth.role === 'owner' ? { payout: Math.round(payout), bracket_cost: bracketCost, profit, flags } : {}),
    profit,
    max_discount: maxDiscount,
    floor: QUOTE_PROFIT_FLOOR,
    // Which limit actually bound this quote, so the office can see WHY a job
    // has little room rather than just being told "no".
    // Derived from the constant, never hardcoded: this string is shown to the
    // secretary as "limit: ...", so a literal would silently lie the next time
    // the percentage moves.
    capped_by: maxDiscount <= 0 ? 'nothing to give'
      : (pctRoom < floorRoom ? `${(QUOTE_MAX_DISCOUNT_PCT * 100).toFixed(2).replace(/\.?0+$/, '')}% of the ticket` : 'profit floor'),
  });
}

// ── Take a Call: event log + rollups ────────────────────────────────────────
// Every step of the phone script writes one row here. The point is the funnel:
// a call that dies on the zip question and a call that dies after the price was
// quoted are very different failures, and only the event history tells them
// apart. Also stamps the denormalized outcome columns on the call itself so the
// day/week rollup is one scan instead of re-aggregating events every load.
const CALL_EVENTS = new Set([
  'started', 'service_picked', 'zip_checked', 'question_answered', 'options_done',
  'date_picked', 'slot_picked', 'price_quoted', 'read_to_customer',
  'accepted', 'pushback', 'source_picked', 'coupon_tried', 'coupon_applied',
  'manual_discount', 'discount_final', 'booking_started', 'booking_created',
  'estimate_sent', 'declined', 'abandoned',
]);
async function callEvent(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const event = String(body.event || '').trim();
  if (!CALL_EVENTS.has(event)) return res.status(400).json({ error: `Unknown event "${event}"` });
  if (!body.call_id) return res.status(400).json({ error: 'call_id required' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }

  const meta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
  const actor = auth.name || adminAuthorName(auth) || auth.role || 'office';

  // Best-effort: analytics must never break the call the secretary is on.
  try {
    await db.from('call_events').insert({
      call_id: body.call_id, business_id: biz.id, actor,
      event, step: body.step ? String(body.step).slice(0, 40) : null, meta,
    });
  } catch (e) { console.warn('[call_event] insert failed:', e.message); }

  // Roll the interesting values onto the call row so reports don't have to dig
  // through jsonb for the numbers they show on every line.
  const patch = { reached_step: body.step ? String(body.step).slice(0, 40) : undefined };
  if (event === 'price_quoted') {
    if (meta.total != null) patch.quoted_total = Number(meta.total) || 0;
    if (meta.tv_count != null) patch.tv_count = Number(meta.tv_count) || 0;
  }
  if (event === 'discount_final') {
    patch.discount_amount = Number(meta.amount) || 0;
    patch.discount_detail = meta.detail ? String(meta.detail).slice(0, 200) : null;
  }
  if (event === 'booking_created' && meta.total != null) {
    // quoted_total was frozen at the FIRST recap, before any discount, so booked
    // revenue read higher than what was actually charged and never reconciled
    // with the discount column sitting next to it. The booked price wins.
    patch.quoted_total = Number(meta.total) || 0;
  }
  if (['booking_created', 'estimate_sent', 'declined', 'abandoned'].includes(event)) {
    patch.ended_at = new Date().toISOString();
  }
  Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
  if (Object.keys(patch).length) {
    try { await db.from('calls').update(patch).eq('id', body.call_id); }
    catch (e) { console.warn('[call_event] call patch failed:', e.message); }
  }
  return res.status(200).json({ ok: true });
}

// Daily + weekly rollups for the phone script. The headline number the owner
// asked for is calls-taken vs calls-booked, broken down by who took the call —
// everything else on this payload exists to explain that ratio.
// Rolls up the manual call audits (see api/audit.js) into the one question the
// owner actually asks: are the secretaries doing what they were told. Owner
// only, and unlike the profit endpoints this one genuinely needs to span both
// businesses, since the auditor works every line regardless of brand.
//
// The reconciliation is the headline. Her per-line counts are the only record
// of how many calls actually came in (live call rows carry handled_by but no
// grasshopper_number), so counted-minus-scripted is the number of calls handled
// without opening the script at all. That is a bigger finding than any single
// question's score, which is why it leads.
async function auditReport(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });

  const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 30));
  // offset shifts the whole window back in whole days: 0 = ending today (the
  // default for every multi-day range), -1 = ending yesterday. Combined with
  // days=1 this is what makes "Today" and "Yesterday" single-day views rather
  // than a 1-day slice of a rolling window; every other range stays anchored
  // to today the way it always has.
  const offset = Math.max(-365, Math.min(0, parseInt(req.query.offset, 10) || 0));
  const { data: bizRows } = await db.from('businesses').select('id, slug, timezone').eq('active', true);
  const tz = (bizRows && bizRows[0] && bizRows[0].timezone) || 'America/Denver';
  const dayStr = (off) => localDayStartUTC(tz, off).toISOString().slice(0, 10);
  const to = dayStr(offset), from = dayStr(offset - (days - 1));

  const [{ data: dayRows }, { data: audits }] = await Promise.all([
    db.from('call_audit_days').select('audit_date, grasshopper_number, calls_counted')
      .gte('audit_date', from).lte('audit_date', to),
    db.from('call_audits')
      .select('id, audit_date, grasshopper_number, call_id, occurred_at, time_local, handled_by, service, caller_name, caller_phone, answers, flagged, notes')
      .gte('audit_date', from).lte('audit_date', to)
      .order('occurred_at', { ascending: false }),
  ]);

  // Scripted calls over the same window, bucketed by local day so they line up
  // with audit_date, which is a plain calendar date the auditor typed.
  const start = localDayStartUTC(tz, offset - (days - 1));
  const end = localDayStartUTC(tz, offset + 1);
  const { data: liveCalls } = await db.from('calls')
    .select('id, occurred_at, handled_by')
    .eq('kind', 'live')
    .gte('occurred_at', start.toISOString())
    .lt('occurred_at', end.toISOString());

  const scriptedByDay = {};
  for (const c of (liveCalls || [])) {
    const d = new Date(c.occurred_at).toLocaleDateString('en-CA', { timeZone: tz });
    scriptedByDay[d] = (scriptedByDay[d] || 0) + 1;
  }

  const countedByDay = {}, byLine = {};
  let totalCounted = 0;
  for (const r of (dayRows || [])) {
    const n = Number(r.calls_counted) || 0;
    totalCounted += n;
    countedByDay[r.audit_date] = (countedByDay[r.audit_date] || 0) + n;
    byLine[r.grasshopper_number] = (byLine[r.grasshopper_number] || 0) + n;
  }
  const totalScripted = (liveCalls || []).length;

  const scoreOf = (a) => {
    const v = Object.values(a.answers || {});
    const yes = v.filter(x => x === 'yes').length;
    const no = v.filter(x => x === 'no').length;
    return { yes, no, pct: (yes + no) ? Math.round(100 * yes / (yes + no)) : null };
  };

  // Per-day grading activity and script score, for the owner's trend chart:
  // "are they getting better" needs the score over time, not one pooled
  // number, and "is the auditor keeping up" needs graded-per-day next to
  // counted-per-day.
  const gradedByDay = {}, scoreAggByDay = {};
  for (const a of (audits || [])) {
    gradedByDay[a.audit_date] = (gradedByDay[a.audit_date] || 0) + 1;
    const s = scoreOf(a);
    if (s.yes + s.no > 0) {
      const g = scoreAggByDay[a.audit_date] || (scoreAggByDay[a.audit_date] = { yes: 0, no: 0 });
      g.yes += s.yes; g.no += s.no;
    }
  }

  // Per-day series so a bad week is visible rather than averaged away.
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = dayStr(offset - (days - 1) + i);
    const counted = countedByDay[d];
    const agg = scoreAggByDay[d];
    daily.push({
      date: d,
      // null, not 0, when the auditor never saved that day. A day she skipped
      // and a day with genuinely no calls must not look the same on the chart.
      counted: counted == null ? null : counted,
      scripted: scriptedByDay[d] || 0,
      graded: gradedByDay[d] || 0,
      avg_pct: agg ? Math.round(100 * agg.yes / (agg.yes + agg.no)) : null,
    });
  }

  const people = {};
  const questions = {};
  // Same tally as `questions`, kept separately per person too. The combined
  // list answers "what goes wrong on these calls" but not "who", which is the
  // actual coaching question the owner is asking; Heather and Joey missing
  // different things at a 50/50 split reads identically to one of them
  // missing everything, in a list that only ever names the question.
  const questionsByPerson = {};
  for (const a of (audits || [])) {
    const s = scoreOf(a);
    const who = a.handled_by || 'Unknown';
    const p = people[who] || (people[who] = { name: who, audited: 0, yes: 0, no: 0, flagged: 0 });
    p.audited++; p.yes += s.yes; p.no += s.no;
    if (a.flagged) p.flagged++;
    const pq = questionsByPerson[who] || (questionsByPerson[who] = {});
    for (const [k, v] of Object.entries(a.answers || {})) {
      if (v !== 'yes' && v !== 'no') continue;   // N/A is excluded from the denominator
      const q = questions[k] || (questions[k] = { key: k, asked: 0, no: 0 });
      q.asked++;
      if (v === 'no') q.no++;
      const pqk = pq[k] || (pq[k] = { key: k, asked: 0, no: 0 });
      pqk.asked++;
      if (v === 'no') pqk.no++;
    }
  }

  // Worst first, same rule as the combined list below: fail rate, then volume
  // to break ties, and only questions actually missed at least once.
  const rankQuestions = (map) => Object.values(map)
    .map(q => ({ ...q, fail_rate: q.asked ? Math.round(100 * q.no / q.asked) : 0 }))
    .filter(q => q.no > 0)
    .sort((a, b) => b.fail_rate - a.fail_rate || b.asked - a.asked);

  const peopleOut = Object.values(people).map(p => ({
    ...p,
    pct: (p.yes + p.no) ? Math.round(100 * p.yes / (p.yes + p.no)) : null,
    questions: rankQuestions(questionsByPerson[p.name] || {}),
  })).sort((a, b) => b.audited - a.audited);

  // Worst first: this is the coaching list, so the thing they get wrong most
  // often has to be at the top. Ties break toward the more frequently asked
  // question, since a 50% failure over 20 calls matters more than over 2.
  const questionsOut = rankQuestions(questions);

  const flagged = (audits || []).filter(a => a.flagged).slice(0, 25).map(a => ({
    id: a.id,
    audit_date: a.audit_date,
    occurred_at: a.occurred_at,
    time_local: a.time_local,
    grasshopper_number: a.grasshopper_number,
    handled_by: a.handled_by,
    service: a.service,
    caller_name: a.caller_name,
    caller_phone: a.caller_phone,
    notes: a.notes,
    pct: scoreOf(a).pct,
  }));

  return res.status(200).json({
    from, to, days,
    volume: {
      counted: totalCounted,
      scripted: totalScripted,
      off_script: Math.max(0, totalCounted - totalScripted),
      by_line: Object.entries(byLine).map(([number, calls]) => ({ number, calls }))
        .sort((a, b) => b.calls - a.calls),
    },
    audited: (audits || []).length,
    people: peopleOut,
    questions: questionsOut,
    flagged,
    daily,
    // Days in range the auditor never saved anything for, so a gap in her own
    // coverage does not read as a quiet stretch for the business.
    missing_days: daily.filter(d => d.counted == null).map(d => d.date),
  });
}

// Every Twilio tracking number across the whole portfolio, with the business
// it belongs to and where a call to it actually rings. Owner-only, same as
// Performance/Audit -- forward_to is a real personal cell number, not
// something a secretary needs to see to do her job.
// Twilio itself is the only source of truth for whether a number's voice
// webhook actually points at Vapi (importing a number into Vapi silently
// rewrites this URL on Twilio's side -- nothing in our own DB changes when
// that happens). Pulled fresh every time the Numbers screen loads rather than
// cached, since a number can be imported/removed from Vapi at any moment
// outside this app. 10s timeout + swallow-on-failure: a slow/erroring Twilio
// call should degrade to "can't tell" for every row, never break the page.
let _twilioNumbersCache = null; // { at, byPhone: Map<10-digit, voiceUrl> }
const TWILIO_NUMBERS_CACHE_MS = 30 * 1000;
async function fetchTwilioVoiceUrls() {
  if (_twilioNumbersCache && (Date.now() - _twilioNumbersCache.at) < TWILIO_NUMBERS_CACHE_MS) return _twilioNumbersCache.byPhone;
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  const byPhone = new Map();
  if (!sid || !token) return byPhone;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  let url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=200`;
  try {
    for (let page = 0; page < 5 && url; page++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) break;
      const data = await r.json();
      for (const rec of (data.incoming_phone_numbers || [])) {
        const ten = (rec.phone_number || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
        if (ten) byPhone.set(ten, rec.voice_url || '');
      }
      url = data.next_page_uri ? `https://api.twilio.com${data.next_page_uri}` : null;
    }
  } catch (e) { /* Twilio unreachable/slow -- callers treat a missing entry as "unknown" */ }
  _twilioNumbersCache = { at: Date.now(), byPhone };
  return byPhone;
}
function aiVoiceStatusFor(voiceUrl) {
  if (voiceUrl == null) return 'unknown';   // Twilio call failed/timed out
  return /vapi\.ai/i.test(voiceUrl) ? 'connected' : 'not_connected';
}

async function callNumbers(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });

  const [{ data: numbers }, { data: businesses }, voiceUrlByPhone] = await Promise.all([
    db.from('tracking_numbers')
      .select('phone, label, business_slug, market, forward_to, after_hours_forward_to, active, hours_start, hours_end, hours_timezone')
      .order('business_slug'),
    db.from('businesses').select('slug, name, url'),
    fetchTwilioVoiceUrls(),
  ]);

  const bizBySlug = {};
  for (const b of (businesses || [])) bizBySlug[b.slug] = b;

  const rows = (numbers || []).map(n => {
    const biz = bizBySlug[n.business_slug] || {};
    const hasVoiceUrl = voiceUrlByPhone.has(n.phone);
    return {
      ...n,
      business_name: biz.name || n.business_slug,
      business_url: biz.url || null,
      ai_voice_status: aiVoiceStatusFor(hasVoiceUrl ? voiceUrlByPhone.get(n.phone) : null),
    };
  });

  return res.status(200).json({ numbers: rows });
}

// A secretary's own booking numbers: how many calls she took, how many became
// jobs, and what those jobs were worth. The SAME definition of "booked" the
// owner's Call Performance screen uses (callAnalytics isBooked), so her
// conversion figure and his agree to the decimal rather than being two
// different ideas of the word.
//
// Deliberately her own row only -- no other person's conversion rate, and none
// of the owner's cross-staff ranking. Scope comes from the token, never the
// request, so Heather's login can only ever total Heather's calls on Handy
// Andy and Joey's only Joey's on Dom's.
//
// auth.role === 'secretary' covers a real secretary login AND the owner's
// "View As" (see viewAs above), which mints an identical secretary-role token
// on purpose so he can see exactly what she sees.
async function myCallPerformance(req, res, db, auth) {
  if (auth.role !== 'secretary' || !['handy-andy', 'doms'].includes(auth.scope)) {
    return res.status(403).json({ error: 'Not available for this login' });
  }
  const name = displayNameFor(auth.scope);

  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const offset = Math.max(-365, Math.min(0, parseInt(req.query.offset, 10) || 0));
  const { data: bizRows } = await db.from('businesses').select('id, timezone').eq('slug', auth.scope).limit(1);
  const bizId = bizRows && bizRows[0] && bizRows[0].id;
  const tz = (bizRows && bizRows[0] && bizRows[0].timezone) || 'America/Denver';
  const dayStr = (off) => localDayStartUTC(tz, off).toISOString().slice(0, 10);
  const to = dayStr(offset), from = dayStr(offset - (days - 1));
  const empty = {
    name, from, to, days, calls: 0, booked: 0, not_booked: 0, estimates: 0,
    conversion: 0, booked_value: 0, avg_quote: 0, daily: [],
  };
  // Should never happen -- both slugs are seeded business rows every other part
  // of this file assumes exist -- but failing closed with an empty report beats
  // a 500 or, worse, silently dropping the business_id filter below.
  if (!bizId) return res.status(200).json(empty);

  // Live (script-taken) calls only, exactly as callAnalytics does: Grasshopper
  // voicemails are a different thing and would wreck the conversion rate if
  // mixed in. The window is [from 00:00, to 24:00) in the BUSINESS timezone.
  const since = localDayStartUTC(tz, offset - (days - 1));
  const until = localDayStartUTC(tz, offset + 1);
  const { data: calls, error } = await db.from('calls')
    .select('handled_by, resolution, booking_id, quoted_total, occurred_at, reached_step')
    .eq('business_id', bizId).eq('kind', 'live')
    .eq('handled_by', name)
    .gte('occurred_at', since.toISOString())
    .lt('occurred_at', until.toISOString());
  if (error) throw error;
  // Same worked-the-script gate as callAnalytics (owner rule, 2026-08-25): an
  // opened-and-abandoned greet screen is a misclick, not a call, and must not
  // drag this person's own conversion number down. Keep the two definitions
  // identical or her report and the owner's ranking disagree about the same week.
  const rows = (calls || []).filter(r =>
    !!r.booking_id || !!r.resolution || (r.reached_step && r.reached_step !== 'greet'));

  const isBooked = r => !!r.booking_id || r.resolution === 'booked';
  const dayKeyOf = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });

  let booked = 0, notBooked = 0, estimates = 0, bookedValue = 0, quotedTotal = 0, quotedCount = 0;
  const byDay = {};
  for (const r of rows) {
    const b = isBooked(r);
    if (b) { booked++; bookedValue += Number(r.quoted_total) || 0; }
    else { notBooked++; if (r.resolution === 'estimate_sent') estimates++; }
    if (r.quoted_total != null) { quotedTotal += Number(r.quoted_total) || 0; quotedCount++; }
    const k = dayKeyOf(r.occurred_at);
    const d = byDay[k] || (byDay[k] = { calls: 0, booked: 0 });
    d.calls++; if (b) d.booked++;
  }

  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = dayStr(offset - (days - 1) + i);
    const b = byDay[d];
    daily.push({
      date: d,
      calls: b ? b.calls : 0,
      booked: b ? b.booked : 0,
      conversion: b && b.calls ? Math.round((b.booked / b.calls) * 1000) / 10 : 0,
    });
  }

  return res.status(200).json({
    name, from, to, days,
    calls: rows.length,
    booked, not_booked: notBooked, estimates,
    conversion: rows.length ? Math.round((booked / rows.length) * 1000) / 10 : 0,
    booked_value: Math.round(bookedValue),
    avg_quote: quotedCount ? Math.round(quotedTotal / quotedCount) : 0,
    daily,
  });
}

// Backs the click-a-day-to-see-the-calls drill-down on both Call Performance
// screens. A secretary can only ever see her OWN calls for HER OWN business:
// the query/body params are trusted for the date only; person and business
// are always derived from the auth token for that role, never taken from the
// client, so Heather can't page through Joey's calls by editing the request.
// An owner may pass a person to filter by, or omit it to see everyone's.
async function callDayDetail(req, res, db, auth) {
  const dateStr = (req.query.date || (req.body && req.body.date) || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });

  let bizId, tz, person = null;
  if (auth.role === 'secretary') {
    if (!['handy-andy', 'doms'].includes(auth.scope)) return res.status(403).json({ error: 'Not available for this login' });
    const { data: bizRows } = await db.from('businesses').select('id, timezone').eq('slug', auth.scope).limit(1);
    if (!bizRows || !bizRows[0]) return res.status(200).json({ date: dateStr, calls: [] });
    bizId = bizRows[0].id;
    tz = bizRows[0].timezone || 'America/Denver';
    person = displayNameFor(auth.scope);
  } else if (auth.role === 'owner') {
    let biz; try { biz = await resolveBusiness(db, auth, req.query.business || (req.body && req.body.business)); } catch (e) { return bail(res, e); }
    bizId = biz.id;
    tz = biz.timezone || 'America/Denver';
    const p = (req.query.person || (req.body && req.body.person) || '').toString();
    if (p) person = p;
  } else {
    return res.status(403).json({ error: 'Not available for this login' });
  }

  const since = localDateStartUTC(tz, dateStr);
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);
  let q = db.from('calls')
    .select('id, handled_by, resolution, booking_id, quoted_total, service, occurred_at')
    .eq('business_id', bizId).eq('kind', 'live')
    .gte('occurred_at', since.toISOString()).lt('occurred_at', until.toISOString())
    .order('occurred_at', { ascending: true });
  if (person) q = q.eq('handled_by', person);
  const { data: rows, error } = await q;
  if (error) throw error;

  const isBooked = r => !!r.booking_id || r.resolution === 'booked';
  return res.status(200).json({
    date: dateStr,
    calls: (rows || []).map(r => ({
      id: r.id,
      handled_by: r.handled_by,
      occurred_at: r.occurred_at,
      service: r.service,
      booked: isBooked(r),
      resolution: r.resolution,
      quoted_total: r.quoted_total,
    })),
  });
}

async function callAnalytics(req, res, db, auth) {
  // Ranks staff against each other on booking rate — the hidden nav button is a
  // convenience, this is the actual gate.
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }
  const RANGE_TO_DAYS = { today: 1, yesterday: 1, '7': 7, '30': 30, '90': 90 };
  const range = String(req.query.range || '30');
  const days = RANGE_TO_DAYS[range] ?? Math.min(180, Math.max(1, parseInt(range, 10) || 30));
  const tz = biz.timezone || 'America/Denver';
  // "Yesterday" is the one range that isn't "since X through now" — it needs an
  // upper bound too, or it'd silently include today's calls.
  const since = range === 'yesterday' ? localDayStartUTC(tz, -1) : localDayStartUTC(tz, -(days - 1));
  const until = range === 'yesterday' ? localDayStartUTC(tz, 0) : null;

  // Live (script-taken) calls only. Grasshopper voicemails are a different
  // thing entirely and would wreck the conversion rate if mixed in.
  let callsQuery = db.from('calls')
    .select('id, handled_by, service, market, status, resolution, booking_id, quoted_total, discount_amount, discount_detail, tv_count, reached_step, occurred_at, ended_at')
    .eq('business_id', biz.id).eq('kind', 'live')
    .gte('occurred_at', since.toISOString());
  if (until) callsQuery = callsQuery.lt('occurred_at', until.toISOString());
  const { data: calls, error } = await callsQuery.order('occurred_at', { ascending: false });
  if (error) throw error;
  // Only calls where the script was actually WORKED count (owner rule,
  // 2026-08-25). Opening "Take a Call", tapping a service, and abandoning it
  // leaves a row stuck at the greet step with no resolution — a misclick or a
  // wrong number, not a conversation — and every one of those was scored as a
  // 0% call against whoever opened it. A call counts once it moved past the
  // greeting (any later step stamped) or actually ended somewhere (resolution
  // or a booking).
  const rows = (calls || []).filter(r =>
    !!r.booking_id || !!r.resolution || (r.reached_step && r.reached_step !== 'greet'));

  let eventsQuery = db.from('call_events')
    .select('call_id, actor, event, step, meta, created_at')
    .eq('business_id', biz.id)
    .gte('created_at', since.toISOString());
  if (until) eventsQuery = eventsQuery.lt('created_at', until.toISOString());
  const { data: events } = await eventsQuery;
  const evs = events || [];

  const isBooked = r => !!r.booking_id || r.resolution === 'booked';
  const dayKeyOf = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });   // YYYY-MM-DD

  // ── Per-person scoreboard: the "who is booking and who is not" table.
  // Everything that isn't a booking is one bucket ("not booked"). Splitting it
  // into declined-vs-unfinished implied we knew WHY a call didn't convert, and
  // we don't — the phone system isn't wired into this, so those were guesses
  // dressed up as data.
  const byPerson = {};
  for (const r of rows) {
    const who = r.handled_by || 'Unknown';
    const p = byPerson[who] || (byPerson[who] = {
      person: who, calls: 0, booked: 0, estimates: 0, not_booked: 0,
      quoted_total: 0, quoted_count: 0, discount_given: 0, discounted_calls: 0, booked_value: 0,
    });
    p.calls++;
    if (isBooked(r)) { p.booked++; p.booked_value += Number(r.quoted_total) || 0; }
    else { p.not_booked++; if (r.resolution === 'estimate_sent') p.estimates++; }
    if (r.quoted_total != null) { p.quoted_total += Number(r.quoted_total) || 0; p.quoted_count++; }
    if (Number(r.discount_amount) > 0) { p.discount_given += Number(r.discount_amount); p.discounted_calls++; }
  }
  const people = Object.values(byPerson).map(p => ({
    ...p,
    conversion: p.calls ? Math.round((p.booked / p.calls) * 1000) / 10 : 0,
    avg_quote: p.quoted_count ? Math.round(p.quoted_total / p.quoted_count) : 0,
    avg_discount: p.discounted_calls ? Math.round(p.discount_given / p.discounted_calls) : 0,
  })).sort((a, b) => b.calls - a.calls);

  // ── Day-by-day series, for the daily number and the weekly chart.
  const byDay = {};
  for (const r of rows) {
    const k = dayKeyOf(r.occurred_at);
    const d = byDay[k] || (byDay[k] = { date: k, calls: 0, booked: 0, quoted_total: 0, discount_given: 0 });
    d.calls++;
    if (isBooked(r)) { d.booked++; d.quoted_total += Number(r.quoted_total) || 0; }
    d.discount_given += Number(r.discount_amount) || 0;
  }
  const daily = Object.values(byDay).sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(d => ({ ...d, conversion: d.calls ? Math.round((d.booked / d.calls) * 1000) / 10 : 0 }));

  // ── Where calls die. Counted from the furthest step each call reached, so a
  // call that quit on the zip question is distinguishable from one that heard
  // the price and walked.
  // These must be the steps the wizard actually stamps. 'wait' was a screen that
  // got merged into the recap and is never emitted, while 'customer',
  // 'handydesc', 'estimate' and 'resolution' ARE emitted and were missing — so
  // indexOf returned -1 and every deep call that didn't book was reported as
  // dying at hello, which is precisely the group this chart exists to explain.
  const FUNNEL = ['greet', 'zip', 'tvopts', 'schedule', 'recap', 'discount', 'customer', 'booked'];
  // Branch steps that aren't stages of their own: a handyman description is the
  // handyman equivalent of the options step, and estimate/resolution are exits
  // taken from the discount screen.
  const STEP_ALIAS = { handydesc: 'tvopts', estimate: 'discount', resolution: 'discount' };
  const funnel = FUNNEL.map(step => ({ step, reached: 0 }));
  for (const r of rows) {
    const reached = isBooked(r) ? 'booked' : (STEP_ALIAS[r.reached_step] || r.reached_step || 'greet');
    const idx = FUNNEL.indexOf(reached);
    // Reaching a step means having reached everything before it.
    for (let i = 0; i <= (idx < 0 ? 0 : idx); i++) funnel[i].reached++;
  }

  // ── Discounts: what is actually being given away, on which lever, by whom,
  // and whether it bought a booking. The `discount_final` event carries the
  // full picture for one call (which levers were pulled, what was asked for,
  // what the caps allowed), so it is the spine of this whole section.
  const discounted = rows.filter(r => Number(r.discount_amount) > 0);
  const callById = Object.fromEntries(rows.map(r => [r.id, r]));
  const finals = evs.filter(e => e.event === 'discount_final' && Number(e.meta?.amount) > 0);

  // Per-lever totals. A call can pull more than one lever, so `amount` is the
  // call's TOTAL and is attributed to each lever used — the counts are exact,
  // the money is "discounts involving this lever".
  const lever = { source: { count: 0, amount: 0 }, coupon: { count: 0, amount: 0 }, manual: { count: 0, amount: 0 } };
  const bySource = {}, byCoupon = {};
  for (const e of finals) {
    const m = e.meta || {};
    const amt = Number(m.amount) || 0;
    if (m.source) {
      lever.source.count++; lever.source.amount += amt;
      const s = bySource[m.source] || (bySource[m.source] = { source: m.source, count: 0, amount: 0, booked: 0 });
      s.count++; s.amount += amt;
      if (callById[e.call_id] && isBooked(callById[e.call_id])) s.booked++;
    }
    if (m.coupon) {
      lever.coupon.count++; lever.coupon.amount += amt;
      const c = byCoupon[m.coupon] || (byCoupon[m.coupon] = { code: m.coupon, count: 0, amount: 0, booked: 0 });
      c.count++; c.amount += amt;
      if (callById[e.call_id] && isBooked(callById[e.call_id])) c.booked++;
    }
    if (Number(m.manual) > 0) { lever.manual.count++; lever.manual.amount += amt; }
  }
  // How often the caps actually bit — a secretary asking for more than the
  // rules allow, repeatedly, is a conversation worth having.
  const cappedCount = evs.filter(e =>
    e.event === 'manual_discount' && Number(e.meta?.requested) > Number(e.meta?.allowed || 0)).length;
  // Coupon codes that were READ OUT but rejected — a customer quoting a dead
  // code is worth knowing about (an ad still running with an expired offer).
  const badCoupons = {};
  for (const e of evs) {
    if (e.event === 'coupon_tried' && e.meta && e.meta.valid === false && e.meta.code) {
      badCoupons[e.meta.code] = (badCoupons[e.meta.code] || 0) + 1;
    }
  }
  // Call-by-call discount log, newest first — the "show me exactly what was
  // given away" list.
  const discountLog = finals
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 100)
    .map(e => {
      const c = callById[e.call_id] || {};
      const m = e.meta || {};
      const levers = [];
      if (m.source) levers.push(m.source);
      if (m.coupon) levers.push(m.coupon);
      if (Number(m.manual) > 0) levers.push(`manual $${Math.round(Number(m.manual))}`);
      return {
        at: e.created_at, person: e.actor || c.handled_by || 'Unknown',
        amount: Number(m.amount) || 0, levers,
        max_allowed: m.max_allowed != null ? Number(m.max_allowed) : null,
        quoted: c.quoted_total != null ? Number(c.quoted_total) : null,
        booked: isBooked(c),
      };
    });
  // Did discounting actually work? Conversion with vs without.
  const discBooked = discounted.filter(isBooked).length;
  const plain = rows.filter(r => !(Number(r.discount_amount) > 0));
  const plainBooked = plain.filter(isBooked).length;

  const totals = {
    calls: rows.length,
    booked: rows.filter(isBooked).length,
    estimates: rows.filter(r => r.resolution === 'estimate_sent').length,
    not_booked: rows.filter(r => !isBooked(r)).length,
    booked_value: Math.round(rows.filter(isBooked).reduce((t, r) => t + (Number(r.quoted_total) || 0), 0)),
    discount_given: Math.round(rows.reduce((t, r) => t + (Number(r.discount_amount) || 0), 0)),
    discounted_calls: discounted.length,
  };
  totals.conversion = totals.calls ? Math.round((totals.booked / totals.calls) * 1000) / 10 : 0;
  totals.avg_discount = discounted.length ? Math.round(totals.discount_given / discounted.length) : 0;

  return res.status(200).json({
    days, since: since.toISOString(), totals, people, daily, funnel,
    discounts: {
      lever: {
        source: { ...lever.source, amount: Math.round(lever.source.amount) },
        coupon: { ...lever.coupon, amount: Math.round(lever.coupon.amount) },
        manual: { ...lever.manual, amount: Math.round(lever.manual.amount) },
      },
      by_source: Object.values(bySource).map(s => ({ ...s, amount: Math.round(s.amount) })).sort((a, b) => b.count - a.count),
      by_coupon: Object.values(byCoupon).map(c => ({ ...c, amount: Math.round(c.amount) })).sort((a, b) => b.count - a.count),
      rejected_coupons: Object.entries(badCoupons).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      capped_attempts: cappedCount,
      log: discountLog,
      // Whether discounting is buying anything: booking rate on discounted
      // calls vs everything else.
      effect: {
        discounted_calls: discounted.length, discounted_booked: discBooked,
        discounted_conversion: discounted.length ? Math.round((discBooked / discounted.length) * 1000) / 10 : 0,
        plain_calls: plain.length, plain_booked: plainBooked,
        plain_conversion: plain.length ? Math.round((plainBooked / plain.length) * 1000) / 10 : 0,
      },
    },
    event_counts: Object.entries(evs.reduce((m, e) => { m[e.event] = (m[e.event] || 0) + 1; return m; }, {}))
      .map(([k, v]) => ({ event: k, count: v })).sort((a, b) => b.count - a.count),
  });
}

// Validate a promo code the customer read out over the phone. Resolves against
// the SAME table the public booking widget uses, so the office can never tell a
// caller a live code is invalid (or honor one that has been retired).
// Levenshtein distance, small inputs only (promo codes) — used to suggest the
// code the caller probably meant.
function editDistance(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;   // too far apart to be a typo
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
async function quoteCoupon(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let biz; try { biz = await resolveBusiness(db, auth, body.business); } catch (e) { return bail(res, e); }
  const code = String(body.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code required' });
  const amount = await couponAmountFor(db, biz.slug, code);
  if (!amount) {
    // Offer the closest real code when it's within one or two characters — a
    // code read aloud over the phone is easy to mistype, and a bare "not valid"
    // strands the secretary mid-call against a customer who is actually right.
    let suggest = null, best = 3;
    for (const c of await couponCodesFor(db, biz.slug)) {
      const d = editDistance(code, c);
      if (d > 0 && d < best) { best = d; suggest = c; }
    }
    return res.status(200).json({ ok: false, code, amount: 0, suggest });
  }
  return res.status(200).json({ ok: true, code, amount });
}

// ── Public "what we do" services list (no admin auth) ────────────────────────
// Backs services.html, the link sent by estimate_decline. Read-only, no
// customer-specific data — just this business's active service categories, so
// it skips the auth gate like estimate_approve_info does.
async function servicesPublic(req, res, body) {
  const slug = ((req.query && req.query.business) || (body && body.business) || '').toString().trim();
  if (!slug) return res.status(400).json({ error: 'business required' });
  const db = serviceClient();
  const { data: biz } = await db.from('businesses').select('id, slug, name').eq('slug', slug).maybeSingle();
  if (!biz) return res.status(404).json({ error: 'Business not found' });
  const { data: rows } = await db.from('services')
    .select('name, category')
    .eq('business_id', biz.id).eq('active', true)
    .order('sort_order').order('name');
  const groups = {};
  (rows || []).forEach(r => {
    const cat = (r.category || 'Services').trim();
    (groups[cat] = groups[cat] || []).push(r.name);
  });
  return res.status(200).json({ business: biz.slug, business_name: biz.name, groups });
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
  // No resolvable metro => offer NOTHING. publicOpenSlots applies no
  // service_area filter when serviceAreaId is null, so it would happily offer
  // every tech in the company (a Denver customer shown Austin's openings), and
  // the booking's strict per-metro check then refuses all of them — the
  // customer picks a time, hands over a card, and gets silently bounced. An
  // empty list makes the page show its "please call us to book" message, which
  // is the honest outcome when we can't tell which metro serves this address.
  if (!serviceAreaId) {
    console.warn('[estimate_slots] no service area for estimate', id, 'zip', est.customer_zip || '(blank)', '— offering no slots');
    return res.status(200).json({ days: [], timezone: est.business?.timezone || 'America/Denver' });
  }
  try {
    const result = await publicOpenSlots(db, { businessSlug: slug, days: 45, serviceAreaId });
    return res.status(200).json({ days: result.days || [], timezone: result.timezone || 'America/Denver' });
  } catch (e) {
    console.warn('[estimate_slots] availability lookup failed:', e.message);
    return res.status(200).json({ days: [], timezone: 'America/Denver' });
  }
}

// ── Guaranteed Dismount Service upsell (confirmation-email button) ─────────
// The "Want to upgrade?" button in the booking-confirmation email links to
// /add-gds.html with a signed token (kind=add_gds, booking_id). That page
// shows a one-tap confirm (never mutates on the GET — a mail client or bot
// prefetching the link must not silently add a charge), and the POST here
// is what actually writes the line item onto the customer's real ticket.
const GDS_LINE_NAME = 'Guaranteed Dismount Service';
const GDS_PRICE = 35;
const GDS_RE = /guarante\w*\s+dismount|dismount\s+service|\btv removal\b/i;

function gdsTokenBookingId(raw) {
  const t = verifyToken((raw || '').toString());
  if (!t || t.kind !== 'add_gds' || !t.booking_id) return null;
  return t.booking_id;
}

async function fetchBookingForGds(db, id) {
  const { data, error } = await db.from('bookings')
    .select(`id, business_id, price, status, service:services ( name ), customer:customers ( name )`)
    .eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: biz, error: bizErr } = await db.from('businesses').select('id, slug, name').eq('id', data.business_id).maybeSingle();
  if (bizErr) throw bizErr;
  data.business = biz || null;
  const { data: lines, error: liErr } = await db.from('booking_line_items')
    .select('id, name, kind, quantity, unit_price, line_total, taxable').eq('booking_id', id);
  if (liErr) throw liErr;
  data.line_items = lines || [];
  return data;
}

async function gdsUpsellInfo(req, res, body) {
  const token = (req.query.token || (body && body.token) || '').toString();
  const id = gdsTokenBookingId(token);
  if (!id) return res.status(401).json({ error: 'This link is invalid or has expired.' });

  const db = serviceClient();
  const est = await fetchBookingForGds(db, id);
  if (!est) return res.status(404).json({ error: 'Booking not found.' });

  const alreadyHasGds = est.line_items.some(li => GDS_RE.test(li.name || ''));
  return res.status(200).json({
    already_has_gds: alreadyHasGds,
    customer_name: est.customer?.name || '',
    service_label: est.service?.name || 'Service',
    current_total: Number(est.price) || 0,
    gds_price: GDS_PRICE,
    business_slug: est.business?.slug || 'handy-andy',
    business_name: est.business?.name || 'Handy Andy',
  });
}

async function gdsUpsellAdd(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = (body.token || '').toString();
  const id = gdsTokenBookingId(token);
  if (!id) return res.status(401).json({ error: 'This link is invalid or has expired.' });

  const db = serviceClient();
  const est = await fetchBookingForGds(db, id);
  if (!est) return res.status(404).json({ error: 'Booking not found.' });

  if (est.line_items.some(li => GDS_RE.test(li.name || ''))) {
    // Already added (a prior click, or the office added it manually) — no-op,
    // not an error, so a double-tap or refresh doesn't look broken.
    return res.status(200).json({ ok: true, already: true, new_total: Number(est.price) || 0 });
  }

  const { error: insErr } = await db.from('booking_line_items').insert({
    booking_id: id, business_id: est.business_id, kind: 'service',
    name: GDS_LINE_NAME, quantity: 1, unit_price: GDS_PRICE, line_total: GDS_PRICE,
    service_id: null, option_id: null, taxable: true,
  });
  if (insErr) return res.status(500).json({ error: 'Could not add this to your ticket. Please try again.' });

  // Invalidate any open office/tech editor IMMEDIATELY — the line is on the
  // ticket from this point, so every later exit path (even the price-update
  // 500 below) must leave open editors unable to silently replace it. Then
  // slot the new line into the canonical order (it would otherwise default to
  // sort_order 0 and render at the top of the ticket).
  await bumpLiRev(db, id);
  await recanonicalizeBookingRows(db, id);

  // Bump the existing tax line (if any) by the same rate rather than
  // re-deriving a rate from scratch — matches how tax is stored everywhere
  // else in this codebase (a flat 'fee' line item, not a stored rate column).
  const taxLine = est.line_items.find(li => /^tax\s*\(/i.test(li.name || ''));
  let taxAdd = 0;
  if (taxLine) {
    const rateMatch = /\(([\d.]+)%\)/.exec(taxLine.name || '');
    const rate = rateMatch ? Number(rateMatch[1]) / 100 : 0;
    taxAdd = Math.round(GDS_PRICE * rate * 100) / 100;
    if (taxAdd > 0) {
      await db.from('booking_line_items').update({
        unit_price: Number(taxLine.unit_price) + taxAdd,
        line_total: Number(taxLine.line_total) + taxAdd,
      }).eq('id', taxLine.id);
    }
  }

  const newTotal = Math.round(((Number(est.price) || 0) + GDS_PRICE + taxAdd) * 100) / 100;
  const { error: updErr } = await db.from('bookings').update({ price: newTotal }).eq('id', id);
  if (updErr) return res.status(500).json({ error: 'Added the service, but could not update the ticket total. We will fix this shortly.' });

  return res.status(200).json({ ok: true, already: false, new_total: newTotal });
}

// ── Self-serve reschedule (confirmation-email button) ──────────────────────
// The "Reschedule this appointment" link opens /reschedule.html with a signed
// token (kind=reschedule, booking_id). GET (rescheduleInfo) shows the current
// time plus real open slots (same publicOpenSlots engine the booking widget
// itself uses); POST (rescheduleSubmit) moves the booking and re-assigns a
// tech via the SAME pickOpenTech() call the original booking used. If NO tech
// is open for the requested slot (availability changed between page load and
// confirm, or a crafted request names a slot nobody works), the submit is
// REJECTED — a staffed job is never silently converted into an unstaffed one,
// and a job never lands on a slot no tech marked available.
const RESCHEDULE_CUTOFF_MS = 24 * 60 * 60 * 1000; // matches the email's "not within 24 hours" policy

function rescheduleTokenBookingId(raw) {
  const t = verifyToken((raw || '').toString());
  if (!t || t.kind !== 'reschedule' || !t.booking_id) return null;
  return t.booking_id;
}

async function fetchBookingForReschedule(db, id) {
  const { data, error } = await db.from('bookings')
    .select(`id, business_id, status, scheduled_at, scheduled_end, duration_minutes, service_area_id, postal_code,
             technician_id, secondary_technician_id, extra_slots, metadata,
             service:services ( name ), customer:customers ( name )`)
    .eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: biz, error: bizErr } = await db.from('businesses').select('id, slug, name, timezone').eq('id', data.business_id).maybeSingle();
  if (bizErr) throw bizErr;
  data.business = biz || null;
  return data;
}

// A two-tech (lifting) job or a big job holding extra time slots can't be
// safely moved by the single-slot self-serve flow: the second tech and the
// extra slots would either be silently dragged to an unvalidated time or
// silently dropped, both of which break real scheduling. Those customers are
// asked to call — the office reschedule path handles the extra moving parts.
function rescheduleNeedsOffice(b) {
  return !!(b.secondary_technician_id || (Array.isArray(b.extra_slots) && b.extra_slots.length));
}
const RESCHEDULE_CALL_US = 'This appointment has multiple technicians or extra time reserved — please call or text us to reschedule it.';

async function rescheduleInfo(req, res, body) {
  const token = (req.query.token || (body && body.token) || '').toString();
  const id = rescheduleTokenBookingId(token);
  if (!id) return res.status(401).json({ error: 'This link is invalid or has expired.' });

  const db = serviceClient();
  const b = await fetchBookingForReschedule(db, id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });

  const slug = b.business?.slug || 'handy-andy';
  const serviceAreaId = b.service_area_id || await serviceAreaIdFromPostal(db, b.business_id, b.postal_code);
  const tz = await areaTimezone(db, serviceAreaId, b.business?.timezone || 'America/Denver');

  const blockedReason =
    b.status === 'cancelled' ? 'This appointment has already been cancelled.'
    : b.status === 'completed' ? 'This appointment has already been completed.'
    : b.status === 'no_show' ? 'This appointment can no longer be rescheduled online — please call or text us.'
    : rescheduleNeedsOffice(b) ? RESCHEDULE_CALL_US
    : null;
  if (blockedReason) {
    return res.status(200).json({
      can_reschedule: false,
      reason: blockedReason,
      customer_name: b.customer?.name || '', service_label: b.service?.name || 'Service',
      business_name: b.business?.name || '', current_date: null, current_time: null, days: [], timezone: tz,
    });
  }
  const scheduledMs = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
  const tooSoon = scheduledMs && (scheduledMs - Date.now() < RESCHEDULE_CUTOFF_MS);

  let days = [];
  try {
    const result = await publicOpenSlots(db, { businessSlug: slug, days: 45, serviceAreaId, timezone: tz, crossHire: true });
    days = result.days || [];
  } catch (e) { console.warn('[reschedule_info] availability lookup failed:', e.message); }

  return res.status(200).json({
    can_reschedule: !tooSoon,
    reason: tooSoon ? "This appointment is within 24 hours — please call or text us to reschedule; a $50 late-change fee applies." : null,
    customer_name: b.customer?.name || '',
    service_label: b.service?.name || 'Service',
    business_name: b.business?.name || '',
    // Metro-LOCAL date, not a UTC slice — an 8 PM Denver job is stored as
    // 02:00 UTC the next day, so slicing the ISO string shows the wrong day.
    current_date: b.scheduled_at ? localDateStr(tz, b.scheduled_at) : null,
    current_time: slotTimeLabel(tz, b.scheduled_at),
    business_slug: slug,
    days, timezone: tz,
  });
}

async function rescheduleSubmit(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const token = (body.token || '').toString();
  const id = rescheduleTokenBookingId(token);
  if (!id) return res.status(401).json({ error: 'This link is invalid or has expired.' });

  const db = serviceClient();
  const b = await fetchBookingForReschedule(db, id);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (['cancelled', 'completed', 'no_show'].includes(b.status)) {
    return res.status(409).json({ error: 'This appointment can no longer be rescheduled online — please call or text us.' });
  }
  if (rescheduleNeedsOffice(b)) {
    return res.status(409).json({ error: RESCHEDULE_CALL_US });
  }
  const scheduledMs = b.scheduled_at ? new Date(b.scheduled_at).getTime() : 0;
  if (scheduledMs && (scheduledMs - Date.now() < RESCHEDULE_CUTOFF_MS)) {
    return res.status(409).json({ error: 'This appointment is within 24 hours — please call or text us to reschedule; a $50 late-change fee applies.' });
  }

  const parsed = parseSlotId((body.selected_slot || '').toString());
  const slug = b.business?.slug || 'handy-andy';
  if (!parsed || parsed.businessSlug !== slug) return res.status(400).json({ error: 'Please pick a valid time slot.' });
  const { dateStr, slotKey } = parsed;

  const serviceAreaId = b.service_area_id || await serviceAreaIdFromPostal(db, b.business_id, b.postal_code);
  const tz = await areaTimezone(db, serviceAreaId, b.business?.timezone || 'America/Denver');
  const startUTC = slotStartUTC(tz, dateStr, slotKey);
  const endUTC = slotEndUTC(tz, dateStr, slotKey);
  if (!startUTC) return res.status(400).json({ error: 'Invalid time slot.' });
  if (startUTC.getTime() - Date.now() <= 60 * 60 * 1000) {
    return res.status(409).json({ error: 'That time is too soon — please pick a later slot.' });
  }

  let technician_id = null;
  try { technician_id = await pickOpenTech(db, { businessSlug: slug, dateStr, slotKey, serviceAreaId, timezone: tz, crossHire: true }); }
  catch (e) { console.warn('[reschedule_submit] tech pick failed:', e.message); }
  if (!technician_id) {
    // Hard rule: a job never lands on a slot no tech marked available, and a
    // currently-staffed job is never traded for an unstaffed one. Refuse and
    // let the customer pick again (the page refreshes availability on this).
    return res.status(409).json({ error: 'That time was just taken — please pick a different time.', slot_taken: true });
  }

  const oldLabel = `${b.scheduled_at ? localDateStr(tz, b.scheduled_at) : '?'} ${slotTimeLabel(tz, b.scheduled_at) || ''}`.trim();
  const newLabel = `${dateStr} ${slotTimeLabel(tz, startUTC.toISOString()) || ''}`.trim();

  const { error: updErr } = await db.from('bookings').update({
    scheduled_at: startUTC.toISOString(),
    scheduled_end: endUTC ? endUTC.toISOString() : null,
    technician_id,
    status: 'assigned',
    // Same "rescheduled from" stamp the office-side reschedule writes, so the
    // job card shows this under Date & time regardless of which path moved it.
    metadata: { ...(b.metadata || {}), rescheduled_from: b.scheduled_at },
  }).eq('id', id);
  if (updErr) return res.status(500).json({ error: 'Could not reschedule this appointment. Please try again.' });

  await db.from('booking_notes').insert({
    business_id: b.business_id, booking_id: id,
    author_kind: 'customer', author_id: null, author_name: 'Customer (self-service reschedule)',
    body: `Rescheduled from ${oldLabel} to ${newLabel}.`,
  }).then(({ error }) => { if (error) console.warn('[reschedule_submit] note insert failed:', error.message); })
    .catch(e => console.warn('[reschedule_submit] note insert failed:', e.message));

  // Every send below is AWAITED: this handler returns on the next statement,
  // and an unawaited send lets Vercel freeze the lambda before Twilio is called.
  const ownerPhone = process.env.OWNER_PHONE_NUMBER;
  if (ownerPhone) {
    await sendSMS(ownerPhone, `${b.customer?.name || 'A customer'} just rescheduled their ${b.business?.name || ''} appointment: ${oldLabel} → ${newLabel}.`)
      .catch(e => console.warn('[reschedule_submit] owner SMS failed:', e.message));
  }
  const bizForNotify = b.business || { id: b.business_id };
  // The customer's new slot can land on a DIFFERENT tech than the one who had
  // the job. Tell the previous tech it's off their plate — otherwise they still
  // believe they're working it and may drive out to a job that isn't theirs.
  if (b.technician_id && b.technician_id !== technician_id) {
    await notifyTechAssigned(db, bizForNotify, b.technician_id, b.scheduled_at, tz, { bookingId: id, kind: 'unassigned' })
      .catch(e => console.warn('[reschedule_submit] prior-tech SMS failed:', e.message));
  }
  // Text the newly assigned tech the same way office assignment does — they
  // may be a different person than before, and even the same tech needs to
  // know the job moved.
  await notifyTechAssigned(db, bizForNotify, technician_id, startUTC.toISOString(), tz,
    { bookingId: id, kind: b.technician_id === technician_id ? 'rescheduled' : 'assigned' })
    .catch(e => console.warn('[reschedule_submit] tech SMS failed:', e.message));

  return res.status(200).json({ ok: true, new_date: dateStr, new_time: slotTimeLabel(tz, startUTC.toISOString()) });
}

// ── Review-email tester (public/review-email-tester.html) ─────────────────
// No admin auth — this only ever renders sample data or sends to a single
// hardcoded inbox, so there's nothing here worth gating behind a login.
// The preview action returns the REAL rendered output of reviewEmail() (not
// a hand-copied mockup), so what's shown is byte-for-byte what a customer
// would receive.
// Real, live token (sentinel booking_id 'TEST' — see reviewCheck/reviewSubmit)
// so the button/stars in a test email go through the ACTUAL review_click ->
// review.html -> review flow, not a dead '#' link.
function testReviewClickUrl(bizSlug) {
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  const token = signToken({ kind: 'review', booking_id: 'TEST', business_slug: bizSlug }, 3600);
  return `${baseUrl}/api/book?action=review_click&token=${encodeURIComponent(token)}&ch=email`;
}

function reviewTesterSample(bizSlug) {
  return { firstName: 'Marcus', technicianName: 'Kregg Daniels', clickUrl: testReviewClickUrl(bizSlug) };
}

async function reviewEmailPreview(req, res) {
  const slug = (req.query.business || 'handy-andy').toString();
  const bizSlug = ['doms', 'mile-high', 'austin', 'precision'].includes(slug) ? slug : 'handy-andy';
  const { subject, html } = reviewEmail(reviewTesterSample(bizSlug), brandFor(bizSlug));
  return res.status(200).json({ subject, html });
}

// Fixed recipient — deliberately ignores anything the client sends, so this
// endpoint can never be used to relay mail to an arbitrary address.
const TEST_EMAIL_RECIPIENT = 'andrewtrading04@gmail.com';

async function sendTestReviewEmail(req, res, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const slug = ((body && body.business) || 'handy-andy').toString();
  const bizSlug = ['doms', 'mile-high', 'austin', 'precision'].includes(slug) ? slug : 'handy-andy';
  const brand = brandFor(bizSlug);
  const { subject, html } = reviewEmail(reviewTesterSample(bizSlug), brand);
  const { from } = emailConfig(bizSlug);
  const result = await sendEmail({ slug: bizSlug, to: TEST_EMAIL_RECIPIENT, subject: `[TEST] ${subject}`, html, replyTo: from });
  if (!result.sent) return res.status(500).json({ error: result.error || result.skipped || 'Email did not send.' });
  return res.status(200).json({ ok: true, to: TEST_EMAIL_RECIPIENT });
}

// ── Zenbooker historical job import ─────────────────────────────────────────
// Batch loader for the "All Jobs" export. Idempotent: bookings are keyed on
// zenbooker_job_id, so re-running a batch updates rather than duplicates.
// Customers are MATCHED against the existing roster (phone first, then email)
// because the customer export was already imported; only genuinely new people
// are created. Pass dry_run to get the counts without writing anything.
const ZB_PLACEHOLDER_CREW = {};   // crewId -> label, filled from the request

async function zbImport(req, res, db, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'No rows supplied.' });
  const dry = !!body.dry_run;
  const slug = body.business || 'handy-andy';

  const { data: biz } = await db.from('businesses').select('id, slug').eq('slug', slug).single();
  if (!biz) return res.status(400).json({ error: 'Unknown business ' + slug });

  const { data: areas } = await db.from('service_areas').select('id, name').eq('business_id', biz.id);
  const areaByName = {};
  for (const a of areas || []) areaByName[(a.name || '').toLowerCase()] = a.id;

  // ── technicians: map Zenbooker crew id -> technician row, creating a clearly
  // provisional placeholder when the crew is one we could not name. Renaming
  // the placeholder later re-labels every job automatically (jobs point at the
  // technician row, not at a name string).
  const { data: techs } = await db.from('technicians').select('id, name, zenbooker_provider_id').eq('business_id', biz.id);
  const techByCrew = {};
  for (const t of techs || []) if (t.zenbooker_provider_id) techByCrew[t.zenbooker_provider_id] = t.id;
  const techByName = {};
  for (const t of techs || []) techByName[(t.name || '').toLowerCase()] = t.id;

  const crewNames = body.crew_names || {};
  const neededCrews = [...new Set(rows.map(r => r.crew).filter(Boolean))];
  const createdTechs = [];
  for (const crew of neededCrews) {
    if (techByCrew[crew]) continue;
    const wanted = crewNames[crew];
    // A known name (Juan / Zach) attaches the crew id to the EXISTING tech row
    // rather than creating a duplicate person.
    if (wanted && techByName[wanted.toLowerCase()]) {
      const id = techByName[wanted.toLowerCase()];
      if (!dry) await db.from('technicians').update({ zenbooker_provider_id: crew }).eq('id', id);
      techByCrew[crew] = id;
      continue;
    }
    if (!wanted) continue;   // unnamed crews are handled by the caller
    if (dry) { createdTechs.push(wanted); techByCrew[crew] = '00000000-0000-0000-0000-000000000000'; continue; }
    const { data: nt, error } = await db.from('technicians').insert({
      business_id: biz.id, name: wanted, active: false, status: 'off',
      zenbooker_provider_id: crew,
    }).select('id').single();
    if (error) return res.status(500).json({ error: 'tech insert: ' + error.message });
    techByCrew[crew] = nt.id; createdTechs.push(wanted);
  }

  // ── customer matching, in bulk ────────────────────────────────────────────
  const phones = [...new Set(rows.map(r => r.phone).filter(Boolean))];
  const emails = [...new Set(rows.map(r => r.email).filter(Boolean))];
  const byPhone = {}, byEmail = {};
  for (let i = 0; i < phones.length; i += 200) {
    const { data } = await db.from('customers').select('id, phone').eq('business_id', biz.id).in('phone', phones.slice(i, i + 200));
    for (const c of data || []) if (c.phone) byPhone[c.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')] = c.id;
  }
  for (let i = 0; i < emails.length; i += 200) {
    const { data } = await db.from('customers').select('id, email').eq('business_id', biz.id).in('email', emails.slice(i, i + 200));
    for (const c of data || []) if (c.email) byEmail[c.email.toLowerCase()] = c.id;
  }

  const matched = new Set(), toCreate = new Map();
  for (const r of rows) {
    const hit = (r.phone && byPhone[r.phone]) || (r.email && byEmail[r.email]) || null;
    if (hit) { matched.add(hit); continue; }
    const key = r.phone || r.email;
    if (!toCreate.has(key)) toCreate.set(key, r);
  }

  let created = 0;
  if (!dry && toCreate.size) {
    const payload = [...toCreate.values()].map(r => ({
      business_id: biz.id, name: r.name, phone: r.phone || null, email: r.email || null,
      address_line1: r.line1 || null, address_line2: r.line2 || null,
      city: r.city || null, state: r.state || null, postal_code: r.zip || null,
      stripe_customer_id: r.stripe_cust || null,
      metadata: { imported_from: 'zenbooker_all_jobs' },
    }));
    for (let i = 0; i < payload.length; i += 200) {
      const { data, error } = await db.from('customers').insert(payload.slice(i, i + 200)).select('id, phone, email');
      if (error) return res.status(500).json({ error: 'customer insert: ' + error.message });
      for (const c of data || []) {
        created++;
        if (c.phone) byPhone[c.phone.replace(/\D/g, '')] = c.id;
        if (c.email) byEmail[c.email.toLowerCase()] = c.id;
      }
    }
  }

  if (dry) {
    return res.status(200).json({
      dry_run: true, rows: rows.length,
      customers_matched: matched.size, customers_would_create: toCreate.size,
      techs_would_create: createdTechs, crews_unnamed: neededCrews.filter(c => !techByCrew[c]),
      gds_rows: rows.filter(r => r.gds).length,
    });
  }

  // ── bookings ──────────────────────────────────────────────────────────────
  const bookingRows = [];
  for (const r of rows) {
    const cid = (r.phone && byPhone[r.phone]) || (r.email && byEmail[r.email]) || null;
    if (!cid) continue;
    bookingRows.push({
      business_id: biz.id, customer_id: cid,
      technician_id: techByCrew[r.crew] || null,
      service_area_id: areaByName[(r.market || '').toLowerCase()] || null,
      status: r.status, source: 'import',
      scheduled_at: r.start, duration_minutes: r.duration || 60,
      subtotal: r.subtotal || 0, price: r.price || 0, tip: r.tip || 0,
      payment_status: r.paid ? 'paid' : 'unpaid',
      amount_paid: r.paid ? (r.price || 0) : 0,
      paid_at: r.paid ? (r.completed || r.start) : null,
      stripe_customer_id: r.stripe_cust || null,
      address_line1: r.line1 || null, address_line2: r.line2 || null,
      city: r.city || null, state: r.state || null, postal_code: r.zip || null,
      on_the_way_at: r.enroute, arrived_at: r.arrived, completed_at: r.completed,
      review_rating: r.rating || null,
      zenbooker_job_id: r.zb_id, zenbooker_job_number: r.job_no || null,
      notes: r.svc || null, payment_required: false,
    });
  }
  const savedIds = {};
  for (let i = 0; i < bookingRows.length; i += 200) {
    const { data, error } = await db.from('bookings')
      .upsert(bookingRows.slice(i, i + 200), { onConflict: 'business_id,zenbooker_job_id' })
      .select('id, zenbooker_job_id');
    if (error) return res.status(500).json({ error: 'booking upsert: ' + error.message });
    for (const b of data || []) savedIds[b.zenbooker_job_id] = b.id;
  }

  // ── GDS line items (this is what lights up the ✓ in the customer modal) ────
  const gdsRows = rows.filter(r => r.gds && savedIds[r.zb_id]);
  let gdsWritten = 0;
  if (gdsRows.length) {
    const ids = gdsRows.map(r => savedIds[r.zb_id]);
    const { data: existing } = await db.from('booking_line_items')
      .select('booking_id, name').in('booking_id', ids);
    const have = new Set((existing || []).filter(l => /guaranteed dismount/i.test(l.name || '')).map(l => l.booking_id));
    const payload = gdsRows.filter(r => !have.has(savedIds[r.zb_id])).map(r => ({
      booking_id: savedIds[r.zb_id], business_id: biz.id, kind: 'addon',
      name: 'Guaranteed Dismount Service', quantity: 1, unit_price: 35, line_total: 35,
      taxable: true, zenbooker_ref: r.zb_id, sort_order: 99,
    }));
    if (payload.length) {
      const { error } = await db.from('booking_line_items').insert(payload);
      if (error) return res.status(500).json({ error: 'line item insert: ' + error.message });
      gdsWritten = payload.length;
      // These rows landed on EXISTING bookings outside any editor — invalidate
      // any open editor on each (so its save can't silently drop the GDS line)
      // and slot the line into the canonical order (the raw sort_order 99
      // above would otherwise sit below the tax line). Best-effort per
      // booking, capped so a huge first-run backfill can't push this already
      // heavy import handler into the platform timeout (the inserts above are
      // committed, and re-running would skip them via the `have` dedupe) —
      // anything past the cap is LOGGED, not silently dropped.
      const affected = [...new Set(payload.map(p => p.booking_id))];
      const CANON_CAP = 50;
      for (const bid of affected.slice(0, CANON_CAP)) {
        await bumpLiRev(db, bid);
        await recanonicalizeBookingRows(db, bid);
      }
      if (affected.length > CANON_CAP) {
        console.warn(`[zbimport] GDS backfill touched ${affected.length} bookings; only the first ${CANON_CAP} were re-ordered/rev-bumped this run — the rest keep sort_order 99 until next edited.`);
      }
    }
  }

  return res.status(200).json({
    ok: true, rows: rows.length, customers_matched: matched.size, customers_created: created,
    bookings_written: Object.keys(savedIds).length, gds_line_items: gdsWritten,
    techs_created: createdTechs,
  });
}

// One-off internal notice to every active tech about the GDS-redemption pay
// rate change ($60 -> $50, effective Mon Aug 3 2026 -- see api/_lib/payroll.js's
// GDS_REDEEMED_RATE_CHANGE, which the payroll engine itself gates on the job's
// scheduled date, not on when this code deployed). Recipients are read
// straight from the technicians table (active + has an email on file), never
// from the request. Sent from each tech's OWN business identity (Doms techs
// get a Doms-branded email, Handy Andy techs a Handy Andy one) so it reads as
// coming from the company they actually work for.
async function sendGdsRateUpdate(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { data: rows } = await db.from('technicians')
    .select('name, email, business:businesses ( slug )')
    .eq('active', true).not('email', 'is', null);
  const subject = 'Pay rate update: GDS redemption jobs';
  const results = [];
  for (const t of rows || []) {
    const slug = t.business?.slug || 'handy-andy';
    const firstName = String(t.name || '').trim().split(/\s+/)[0] || 'there';
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222;">
      <p>Hi ${firstName},</p>
      <p>Quick rate sheet update. Starting Monday, August 3, Guaranteed Dismount Service
         redemption jobs (the free TV removal visits, $0 to the customer) now pay $50 per job,
         previously $60.</p>
      <p>Everything else on the rate sheet stays the same.</p>
      <p>Thanks,<br>Andrew</p>
    </div>`;
    const r = await sendEmail({ slug, to: t.email, subject, html });
    results.push({ to: t.email, name: t.name, business: slug, sent: !!r.sent, error: r.error || r.skipped || null });
  }
  return res.status(200).json({ results });
}

// One-off internal notice asking the office to un-spam the brand-new Mile High
// sending address. Recipients are read from the same env vars owner-notify uses
// (never from the request), so this can't be used to relay mail anywhere else.
async function sendSpamNotice(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const to = [
    process.env.MILE_HIGH_SECRETARY_EMAIL || process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com',
    process.env.DOMS_SECRETARY_EMAIL || 'jyrsbries@gmail.com',
  ];
  const subject = 'Quick favor: mark this email as "not spam"';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222;">
    <p>Hi Joey and Heather,</p>
    <p>We just set up the email address for Mile High TV Mounting. Because the address is brand new,
       Gmail does not trust it yet and is filing our messages into spam.</p>
    <p><b>If this email landed in your spam folder, please open it and click "Not spam."</b>
       If it came straight to your inbox, no action needed.</p>
    <p>It also helps to add <b>contact@milehightvmounting.com</b> to your contacts.</p>
    <p>That small step teaches Gmail we are legitimate, so booking confirmations reach our customers
       instead of their spam folders.</p>
    <p>Thanks,<br>Andrew</p>
  </div>`;
  const results = [];
  for (const addr of to) {
    const r = await sendEmail({ slug: 'mile-high', to: addr, subject, html });
    results.push({ to: addr, sent: !!r.sent, error: r.error || r.skipped || null });
  }
  return res.status(200).json({ results });
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
  // Resolve the metro the SAME way estimateSlots did when it offered these
  // times, or "offered" and "bookable" disagree and every approval 409s.
  // estimateSlots keys off the ESTIMATE's zip; this used to key only off the
  // zip the customer types on the details form. When that typed zip isn't in
  // service_area_zips (a typo, or a genuinely-served zip nobody has mapped
  // yet) this came back null, and scopedRosterTechs deliberately contributes
  // NOTHING for a null area — so the strict tech pick found nobody, threw
  // .conflict, and the customer was bounced back to the start after their
  // card had already been tokenized. Falling back to the estimate's own zip
  // keeps both sides on the same roster.
  const bookingAreaId = (await serviceAreaIdFromPostal(db, biz.id, cust.zip))
    || (await serviceAreaIdFromPostal(db, biz.id, est.customer_zip));
  const areaTz = bookingAreaId ? await areaTimezone(db, bookingAreaId, biz.timezone || 'America/Denver') : tz;

  const slotDef = SLOTS.find(s => s.key === slot.slot_key);
  if (!slotDef) { const e = new Error('That time slot is no longer valid — please pick another.'); e.conflict = true; throw e; }
  const [hh, mm] = slotDef.start.split(':').map(Number);
  const midnight = localDateStartUTC(areaTz, slot.date);
  const scheduled_at = new Date(midnight.getTime() + (hh * 60 + mm) * 60000).toISOString();

  // Re-check availability RIGHT NOW — the page may have loaded minutes ago.
  // strict:true — this is a fully automated, customer-triggered booking with
  // no office staffer to confirm an override, so it must never fall back to a
  // tech who merely has no conflicting job (pickAvailableTech's off-schedule
  // second choice) — only someone actually scheduled to work that slot, and
  // only from THIS metro's roster (a multi-metro business must never book its
  // Austin tech onto a Denver estimate just because slot keys match).
  const technician_id = await pickAvailableTech(db, [{ bizId: biz.id, serviceAreaId: bookingAreaId }], slot.date, slot.slot_key, areaTz, null, false, true);
  if (!technician_id) {
    const e = new Error("That time isn't available anymore — please pick another time.");
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

  // Hard $139 minimum ticket (owner rule 2026-08-31) — see MIN_TICKET_PRICE.
  // An estimate is office-authored, so a normal (non-$0) one should already
  // have cleared the same floor at send time, but this is real money about to
  // be charged on approval, so it's checked again here rather than trusted.
  if ((Number(totals.total) || 0) > 0 && Number(totals.total) < MIN_TICKET_PRICE) {
    const e = new Error(`This estimate totals $${Number(totals.total).toFixed(2)}, under the $${MIN_TICKET_PRICE} minimum — it cannot be booked as-is.`);
    e.conflict = true; throw e;
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

  // Canonical ticket order from birth (TVs smallest-first, then work, then
  // travel/discounts); tax gets the next sort_order so it's always the last line.
  const rows = canonicalizeLineItems(combinedItems.map(it => ({
    booking_id: bRow.id, business_id: biz.id, kind: 'option', name: it.description || 'Item',
    quantity: Number(it.qty) || 1, unit_price: Number(it.unit_price) || 0,
    line_total: (Number(it.qty) || 1) * (Number(it.unit_price) || 0),
  }))).map((r, i) => ({ ...r, sort_order: i }));
  if (rows.length) {
    let { error: liErr } = await db.from('booking_line_items').insert(rows);
    if (liErr && isSortOrderErr(liErr)) {
      ({ error: liErr } = await db.from('booking_line_items').insert(rows.map(({ sort_order, ...r }) => r)));
    }
    if (liErr) console.error('[estimate_approve] line items insert failed:', liErr.message);
  }
  if (totals.tax > 0) {
    const taxRow = {
      booking_id: bRow.id, business_id: biz.id, kind: 'fee', name: 'Tax',
      quantity: 1, unit_price: totals.tax, line_total: totals.tax, taxable: false, sort_order: rows.length,
    };
    let { error: taxErr } = await db.from('booking_line_items').insert(taxRow);
    if (taxErr && isSortOrderErr(taxErr)) {
      const { sort_order, ...bare } = taxRow;
      ({ error: taxErr } = await db.from('booking_line_items').insert(bare));
    }
    if (taxErr) console.error('[estimate_approve] tax line item insert failed:', taxErr.message);
  }

  await db.from('booking_status_events').insert({
    booking_id: bRow.id, business_id: biz.id, technician_id,
    status: 'assigned', note: 'Auto-booked from estimate approval',
  });

  const { data: techInfo } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
  await notifyTechAssigned(db, biz, technician_id, scheduled_at, areaTz, { bookingId: bRow.id })
    .catch(e => console.error('[tech-notify]', e.message));

  if (cust.phone) {
    const _d = new Date(scheduled_at);
    const dateStr = _d.toLocaleDateString('en-US', { timeZone: areaTz, weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = _d.toLocaleTimeString('en-US', { timeZone: areaTz, hour: 'numeric', minute: '2-digit' });
    // "He" is a simplification (a technician could be any gender) — matches
    // the exact wording requested; revisit if the roster ever needs it neutral.
    const techLine = techInfo?.name
      ? `${techInfo.name} will text you when he's on the way.`
      : `We'll text you when your tech is on the way.`;
    sendSMS(cust.phone, `You're booked! ✅ We will see you ${dateStr} at ${timeStr}. ${techLine} Reply STOP to opt out.`).catch(console.error);
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
          gdsUpsellUrl: gdsUpsellUrlFor({
            lines: emailLines, bookingId: bRow.id, baseUrl,
            eligible: /tv/i.test(est.service_label || ''),
          }),
          rescheduleUrl: rescheduleUrlFor({ bookingId: bRow.id, baseUrl }),
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
    // Neither branch below writes anything to the `estimates` row — approval
    // isn't recorded until AFTER a successful booking, further down. Without an
    // alert here, a customer who hits this (a slot conflict, or anything else
    // going wrong) leaves zero trace: the estimate just sits "pending," looking
    // exactly like one nobody has looked at yet, and no one at the office knows
    // to follow up — which is exactly the gap that put a customer's card and
    // approval intent in limbo with no human ever notified.
    // Goes to whichever secretary actually runs THIS business (Heather for
    // Handy Andy, Joey for Dom's) — not the owner. Andrew doesn't work these.
    const secretaryPhone = secretaryPhoneFor(est.business?.slug);
    if (secretaryPhone) {
      const reason = e.conflict ? 'their picked time was just taken' : `a booking error (${e.message || 'unknown'})`;
      const slotLabel = chosenSlot ? `${chosenSlot.date || ''} ${chosenSlot.slot_key || ''}`.trim() : 'an unspecified time';
      const msg = `⚠ ${businessName}: ${custName || 'A customer'} (${custPhone || 'no phone on file'}) tried to approve estimate #${est.id} for ${slotLabel} but it failed — ${reason}. They were told someone would reach out. Please call them to finish booking.`;
      sendSMS(secretaryPhone, msg).catch(err => console.warn('[estimate_approve] secretary alert SMS failed:', err));
    } else {
      console.warn(`[estimate_approve] no secretary phone configured for ${est.business?.slug || 'this business'} — failed approval attempt went unnotified:`, est.id, e.message);
    }
    if (e.conflict) return res.status(409).json({ error: e.message, conflict: true });
    console.error('[estimate_approve] auto-book failed:', e.message);
    return res.status(500).json({ error: "We couldn't book your appointment automatically — we've been notified and someone will reach out to finish scheduling you." });
  }

  const now = new Date().toISOString();
  const patch = {
    approved_at: now, accepted_upsells: accepted, approved_total: totals.total,
    customer_name: custName || est.customer_name, customer_phone: custPhone || est.customer_phone,
    customer_address: line1, customer_city: city, customer_state: stateAbbr, customer_zip: zip,
    stripe_customer_id: card.customerId, card_brand: card.brand, card_last4: card.last4,
    preferred_slots: [chosenSlot], status: 'scheduled',
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
// Runs the payroll computation for ONE business over a given Sun–Sat week.
// Shared by payroll() (single-business view) and payrollCombined() (both
// businesses merged into one screen) so the two never drift apart. Each job
// carries business_name/business_slug so a combined, multi-business list can
// still show which company it came from.
async function computeBizPayroll(db, biz, parsedWeek, weekEnd) {
  // All active technicians for this business
  const { data: techs, error: techErr } = await db.from('technicians')
    .select('id, name').eq('business_id', biz.id).eq('active', true).order('name');
  if (techErr) throw techErr;

  // Completed jobs for all techs in the week with payroll computation.
  //
  // `quantity` is REQUIRED in the line-items embed. Most rates survive without
  // it because payQty() can infer the count from line_total/unit_price, but
  // dismountQty() has no such fallback and returns 1, so a job with 2 dismounts
  // charged $120 read as ONE $120 dismount and paid $60 instead of 2 x $50.
  // economicsSelect() (the profit side) has always selected quantity, so
  // omitting it here also made profit and payroll disagree about the same job.
  const { data: jobs, error: jobErr } = await db.from('bookings')
    .select(`
      id, scheduled_at, status, subtotal, price, payment_status, amount_paid, payment_method,
      tip, notes, customer_notes, zenbooker_job_number, postal_code, service_area_id,
      technician_id, secondary_technician_id,
      customers(name), services(name),
      line_items:booking_line_items(kind, name, quantity, unit_price, line_total)
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
    const isHouston = await isHoustonBooking(db, biz.id, biz.slug, b.service_area_id);
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
        scheduled_at: b.scheduled_at,
        travel_payout: travelPayoutByZip.get(String(b.postal_code || '')) || 0,
        // A 2nd tech is on the job — but it only SPLITS 50/50 when the customer
        // booked a two-person job. On a one-person job the lead keeps full pay and
        // the assigned helper earns $0.
        second_tech: (jobTechs[b.id] || []).length > 1,
        is_secondary: techId === b.secondary_technician_id && techId !== b.technician_id,
        is_houston: isHouston,
      }, techPayroll[techId].name);

      const jobBase = {
        id: b.id,
        customer_name: b.customers?.name || 'Unknown',
        service: b.services?.name || 'Service',
        time: new Date(b.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
        scheduled_at: b.scheduled_at,
        business_name: biz.name,
        business_slug: biz.slug,
      };

      if (result.state === 'deferred') {
        techPayroll[techId].deferred.push({ ...jobBase, customer_due: Math.floor((Number(b.price) || 0) - (Number(b.amount_paid) || 0)) });
      } else if (result.state !== 'excluded') {
        // CASH JOB: the tech collected the customer's money and kept it, so the
        // business's share comes back out of their pay. The job's own economics
        // are unchanged (profit is still price − pay elsewhere) — this is purely
        // "pay the tech less because they're already holding the cash", which is
        // why it lives here in payroll and NOT in computeJobPay (profit shares
        // that engine and must not see the deduction).
        //
        // Only the PRIMARY tech is deducted: they're the one who took the money.
        // A helper on the same job is paid normally.
        const collected = (b.payment_method === 'cash' && techId === b.technician_id)
          ? Math.round(Number(b.amount_paid) || Number(b.price) || 0)
          : 0;
        const breakdown = [...(result.breakdown || [])];
        if (collected > 0) breakdown.push({ label: `Cash collected from customer (kept by tech)`, amount: -collected });
        const netPay = result.pay - collected;
        techPayroll[techId].jobs.push({
          ...jobBase,
          tech_pay: netPay,
          cash_collected: collected || undefined,
          breakdown,
          flags: result.flags,
          needs_review: result.flags.length > 0 || result.state === 'partial',
        });
        techPayroll[techId].total += netPay;
      }
    }
  }

  // ── $100 review bonus (all 5 Google listings, migration 0090) ────────────
  // One locked row per tech; surfaced as its own labeled pseudo-job in the
  // Sun-Sat week containing completed_at, under the TECH's home business, so
  // it flows through this screen's totals (and payrollCombined's merge) into
  // exactly what the owner types into the payroll processor. Pushed as a
  // jobs[] entry on purpose: the renderer is generic over job rows, and the
  // "jobs.length > 0" keep-filter below then retains a tech whose only line
  // this week is the bonus. Best-effort: a missing table never breaks payroll.
  try {
    // Half-open week window [Sunday, next Sunday): completed_at is a real
    // wall-clock now() with fractional seconds, and an lte on 23:59:59 would
    // drop a completion landing inside the final second of Saturday into NO
    // week at all (the jobs query above gets away with lte only because slot
    // times are hour-aligned).
    const { data: bonuses } = await db.from('tech_review_bonus')
      .select('technician_id, amount, completed_at, technician:technicians!technician_id(name, business_id)')
      .gte('completed_at', parsedWeek + 'T00:00:00Z')
      .lt('completed_at', addDaysStr(weekEnd, 1) + 'T00:00:00Z');
    for (const bns of bonuses || []) {
      if (bns.technician?.business_id !== biz.id) continue;   // shows under the tech's own business only
      const tId = bns.technician_id;
      // A tech with no jobs this week (or inactive) still gets their bonus row.
      if (!techPayroll[tId]) techPayroll[tId] = { name: bns.technician?.name || 'Technician', jobs: [], deferred: [], total: 0 };
      const amt = Math.round(Number(bns.amount) || 0);
      techPayroll[tId].jobs.push({
        id: `review-bonus-${tId}`,
        bonus: true,   // the client excludes bonus rows from "jobs worked" counts
        customer_name: 'Review bonus',
        service: 'All 5 Google listings reviewed',
        time: '',
        scheduled_at: bns.completed_at,
        business_name: biz.name,
        business_slug: biz.slug,
        tech_pay: amt,
        breakdown: [{ label: 'Review bonus, all 5 Google listings', amount: amt }],
        flags: [],
        needs_review: false,
      });
      techPayroll[tId].total += amt;
    }
  } catch (e) { console.warn('[payroll] review bonus lookup failed:', e.message); }

  // ── One-off bonuses (migration 0105) ─────────────────────────────────────
  // The generic version of the block above: any number per tech, each with its
  // own label. Same pseudo-job treatment for the same reason — it has to reach
  // the number the owner types into the payroll processor, or the tech sees a
  // bonus in their app that never actually gets paid. awarded_on is a plain
  // date, so a simple inclusive range matches the Sun-Sat week exactly.
  try {
    const { data: bonuses } = await db.from('tech_bonuses')
      .select('id, technician_id, amount, reason, awarded_on, technician:technicians!technician_id(name, business_id)')
      .gte('awarded_on', parsedWeek).lte('awarded_on', weekEnd);
    for (const bns of bonuses || []) {
      if (bns.technician?.business_id !== biz.id) continue;   // shows under the tech's own business only
      const amt = Math.round(Number(bns.amount) || 0);
      if (!amt) continue;
      const tId = bns.technician_id;
      if (!techPayroll[tId]) techPayroll[tId] = { name: bns.technician?.name || 'Technician', jobs: [], deferred: [], total: 0 };
      techPayroll[tId].jobs.push({
        id: `bonus-${bns.id}`,
        bonus: true,   // the client excludes bonus rows from "jobs worked" counts
        customer_name: bns.reason || 'Bonus',
        service: 'Bonus',
        time: '',
        scheduled_at: bns.awarded_on,
        business_name: biz.name,
        business_slug: biz.slug,
        tech_pay: amt,
        breakdown: [{ label: bns.reason || 'Bonus', amount: amt }],
        flags: [],
        needs_review: false,
      });
      techPayroll[tId].total += amt;
    }
  } catch (e) { console.warn('[payroll] tech bonus lookup failed:', e.message); }

  return Object.entries(techPayroll)
    .map(([id, t]) => ({ ...t, _id: id }))
    .filter(t => t.jobs.length > 0 || t.deferred.length > 0);
}

// Shared "actual profit" lookup — same hand-entered row shown on both the
// single-business and combined payroll screens (one row per pay_date, not
// per business). Owner-gated by both callers already.
async function actualProfitFor(db, payDate) {
  const { data: profitRow } = await db.from('actual_profit_weekly')
    .select('doms_stripe_payout, handy_andy_stripe_payout, tech_pay').eq('pay_date', payDate).maybeSingle();
  const domsStripe = profitRow?.doms_stripe_payout != null ? Number(profitRow.doms_stripe_payout) : null;
  const haStripe = profitRow?.handy_andy_stripe_payout != null ? Number(profitRow.handy_andy_stripe_payout) : null;
  const techPay = profitRow?.tech_pay != null ? Number(profitRow.tech_pay) : null;
  const allThreeSet = domsStripe != null && haStripe != null && techPay != null;
  return {
    doms_stripe_payout: domsStripe,
    handy_andy_stripe_payout: haStripe,
    tech_pay: techPay,
    total_made: allThreeSet ? (domsStripe + haStripe - techPay) : null,
  };
}

// Payroll displays people the way the owner actually runs payroll (matches
// the contractor list in the payroll processor, sorted by LAST name) rather
// than first-name alphabetical or job-count order. Anyone not in this map
// (a new hire) falls back to sorting by their own first name so they still
// land somewhere sane instead of erroring.
const PAYROLL_LAST_NAME = {
  'TK': 'Adeshewo', 'Juan': 'Beltran', 'Zach': 'Benaya', 'Kregg': 'Buesig',
  'Steve': 'Burns', 'Gregory': 'Gadlin', 'Heather': 'Gonzalez',
};
function sortForPayroll(data) {
  return [...data].sort((a, b) => {
    const la = PAYROLL_LAST_NAME[a.name] || a.name;
    const lb = PAYROLL_LAST_NAME[b.name] || b.name;
    return la.localeCompare(lb);
  });
}

// Heather ($95/day) — how many of the 7 days in this Sun-Sat week her
// availability says she worked, checking the date-specific exception first
// and falling back to the recurring weekly pattern. Powers the payroll
// suggestion below so a week's pay reflects her ACTUAL schedule instead of
// always assuming a full 5-day week.
async function secretaryWorkDaysInWeek(db, bizSlug, weekStart) {
  const { data: biz } = await db.from('businesses').select('id').eq('slug', bizSlug).maybeSingle();
  if (!biz) return 0;
  const { data: pattern } = await db.from('secretary_availability')
    .select('day_of_week, is_available').eq('business_id', biz.id);
  // Exceptions for THIS pay week specifically, not fetchSecretaryAvailability's
  // rolling "last 7 days onward" window. That window is for the dashboard's
  // "upcoming days off" list; using it here silently overpaid, because payroll
  // for a week is run the SECOND Monday after it closes (see _lib/payroll.js),
  // by which point that week's days off had already fallen outside it — so a
  // day the secretary took off was counted and paid as a normal work day.
  const weekEnd = addDaysStr(weekStart, 6);
  const { data: exceptions } = await db.from('secretary_availability_exceptions')
    .select('exception_date, is_available').eq('business_id', biz.id)
    .gte('exception_date', weekStart).lte('exception_date', weekEnd);
  const patternByDow = new Map((pattern || []).map(p => [p.day_of_week, p.is_available]));
  const excByDate = new Map((exceptions || []).map(e => [e.exception_date, e.is_available]));
  let workDays = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDaysStr(weekStart, i);
    const dow = dayOfWeekFor(d);
    const avail = excByDate.has(d) ? excByDate.get(d) : (patternByDow.get(dow) ?? false);
    if (avail) workDays++;
  }
  return workDays;
}
// Heather is paid in US dollars; Joey is paid in Philippine pesos (PHP). Each
// secretary's daily rate carries its own currency — these are NEVER added
// together, and never folded into the technicians' USD payroll total (see
// the currency-aware sum in payroll()/payrollCombined() below).
const SECRETARY_RATE = {
  'handy-andy': { daily: 95, currency: 'USD' },
  'doms': { daily: 2083, currency: 'PHP' },
};
// Approximate PHP -> USD reference rate, for display only (never touches what
// Joey is actually paid — he's paid in pesos, full stop). Update this number
// as the real exchange rate drifts; there's no live FX feed wired in, so it's
// a plain constant rather than silently going stale against a forgotten API.
const PHP_PER_USD = 56.5;
function phpToUsd(php) { return Math.round((Number(php) || 0) / PHP_PER_USD * 100) / 100; }

// Heather (Handy Andy) / Joey (Dom's) aren't technicians — no jobs, no
// per-job pay — but they ARE real payroll: paid their daily rate for every
// day their "My Availability" schedule (weekly pattern + exceptions) says
// they worked that week, $0 for any day they didn't. That's computed here
// automatically and IS the real payroll figure — no manual step required.
// A hand-entered office_pay_weekly value, if one exists, overrides the
// computed number for a one-off adjustment (a partial day, a correction);
// absent that, the automatic total is what's owed.
async function officePayRows(db, weekStart) {
  const { data: row } = await db.from('office_pay_weekly').select('heather_pay, joey_pay, php_rate').eq('week_start', weekStart).maybeSingle();
  // Owner can type in the real PHP->USD rate per week (office_pay_weekly.php_rate);
  // falls back to the plain PHP_PER_USD constant when nothing's been entered.
  const effectiveRate = Number(row?.php_rate) > 0 ? Number(row.php_rate) : PHP_PER_USD;
  const mk = async (name, slug, saved) => {
    const currency = SECRETARY_RATE[slug].currency;
    const usdEq = (total) => currency === 'PHP' ? Math.round((Number(total) || 0) / effectiveRate * 100) / 100 : null;
    if (saved != null) {
      const total = Number(saved);
      return { name, jobs: [], deferred: [], total, is_office: true, is_suggested: false, currency, usd_equivalent: usdEq(total), fx_rate: currency === 'PHP' ? effectiveRate : null };
    }
    const workDays = await secretaryWorkDaysInWeek(db, slug, weekStart);
    const total = workDays * SECRETARY_RATE[slug].daily;
    return { name, jobs: [], deferred: [], total, is_office: true, is_suggested: true, work_days: workDays, currency, usd_equivalent: usdEq(total), fx_rate: currency === 'PHP' ? effectiveRate : null };
  };
  return Promise.all([
    mk('Heather', 'handy-andy', row?.heather_pay),
    mk('Joey', 'doms', row?.joey_pay),
  ]);
}

// Owner-only: set the PHP->USD reference rate for one pay week. Independent
// of the pay amount override — the owner can correct the exchange rate
// without also having to hand-enter Joey's whole week's pay.
async function officePayRateSave(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { week_start, php_rate } = req.body || {};
  if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start)) return res.status(400).json({ error: 'week_start (YYYY-MM-DD) required' });
  if (php_rate == null || isNaN(Number(php_rate)) || Number(php_rate) <= 0) return res.status(400).json({ error: 'php_rate must be a positive number' });

  const { data: existing } = await db.from('office_pay_weekly').select('heather_pay, joey_pay').eq('week_start', week_start).maybeSingle();
  const row = {
    week_start,
    heather_pay: existing?.heather_pay ?? null,
    joey_pay: existing?.joey_pay ?? null,
    php_rate: Number(php_rate),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from('office_pay_weekly').upsert(row, { onConflict: 'week_start' });
  if (error) throw error;
  return res.status(200).json({ ok: true, week_start, php_rate: Number(php_rate) });
}

async function officePaySave(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { week_start, field, amount, clear } = req.body || {};
  const validFields = ['heather_pay', 'joey_pay'];
  if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start)) return res.status(400).json({ error: 'week_start (YYYY-MM-DD) required' });
  if (!validFields.includes(field)) return res.status(400).json({ error: `field must be one of ${validFields.join(', ')}` });
  if (!clear && (amount == null || isNaN(Number(amount)))) return res.status(400).json({ error: 'amount required' });

  const { data: existing } = await db.from('office_pay_weekly').select('heather_pay, joey_pay').eq('week_start', week_start).maybeSingle();
  const row = {
    week_start,
    heather_pay: existing?.heather_pay ?? null,
    joey_pay: existing?.joey_pay ?? null,
    // `clear` removes a manual override so payroll goes back to the
    // automatic (days worked × daily rate) figure for this week.
    [field]: clear ? null : Number(amount),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from('office_pay_weekly').upsert(row, { onConflict: 'week_start' });
  if (error) throw error;
  return res.status(200).json({ ok: true, week_start, field, amount: clear ? null : Number(amount) });
}

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

  const data = await computeBizPayroll(db, biz, parsedWeek, weekEnd);
  const payDate = addDaysStr(weekEnd, PAY_DATE_OFFSET_DAYS);

  // Office staff aren't technicians (no jobs), but the owner runs payroll for
  // them too — add just THIS business's secretary row (Heather for Handy
  // Andy, Joey for Dom's), not both, so a single-business view never shows
  // someone who doesn't work there.
  const officeRows = (await officePayRows(db, parsedWeek))
    .filter(r => (biz.slug === 'handy-andy' && r.name === 'Heather') || (biz.slug === 'doms' && r.name === 'Joey'));
  const allRows = sortForPayroll([...data, ...officeRows]);

  return res.status(200).json({
    week_start: parsedWeek,
    week_end: weekEnd,
    pay_date: payDate,
    techs: allRows,
    // USD only — Joey's peso row is never added into the technicians' dollar
    // total (see currency tag on each row; the client keeps his figure
    // displayed separately instead of folding mismatched currencies together).
    total: allRows.filter(t => (t.currency || 'USD') === 'USD').reduce((sum, t) => sum + t.total, 0),
    actual_profit: await actualProfitFor(db, payDate),
  });
}

// One combined payroll screen for BOTH businesses — so the owner never has to
// flip tabs to find what a cross-hired tech's actual total is for the week.
// Same job-level computation as the single-business view (computeBizPayroll),
// run once per business and merged by technician id — cross-hired techs (e.g.
// Kregg working both Handy Andy and Dom's jobs) share ONE technicians row, so
// merging by id naturally sums their pay across both companies into one line.
async function payrollCombined(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });

  const weekStart = (req.query.week_start || '').toString();
  const rawWeek = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? weekStart : startOfWeekUTC('America/Denver').toISOString().split('T')[0];
  const parsedWeek = addDaysStr(rawWeek, -dayOfWeekFor(rawWeek));
  const weekEnd = addDaysStr(parsedWeek, 6);

  const { data: bizRows, error: bizErr } = await db.from('businesses')
    .select('id, slug, name, timezone').in('slug', ['handy-andy', 'doms']);
  if (bizErr) throw bizErr;

  const perBiz = await Promise.all((bizRows || []).map(biz => computeBizPayroll(db, biz, parsedWeek, weekEnd)));

  // Merge by tech id (the field stashed as _id in computeBizPayroll's result).
  const merged = new Map();
  for (const bizTechs of perBiz) {
    for (const t of bizTechs) {
      if (!merged.has(t._id)) merged.set(t._id, { name: t.name, jobs: [], deferred: [], total: 0 });
      const m = merged.get(t._id);
      m.jobs.push(...t.jobs);
      m.deferred.push(...t.deferred);
      m.total += t.total;
    }
  }
  const payDate = addDaysStr(weekEnd, PAY_DATE_OFFSET_DAYS);
  const officeRows = await officePayRows(db, parsedWeek);   // both Heather and Joey — combined view spans both businesses
  const data = sortForPayroll([...merged.values(), ...officeRows]);

  return res.status(200).json({
    week_start: parsedWeek,
    week_end: weekEnd,
    pay_date: payDate,
    techs: data,
    total: data.filter(t => (t.currency || 'USD') === 'USD').reduce((sum, t) => sum + t.total, 0),
    actual_profit: await actualProfitFor(db, payDate),
    combined: true,
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

// ── Secretary availability ("My Availability" / "Secretaries") ─────────────
// Whole-day on/off per business (Heather = Handy Andy, Joey = Dom's) — no
// time-of-day slots, since a secretary is paid a flat $95/day, not per job.
// A secretary's own login is already scoped to exactly one business (see
// login(): the shared per-business password sets role:'secretary',
// scope:'<slug>'), so "Heather only sees her own availability" and "Joey
// only sees his" fall out of that scoping for free — no new identity system
// needed. The owner (role:'owner', scope:'all') can view (not edit) both
// under the "Secretaries" menu.
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function fetchSecretaryAvailability(db, bizId) {
  const { data: pattern, error: pErr } = await db.from('secretary_availability')
    .select('day_of_week, is_available').eq('business_id', bizId).order('day_of_week');
  if (pErr) throw pErr;
  const { data: exceptions, error: eErr } = await db.from('secretary_availability_exceptions')
    .select('exception_date, is_available').eq('business_id', bizId)
    .gte('exception_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
    .order('exception_date');
  if (eErr) throw eErr;
  return { pattern: pattern || [], exceptions: exceptions || [] };
}

// GET — a secretary sees their OWN business (from their token's scope); the
// owner must pass ?business= to pick which one.
async function secretaryAvailability(req, res, db, auth) {
  let slug;
  if (auth.role === 'secretary') slug = auth.scope;
  else if (auth.role === 'owner') slug = (req.query.business || '').toString();
  else return res.status(403).json({ error: 'Not authorized' });
  if (!slug || !['handy-andy', 'doms'].includes(slug)) return res.status(400).json({ error: 'business required' });

  const { data: biz, error: bizErr } = await db.from('businesses').select('id, slug').eq('slug', slug).maybeSingle();
  if (bizErr) throw bizErr;
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  const { pattern, exceptions } = await fetchSecretaryAvailability(db, biz.id);
  return res.status(200).json({
    business_slug: slug, name: displayNameFor(slug), pattern, exceptions, day_names: DOW_NAMES,
    daily_rate: SECRETARY_RATE[slug].daily, currency: SECRETARY_RATE[slug].currency,
  });
}

// POST — set the recurring weekly pattern for ONE day. Secretary-only, and
// always scoped to THEIR OWN business (auth.scope) — a request body business
// field is never trusted, so Heather's session can never edit Joey's days.
async function secretaryAvailabilitySet(req, res, db, auth) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'secretary') return res.status(403).json({ error: 'Secretary only' });
  const dayOfWeek = parseInt(req.body?.day_of_week, 10);
  const isAvailable = !!(req.body || {}).is_available;
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return res.status(400).json({ error: 'day_of_week (0-6) required' });

  const { data: biz, error: bizErr } = await db.from('businesses').select('id').eq('slug', auth.scope).maybeSingle();
  if (bizErr) throw bizErr;
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  // Read the prior value BEFORE the upsert so the owner's feed can describe a
  // real change ("was working -> now off") instead of just the end state.
  const { data: prevRow } = await db.from('secretary_availability')
    .select('is_available').eq('business_id', biz.id).eq('day_of_week', dayOfWeek).maybeSingle();

  const { error } = await db.from('secretary_availability')
    .upsert({ business_id: biz.id, day_of_week: dayOfWeek, is_available: isAvailable, updated_at: new Date().toISOString() },
      { onConflict: 'business_id,day_of_week' });
  if (error) throw error;

  await recordSecretaryChange(db, {
    biz, scope: auth.scope, kind: 'weekly',
    dayOfWeek, isAvailable, previous: prevRow ? prevRow.is_available : null,
  });
  return res.status(200).json({ ok: true, day_of_week: dayOfWeek, is_available: isAvailable });
}

// Record a secretary schedule change for the owner's dashboard feed, and text
// the owner. Best-effort throughout: the schedule change itself is already
// committed by the time this runs, so a logging or SMS failure must never turn
// a successful save into an error for Heather/Joey.
async function recordSecretaryChange(db, { biz, scope, kind, dayOfWeek = null, dateStr = null, isAvailable, previous, actor = 'secretary' }) {
  // Nothing actually changed (re-saving the same value) — don't cry wolf.
  if (previous !== null && previous === isAvailable) return;
  // Name who actually did it. An owner booking a day off on someone's behalf
  // must not show up in the feed as the secretary having done it themselves —
  // the whole point of this log is knowing who changed what.
  const subject = displayNameFor(scope);
  const who = actor === 'owner' ? `Owner (for ${subject})` : subject;
  try {
    await db.from('secretary_schedule_changes').insert({
      business_id: biz.id, changed_by: who, kind,
      day_of_week: kind === 'weekly' ? dayOfWeek : null,
      exception_date: kind === 'exception' ? dateStr : null,
      is_available: isAvailable, previous_available: previous,
    });
  } catch (e) { console.warn('[secretary-change] log failed:', e.message); }

  try {
    const ownerPhone = process.env.OWNER_PHONE_NUMBER;
    if (!ownerPhone) return;
    const when = kind === 'weekly'
      ? `every ${DOW_NAMES[dayOfWeek] || `day ${dayOfWeek}`}`
      : (() => { try { return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); }
                 catch { return dateStr; } })();
    const what = isAvailable
      ? (kind === 'weekly' ? `is now WORKING ${when}` : `is now WORKING on ${when}`)
      : (kind === 'weekly' ? `is now OFF ${when}` : `took ${when} OFF`);
    await sendSMS(ownerPhone, `Schedule change: ${who} ${what}.`);
  } catch (e) { console.warn('[secretary-change] owner SMS failed:', e.message); }

  // Tell the crew when the office is closed on a specific day. Scoped tightly
  // on purpose:
  //   * one-off dates only, never a weekly-pattern edit. "Heather is now off
  //     every Sunday" is a standing arrangement the techs already live with;
  //     texting all of them every time it's re-saved is pure noise.
  //   * only when going OFF. Putting a day BACK to working is a correction the
  //     office cares about, not something the techs need woken up for.
  // The techs of the affected business only, because that is whose office
  // phone goes unanswered that day.
  if (kind === 'exception' && !isAvailable) {
    try {
      const { data: techs } = await db.from('technicians')
        .select('name, phone').eq('business_id', biz.id).eq('active', true);
      const reachable = (techs || []).filter(t => t.phone);
      if (reachable.length) {
        const dayTxt = (() => { try { return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }); }
                                catch { return dateStr; } })();
        const msg = `Heads up: ${subject} is OFF ${dayTxt}, so the office phone won't be covered that day. Reach the owner directly if you need something.`;
        for (const t of reachable) {
          const r = await sendSMSResult(t.phone, msg);
          if (!r.ok) console.warn(`[secretary-change] tech SMS failed for ${t.name}:`, r.error || r.skipped);
        }
      }
    } catch (e) {
      // Never let a crew alert fail the schedule change itself — the day off is
      // already saved and visible by this point.
      console.warn('[secretary-change] tech alert failed:', e.message);
    }
  }
}

// POST — a one-off exception for a specific date (e.g. a day off this week
// only). Same secretary-only, own-business-only scoping as the weekly set.
// POST — a one-off day for a specific date, overriding the weekly pattern.
//
// Two callers with different rules:
//   secretary — their OWN business only, taken from auth.scope. A body
//               `business` field is never trusted, so Heather can never edit
//               Joey's calendar.
//   owner     — either secretary, and must name which via body.business. This
//               is how the office books a day off on someone's behalf ("Joey
//               told me he's out on the 12th") without logging in as them.
//
// `remove: true` deletes the override so the date falls back to the weekly
// pattern, rather than leaving a redundant row that says the same thing.
async function secretaryAvailabilityExceptionSet(req, res, db, auth) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  let scope;
  if (auth.role === 'secretary') scope = auth.scope;
  else if (auth.role === 'owner') scope = (body.business || '').toString();
  else return res.status(403).json({ error: 'Not authorized' });
  if (!scope || !['handy-andy', 'doms'].includes(scope)) return res.status(400).json({ error: 'business required' });

  const date = (body.date || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  const remove = !!body.remove;
  const isAvailable = !!body.is_available;

  const { data: biz, error: bizErr } = await db.from('businesses').select('id').eq('slug', scope).maybeSingle();
  if (bizErr) throw bizErr;
  if (!biz) return res.status(404).json({ error: 'Business not found' });

  // What the weekly pattern says for this weekday — needed both as the "prior
  // state" fallback and as the value the date reverts to when an override is
  // removed.
  let patternSays = null;
  try {
    const dow = dayOfWeekFor(date);
    const { data: pat } = await db.from('secretary_availability')
      .select('is_available').eq('business_id', biz.id).eq('day_of_week', dow).maybeSingle();
    if (pat) patternSays = pat.is_available;
  } catch { /* fall back to "no prior state" */ }

  // Prior state for this exact date: an existing override if there is one,
  // otherwise the weekly pattern — so "took Friday off" is only reported when
  // Friday was actually a work day.
  const { data: prevEx } = await db.from('secretary_availability_exceptions')
    .select('is_available').eq('business_id', biz.id).eq('exception_date', date).maybeSingle();
  const previous = prevEx ? prevEx.is_available : patternSays;

  if (remove) {
    const { error: delErr } = await db.from('secretary_availability_exceptions')
      .delete().eq('business_id', biz.id).eq('exception_date', date);
    if (delErr) throw delErr;
    // The date now means whatever the weekly pattern means. Only worth logging
    // if that is actually different from the override we just deleted.
    await recordSecretaryChange(db, {
      biz, scope, actor: auth.role === 'owner' ? 'owner' : 'secretary', kind: 'exception',
      dateStr: date, isAvailable: patternSays === null ? true : patternSays, previous,
    });
    return res.status(200).json({ ok: true, date, removed: true, reverts_to: patternSays });
  }

  const { error } = await db.from('secretary_availability_exceptions')
    .upsert({ business_id: biz.id, exception_date: date, is_available: isAvailable, updated_at: new Date().toISOString() },
      { onConflict: 'business_id,exception_date' });
  if (error) throw error;

  await recordSecretaryChange(db, {
    biz, scope, actor: auth.role === 'owner' ? 'owner' : 'secretary', kind: 'exception',
    dateStr: date, isAvailable, previous,
  });
  return res.status(200).json({ ok: true, date, is_available: isAvailable });
}

// GET — owner-only feed of secretary schedule changes, newest first, with an
// unread count for the nav badge. Read-only; marking read is a separate POST
// so simply opening the page doesn't silently clear the badge.
async function secretaryChanges(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { data, error } = await db.from('secretary_schedule_changes')
    .select('id, business_id, changed_by, kind, day_of_week, exception_date, is_available, previous_available, seen_at, created_at, business:businesses ( slug, name )')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  const changes = (data || []).map(c => ({
    id: c.id, changed_by: c.changed_by, kind: c.kind,
    day_of_week: c.day_of_week, day_name: c.day_of_week != null ? DOW_NAMES[c.day_of_week] : null,
    exception_date: c.exception_date, is_available: c.is_available,
    previous_available: c.previous_available, seen: !!c.seen_at, created_at: c.created_at,
    business_slug: c.business?.slug || null, business_name: c.business?.name || null,
  }));
  return res.status(200).json({ changes, unseen: changes.filter(c => !c.seen).length });
}

// POST — mark schedule changes read. { id } for one, or { all:true } for the lot.
async function secretaryChangesSeen(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const now = new Date().toISOString();
  let q = db.from('secretary_schedule_changes').update({ seen_at: now }).is('seen_at', null);
  if (!body.all) {
    const id = (body.id || '').toString();
    if (!id) return res.status(400).json({ error: 'id or all:true required' });
    q = q.eq('id', id);
  }
  const { error } = await q;
  if (error) throw error;
  return res.status(200).json({ ok: true });
}

// GET — owner-only "Secretaries" admin view: both Heather's and Joey's
// weekly pattern + upcoming exceptions side by side.
async function secretariesList(req, res, db, auth) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const { data: bizRows, error: bizErr } = await db.from('businesses')
    .select('id, slug').in('slug', ['handy-andy', 'doms']);
  if (bizErr) throw bizErr;

  const secretaries = await Promise.all((bizRows || []).map(async biz => {
    const { pattern, exceptions } = await fetchSecretaryAvailability(db, biz.id);
    return {
      business_slug: biz.slug, name: displayNameFor(biz.slug), pattern, exceptions,
      daily_rate: SECRETARY_RATE[biz.slug].daily, currency: SECRETARY_RATE[biz.slug].currency,
    };
  }));
  return res.status(200).json({ secretaries, day_names: DOW_NAMES });
}

// ── Bracket Inventory ────────────────────────────────────────────────────────
// Get current bracket inventory for all technicians in the business
async function bracketInventory(req, res, db, auth) {
  // A tech carries ONE physical stock of brackets in their truck regardless of
  // which company's customer they're serving that day (see the matching
  // comment on adjustBracketInventory) — same "shared resource" reasoning
  // bracketPurchases already uses. So this reads across EVERY active
  // business's technicians, not just the one currently loaded in the
  // dashboard (found 2026-09-02: the Inventory tab only ever showed whoever
  // belonged to the currently-viewed company, silently hiding the other
  // company's techs entirely). resolveBusiness still runs first, purely to
  // enforce the caller's own auth/scope.
  let biz; try { biz = await resolveBusiness(db, auth, req.query.business); } catch (e) { return bail(res, e); }

  const { data: bizes } = await db.from('businesses').select('id, slug').eq('active', true);
  const slugById = new Map((bizes || []).map(b => [b.id, b.slug]));
  const bizIds = (bizes || []).map(b => b.id);

  let { data: inv, error } = await db.from('bracket_inventory')
    .select(`id, business_id, technician_id, flat_qty, tilting_qty, full_motion_qty, wire_plate_qty, appletv_bracket_qty, updated_at,
             technician:technicians ( id, name )`)
    .in('business_id', bizIds);
  // appletv_bracket_qty arrives with migration 0087; degrade to the pre-0087
  // select, then the pre-0039 select, so this endpoint never breaks on an
  // environment that hasn't run every migration yet.
  if (error && /appletv_bracket_qty/.test(error.message || '')) {
    ({ data: inv, error } = await db.from('bracket_inventory')
      .select(`id, business_id, technician_id, flat_qty, tilting_qty, full_motion_qty, wire_plate_qty, updated_at,
               technician:technicians ( id, name )`)
      .in('business_id', bizIds));
  }
  // wire_plate_qty arrives with migration 0039; degrade gracefully if not applied yet.
  if (error && /wire_plate_qty/.test(error.message || '')) {
    ({ data: inv, error } = await db.from('bracket_inventory')
      .select(`id, business_id, technician_id, flat_qty, tilting_qty, full_motion_qty, updated_at,
               technician:technicians ( id, name )`)
      .in('business_id', bizIds));
  }
  if (error) throw error;

  // Ensure every active tech (on ANY business) has an inventory row (create if missing)
  const { data: techs } = await db.from('technicians')
    .select('id, name, business_id').in('business_id', bizIds).eq('active', true).order('name');

  const invByTech = new Map((inv || []).map(i => [i.technician_id, i]));
  const missing = (techs || []).filter(t => !invByTech.has(t.id));

  if (missing.length) {
    const toInsert = missing.map(t => ({
      business_id: t.business_id,
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
      business_id: t.business_id,
      technician_id: t.id,
      flat_qty: 0,
      tilting_qty: 0,
      full_motion_qty: 0,
      updated_at: new Date().toISOString(),
      technician: { id: t.id, name: t.name },
    }))
  );

  // Which BUSINESSES actually stock wire-concealment plates? The wire_plate_qty
  // column is `not null default 0`, so a 0 can mean either "ran out" or "never
  // tracked". Businesses that don't do behind-the-wall wire concealment (e.g.
  // Handy Andy) sit at 0 forever, so a blanket "0 <= 3 = low" fires a permanent
  // false alarm. Distinguish via purchase history: a business is plate-tracked
  // if it has ever ordered plates; a tech is plate-tracked if THEIR business is
  // OR they currently hold >0. Untracked techs are excluded from plate low-stock
  // warnings; a tracked tech who genuinely burns to 0 STILL warns (real shortage).
  // Computed per business now (was a single bool for just the loaded business).
  const plateTrackedBizIds = new Set();
  try {
    const { data: plateRows } = await db.from('wire_plate_purchases')
      .select('business_id').in('business_id', bizIds);
    for (const r of (plateRows || [])) plateTrackedBizIds.add(r.business_id);
  } catch { /* table missing on older deploys → treat as untracked (no false alarms) */ }

  return res.status(200).json({
    inventory: final.map(i => ({
      technician_id: i.technician_id,
      technician_name: i.technician?.name || 'Unknown',
      business: slugById.get(i.business_id) || null,
      flat: i.flat_qty || 0,
      tilting: i.tilting_qty || 0,
      full_motion: i.full_motion_qty || 0,
      total: (i.flat_qty || 0) + (i.tilting_qty || 0) + (i.full_motion_qty || 0),
      wire_plate: i.wire_plate_qty || 0,
      wire_plate_tracked: plateTrackedBizIds.has(i.business_id) || (i.wire_plate_qty || 0) > 0,
      appletv_bracket: i.appletv_bracket_qty || 0,
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
// Add/subtract PLATES on a tech's on-hand count (delta can be negative). This
// is the crediting-side helper — NOT the same as adjustWirePlateInventory
// below, which only ever DEDUCTS for job usage. Mirrors api/migrate.js's
// adjustWirePlateInv exactly (that one isn't importable from here — separate
// serverless function — so the logic is duplicated on purpose; keep them in
// sync if this ever changes).
async function creditWirePlateInv(db, businessId, technicianId, delta) {
  if (!delta) return;
  const { data: inv, error } = await db.from('bracket_inventory')
    .select('id, wire_plate_qty').eq('business_id', businessId).eq('technician_id', technicianId).maybeSingle();
  if (error) { if (/wire_plate_qty/.test(error.message || '')) return; throw error; }
  if (!inv) {
    await db.from('bracket_inventory').insert({
      business_id: businessId, technician_id: technicianId, wire_plate_qty: Math.max(0, delta),
    });
    return;
  }
  await db.from('bracket_inventory')
    .update({ wire_plate_qty: Math.max(0, (inv.wire_plate_qty || 0) + delta) })
    .eq('id', inv.id);
}

// Owner-only manual override for one wire-plate (Amazon) order's status. The
// automated path (scripts/bracket-email-sync.mjs) only ever learns of a
// delivery if Amazon actually SENDS a "Delivered" email to the scanned
// mailbox — it doesn't always (often it's an app-only push notification, no
// email at all) — so an order Amazon's own site shows as delivered can sit
// stuck "En route" here forever with nothing to fix it. The Walmart bracket
// table already had this exact control (bracketSetStatus below); the Amazon
// wire-plate table never got one. Mirrors wirePlateSync's (api/migrate.js)
// own crediting rule: plates only count toward a tech's on-hand total the
// moment the order is DELIVERED, and only once (credited is a one-way latch
// until a cancel/return claws them back out).
async function wirePlateSetStatus(req, res, db, auth, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change plate order status.' });
  const id = (body.id || '').toString().trim();
  const status = (body.status || '').toString().trim();
  if (!['in_route', 'delivered', 'canceled'].includes(status)) {
    return res.status(400).json({ error: 'status must be in_route, delivered, or canceled' });
  }
  if (!id) return res.status(400).json({ error: 'id required' });

  let hasCredited = true;
  let { data: row, error: rowErr } = await db.from('wire_plate_purchases')
    .select('id, business_id, status, plates, technician_id, credited').eq('id', id).maybeSingle();
  if (rowErr && /credited/.test(rowErr.message || '')) {
    hasCredited = false;
    ({ data: row, error: rowErr } = await db.from('wire_plate_purchases')
      .select('id, business_id, status, plates, technician_id').eq('id', id).maybeSingle());
  }
  if (rowErr) throw rowErr;
  if (!row) return res.status(404).json({ error: 'Order not found' });

  const wasCredited = hasCredited && !!row.credited;
  if (wasCredited) {
    // Already counted toward a tech's on-hand total — a status change from here
    // is cosmetic EXCEPT a cancel/return, which claws the credited plates back.
    if (status === 'canceled' && row.status !== 'canceled') {
      await creditWirePlateInv(db, row.business_id, row.technician_id, -(row.plates || 0));
      await db.from('wire_plate_purchases').update({ status: 'canceled', credited: false }).eq('id', id);
      return res.status(200).json({ ok: true, status: 'canceled', plates_removed: row.plates || 0 });
    }
    const { error } = await db.from('wire_plate_purchases').update({ status }).eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true, status });
  }

  const patch = { status, delivered_date: status === 'delivered' ? new Date().toISOString().slice(0, 10) : null };
  let credited = false;
  if (hasCredited && status === 'delivered' && row.technician_id) {
    await creditWirePlateInv(db, row.business_id, row.technician_id, row.plates || 0);
    patch.credited = true;
    credited = true;
  }
  const { error } = await db.from('wire_plate_purchases').update(patch).eq('id', id);
  if (error) throw error;
  return res.status(200).json({ ok: true, status, credited });
}

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

  // The owner's dropdown looked like a stock control but used to be JUST a
  // label — flipping it to "Delivered" never moved inventory (found in the
  // 2026-09-03 audit: an auto-assigned order marked delivered this way was
  // NEVER credited, and the cron would never credit it either since its status
  // already read 'delivered'). Fetch the row(s) first so a status change here
  // can credit/reverse through the ledger exactly like the automated sync does.
  let sel = db.from('bracket_purchases')
    .select('id, business_id, technician_id, status, walmart_order_num, flat_qty, tilting_qty, full_motion_qty');
  sel = orderNum ? sel.eq('walmart_order_num', orderNum) : sel.eq('id', id);
  const { data: rows, error: selErr } = await sel;
  if (selErr) throw selErr;
  if (!rows || !rows.length) return res.status(404).json({ error: 'Order not found' });

  const patch = { status, delivered_date: status === 'delivered' ? new Date().toISOString().slice(0, 10) : null };
  for (const row of rows) {
    if (row.technician_id) {
      const key = row.walmart_order_num || row.id;
      const qtys = { flat: row.flat_qty || 0, tilting: row.tilting_qty || 0, full_motion: row.full_motion_qty || 0 };
      if (status === 'delivered' && row.status !== 'delivered' && bracketMoveTotal(qtys) > 0) {
        const { data: tech } = await db.from('technicians').select('business_id').eq('id', row.technician_id).maybeSingle();
        await ledgerCreditDelivery(db, {
          businessId: tech?.business_id || row.business_id, technicianId: row.technician_id,
          qtys, purchaseId: row.id, orderNum: key, actor: auth.name || auth.role || 'owner',
        });
      } else if (status === 'canceled' && row.status === 'delivered' && bracketMoveTotal(qtys) > 0) {
        // Keyed on (orderNum, 'canceled') so clicking Cancel twice on the same
        // order claws the credit back exactly once, not once per click.
        const { data: tech } = await db.from('technicians').select('business_id').eq('id', row.technician_id).maybeSingle();
        await ledgerAdjustDelivery(db, {
          businessId: tech?.business_id || row.business_id, technicianId: row.technician_id,
          deltaQtys: { flat: -qtys.flat, tilting: -qtys.tilting, full_motion: -qtys.full_motion },
          purchaseId: row.id, orderNum: key, tag: 'canceled',
          reason: 'order canceled after delivery credit — clawing back', actor: auth.name || auth.role || 'owner',
        });
      }
    }
  }

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

  // Brackets are shared across companies (same reasoning as bracket_inventory
  // and bracketAssign) — the Inventory tab now lists every business's techs
  // together, so this edits the tech's OWN home business row, not whichever
  // business tab happened to be loaded when the office opened the modal.
  const { data: tech } = await db.from('technicians').select('id, business_id').eq('id', techId).single();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  const techBizId = tech.business_id;

  // Get or create inventory row
  let { data: inv } = await db.from('bracket_inventory')
    .select('*').eq('technician_id', techId).eq('business_id', techBizId).maybeSingle();

  if (!inv) {
    await db.from('bracket_inventory').insert({
      business_id: techBizId,
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

  // Apple TV brackets (migration 0087). No email pipeline for these -- Amazon's
  // order-confirmation email for this product carries no distinguishing text,
  // so a tech's stock is credited by typing the new total here, same as wire
  // plates, just always by hand instead of usually by the Amazon sync.
  const wantsAppleTv = body.appletv_bracket_delta != null && body.appletv_bracket_delta !== 0;
  const hasAppleTvCol = Object.prototype.hasOwnProperty.call(inv, 'appletv_bracket_qty');
  const appleTv = (inv.appletv_bracket_qty || 0) + (body.appletv_bracket_delta || 0);

  // Ensure no negative inventory
  if (flat < 0 || tilting < 0 || fullMotion < 0 || (wantsWirePlate && wirePlate < 0) || (wantsAppleTv && appleTv < 0)) {
    return res.status(400).json({ error: 'Insufficient inventory for this operation' });
  }

  // flat/tilting/full_motion go ONLY through bracket_move (migration 0088) —
  // it is the sole writer of those three columns and it always logs a signed
  // ledger row with a reason, which is exactly what was missing when TK/Greg/
  // Juan/Steve's manual resets left no trace for the 2026-09-02 backfill to
  // check against. wire_plate/appletv_bracket are not on the ledger yet and
  // still go through the direct update below.
  const actor = auth.name || auth.role || 'owner';
  if (isSet) {
    await ledgerRecount(db, {
      businessId: techBizId, technicianId: techId,
      flat, tilting, fullMotion,
      reason: body.notes || 'manual recount by office', actor,
    });
  } else {
    await ledgerAdjust(db, {
      businessId: techBizId, technicianId: techId,
      deltaQtys: { flat: body.flat_delta || 0, tilting: body.tilting_delta || 0, full_motion: body.full_motion_delta || 0 },
      bookingId: body.booking_id || null,
      reason: body.notes || (action === 'usage' ? 'manual usage log by office' : 'manual adjustment by office'),
      actor,
    });
  }

  // wire_plate / appletv_bracket: still a direct update (not yet on the ledger).
  const patch = {};
  if (wantsWirePlate && hasWirePlateCol) patch.wire_plate_qty = wirePlate;
  if (wantsAppleTv && hasAppleTvCol) patch.appletv_bracket_qty = appleTv;
  if (Object.keys(patch).length) {
    const { error: e1 } = await db.from('bracket_inventory').update(patch)
      .eq('technician_id', techId).eq('business_id', techBizId);
    if (e1) throw e1;
  }

  // Log wire_plate/appletv manual corrections the old way — flat/tilting/
  // full_motion are now logged by bracket_move itself, so only mention those
  // two columns here to avoid a duplicate/contradictory ledger entry.
  if ((action === 'set' || action === 'adjust') && ((wantsWirePlate && hasWirePlateCol && (inv.wire_plate_qty || 0) !== wirePlate) || (wantsAppleTv && hasAppleTvCol && (inv.appletv_bracket_qty || 0) !== appleTv))) {
    try {
      const changes = [];
      if (wantsWirePlate && hasWirePlateCol && (inv.wire_plate_qty || 0) !== wirePlate) changes.push(`wire_plate ${inv.wire_plate_qty || 0}→${wirePlate}`);
      if (wantsAppleTv && hasAppleTvCol && (inv.appletv_bracket_qty || 0) !== appleTv) changes.push(`appletv ${inv.appletv_bracket_qty || 0}→${appleTv}`);
      await db.from('bracket_usage_logs').insert({
        business_id: techBizId, booking_id: body.booking_id || null, technician_id: techId,
        logged_by_kind: 'admin',
        notes: `manual ${action} by office: ${changes.join(', ')}${body.notes ? ` — ${body.notes}` : ''}`,
      });
    } catch (e) { console.error('[bracket] manual-change log failed:', e.message); }
  }

  // Log wire_plate/appletv usage the old way (flat/tilting/full_motion usage
  // is now logged by bracket_move itself).
  if (action === 'usage' && (wantsWirePlate || wantsAppleTv)) {
    const log = {
      business_id: techBizId,
      booking_id: body.booking_id || null,
      technician_id: techId,
      flat_used: 0, tilting_used: 0, full_motion_used: 0,
      logged_by_kind: 'admin',
      notes: body.notes || null,
    };
    if (wantsWirePlate && hasWirePlateCol) log.wire_plate_used = Math.abs(body.wire_plate_delta || 0);
    if (wantsAppleTv && hasAppleTvCol) log.appletv_bracket_used = Math.abs(body.appletv_bracket_delta || 0);
    await db.from('bracket_usage_logs').insert(log);
  }

  // A positive Apple TV delta from a non-usage action is a manual "these
  // arrived" entry -- log it for a future history view even though nothing
  // reads this table yet. Best-effort: never blocks the inventory write above,
  // which already succeeded by this point.
  if (wantsAppleTv && hasAppleTvCol && action !== 'usage' && body.appletv_bracket_delta > 0) {
    try {
      await db.from('appletv_bracket_log').insert({
        business_id: techBizId, technician_id: techId,
        qty: body.appletv_bracket_delta, added_by: auth.name || auth.role || 'owner',
        notes: body.notes || null,
      });
    } catch (e) { console.error('[appletv_bracket] arrival log failed:', e.message); }
  }

  // Re-read after bracket_move's atomic write — flat/tilting/full_motion may
  // differ from the locally-computed values above if another mover (a job
  // completing, a delivery landing) raced this request.
  const { data: freshInv } = await db.from('bracket_inventory')
    .select('flat_qty, tilting_qty, full_motion_qty, wire_plate_qty, appletv_bracket_qty')
    .eq('technician_id', techId).eq('business_id', techBizId).maybeSingle();
  const outFlat = freshInv ? (freshInv.flat_qty || 0) : flat;
  const outTilting = freshInv ? (freshInv.tilting_qty || 0) : tilting;
  const outFullMotion = freshInv ? (freshInv.full_motion_qty || 0) : fullMotion;
  return res.status(200).json({
    ok: true,
    inventory: {
      flat_qty: outFlat,
      tilting_qty: outTilting,
      full_motion_qty: outFullMotion,
      wire_plate_qty: hasWirePlateCol ? (freshInv ? (freshInv.wire_plate_qty || 0) : wirePlate) : 0,
      appletv_bracket_qty: hasAppleTvCol ? (freshInv ? (freshInv.appletv_bracket_qty || 0) : appleTv) : 0,
      total: outFlat + outTilting + outFullMotion,
    },
  });
}

// Wire concealment plates used on a job: one per unit of the "Hide wires BEHIND
// the wall" service. Mirrors the same detection used in the tech app so admin-
// completed jobs deduct identically. Also matches Dom's own "Inwall Concealment"
// wording (no "behind" word, "wall" glued to "In") — see the fuller comment on
// the tech.js copy of this function.
function detectWirePlateQty(lineItems) {
  let n = 0;
  for (const li of lineItems || []) {
    const name = (li.name || '').toLowerCase();
    const behindWall = /behind/.test(name) && /wall/.test(name) && /(wire|cord|conceal)/.test(name);
    const inwall = /inwall/.test(name) && /conceal/.test(name);
    if (behindWall || inwall) {
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
  // A job can't use more brackets than it has TVs. A ticket carrying BOTH a
  // bracket option line and a hand-typed hardware line ("Tilting Mounts")
  // otherwise double-counts (Throckmorton, 2026-08-21: 6 tilting deducted from
  // a 4-TV / 3-bracket job). Keep in sync with api/tech.js's copy.
  clampBracketQtysToTvCount(out, lineItems);
  return out;
}
function bracketTotal(q) { return (q.flat || 0) + (q.tilting || 0) + (q.full_motion || 0); }

// flat/tilting/full_motion brackets moved off this direct read-modify-write
// helper and onto api/_lib/bracket-moves.js (migration 0088's bracket_moves
// ledger) -- see debitForJob / reconcileJobEdit / creditDelivery / recount /
// adjust, imported above. That's the only thing allowed to change those three
// columns now; everything below this line is unaffected (wire_plate_qty and
// appletv_bracket_qty are not yet on the ledger).

// Subtract wire concealment plates from a tech's inventory (floor 0) and log it.
// No-ops gracefully if migration 0039 isn't applied; never throws into the
// completion path. Same cross-hire fix bracket-moves.js makes for brackets: the
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

// Apple TV brackets used on a job: one per unit of "Apple TV installation
// (mounting bracket included)". Requires BOTH "apple tv" and "bracket" in the
// name, not just "apple tv install" -- the catalog also has a plain "Apple TV
// installation" option (no bracket, presumably the customer already has one
// mounted) that must never decrement stock.
function detectAppleTvBracketQty(lineItems) {
  let n = 0;
  for (const li of lineItems || []) {
    const name = (li.name || '').toLowerCase();
    if (/apple\s*tv\b.*\bbracket\b/.test(name)) n += Number(li.quantity) || 1;
  }
  return n;
}

// Subtract Apple TV brackets from a tech's inventory (floor 0) and log it.
// No-ops gracefully if migration 0087 isn't applied; never throws into the
// completion path. Same cross-hire fix as the other adjust* functions above:
// the STOCK row lives under the tech's own home business, never the job's.
async function adjustAppleTvBracketInventory(db, businessId, techId, qty, bookingId) {
  if (!qty || !techId) return;
  const { data: techRow } = await db.from('technicians').select('business_id').eq('id', techId).maybeSingle();
  const homeBizId = techRow?.business_id || businessId;
  let { data: inv, error } = await db.from('bracket_inventory')
    .select('id, appletv_bracket_qty')
    .eq('business_id', homeBizId).eq('technician_id', techId).maybeSingle();
  if (error) { if (/appletv_bracket_qty/.test(error.message || '')) return; throw error; }
  if (!inv) {
    const { data: created } = await db.from('bracket_inventory')
      .insert({ business_id: homeBizId, technician_id: techId, appletv_bracket_qty: 0 })
      .select('id, appletv_bracket_qty').maybeSingle();
    inv = created || { id: null, appletv_bracket_qty: 0 };
  }
  const nextQty = Math.max(0, (Number(inv.appletv_bracket_qty) || 0) - qty);
  if (inv.id) {
    await db.from('bracket_inventory')
      .update({ appletv_bracket_qty: nextQty, updated_at: new Date().toISOString() })
      .eq('id', inv.id);
  }
  try {
    await db.from('bracket_usage_logs').insert({
      business_id: businessId, booking_id: bookingId || null, technician_id: techId,
      flat_used: 0, tilting_used: 0, full_motion_used: 0, appletv_bracket_used: qty,
      logged_by_kind: 'admin', notes: 'Apple TV installation, mounting bracket included',
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

  // Inventory is deliberately NOT credited here. This endpoint records that an
  // order EXISTS; brackets are credited only when that order is DELIVERED, by
  // the email sync (api/migrate.js bracketSync), the Assign button, or the
  // status dropdown -- all of which go through bracket_move() keyed on the
  // order number, so an order can only ever be credited once no matter how
  // many of those paths see it.
  //
  // It used to credit right here, with a read-then-write and no idempotency
  // key: re-submitting the same order credited it again every time, it
  // credited at ORDER time (a rule superseded 2026-07-07 by commit 3e13303,
  // which moved every other path to credit-on-delivery), and it wrote to the
  // currently-loaded business rather than the tech's home business, spawning
  // the phantom-row bug. Found in the 2026-09-03 post-implementation review.
  return res.status(200).json({
    ok: true,
    purchase: result,
    inventory_updated: null,
    note: 'Order recorded. Brackets are credited when the order is marked delivered.',
    ordered: {
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

  // Brackets are shared across companies (same "one truck stock" reasoning as
  // bracket_inventory/bracketPurchases) — the delivery is a real physical
  // package, and the tech who actually receives it may belong to either
  // business, not just the one whose purchase-row copy is loaded here. So this
  // does NOT filter by bizId, unlike the purchase lookup above (which legitimately
  // is one specific business's mirrored copy of the order).
  const { data: tech } = await db.from('technicians')
    .select('id, name, business_id').eq('id', techId).eq('active', true).maybeSingle();
  if (!tech) return res.status(404).json({ error: 'Technician not found' });
  // The tech's OWN home business, not the purchase-row's bizId — a Handy Andy
  // tech assigned from the Dom's tab must still credit HIS bracket_inventory
  // row, or this creates a phantom duplicate stock row under the wrong
  // business (the exact bug class just fixed in bracket_inventory itself).
  const techBizId = tech.business_id;

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
  // credits it now. Keyed on walmart_order_num (migration 0088) so a double-
  // click on Assign, or the sync crediting the same order moments later,
  // credits exactly once instead of twice.
  const credited = purchase.status === 'delivered';
  if (credited) {
    await ledgerCreditDelivery(db, {
      businessId: techBizId, technicianId: techId,
      qtys: { flat, tilting, full_motion },
      purchaseId: purchaseId, orderNum: purchase.walmart_order_num || purchaseId,
      actor: auth.name || auth.role || 'owner',
    });
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
