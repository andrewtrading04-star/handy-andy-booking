import { mirrorBooking } from './_lib/mirror.js';
import { NATIVE_BUSINESS } from './_lib/native-businesses.js';
import { emailNotificationsOn } from './_lib/notify.js';
import { emailConfig, sendEmail, bookingConfirmationEmail, brandFor } from './_lib/email.js';
import { serviceClient } from './_lib/supabase.js';
import { parseSlotId, slotStartUTC, slotEndUTC, pickOpenTech, SLOTS, dayOfWeekFor } from './_lib/availability.js';
import { saveCardOnFile, stripeConfigured } from './_lib/stripe.js';
import { verifyToken } from './_lib/auth.js';
import { isLikelyStreetAddress } from './_lib/address.js';
import { sendCardSaveFailedAlert, sendUnassignedBookingAlert, maybeSendBigBracketAlert, maybeSendFirstMultiTvDiscountAlert, maybeSendZeroOrLowProfitAlert, gdsUpsellUrlFor, rescheduleUrlFor } from './_lib/owner-notify.js';
import { notifyTechAssigned } from './_lib/tech-notify.js';
import { sendEnRouteSms } from './_lib/en-route.js';
import { sendBookingConfirmSms } from './_lib/booking-confirm-sms.js';

const BAD_ADDRESS = 'Please enter a valid street address (with a house number) — not an email or phone number.';

// service_area_zips stores bare 5-digit zips; a ZIP+4 ("80220-1032") from any
// caller misses the exact-match lookup and reads a covered address as
// out-of-area. Keep the leading 5 digits (same helper as api/admin.js and
// api/service-area.js). STRICT shape: only a bare zip or a real ZIP+4 tail
// normalizes; a 6-digit typo ("800122") must NOT silently become the
// different-but-real zip 80012, it stays as typed and fails closed.
function zip5(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{5})(?:[-\s]\d{1,4})?$/);
  return m ? m[1] : s;
}

// Best-effort record of whether the confirmation email actually sent, so the
// booking detail card can show real status instead of nothing at all. Never
// allowed to affect the booking itself — swallow a missing-column error the
// same way every other optimistic-column write in this codebase does (migration
// 0075 not applied yet).
async function persistConfirmationEmailStatus(db, bookingId, status) {
  try {
    await db.from('bookings')
      .update({ confirmation_email_status: status, confirmation_email_sent_at: new Date().toISOString() })
      .eq('id', bookingId);
  } catch (e) { /* migration 0075 not applied yet — status just won't show */ }
}

// Public Google Places proxy for the booking widget's address autocomplete (the
// admin's places endpoint requires a login). No auth: it only reads address
// suggestions. Lives here to stay under Vercel's function cap.
async function placesAutocompletePublic(req, res) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const input = ((req.query || {}).input || '').toString().trim();
  const token = ((req.query || {}).session || '').toString().trim();
  if (!key || input.length < 3) return res.status(200).json({ predictions: [] });
  try {
    const u = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    u.searchParams.set('input', input);
    u.searchParams.set('key', key);
    u.searchParams.set('types', 'address');
    u.searchParams.set('components', 'country:us');
    if (token) u.searchParams.set('sessiontoken', token);
    const j = await (await fetch(u.toString())).json();
    const predictions = (j.predictions || []).slice(0, 5).map(p => ({ description: p.description, place_id: p.place_id }));
    return res.status(200).json({ predictions });
  } catch (e) {
    console.warn('[book] places autocomplete failed:', e.message);
    return res.status(200).json({ predictions: [] });
  }
}
// Resolve a place_id to its parts: { line1 (street # + name), city, state, zip }.
async function placeDetailsPublic(req, res) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const placeId = ((req.query || {}).place_id || '').toString().trim();
  const token = ((req.query || {}).session || '').toString().trim();
  if (!key || !placeId) return res.status(200).json({ address: null });
  try {
    const u = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    u.searchParams.set('place_id', placeId);
    u.searchParams.set('key', key);
    u.searchParams.set('fields', 'address_component');
    if (token) u.searchParams.set('sessiontoken', token);
    const j = await (await fetch(u.toString())).json();
    if (j.status !== 'OK') return res.status(200).json({ address: null });
    const comps = j.result?.address_components || [];
    const get = (type, short) => { const c = comps.find(x => (x.types || []).includes(type)); return c ? (short ? c.short_name : c.long_name) : ''; };
    return res.status(200).json({ address: {
      line1: [get('street_number'), get('route')].filter(Boolean).join(' '),
      city:  get('locality') || get('sublocality') || get('postal_town') || '',
      state: get('administrative_area_level_1', true) || '',
      zip:   get('postal_code') || '',
    } });
  } catch (e) {
    console.warn('[book] place details failed:', e.message);
    return res.status(200).json({ address: null });
  }
}
// Public price overrides for the booking widget (app.widget_prices, edited from
// the admin dashboard's Other -> Widget Pricing page). No auth: it only reads
// prices, same trust level as the static numbers it's replacing. Returns
// {option_id: price} — the widget overlays this onto its own hardcoded
// SERVICE_CONFIGS at load, so a fetch failure or an empty/new deploy just
// falls back to the widget's built-in numbers instead of breaking checkout.
// Public: the Stripe PUBLISHABLE key for a business, so one widget file can
// serve several businesses instead of hardcoding one company's key. Publishable
// keys are designed to ship in client code — this exposes nothing secret.
//
// `configured` reports whether the matching SECRET key is present on the server
// (a boolean, never the key). Without it, a business whose secret key is missing
// looks fine right up until a real customer's card fails at checkout.
const STRIPE_PK_ENV = {
  'handy-andy': 'STRIPE_PUBLISHABLE_KEY',
  doms:         'DOMS_STRIPE_PUBLISHABLE_KEY',
  'mile-high':  'MILE_HIGH_STRIPE_PUBLISHABLE_KEY',
  austin:       'AUSTIN_STRIPE_PUBLISHABLE_KEY',
  precision:    'PRECISION_STRIPE_PUBLISHABLE_KEY',
};
function stripePublicConfig(req, res) {
  const business = ((req.query || {}).business || 'handy-andy').toString().trim();
  const envName = STRIPE_PK_ENV[business];
  if (!envName) return res.status(400).json({ error: `Unknown business "${business}"` });
  let configured = false;
  try { configured = stripeConfigured({ account: business }); }
  catch (e) { configured = false; }   // no Stripe account mapped for this slug
  return res.status(200).json({
    business,
    publishable_key: process.env[envName] || null,
    configured,
  });
}

// Public: whether a business's transactional email is wired up. Reports the
// from-address and a boolean 'configured' -- NEVER the Resend API key itself.
// Same purpose as stripe_config above: surface a missing key before a real
// customer's confirmation email silently fails to send.
const EMAIL_BUSINESSES = new Set(['handy-andy', 'doms', 'mile-high', 'austin', 'precision']);
function emailPublicConfig(req, res) {
  const business = ((req.query || {}).business || 'handy-andy').toString().trim();
  if (!EMAIL_BUSINESSES.has(business)) return res.status(400).json({ error: `Unknown business "${business}"` });
  const cfg = emailConfig(business);
  return res.status(200).json({ business, from: cfg.from, configured: !!cfg.apiKey });
}

async function widgetPricesPublic(req, res) {
  const business = ((req.query || {}).business || 'handy-andy').toString().trim();
  const city = ((req.query || {}).city || 'default').toString().trim();
  try {
    const db = serviceClient();
    const { data: biz } = await db.from('businesses').select('id').eq('slug', business).maybeSingle();
    if (!biz) return res.status(200).json({ prices: {} });
    const fetchCity = async (key) => {
      const { data, error } = await db.from('widget_prices')
        .select('option_id, price')
        .eq('business_id', biz.id)
        .eq('city_key', key);
      if (error) throw error;
      return data || [];
    };
    let data = await fetchCity(city);
    // A metro with no price rows of its own falls back to 'default' (Denver,
    // the canonical set every other city was copied from) rather than to
    // widget.js's baked-in constants. Those constants drift the moment anyone
    // edits a price in the dashboard, so without this a brand-new market would
    // quietly quote whatever was hardcoded at the last deploy.
    if (!data.length && city !== 'default') {
      console.warn(`[book] no widget_prices for ${business}/${city} — falling back to default`);
      data = await fetchCity('default');
    }
    const prices = {};
    for (const r of data) prices[r.option_id] = Number(r.price) || 0;
    return res.status(200).json({ prices });
  } catch (e) {
    console.warn('[book] widget_prices lookup failed:', e.message);
    return res.status(200).json({ prices: {} });
  }
}

// GET /api/book?action=coupons&business=<slug>
// The live promo codes, so the widget stops shipping its own copy. That copy
// had already drifted from the enforcing list (FB20 worked server-side but the
// widget called it invalid), which reads to a customer as a broken code.
// Amounts are public by nature — a customer types the code and sees the
// discount — so this needs no auth, same as widget_prices above.
async function couponsPublic(req, res) {
  const business = ((req.query || {}).business || 'handy-andy').toString().trim();
  try {
    const map = await couponMapFor(serviceClient(), business);
    return res.status(200).json({ coupons: map });
  } catch (e) {
    console.warn('[book] coupons lookup failed:', e.message);
    return res.status(200).json({ coupons: {} });
  }
}

// No business param -- the config is global, not per-business (see
// multiTvDiscountConfigFor above). Falls back to MULTI_TV_CFG_DEFAULTS on any
// failure so a DB hiccup degrades to today's known-correct numbers rather than
// to a broken widget quote.
async function multiTvDiscountPublic(req, res) {
  try {
    const cfg = await multiTvDiscountConfigFor(serviceClient());
    return res.status(200).json({ config: cfg });
  } catch (e) {
    console.warn('[book] multi-TV discount config lookup failed:', e.message);
    return res.status(200).json({ config: MULTI_TV_CFG_DEFAULTS });
  }
}

// GET/POST /api/book?action=review_click&token=<review_token>&ch=email|sms
// Records the first time a customer clicks the review link from either channel,
// then redirects to review.html. Replaces the old email open-pixel with a
// click-tracking redirect that works identically for email and SMS.
//
// The redirect ALWAYS carries the customer's original token, no matter what
// happens with tracking — a tracking failure (bad token, DB error, migration
// not applied yet) must never break the review page for the customer.
async function serveReviewClick(req, res) {
  const rawToken = ((req.query || {}).token || '').toString();
  const channel = ((req.query || {}).ch || '').toString().toLowerCase() === 'sms' ? 'sms' : 'email';
  const perChannelCol = channel === 'sms' ? 'review_sms_clicked_at' : 'review_email_clicked_at';
  try {
    const t = verifyToken(rawToken);
    // Accept BOTH token shapes: kind:'review' (admin.js mint, and mirror.js
    // going forward) AND legacy kindless { booking_id } tokens — mirror.js
    // minted those for every widget booking until Jul 2026, they live 30
    // days, and resends reuse the STORED token, so they'll circulate for a
    // while. A kindless token with a booking_id can only be a review token:
    // every other token type (admin/tech/on_the_way/estimate_approve) always
    // sets kind. Without this, the per-channel "opened" stamp was silently
    // skipped for all widget bookings.
    if (t && t.booking_id && (t.kind === 'review' || !t.kind)) {
      const db = serviceClient();
      const now = new Date().toISOString();
      // Per-channel click (migration 0063) — each channel records its OWN first
      // click, so a customer who opens both links shows as having opened both,
      // not just whichever channel they clicked first. review_clicked_at/
      // review_click_channel (0062) are kept in step for anything still reading
      // them. If the 0063/0062 columns aren't applied yet, fall back to metadata.
      const { error } = await db.from('bookings')
        .update({ [perChannelCol]: now, review_clicked_at: now, review_click_channel: channel })
        .eq('id', t.booking_id)
        .is(perChannelCol, null);
      if (error) {
        const { data: cur } = await db.from('bookings').select('metadata').eq('id', t.booking_id).maybeSingle();
        const meta = (cur && cur.metadata) || {};
        const metaKey = channel === 'sms' ? 'review_sms_clicked_at' : 'review_email_clicked_at';
        if (cur && !meta[metaKey]) {
          await db.from('bookings')
            .update({ metadata: { ...meta, [metaKey]: now, review_clicked_at: meta.review_clicked_at || now, review_click_channel: meta.review_click_channel || channel } })
            .eq('id', t.booking_id);
        }
      }
    }
  } catch (e) { /* tracking is best-effort; always redirect */ }
  const base = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return res.redirect(302, `${base}/review.html?token=${encodeURIComponent(rawToken)}`);
}

// After creating the booking this handler does several more sequential calls
// (tech pick, CRM mirror, notify-tech SMS, confirmation email). At Vercel's
// default ~10s timeout the function could die AFTER the booking was created,
// leaving the customer with no confirmation — so they'd click again and
// create a duplicate. Give the post-booking work room to finish so the client
// always gets a clean success and never needs to retry.
export const config = { maxDuration: 60 };

// Valid coupon codes → discount in dollars (owner-provided, June 2026).
// Zenbooker has no native coupon support, so a valid code is applied to the
// job as a negative-price custom service line item. Kept in its own map per
// business (renamed from a single shared COUPONS) so a code minted for one
// business can never accidentally apply to the other's booking.
const HA_COUPONS = {
  MCDENVER20: 20, MP10: 10, AUS10: 10, HOU10: 10, DEN10: 10,
  ISREAL15: 15, STEVE15: 15, BATCITY10: 10, FBD15: 15, FB15: 15,
  ANNIVERSARY15: 15, BING10: 10, OLIVE10: 10, STV10: 10, G10TV: 10,
  TV2026: 10, HG20: 20, LA10: 10, AB20: 20, FBA20: 20, FB10: 10,
  FB20: 20,   // Facebook ad code, Houston, Aug 2026
  LASTCHANCE10: 10,   // exit-intent offer
};
const DOMS_COUPONS = {
  DONTGO10: 10,   // exit-intent offer
};

// Mile High runs the same Denver playbook as Handy Andy, so it honors the same
// promo codes. Kept as a per-slug map rather than a shared reference so either
// business can diverge without touching the other.
const NATIVE_COUPONS = {
  'handy-andy': HA_COUPONS,
  'mile-high':  HA_COUPONS,
  'austin':     HA_COUPONS,   // same playbook as Handy Andy's Austin market
  'precision':  HA_COUPONS,   // same playbook as Handy Andy's Houston market
};

// The hardcoded maps above are now only a FALLBACK. app.coupons is the live
// list (Other -> Coupons), so a code can be added, repriced or retired without
// a deploy. If that table is missing or unreadable we fall back to the maps
// rather than silently rejecting every code a customer types.
const COUPON_TTL_MS = 60000;
const _couponCache = new Map();   // slug -> { at, map }
function couponFallbackMap(businessSlug) {
  return businessSlug === 'doms' ? DOMS_COUPONS : (NATIVE_COUPONS[businessSlug] || {});
}
// { CODE: amount } for every ACTIVE, unexpired coupon this business honors.
// Cached for a minute — this sits in the booking hot path and the list changes
// a few times a month at most.
export async function couponMapFor(db, businessSlug) {
  const slug = String(businessSlug || '');
  const hit = _couponCache.get(slug);
  if (hit && Date.now() - hit.at < COUPON_TTL_MS) return hit.map;
  let map = null;
  try {
    const { data: biz } = await db.from('businesses').select('id').eq('slug', slug).maybeSingle();
    if (biz?.id) {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await db.from('coupons')
        .select('code, amount, active, expires_on').eq('business_id', biz.id).eq('active', true);
      if (!error && Array.isArray(data)) {
        map = {};
        for (const c of data) {
          if (c.expires_on && String(c.expires_on) < today) continue;   // lapsed
          map[String(c.code || '').trim().toUpperCase()] = Number(c.amount) || 0;
        }
      }
    }
  } catch { /* table not applied yet — fall through to the hardcoded map */ }
  if (!map) map = couponFallbackMap(slug);
  _couponCache.set(slug, { at: Date.now(), map });
  return map;
}
// Drop the cache so an edit in the dashboard takes effect immediately rather
// than up to a minute later (the office repricing a code then testing it must
// not see the old amount).
export function couponCacheClear(businessSlug) {
  if (businessSlug) _couponCache.delete(String(businessSlug));
  else _couponCache.clear();
}
// The one place any surface resolves a promo code to a dollar amount, so the
// office's phone-quote flow (api/admin.js quote_coupon) honors EXACTLY the
// codes a customer can use online — a second hand-maintained list would drift
// the moment a code changes, and the office would be telling callers a code is
// invalid while the website accepts it.
export async function couponAmountFor(db, businessSlug, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return 0;
  const map = await couponMapFor(db, businessSlug);
  return Number(map[code]) || 0;
}
// Every code this business honors. Used by the phone flow to offer a "did they
// mean…" on a near miss — a customer reading a code down the phone is one
// dropped letter away from being told, wrongly, that their code is no good.
export async function couponCodesFor(db, businessSlug) {
  return Object.keys(await couponMapFor(db, businessSlug));
}

// The multi-TV discount used to be these exact numbers hardcoded three times
// (here, public/widget.js, and public/admin.html's phone-in booking form) with
// no way to change one without a deploy. Same cache-with-TTL / graceful-
// fallback shape as couponMapFor above: one global row (not per-business --
// today's rule is identical for both companies), and if the table or row is
// ever missing (migration not applied, or someone deletes the row), these
// DEFAULTS are the exact values that were hardcoded before this existed, so a
// missing config degrades to today's behavior rather than to no discount at all.
const MULTI_TV_CFG_TTL_MS = 60000;
let _multiTvCfgCache = null;   // { at, cfg }
const MULTI_TV_CFG_DEFAULTS = {
  tv_threshold: 3, zero_fee_per_tv: 10, full_cut_fee: 15,
  partial_cut_pct: 0.60, partial_cut_fees: [65, 100],
  price_discount_enabled: true, price_tier3: 20, price_tier4: 25, price_tier5plus: 30,
};
export async function multiTvDiscountConfigFor(db) {
  if (_multiTvCfgCache && Date.now() - _multiTvCfgCache.at < MULTI_TV_CFG_TTL_MS) return _multiTvCfgCache.cfg;
  let cfg = null;
  try {
    const { data, error } = await db.from('multi_tv_discount_config').select('*').limit(1).maybeSingle();
    if (!error && data) cfg = data;
  } catch { /* table not applied yet, fall through to the hardcoded defaults */ }
  if (!cfg) cfg = MULTI_TV_CFG_DEFAULTS;
  _multiTvCfgCache = { at: Date.now(), cfg };
  return cfg;
}
// So the owner's dashboard edit takes effect on the very next booking, not up
// to a minute later, same reasoning as couponCacheClear above.
export function multiTvDiscountConfigCacheClear() { _multiTvCfgCache = null; }

// ── Calendar (.ics) generation for confirmation-email "Add to calendar" ──────
// RFC 5545 text escaping: backslash, comma, semicolon, and newlines.
function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
// Epoch seconds -> UTC stamp "YYYYMMDDTHHMMSSZ".
function icsStamp(sec) {
  const d = new Date(Number(sec) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
// Fold long lines to <=75 octets per RFC 5545 (continuation lines start with a space).
function icsFold(line) {
  if (line.length <= 73) return line;
  const out = [line.slice(0, 73)];
  let s = line.slice(73);
  while (s.length > 72) { out.push(' ' + s.slice(0, 72)); s = s.slice(72); }
  if (s.length) out.push(' ' + s);
  return out.join('\r\n');
}
// GET /api/book?action=ics&title=&start=<epochSec>&end=<epochSec>&location=&details=
// Returns a downloadable single-event calendar file.
function serveIcs(req, res) {
  const { title, start, end, location, details } = req.query || {};
  const startSec = Number(start), endSec = Number(end);
  if (!startSec || !endSec) return res.status(400).json({ error: 'start and end (epoch seconds) are required' });
  const uid = `booking-${startSec}-${Math.random().toString(36).slice(2, 10)}@handyandy`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Handy Andy//Booking//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${icsStamp(startSec)}`,
    `DTEND:${icsStamp(endSec)}`,
    `SUMMARY:${icsEscape(title || 'Appointment')}`,
    location ? `LOCATION:${icsEscape(location)}` : null,
    details ? `DESCRIPTION:${icsEscape(details)}` : null,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Appointment reminder', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).map(icsFold);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(lines.join('\r\n'));
}

// ── Doms native booking (no Zenbooker) ───────────────────────────────────────
// Writes the booking straight into the CRM, saves the card on file in Doms' OWN
// Stripe account, assigns an available Doms tech (so the slot is occupied), and
// sends a Doms-branded confirmation. `selectedSlot` is the
// 'doms_<YYYY-MM-DD>_<slotKey>' id returned by /api/slots?business=doms.
// Multi-TV batching discount (3+ TVs on one ticket): rewards big jobs since
// mounting several TVs in one drive is highly profitable. Shared by bookDoms
// and bookNative so the two businesses can never drift out of sync. Computed
// server-side from the REAL line items (never trusts the client's TV count),
// so a stale/tampered widget can never grant a bigger discount than earned.
// The cut depends on the travel-fee zone (`surcharge`) — the bigger the
// existing fee, the bigger the cut, since that is exactly the case where the
// fee is the reason a big job gets skipped. Zone with no travel fee instead
// gets a flat $10 off PER TV. Mirrored client-side in public/widget.js
// (multiTvDiscount / steppedMultiTvPriceDiscount) — keep in sync.
//
// isTvSizeLine excludes "Second Technician" explicitly: that line's admin
// label embeds a size range (e.g. `70–85"`), so a naive "does the name
// contain a quote mark" check would miscount a 2-TV job with a large TV as
// 3 TVs and grant an unearned discount. Caught in a code audit before it
// ever fired in production.
//
// SECOND BUG, caught in a later audit: "contains a quote mark anywhere" ALSO
// matched the XL bracket options every large TV requires, since HA/Mile High
// sell them as `85"-100" TV Tilting Bracket` and Dom's as `Tilting
// (recommended) 85"-100"`; both embed the same size range as a descriptor
// alongside the mount type. A 2-TV booking
// with one 85"+ TV and its (mandatory) XL bracket was counted as 3 TVs and
// granted an unearned multi-TV discount live in production. A genuine
// TV-SIZE selection is nothing but the size (32" Or Less, 33"-59", 98+); a
// bracket line always has extra words around the range. Matching the WHOLE
// trimmed string against the size pattern, not just checking it contains one
// anywhere, is what actually distinguishes them.
function isTvSizeLine(name) {
  const n = String(name || '').trim();
  if (/second technician/i.test(n)) return false;
  return /^\d{2,3}["″]\s*or less$/i.test(n)
      || /^\d{2,3}["″]\s*[-–]\s*\d{2,3}["″]$/.test(n)
      || /^98["″]?\s*\+$/.test(n);
}
// `cfg` is a row from multi_tv_discount_config (or MULTI_TV_CFG_DEFAULTS),
// fetched once by the caller via multiTvDiscountConfigFor() above and passed
// in here rather than re-fetched per call. This function itself stays sync
// and side-effect-free apart from mutating `lines`, same as before the config
// became editable.
function applyMultiTvDiscounts(lines, surcharge, cfg) {
  const c = cfg || MULTI_TV_CFG_DEFAULTS;
  const tvCount = lines.reduce((n, l) => isTvSizeLine(l.name) ? n + (Number(l.quantity) || 1) : n, 0);
  let multiTvDiscountAmt = 0;
  if (tvCount >= c.tv_threshold) {
    if (!lines.some(l => /multi-tv discount/i.test(l.name))) {
      if (surcharge <= 0) {
        const perTvAmt = c.zero_fee_per_tv * tvCount;
        lines.push({ kind: 'coupon', name: `Multi-TV discount (-$${c.zero_fee_per_tv} × ${tvCount} TVs)`, quantity: 1, unit_price: -perTvAmt, line_total: -perTvAmt });
        multiTvDiscountAmt = perTvAmt;
      } else {
        const partialFees = (c.partial_cut_fees || []).map(Number);
        const cutPct = surcharge === Number(c.full_cut_fee) ? 1.00 : partialFees.includes(surcharge) ? Number(c.partial_cut_pct) : 0;
        if (cutPct > 0) {
          const cutAmt = Math.round(surcharge * cutPct * 100) / 100;
          lines.push({ kind: 'coupon', name: 'Multi-TV discount', quantity: 1, unit_price: -cutAmt, line_total: -cutAmt });
          multiTvDiscountAmt = cutAmt;
        }
      }
    }
    if (c.price_discount_enabled && !lines.some(l => /multi-tv price discount/i.test(l.name))) {
      let priceDiscAmt = 0;
      for (let i = 3; i <= tvCount; i++) priceDiscAmt += (i === 3 ? Number(c.price_tier3) : i === 4 ? Number(c.price_tier4) : Number(c.price_tier5plus));
      if (priceDiscAmt > 0) {
        lines.push({ kind: 'coupon', name: `Multi-TV price discount (${tvCount} TVs)`, quantity: 1, unit_price: -priceDiscAmt, line_total: -priceDiscAmt });
      }
    }
  }
  return multiTvDiscountAmt;
}

// Shared copy for the "your slot filled while you were checking out" rejection
// (no em dashes in customer-facing text, per owner style rule).
const SLOT_TAKEN_MSG = 'That time was just booked by another customer. Please pick a different time.';

function fmtWhen(startUTC, tz, fallback) {
  try { return startUTC.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return fallback; }
}

// An idempotent RETRY of a submit whose first attempt already created a
// booking must be answered with that booking's original success, never a 409
// (the first attempt's own row is what makes the tech pick come up empty).
// Returns a ready-to-send response body, or null when there is no prior row.
async function idempotentPrior(db, bizId, idempotencyKey) {
  if (!idempotencyKey) return null;
  try {
    const { data: prev } = await db.from('bookings')
      .select('id, technician_id, status, payment_status')
      .eq('business_id', bizId).eq('idempotency_key', String(idempotencyKey)).maybeSingle();
    if (!prev) return null;
    return {
      success: true, booking_id: prev.id, job_id: prev.id,
      status: prev.technician_id ? 'assigned' : (prev.status || 'confirmed'),
      card_saved: prev.payment_status === 'card_on_file',
      duplicate: true,
    };
  } catch (e) { console.warn('[book] idempotent lookup failed:', e.message); return null; }
}

// A widget booking must never sit in the CRM without a technician (the Connor
// Hasselman job, 2026-08-12 8am Denver: booked techless, discovered 25 minutes
// after its start time). Both public paths now guarantee a tech BEFORE the
// booking is created (they 409 instead), so the main way a booking can still
// land techless is losing the bookings_tech_slot_unique race inside
// mirrorBooking. This re-runs the pick (the race winner's booking now occupies
// that tech, so a different tech can still come back), updates the row, and if
// nobody is left it alerts the office immediately so a human assigns or calls
// the customer while they are still at their screen.
async function recoverUnassignedBooking(db, { slug, bizId, bookingId, dateStr, slotKey, serviceAreaId = null, timezone = null, businessName, customerName, whenStr }) {
  let rescueId = null;
  try { rescueId = await pickOpenTech(db, { businessSlug: slug, dateStr, slotKey, serviceAreaId, timezone, crossHire: true }); }
  catch (e) { console.warn('[book] rescue pick failed:', e.message); }
  if (rescueId) {
    try {
      // `.is('technician_id', null)` so a tech the office assigned in the
      // meantime is never clobbered, and `.neq('status','cancelled')` so a
      // just-cancelled booking is never resurrected to 'assigned'. A 23505
      // here (rescue tech also got taken) falls through to the re-read below.
      const upd = await db.from('bookings')
        .update({ technician_id: rescueId, status: 'assigned' })
        .eq('id', bookingId).is('technician_id', null).neq('status', 'cancelled')
        .select('id').maybeSingle();
      if (upd.error) throw upd.error;
      if (upd.data) {
        const ev = await db.from('booking_status_events').insert({
          booking_id: bookingId, business_id: bizId, technician_id: rescueId,
          status: 'assigned', note: 'Auto-assigned on retry after losing the slot race',
        });
        if (ev.error) console.warn('[book] rescue event insert failed:', ev.error.message);
        return rescueId;
      }
    } catch (e) { console.warn('[book] rescue assign failed:', e.message); }
  }
  // No rescue landed. Re-read before crying wolf: the office may have assigned
  // someone in the window (update matched 0 rows), or the booking may have
  // been cancelled; neither is owed an emergency alert.
  try {
    const { data: row } = await db.from('bookings').select('technician_id, status').eq('id', bookingId).maybeSingle();
    if (row?.technician_id) return row.technician_id;
    if (row?.status === 'cancelled') return null;
  } catch (e) { /* fall through: better a false alarm than silence */ }
  await sendUnassignedBookingAlert({ slug, businessName, customerName, whenStr, bookingId })
    .catch(e => console.warn('[book] unassigned alert failed:', e.message));
  return null;
}

async function bookDoms(req, res) {
  const b = req.body || {};
  const customer = b.customer || {};
  if (!customer.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!isLikelyStreetAddress(customer.address)) return res.status(400).json({ error: BAD_ADDRESS });

  const parsed = parseSlotId(b.selectedSlot);
  if (!parsed || parsed.businessSlug !== 'doms') {
    return res.status(400).json({ error: 'A valid time slot is required' });
  }
  const { dateStr, slotKey } = parsed;
  const tz = 'America/Denver';
  const startUTC = slotStartUTC(tz, dateStr, slotKey);
  const endUTC   = slotEndUTC(tz, dateStr, slotKey);
  if (!startUTC) return res.status(400).json({ error: 'Invalid time slot' });
  // The public slot list already omits anything starting within the next hour
  // (publicOpenSlots), but a page can sit open long enough for a slot that WAS
  // fine when it loaded to cross that line by the time they actually submit —
  // re-check here so a stale page can never book a same-hour job. Strict "not
  // more than 60 min out", matching the listing filter exactly.
  if (startUTC.getTime() - Date.now() <= 60 * 60 * 1000) {
    return res.status(409).json({ error: "That time is too soon to book now. Please pick a later time.", conflict: true });
  }

  let db;
  try { db = serviceClient(); }
  catch (e) { return res.status(500).json({ error: 'Booking storage not configured', message: e.message }); }

  // Resolve Doms business + its Denver service area + the per-zip surcharge.
  const { data: biz } = await db.from('businesses').select('id').eq('slug', 'doms').single();
  if (!biz) return res.status(500).json({ error: 'Doms business not configured' });
  const { data: area } = await db.from('service_areas')
    .select('id').eq('business_id', biz.id).eq('name', 'Denver').maybeSingle();

  const zip = zip5(b.postal_code || customer.zip || '');
  let surcharge = 0;
  if (zip) {
    const { data: z } = await db.from('service_area_zips').select('*')
      .eq('business_id', biz.id).eq('postal_code', zip).maybeSingle();
    surcharge = Number(z?.surcharge) || 0;
  }

  // Coupon (validated server-side; unknown codes are ignored, never trusted).
  const couponCode = String(b.coupon || '').trim().toUpperCase();
  const couponAmt = await couponAmountFor(db, 'doms', couponCode);

  // ── Line items for storage. Prefer explicit line_items; else map the
  // email_summary lines the widget already computed for display.
  const sum = b.email_summary || {};
  let lines = [];
  if (Array.isArray(b.line_items) && b.line_items.length) {
    lines = b.line_items.map(li => ({
      kind: li.kind || 'option',
      name: String(li.name || 'Item').slice(0, 200),
      quantity: Number(li.quantity) || 1,
      unit_price: Number(li.unit_price) || 0,
      line_total: Number(li.line_total != null ? li.line_total : li.unit_price) || 0,
    }));
  } else if (Array.isArray(sum.lines) && sum.lines.length) {
    lines = sum.lines.map(l => {
      const qty = Number(l.qty) || 1;
      const amount = Number(l.amount) || 0;   // line total as displayed
      return { kind: 'option', name: String(l.label || 'Item').slice(0, 200),
        quantity: qty, unit_price: qty ? amount / qty : amount, line_total: amount };
    });
  }
  // Add the travel surcharge server-side if the widget didn't already include it,
  // so a stale/tampered widget can never drop it.
  if (surcharge > 0 && !lines.some(l => /surcharge/i.test(l.name))) {
    lines.push({ kind: 'fee', name: 'Service area surcharge', quantity: 1, unit_price: surcharge, line_total: surcharge });
  }
  if (couponAmt > 0 && !lines.some(l => /coupon|discount/i.test(l.name))) {
    lines.push({ kind: 'coupon', name: `Coupon ${couponCode}`, quantity: 1, unit_price: -couponAmt, line_total: -couponAmt });
  }
  const multiTvDiscountAmt = applyMultiTvDiscounts(lines, surcharge, await multiTvDiscountConfigFor(db));
  // Sales tax (8.25%), same block as bookNative; Dom's never had this. Without
  // it, `subtotal` was tax-EXCLUSIVE while the widget's own total is
  // tax-INCLUSIVE, so the two were never comparable amounts to begin with; the
  // gap happened to look like a safety margin only because tax+tip are
  // (almost) always positive. Placed before the coupon so tax is on the
  // pre-discount amount, matching what the Dom's widget itself already shows
  // on screen (tax computed on sub+afterHoursFee+surcharge before the coupon).
  if (!lines.some(l => /^tax\b/i.test(l.name))) {
    const taxable = lines
      .filter(l => l.kind !== 'coupon' && !/^tax\b/i.test(l.name || ''))
      .reduce((s, l) => s + (Number(l.line_total) || 0), 0);
    const tax = Math.round(taxable * 0.0825 * 100) / 100;
    if (tax > 0) lines.push({ kind: 'fee', name: 'Tax (8.25%)', quantity: 1, unit_price: tax, line_total: tax });
  }
  const tip = Number(b.tip) || 0;
  const subtotal = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const widgetTotal = sum.total != null ? Number(sum.total) : subtotal;
  // `subtotal` is now the authoritative number: real surcharge, real
  // server-validated coupon/multi-TV discount, and now real tax, all computed
  // from data the server itself resolved. The OLD `Math.max(subtotal,
  // widgetTotal)` treated the higher of the two as safer, which is backwards
  // whenever the client's total is stale or simply did not know about a
  // discount the server just validated (e.g. the live coupon fetch failed and
  // the code was not in the widget's hardcoded fallback map), meaning a real,
  // server-approved discount could never actually reduce what the customer
  // was quoted, while the stored line items still listed it, so the receipt's
  // own rows did not sum to its own total. A mismatch beyond a few cents is
  // still worth knowing about (stale cache, a bug, or genuine tampering), so
  // it is logged, but it no longer overrides the number the server just
  // computed from real, validated data.
  const price = subtotal;
  if (Number.isFinite(widgetTotal) && Math.abs(widgetTotal - subtotal) > 0.5) {
    console.warn('[book-doms] price mismatch: server', subtotal, 'vs widget', widgetTotal,
      '- charging the server total; widget total is stale or the client-side preview did not match.');
  }

  // ── Pick an available Doms tech BEFORE saving the card or writing anything.
  // The customer's slot list is a snapshot from when they reached the calendar
  // step; while they type their details, another customer (on either company's
  // widget, the Denver cross-hire pool is shared) can take the last free tech
  // for this slot. That is exactly how the Connor Hasselman job (2026-08-12
  // 8am) was created with no technician. If nobody is available anymore,
  // REJECT with a 409 so the widget sends them back to a fresh calendar; a job
  // must never be created without a technician. One retry so a transient
  // database hiccup does not turn into a lost booking.
  let technician_id = null, pickBroken = false;
  try { technician_id = await pickOpenTech(db, { businessSlug: 'doms', dateStr, slotKey, crossHire: true }); }
  catch (e) {
    console.warn('[book-doms] tech pick failed, retrying once:', e.message);
    try { technician_id = await pickOpenTech(db, { businessSlug: 'doms', dateStr, slotKey, crossHire: true }); }
    catch (e2) { pickBroken = true; console.error('[book-doms] tech pick failed twice:', e2.message); }
  }
  if (!technician_id) {
    // An idempotent RETRY of a submit that already succeeded must not be
    // turned away: the first attempt's own booking is what is occupying the
    // tech, so re-picking finds nobody. Return the existing booking as the
    // success it already is.
    const dup = await idempotentPrior(db, biz.id, b.idempotency_key);
    if (dup) return res.status(200).json(dup);
    if (pickBroken) {
      // Both pick attempts THREW (a database problem, not a full slot). Be
      // honest instead of blaming a phantom competing customer.
      return res.status(409).json({ error: 'We could not confirm that time is still open. Please try again in a moment.', conflict: true });
    }
    return res.status(409).json({ error: SLOT_TAKEN_MSG, conflict: true, slot_taken: true });
  }
  // Resolve the assigned tech's name (+ photo/bio for the "Meet your tech"
  // confirmation-email block) — best-effort.
  let technicianName = null, technicianPhoto = null;
  try {
    const { data: _t } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
    technicianName = _t?.name || null;
    technicianPhoto = _t || null;
  } catch (e) { /* name is best-effort */ }

  // ── Save the card on file in DOMS' Stripe account (best-effort). The card was
  // tokenized client-side with Doms' publishable key, so only Doms' secret key
  // can attach/charge it. Never fail the booking if this errors. Runs AFTER the
  // tech guard on purpose: a rejected booking must not leave a customer + card
  // sitting in Stripe.
  let stripeCustomerId = null, paymentStatus = 'unpaid', cardNote = '';
  if (b.payment_method_id) {
    if (!stripeConfigured('doms')) {
      cardNote = `Card captured (${b.payment_method_id}) but DOMS_STRIPE_SECRET_KEY is not set — card was NOT saved on file.`;
    } else {
      try {
        const r = await saveCardOnFile({
          email: customer.email,
          name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          phone: customer.phone, paymentMethodId: b.payment_method_id, slug: 'doms',
        });
        stripeCustomerId = r.customerId;
        paymentStatus = 'card_on_file';
        cardNote = 'Card is on file (Doms Stripe).';
      } catch (e) {
        cardNote = `Card capture failed: ${e.message} (pm ${b.payment_method_id} was never attached)`;
      }
    }
  }

  if (cardNote) console.log('[book-doms] card:', cardNote);
  // A card was offered but never actually attached (wrong/unset key, a Stripe
  // error) — the exact silent-failure class that left a real customer's card
  // untracked until charge time (the "Annie" incident). The booking still
  // proceeds either way, but this must be VISIBLE, not just a server log line:
  // written into the booking's own internal notes so the office sees it the
  // moment they open the job, and a direct alert email so nobody has to
  // stumble onto it days later at time of service.
  const cardSaveFailed = !!(b.payment_method_id && paymentStatus !== 'card_on_file');

  // ── Write the booking (creates customer, booking, line items, status event,
  // review token) and get the new id back.
  let result = {};
  try {
    result = (await mirrorBooking({
      businessSlug: 'doms', source: 'widget',
      landing_page: b.landing_page || null, traffic_source: b.traffic_source || null,
      service_area_id: area?.id || null,
      technician_id,
      status: technician_id ? 'assigned' : 'confirmed',
      scheduled_at: startUTC.toISOString(),
      scheduled_end: endUTC ? endUTC.toISOString() : null,
      duration_minutes: 120,
      service_name: "Dom's TV Mounting",
      idempotency_key: b.idempotency_key || null,
      sms_consent: b.sms_consent,
      stripe_account: 'doms',
      customer: {
        first_name: customer.first_name, last_name: customer.last_name,
        name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        email: customer.email, phone: customer.phone,
      },
      address: { line1: customer.address, line2: customer.address_line2 || null, city: b.city || 'Denver', state: b.state || 'CO', postal_code: zip },
      line_items: lines, subtotal, price, tip,
      payment_status: paymentStatus,
      stripe_customer_id: stripeCustomerId,
      // Never persist a pm that failed to attach: it reads back as a saved
      // card everywhere downstream, but it is not chargeable. The pm id is
      // still preserved in `notes` via cardNote for the no-secret-key case.
      stripe_payment_method_id: cardSaveFailed ? null : (b.payment_method_id || null),
      notes: cardSaveFailed ? `⚠ ${cardNote}` : null,
      customer_notes: b.customer_notes || sum.notes || null,
    })) || {};
  } catch (e) {
    console.error('[book-doms] mirror error:', e.message);
    return res.status(500).json({ error: 'Could not save booking', message: e.message });
  }
  const bookingId = result.booking_id || null;
  // mirrorBooking swallows its own pre-insert failures and returns undefined.
  // No booking id means NOTHING was created; claiming success would leave the
  // customer confident in a booking that does not exist.
  if (!bookingId) {
    console.error('[book-doms] mirror returned no booking id');
    return res.status(500).json({ error: 'Could not save your booking. Please try again.' });
  }
  // mirrorBooking falls back to unassigned if this exact tech+slot lost a race
  // to a concurrent booking (bookings_tech_slot_unique, migration 0073). A
  // technician-less job must never sit in the CRM silently, so try once to
  // assign a different free tech, and failing that alert the office right now.
  if (bookingId && !result.technician_id) {
    result.technician_id = await recoverUnassignedBooking(db, {
      slug: 'doms', bizId: biz.id, bookingId, dateStr, slotKey, timezone: tz,
      businessName: "Dom's TV Mounting",
      customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      whenStr: fmtWhen(startUTC, tz, dateStr),
    });
  }
  // Never let the confirmation email say "Meet [Tech]" for a job that isn't
  // actually assigned to them (the recovery above may have landed on a
  // different tech than the one picked before the insert).
  if (result.technician_id !== technician_id) {
    technicianName = null; technicianPhoto = null;
    if (result.technician_id) {
      try {
        const { data: _t } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', result.technician_id).maybeSingle();
        technicianName = _t?.name || null;
        technicianPhoto = _t || null;
      } catch (e) { /* best-effort */ }
    }
  }

  // Text the assigned tech. This is the whole reason techs stopped hearing about
  // website bookings: this path auto-assigns (pickOpenTech above) and writes
  // status:'assigned', but for its entire existence never notified anyone — the
  // notify helper was private to admin.js and unimportable from here. Keyed off
  // result.technician_id (not the locally picked id) so a tech who LOST the
  // slot race just above is never told about a job that isn't theirs.
  if (result.technician_id) {
    await notifyTechAssigned(db, { id: biz.id, name: "Dom's TV Mounting", timezone: tz },
      result.technician_id, startUTC.toISOString(), tz, { bookingId })
      .catch(e => console.error('[book-doms] tech notify failed:', e.message));
  }

  maybeSendBigBracketAlert({
    lines,
    customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    whenStr: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }); } catch { return dateStr; } })(),
  });

  maybeSendFirstMultiTvDiscountAlert(db, {
    discountAmt: multiTvDiscountAmt,
    customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    whenStr: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }); } catch { return dateStr; } })(),
  }).catch(e => console.warn('[book-doms] multi-tv-discount alert error:', e.message));

  maybeSendZeroOrLowProfitAlert({
    price, lines, techName: technicianName || '',
    customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    scheduled_at: startUTC.toISOString(),
    whenStr: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }); } catch { return dateStr; } })(),
  });

  if (cardSaveFailed) {
    await sendCardSaveFailedAlert({
      slug: 'doms', businessName: "Dom's TV Mounting",
      customer: { name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(), phone: customer.phone, email: customer.email },
      when: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric' }); } catch { return dateStr; } })(),
      reason: cardNote, bookingId,
    });
  }

  // ── Doms-branded confirmation email (best-effort; never fails the booking).
  const domsEmail = emailConfig('doms');
  const willSend = emailNotificationsOn() && !!domsEmail.apiKey && !!customer.email;
  if (willSend) {
    try {
      const [yy, mm, dd] = dateStr.split('-').map(Number);
      const dateLong = new Date(Date.UTC(yy, mm - 1, dd, 12)).toLocaleDateString('en-US',
        { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const slot = SLOTS.find(s => s.key === slotKey);
      const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
      const emailLines = lines.map(l => ({ label: l.name, qty: l.quantity, amount: l.line_total }));
      const { subject, html } = bookingConfirmationEmail({
        firstName:   customer.first_name || sum.firstName || '',
        dateLong,
        timeWindow:  sum.timeWindow || (slot ? slot.label : ''),
        serviceName: "Dom's TV Mounting",
        technicianName,
        technicianPhotoUrl: technicianPhoto?.photo_url || null,
        technicianBioYears: technicianPhoto?.bio_years || null,
        technicianBioBlurb: technicianPhoto?.bio_blurb || null,
        address:     { line1: customer.address, city: b.city || 'Denver', state: b.state || 'CO', zip },
        lines:       emailLines,
        total:       price,
        tip,
        startEpoch:  Math.floor(startUTC.getTime() / 1000),
        endEpoch:    endUTC ? Math.floor(endUTC.getTime() / 1000) : null,
        baseUrl, jobId: bookingId,
        gdsUpsellUrl: gdsUpsellUrlFor({ lines, bookingId, baseUrl }),
        rescheduleUrl: rescheduleUrlFor({ bookingId, baseUrl }),
      }, brandFor('doms'));
      const sent = await sendEmail({ slug: 'doms', to: customer.email, subject, html, replyTo: domsEmail.from });
      if (!sent.sent) console.warn('[book-doms] confirmation email not sent:', sent.skipped || sent.error);
      await persistConfirmationEmailStatus(db, bookingId, sent.sent ? 'sent' : 'failed');
    } catch (e) {
      console.error('[book-doms] confirmation email error:', e.message);
      await persistConfirmationEmailStatus(db, bookingId, 'failed');
    }
  }

  // ── "You're booked" text. Awaited on purpose (see _lib/booking-confirm-sms.js).
  await sendBookingConfirmSms({
    customerPhone: customer.phone,
    smsConsent: b.sms_consent,
    bizName: "Dom's TV Mounting",
    techName: technicianName,
    startUTC, tz,
    timeWindow: sum.timeWindow || (SLOTS.find(s => s.key === slotKey) || {}).label || '',
    tag: 'book-doms',
  });

  return res.status(200).json({
    success: true,
    booking_id: bookingId, job_id: bookingId,
    // From the mirror RESULT, not the locally-picked tech: if this exact
    // tech+slot lost a race to a concurrent booking, mirrorBooking inserted
    // the booking unassigned ('confirmed') and the response must say so.
    status: result.technician_id ? 'assigned' : 'confirmed',
    card_saved: paymentStatus === 'card_on_file',
  });
}

// ── Handy Andy native booking (no Zenbooker) ─────────────────────────────────
// Multi-metro version of bookDoms. The customer's ZIP resolves the service area
// (Denver / Houston / Austin), which fixes BOTH the timezone the slot is anchored
// in AND the technician roster the slot may be assigned from (Houston -> Juan,
// Austin -> Zach, Denver -> Kregg/Steve). Surcharge, after-hours fee, and coupon
// are enforced server-side. `selectedSlot` is the 'handy-andy_<YYYY-MM-DD>_<slotKey>'
// id returned by /api/slots?business=handy-andy.
async function bookNative(req, res, slug) {
  const DISPLAY = NATIVE_BUSINESS[slug] || { name: slug, legalName: slug };
  const b = req.body || {};
  const customer = b.customer || {};
  if (!customer.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!isLikelyStreetAddress(customer.address)) return res.status(400).json({ error: BAD_ADDRESS });

  const parsed = parseSlotId(b.selectedSlot);
  if (!parsed || parsed.businessSlug !== slug) {
    return res.status(400).json({ error: 'A valid time slot is required' });
  }
  const { dateStr, slotKey } = parsed;

  let db;
  try { db = serviceClient(); }
  catch (e) { return res.status(500).json({ error: 'Booking storage not configured', message: e.message }); }

  const { data: biz } = await db.from('businesses').select('id, name').eq('slug', slug).single();
  if (!biz) return res.status(500).json({ error: `${DISPLAY.name} business not configured` });

  // ZIP -> service area: timezone, tech roster scope, per-zip surcharge, and
  // the per-zip FLAT price adjustment (0 = no-op; resilient select in case
  // migration 0083 hasn't landed on this deploy yet).
  const zip = zip5(b.postal_code || customer.zip || '');
  if (!zip) return res.status(400).json({ error: 'A ZIP code is required' });
  let z, zErr;
  ({ data: z, error: zErr } = await db.from('service_area_zips')
    .select('surcharge, price_adjustment_amount, service_area:service_areas ( id, name, state, timezone )')
    .eq('business_id', biz.id).eq('postal_code', zip).maybeSingle());
  if (zErr && /price_adjustment_amount/.test(zErr.message || '')) {
    ({ data: z } = await db.from('service_area_zips')
      .select('surcharge, service_area:service_areas ( id, name, state, timezone )')
      .eq('business_id', biz.id).eq('postal_code', zip).maybeSingle());
  }
  if (!z || !z.service_area) {
    return res.status(400).json({ error: "Sorry — that ZIP code isn't in our service area." });
  }
  const area = z.service_area;
  const serviceAreaId = area.id;
  const tz = area.timezone || 'America/Denver';
  const surcharge = Number(z.surcharge) || 0;
  const priceAdjustmentAmount = Number(z.price_adjustment_amount) || 0;

  const startUTC = slotStartUTC(tz, dateStr, slotKey);
  const endUTC   = slotEndUTC(tz, dateStr, slotKey);
  if (!startUTC) return res.status(400).json({ error: 'Invalid time slot' });
  // The public slot list already omits anything starting within the next hour
  // (publicOpenSlots), but a page can sit open long enough for a slot that WAS
  // fine when it loaded to cross that line by the time they actually submit —
  // re-check here so a stale page can never book a same-hour job. Strict "not
  // more than 60 min out", matching the listing filter exactly.
  if (startUTC.getTime() - Date.now() <= 60 * 60 * 1000) {
    return res.status(409).json({ error: "That time is too soon to book now. Please pick a later time.", conflict: true });
  }

  // After-hours fee: the 8 PM slot (s5) is charged $100 on Sundays, $75 otherwise.
  const dow = dayOfWeekFor(dateStr);
  const afterHours = slotKey === 's5' ? (dow === 0 ? 100 : 75) : 0;

  // Coupon (validated server-side; unknown codes are ignored, never trusted).
  const couponCode = String(b.coupon || '').trim().toUpperCase();
  const couponAmt = await couponAmountFor(db, slug, couponCode);

  // ── Line items for storage. Prefer explicit line_items; else the email_summary
  // lines the widget computed for display.
  const sum = b.email_summary || {};
  let lines = [];
  if (Array.isArray(b.line_items) && b.line_items.length) {
    lines = b.line_items.map(li => ({
      kind: li.kind || 'option',
      name: String(li.name || 'Item').slice(0, 200),
      quantity: Number(li.quantity) || 1,
      unit_price: Number(li.unit_price) || 0,
      line_total: Number(li.line_total != null ? li.line_total : li.unit_price) || 0,
    }));
  } else if (Array.isArray(sum.lines) && sum.lines.length) {
    lines = sum.lines.map(l => {
      const qty = Number(l.qty) || 1;
      const amount = Number(l.amount) || 0;
      return { kind: 'option', name: String(l.label || 'Item').slice(0, 200),
        quantity: qty, unit_price: qty ? amount / qty : amount, line_total: amount };
    });
  }
  // Enforce the money the customer must owe, server-side, so a stale/tampered
  // widget can never drop the surcharge or after-hours fee.
  if (surcharge > 0 && !lines.some(l => /surcharge/i.test(l.name))) {
    lines.push({ kind: 'fee', name: 'Service area surcharge', quantity: 1, unit_price: surcharge, line_total: surcharge });
  }
  if (afterHours > 0 && !lines.some(l => /after.?hours/i.test(l.name))) {
    lines.push({ kind: 'fee', name: 'After-hours fee', quantity: 1, unit_price: afterHours, line_total: afterHours });
  }
  // Per-zip FLAT price adjustment (owner-set, 0 for every zip until
  // configured — see migration 0083). ALWAYS enforced here — unlike the
  // surcharge/after-hours guards above, the widget never sends this as a
  // named line at all (see widget.js zipFlatAdjustment()/calcTotal() — it's
  // folded silently into the totals the customer sees, with no line to
  // check for). This IS the one and only place the charge gets applied.
  // kind:'fee' so payroll skips it outright — it changes what the customer
  // pays, never what the tech is paid. Named plainly (not "zip"/"pricing
  // adjustment") and EXCLUDED from the customer's emailed receipt below
  // (see the `emailLines` filter) — the office can see it on the ticket in
  // the dashboard and in the daily digest; the customer never sees why (or
  // that) their price differs from another address.
  const ZIP_ADJUSTMENT_LINE_NAME = 'Location-based pricing';
  if (priceAdjustmentAmount) {
    lines.push({ kind: 'fee', name: ZIP_ADJUSTMENT_LINE_NAME, quantity: 1, unit_price: priceAdjustmentAmount, line_total: priceAdjustmentAmount });
  }
  if (couponAmt > 0 && !lines.some(l => /coupon|discount/i.test(l.name))) {
    lines.push({ kind: 'coupon', name: `Coupon ${couponCode}`, quantity: 1, unit_price: -couponAmt, line_total: -couponAmt });
  }
  // Multi-TV batching + price discounts -- see applyMultiTvDiscounts() above
  // (shared with bookDoms). Numbers live in multi_tv_discount_config now, not
  // hardcoded here; the widget (public/widget.js, multiTvDiscount /
  // steppedMultiTvPriceDiscount) fetches the same row via the public
  // multi_tv_discount action below.
  const multiTvDiscountAmt = applyMultiTvDiscounts(lines, surcharge, await multiTvDiscountConfigFor(db));
  // Sales tax (8.25%) on the taxable subtotal (services + fees, not coupons or
  // an existing tax line) — added server-side so a stale/tampered widget can't
  // drop it. Placed before the coupon so tax is on the pre-discount amount.
  if (!lines.some(l => /^tax\b/i.test(l.name))) {
    const taxable = lines
      .filter(l => l.kind !== 'coupon' && !/^tax\b/i.test(l.name || ''))
      .reduce((s, l) => s + (Number(l.line_total) || 0), 0);
    const tax = Math.round(taxable * 0.0825 * 100) / 100;
    if (tax > 0) lines.push({ kind: 'fee', name: 'Tax (8.25%)', quantity: 1, unit_price: tax, line_total: tax });
  }
  const tip = Number(b.tip) || 0;
  const subtotal = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const widgetTotal = sum.total != null ? Number(sum.total) : subtotal;
  const price = Math.max(subtotal, widgetTotal) || subtotal;

  // ── Pick a tech from THIS metro's roster BEFORE saving the card or writing
  // anything, and REJECT with a 409 if nobody is available anymore. Same guard
  // as bookDoms above (see the comment there): the customer's slot list is a
  // snapshot, and a job must never be created without a technician.
  let technician_id = null, pickBroken = false;
  try { technician_id = await pickOpenTech(db, { businessSlug: slug, dateStr, slotKey, serviceAreaId, timezone: tz, crossHire: true }); }
  catch (e) {
    console.warn('[book-ha] tech pick failed, retrying once:', e.message);
    try { technician_id = await pickOpenTech(db, { businessSlug: slug, dateStr, slotKey, serviceAreaId, timezone: tz, crossHire: true }); }
    catch (e2) { pickBroken = true; console.error('[book-ha] tech pick failed twice:', e2.message); }
  }
  if (!technician_id) {
    // See the matching comment in bookDoms: an idempotent retry of an
    // already-successful submit finds its OWN booking occupying the tech
    // (guaranteed in single-tech metros: Houston, Austin) and must get its
    // original success back, not a phantom 409.
    const dup = await idempotentPrior(db, biz.id, b.idempotency_key);
    if (dup) return res.status(200).json(dup);
    if (pickBroken) {
      return res.status(409).json({ error: 'We could not confirm that time is still open. Please try again in a moment.', conflict: true });
    }
    return res.status(409).json({ error: SLOT_TAKEN_MSG, conflict: true, slot_taken: true });
  }
  let technicianName = null, technicianPhoto = null;
  try {
    const { data: _t } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
    technicianName = _t?.name || null;
    technicianPhoto = _t || null;
  } catch (e) { /* name is best-effort */ }

  // ── Save the card on file in this business's own Stripe account (best-effort), using
  // HANDY_ANDY_STRIPE_SECRET_KEY. The card is tokenized in the browser with the
  // matching publishable key, so the publishable/secret pair are the same account.
  // Runs AFTER the tech guard on purpose: a rejected booking must not leave a
  // customer + card sitting in Stripe.
  let stripeCustomerId = null, paymentStatus = 'unpaid', cardNote = '';
  if (b.payment_method_id) {
    if (!stripeConfigured({ account: slug })) {
      cardNote = `Card captured (${b.payment_method_id}) but HANDY_ANDY_STRIPE_SECRET_KEY is not set — card was NOT saved on file.`;
    } else {
      try {
        const r = await saveCardOnFile({
          email: customer.email,
          name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          phone: customer.phone, paymentMethodId: b.payment_method_id, account: slug,
        });
        stripeCustomerId = r.customerId;
        paymentStatus = 'card_on_file';
        cardNote = `Card is on file (${DISPLAY.name} Stripe).`;
      } catch (e) {
        cardNote = `Card capture failed: ${e.message} (pm ${b.payment_method_id} was never attached)`;
      }
    }
  }

  const city = b.city || area.name || null;
  const state = b.state || area.state || null;
  if (cardNote) console.log('[book-ha] card:', cardNote);
  // Same silent-failure class as bookDoms above — see the comment there.
  const cardSaveFailed = !!(b.payment_method_id && paymentStatus !== 'card_on_file');

  // ── Write the booking (customer, booking, line items, status event, review token).
  let result = {};
  try {
    result = (await mirrorBooking({
      businessSlug: slug, source: 'widget',
      landing_page: b.landing_page || null, traffic_source: b.traffic_source || null,
      service_area_id: serviceAreaId,
      technician_id,
      status: technician_id ? 'assigned' : 'confirmed',
      scheduled_at: startUTC.toISOString(),
      scheduled_end: endUTC ? endUTC.toISOString() : null,
      duration_minutes: 120,
      service_name: 'TV Mounting',
      idempotency_key: b.idempotency_key || null,
      sms_consent: b.sms_consent,
      stripe_account: slug,
      customer: {
        first_name: customer.first_name, last_name: customer.last_name,
        name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        email: customer.email, phone: customer.phone,
      },
      address: { line1: customer.address, line2: customer.address_line2 || null, city, state, postal_code: zip },
      line_items: lines, subtotal, price, tip,
      payment_status: paymentStatus,
      stripe_customer_id: stripeCustomerId,
      // Same as bookDoms: a pm that failed to attach is not a saved card.
      stripe_payment_method_id: cardSaveFailed ? null : (b.payment_method_id || null),
      notes: cardSaveFailed ? `⚠ ${cardNote}` : null,
      customer_notes: b.customer_notes || sum.notes || null,
    })) || {};
  } catch (e) {
    console.error('[book-ha] mirror error:', e.message);
    return res.status(500).json({ error: 'Could not save booking', message: e.message });
  }
  const bookingId = result.booking_id || null;
  // See the matching comment in bookDoms: no id means nothing was created.
  if (!bookingId) {
    console.error('[book-ha] mirror returned no booking id');
    return res.status(500).json({ error: 'Could not save your booking. Please try again.' });
  }
  // Same race-fallback recovery as bookDoms above (see the comment there): a
  // technician-less job must never sit in the CRM silently.
  if (bookingId && !result.technician_id) {
    result.technician_id = await recoverUnassignedBooking(db, {
      slug, bizId: biz.id, bookingId, dateStr, slotKey, serviceAreaId, timezone: tz,
      businessName: DISPLAY.name,
      customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      whenStr: fmtWhen(startUTC, tz, dateStr),
    });
  }
  if (result.technician_id !== technician_id) {
    technicianName = null; technicianPhoto = null;
    if (result.technician_id) {
      try {
        const { data: _t } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', result.technician_id).maybeSingle();
        technicianName = _t?.name || null;
        technicianPhoto = _t || null;
      } catch (e) { /* best-effort */ }
    }
  }

  // Text the assigned tech — see the matching comment in bookDoms. `tz` here is
  // the METRO's timezone (an Austin job is Central), so the tech is told the
  // job's real local time rather than the company's Mountain clock.
  if (result.technician_id) {
    await notifyTechAssigned(db, { id: biz.id, name: DISPLAY.name, timezone: tz },
      result.technician_id, startUTC.toISOString(), tz, { bookingId })
      .catch(e => console.error('[book-ha] tech notify failed:', e.message));
  }

  maybeSendBigBracketAlert({
    lines,
    customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    whenStr: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }); } catch { return dateStr; } })(),
  });
  maybeSendFirstMultiTvDiscountAlert(db, {
    discountAmt: multiTvDiscountAmt,
    customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    whenStr: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }); } catch { return dateStr; } })(),
  }).catch(e => console.warn('[book-ha] multi-tv-discount alert error:', e.message));

  maybeSendZeroOrLowProfitAlert({
    price, lines, techName: technicianName || '',
    customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
    scheduled_at: startUTC.toISOString(),
    whenStr: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }); } catch { return dateStr; } })(),
  });

  if (cardSaveFailed) {
    await sendCardSaveFailedAlert({
      slug, businessName: DISPLAY.legalName,
      customer: { name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(), phone: customer.phone, email: customer.email },
      when: (() => { try { return startUTC.toLocaleDateString('en-US', { timeZone: tz || 'America/Denver', weekday: 'short', month: 'short', day: 'numeric' }); } catch { return dateStr; } })(),
      reason: cardNote, bookingId,
    });
  }

  // ── Business-branded confirmation email (best-effort; never fails booking).
  const haEmail = emailConfig(slug);
  const willSend = emailNotificationsOn() && !!haEmail.apiKey && !!customer.email;
  if (willSend) {
    try {
      const [yy, mm, dd] = dateStr.split('-').map(Number);
      const dateLong = new Date(Date.UTC(yy, mm - 1, dd, 12)).toLocaleDateString('en-US',
        { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      const slot = SLOTS.find(s => s.key === slotKey);
      const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
      // The zip price adjustment is real money the customer pays (it's inside
      // `price`/`subtotal` below), but is NEVER itemized to them — filtered
      // out of the receipt they actually see. It still lives in `lines`
      // (stored on the booking) for the office/admin and the daily digest.
      const emailLines = lines
        .filter(l => l.name !== ZIP_ADJUSTMENT_LINE_NAME)
        .map(l => ({ label: l.name, qty: l.quantity, amount: l.line_total }));
      const { subject, html } = bookingConfirmationEmail({
        firstName:   customer.first_name || sum.firstName || '',
        dateLong,
        timeWindow:  sum.timeWindow || (slot ? slot.label : ''),
        serviceName: 'TV Mounting',
        technicianName,
        technicianPhotoUrl: technicianPhoto?.photo_url || null,
        technicianBioYears: technicianPhoto?.bio_years || null,
        technicianBioBlurb: technicianPhoto?.bio_blurb || null,
        address:     { line1: customer.address, city, state, zip },
        lines:       emailLines,
        total:       price,
        tip,
        startEpoch:  Math.floor(startUTC.getTime() / 1000),
        endEpoch:    endUTC ? Math.floor(endUTC.getTime() / 1000) : null,
        baseUrl, jobId: bookingId,
        gdsUpsellUrl: gdsUpsellUrlFor({ lines, bookingId, baseUrl }),
        rescheduleUrl: rescheduleUrlFor({ bookingId, baseUrl }),
      }, brandFor(slug));
      const sent = await sendEmail({ slug, to: customer.email, subject, html, replyTo: haEmail.from });
      if (!sent.sent) console.warn('[book-ha] confirmation email not sent:', sent.skipped || sent.error);
      await persistConfirmationEmailStatus(db, bookingId, sent.sent ? 'sent' : 'failed');
    } catch (e) {
      console.error('[book-ha] confirmation email error:', e.message);
      await persistConfirmationEmailStatus(db, bookingId, 'failed');
    }
  }

  // ── "You're booked" text. Awaited on purpose (see _lib/booking-confirm-sms.js).
  // DISPLAY.name is the JOB's business (Mile High / Precision / Austin), never
  // the cross-hired tech's home company.
  await sendBookingConfirmSms({
    customerPhone: customer.phone,
    smsConsent: b.sms_consent,
    bizName: DISPLAY.name,
    techName: technicianName,
    startUTC, tz,
    timeWindow: sum.timeWindow || (SLOTS.find(s => s.key === slotKey) || {}).label || '',
    tag: 'book-ha',
  });

  return res.status(200).json({
    success: true,
    booking_id: bookingId, job_id: bookingId,
    // From the mirror RESULT, not the locally-picked tech: if this exact
    // tech+slot lost a race to a concurrent booking, mirrorBooking inserted
    // the booking unassigned ('confirmed') and the response must say so.
    status: result.technician_id ? 'assigned' : 'confirmed',
    card_saved: paymentStatus === 'card_on_file',
  });
}

// ── One-tap "on my way" from the pre-job nudge text ─────────────────────────
// The nudge (_lib/tech-late.js stage 1) texts the tech a link to /otw.html
// carrying a signed { kind:'otw_quick', booking_id, tech_id } token. That page
// reads the job with action=otw_info and only acts when the tech taps the
// button, which POSTs action=otw_send.
//
// GET is deliberately read-only. SMS clients, carriers and link scanners
// routinely prefetch URLs in a message — if tapping were a plain GET, a link
// preview would mark the job en route and text the customer before the tech
// had even seen the message.
const OTW_OPEN_STATUSES = ['pending', 'confirmed', 'assigned'];

function otwToken(req) {
  const raw = ((req.query || {}).token || (req.body || {}).token || '').toString();
  const t = verifyToken(raw);
  return (t && t.kind === 'otw_quick' && t.booking_id) ? t : null;
}

async function otwInfo(req, res) {
  const t = otwToken(req);
  if (!t) return res.status(200).json({ ok: false, reason: 'invalid' });
  const db = serviceClient();
  const { data: b } = await db.from('bookings')
    .select('id, status, on_the_way_at, scheduled_at, service_area_id, business:businesses(name, timezone), customer:customers(name)')
    .eq('id', t.booking_id).maybeSingle();
  if (!b) return res.status(200).json({ ok: false, reason: 'invalid' });

  let tz = b.business?.timezone || 'America/Denver';
  if (b.service_area_id) {
    try {
      const { data: sa } = await db.from('service_areas').select('timezone').eq('id', b.service_area_id).maybeSingle();
      if (sa?.timezone) tz = sa.timezone;
    } catch { /* fall back to business tz */ }
  }
  let whenTxt = null;
  try {
    whenTxt = new Date(b.scheduled_at).toLocaleString('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit',
    });
  } catch { /* leave null */ }

  return res.status(200).json({
    ok: true,
    already: !!b.on_the_way_at || !OTW_OPEN_STATUSES.includes(b.status),
    customer: b.customer?.name || 'your customer',
    when: whenTxt,
    business: b.business?.name || null,
  });
}

async function otwSend(req, res) {
  const t = otwToken(req);
  if (!t) return res.status(200).json({ ok: false, reason: 'invalid' });
  const db = serviceClient();

  const { data: b } = await db.from('bookings')
    .select('id, status, on_the_way_at, sms_consent, technician_id, secondary_technician_id, customer:customers(name, phone)')
    .eq('id', t.booking_id).maybeSingle();
  if (!b) return res.status(200).json({ ok: false, reason: 'invalid' });

  // Idempotent, and safe against a stale link: a job already en route (or
  // further along) is never dragged backwards, it just reports success.
  if (b.on_the_way_at || !OTW_OPEN_STATUSES.includes(b.status)) {
    return res.status(200).json({ ok: true, already: true, customer: b.customer?.name || 'your customer' });
  }

  // Only a tech actually on this job may act on it, even with a valid token.
  const tokenTech = String(t.tech_id || '');
  const onThisJob = tokenTech && (tokenTech === String(b.technician_id) || tokenTech === String(b.secondary_technician_id));
  if (!onThisJob) return res.status(200).json({ ok: false, reason: 'not_assigned' });

  const nowISO = new Date().toISOString();
  const { error: upErr } = await db.from('bookings')
    .update({ status: 'on_the_way', on_the_way_at: nowISO })
    .eq('id', b.id)
    .is('on_the_way_at', null);          // lost race with the app = no double send
  if (upErr) {
    console.error('[otw_send] status update failed:', upErr.message);
    return res.status(200).json({ ok: false, reason: 'error' });
  }

  // Mirror the tech app: show them as on a job in the dashboard.
  try { await db.from('technicians').update({ status: 'on_job' }).eq('id', tokenTech); } catch { /* cosmetic */ }

  // Awaited on purpose — an un-awaited send is silently killed when Vercel
  // freezes the lambda on response.
  await sendEnRouteSms(db, {
    bookingId: b.id,
    technicianId: tokenTech,
    customerPhone: b.customer?.phone,
    smsConsent: b.sms_consent,
  });

  console.log(`[otw_send] booking=${b.id} tech=${tokenTech} marked en route from nudge link`);
  return res.status(200).json({ ok: true, already: false, customer: b.customer?.name || 'your customer' });
}

// ── Voicemail deep link ─────────────────────────────────────────────────────
// The alert text sent to the secretary (notifyCallRecipient in api/admin.js)
// carries a signed link to /voicemail.html so they can read what the caller
// actually said and tap to ring them back, without logging into the dashboard
// on a phone first. Read-only: this exposes nothing but the one voicemail the
// token names, and the token is unguessable (HMAC, see _lib/auth.js).
async function voicemailInfo(req, res) {
  const t = verifyToken(((req.query || {}).token || '').toString());
  if (!t || t.kind !== 'voicemail' || !t.call_id) return res.status(200).json({ ok: false, reason: 'invalid' });
  const db = serviceClient();
  const { data: c } = await db.from('calls')
    .select('id, caller_phone, transcript, occurred_at, service, market, status, claimed_by, claimed_at, business:businesses(name)')
    .eq('id', t.call_id).maybeSingle();
  if (!c) return res.status(200).json({ ok: false, reason: 'invalid' });
  return res.status(200).json({
    ok: true,
    phone: c.caller_phone || null,
    transcript: c.transcript || null,
    occurred_at: c.occurred_at || null,
    service: c.service || null,
    market: c.market || null,
    business: c.business?.name || null,
    claimed_by: c.claimed_by || null,
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();
  // Public calendar (.ics) download for the "Add to Apple Calendar" button in
  // booking-confirmation emails. Lives here (rather than its own api/ file) to
  // stay under Vercel's 12-function Hobby cap.
  if (req.method === 'GET' && (req.query || {}).action === 'ics') return serveIcs(req, res);
  if (req.method === 'GET' && (req.query || {}).action === 'review_click') return serveReviewClick(req, res);
  // Public address-autocomplete proxy for the booking widget.
  if (req.method === 'GET' && (req.query || {}).action === 'places_autocomplete') return placesAutocompletePublic(req, res);
  if (req.method === 'GET' && (req.query || {}).action === 'place_details') return placeDetailsPublic(req, res);
  // Public price overrides for the booking widget — see widgetPricesPublic() below.
  if (req.method === 'GET' && (req.query || {}).action === 'widget_prices') return widgetPricesPublic(req, res);
  // Live promo codes for the widget — see couponsPublic() above.
  if (req.method === 'GET' && (req.query || {}).action === 'coupons') return couponsPublic(req, res);
  // Live multi-TV discount numbers for the widget, see multiTvDiscountPublic() below.
  if (req.method === 'GET' && (req.query || {}).action === 'multi_tv_discount') return multiTvDiscountPublic(req, res);
  if (req.method === 'GET' && (req.query || {}).action === 'stripe_config') return stripePublicConfig(req, res);
  if (req.method === 'GET' && (req.query || {}).action === 'email_config') return emailPublicConfig(req, res);
  // One-tap "on my way" link from the pre-job nudge text. Read on GET, act on POST.
  if (req.method === 'GET' && (req.query || {}).action === 'otw_info') return otwInfo(req, res);
  // Signed voicemail link from the secretary's alert text.
  if (req.method === 'GET' && (req.query || {}).action === 'vm_info') return voicemailInfo(req, res);
  if (req.method === 'POST' && ((req.query || {}).action === 'otw_send' || (req.body || {}).action === 'otw_send')) return otwSend(req, res);
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Native CRM businesses — branch before any Zenbooker work.
  if (req.body && req.body.business === 'doms') return bookDoms(req, res);
  if (req.body && NATIVE_BUSINESS[req.body.business]) return bookNative(req, res, req.body.business);

  // Zenbooker was canceled 2026-07-31 — see the matching comment in
  // api/service-area.js. This entire branch (job creation, card-on-file
  // linking, unstaffed-job detection, confirmation email) was the legacy
  // Zenbooker booking flow. Every real business is caught by the native
  // branches above; nothing legitimate should ever reach here, so this is a
  // hard dead-end rather than a live fallback that could ever call out.
  return res.status(410).json({ error: 'Unknown or missing business. Zenbooker is no longer used — pass business=handy-andy, mile-high, or doms.' });
}
