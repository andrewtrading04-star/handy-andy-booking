import { mirrorBooking } from './_lib/mirror.js';
import { NATIVE_BUSINESS } from './_lib/native-businesses.js';
import { emailNotificationsOn } from './_lib/notify.js';
import { emailConfig, sendEmail, bookingConfirmationEmail, brandFor } from './_lib/email.js';
import { serviceClient } from './_lib/supabase.js';
import { parseSlotId, slotStartUTC, slotEndUTC, pickOpenTech, SLOTS, dayOfWeekFor } from './_lib/availability.js';
import { saveCardOnFile, stripeConfigured } from './_lib/stripe.js';
import { verifyToken } from './_lib/auth.js';
import { isLikelyStreetAddress } from './_lib/address.js';
import { sendCardSaveFailedAlert, maybeSendBigBracketAlert, maybeSendFirstMultiTvDiscountAlert, maybeSendZeroOrLowProfitAlert, gdsUpsellUrlFor, rescheduleUrlFor } from './_lib/owner-notify.js';
import { notifyTechAssigned } from './_lib/tech-notify.js';
import { sendEnRouteSms } from './_lib/en-route.js';

const BAD_ADDRESS = 'Please enter a valid street address (with a house number) — not an email or phone number.';

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
const EMAIL_BUSINESSES = new Set(['handy-andy', 'doms', 'mile-high']);
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
    return res.status(409).json({ error: "That time is too soon to book now — please pick a later slot.", conflict: true });
  }

  let db;
  try { db = serviceClient(); }
  catch (e) { return res.status(500).json({ error: 'Booking storage not configured', message: e.message }); }

  // Resolve Doms business + its Denver service area + the per-zip surcharge.
  const { data: biz } = await db.from('businesses').select('id').eq('slug', 'doms').single();
  if (!biz) return res.status(500).json({ error: 'Doms business not configured' });
  const { data: area } = await db.from('service_areas')
    .select('id').eq('business_id', biz.id).eq('name', 'Denver').maybeSingle();

  const zip = String(b.postal_code || customer.zip || '').trim();
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
  const tip = Number(b.tip) || 0;
  const subtotal = lines.reduce((s, l) => s + (Number(l.line_total) || 0), 0);
  const widgetTotal = sum.total != null ? Number(sum.total) : subtotal;
  // Never below the surcharge-inclusive server subtotal.
  const price = Math.max(subtotal, widgetTotal) || subtotal;

  // ── Save the card on file in DOMS' Stripe account (best-effort). The card was
  // tokenized client-side with Doms' publishable key, so only Doms' secret key
  // can attach/charge it. Never fail the booking if this errors.
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
        cardNote = `Card capture failed: ${e.message}`;
      }
    }
  }

  // ── Assign an available Doms tech so the slot is actually occupied.
  let technician_id = null;
  try { technician_id = await pickOpenTech(db, { businessSlug: 'doms', dateStr, slotKey, crossHire: true }); }
  catch (e) { console.warn('[book-doms] tech pick failed:', e.message); }
  // Resolve the assigned tech's name (+ photo/bio for the "Meet your tech"
  // confirmation-email block) — best-effort.
  let technicianName = null, technicianPhoto = null;
  if (technician_id) {
    try {
      const { data: _t } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
      technicianName = _t?.name || null;
      technicianPhoto = _t || null;
    } catch (e) { /* name is best-effort */ }
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
      service_area_id: area?.id || null,
      technician_id,
      status: technician_id ? 'assigned' : 'confirmed',
      scheduled_at: startUTC.toISOString(),
      scheduled_end: endUTC ? endUTC.toISOString() : null,
      duration_minutes: 120,
      service_name: "Dom's TV Mounting",
      idempotency_key: b.idempotency_key || null,
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
      stripe_payment_method_id: b.payment_method_id || null,
      notes: cardSaveFailed ? `⚠ ${cardNote}` : null,
      customer_notes: b.customer_notes || sum.notes || null,
    })) || {};
  } catch (e) {
    console.error('[book-doms] mirror error:', e.message);
    return res.status(500).json({ error: 'Could not save booking', message: e.message });
  }
  const bookingId = result.booking_id || null;
  // mirrorBooking falls back to unassigned if this exact tech+slot lost a race
  // to a concurrent booking (bookings_tech_slot_unique, migration 0073) —
  // when that happens the booking's real technician_id comes back null even
  // though `technician_id` here still holds the tech we ORIGINALLY picked.
  // Never let the confirmation email say "Meet [Tech]" for a job that isn't
  // actually assigned to them.
  if (technician_id && result.technician_id !== technician_id) {
    technicianName = null; technicianPhoto = null;
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
  const zip = String(b.postal_code || customer.zip || '').trim();
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
    return res.status(409).json({ error: "That time is too soon to book now — please pick a later slot.", conflict: true });
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
  // Multi-TV batching discount (3+ TVs on one ticket): rewards big jobs since
  // mounting several TVs in one drive is highly profitable. Computed
  // server-side from the REAL line items (never trusts the client's TV count),
  // so a stale/tampered widget can never grant a bigger discount than earned.
  // The cut depends on the travel-fee zone (`surcharge`, resolved above from
  // this customer's real zip) — the bigger the existing fee, the bigger the
  // cut, since that is exactly the case where the fee is the reason a big job
  // gets skipped. Zone with no travel fee instead gets a flat $10 off PER TV.
  // Mirrored client-side in public/widget.js (multiTvDiscount) — keep in sync.
  let multiTvDiscountAmt = 0;
  if (!lines.some(l => /multi-tv discount/i.test(l.name))) {
    const tvCount = lines.reduce((n, l) => {
      const nm = String(l.name || '');
      if (/"/.test(nm) || /or less/i.test(nm) || /^98\+/i.test(nm.trim())) return n + (Number(l.quantity) || 1);
      return n;
    }, 0);
    if (tvCount >= 3) {
      if (surcharge <= 0) {
        const perTvAmt = 10 * tvCount;
        lines.push({ kind: 'coupon', name: `Multi-TV discount (-$10 × ${tvCount} TVs)`, quantity: 1, unit_price: -perTvAmt, line_total: -perTvAmt });
        multiTvDiscountAmt = perTvAmt;
      } else {
        const cutPct = surcharge === 15 ? 1.00 : (surcharge === 65 || surcharge === 100) ? 0.60 : 0;
        if (cutPct > 0) {
          const cutAmt = Math.round(surcharge * cutPct * 100) / 100;
          lines.push({ kind: 'coupon', name: 'Multi-TV discount', quantity: 1, unit_price: -cutAmt, line_total: -cutAmt });
          multiTvDiscountAmt = cutAmt;
        }
      }
    }
  }
  // Multi-TV PRICE discount (stacks on top of the travel-fee cut above): TV
  // #1-2 stay full price, TV #3 is -$20, TV #4 is -$25, TV #5+ is -$30 each.
  // Flip MULTI_TV_PRICE_DISCOUNT_ENABLED to false to turn the whole thing off.
  // Computed server-side from the REAL line items (never trusts the client),
  // so a stale/tampered widget can never grant a bigger discount than earned.
  // Mirrored client-side in public/widget.js (steppedMultiTvPriceDiscount) —
  // keep in sync.
  const MULTI_TV_PRICE_DISCOUNT_ENABLED = true;
  if (MULTI_TV_PRICE_DISCOUNT_ENABLED && !lines.some(l => /multi-tv price discount/i.test(l.name))) {
    const tvCount = lines.reduce((n, l) => {
      const nm = String(l.name || '');
      if (/"/.test(nm) || /or less/i.test(nm) || /^98\+/i.test(nm.trim())) return n + (Number(l.quantity) || 1);
      return n;
    }, 0);
    if (tvCount >= 3) {
      let priceDiscAmt = 0;
      for (let i = 3; i <= tvCount; i++) priceDiscAmt += (i === 3 ? 20 : i === 4 ? 25 : 30);
      if (priceDiscAmt > 0) {
        lines.push({ kind: 'coupon', name: `Multi-TV price discount (${tvCount} TVs)`, quantity: 1, unit_price: -priceDiscAmt, line_total: -priceDiscAmt });
      }
    }
  }
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

  // ── Save the card on file in this business's own Stripe account (best-effort), using
  // HANDY_ANDY_STRIPE_SECRET_KEY. The card is tokenized in the browser with the
  // matching publishable key, so the publishable/secret pair are the same account.
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
        cardNote = `Card capture failed: ${e.message}`;
      }
    }
  }

  // ── Assign a tech from THIS metro's roster so the slot is occupied.
  let technician_id = null;
  try { technician_id = await pickOpenTech(db, { businessSlug: slug, dateStr, slotKey, serviceAreaId, timezone: tz, crossHire: true }); }
  catch (e) { console.warn('[book-ha] tech pick failed:', e.message); }
  let technicianName = null, technicianPhoto = null;
  if (technician_id) {
    try {
      const { data: _t } = await db.from('technicians').select('name, photo_url, bio_years, bio_blurb').eq('id', technician_id).maybeSingle();
      technicianName = _t?.name || null;
      technicianPhoto = _t || null;
    } catch (e) { /* name is best-effort */ }
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
      service_area_id: serviceAreaId,
      technician_id,
      status: technician_id ? 'assigned' : 'confirmed',
      scheduled_at: startUTC.toISOString(),
      scheduled_end: endUTC ? endUTC.toISOString() : null,
      duration_minutes: 120,
      service_name: 'TV Mounting',
      idempotency_key: b.idempotency_key || null,
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
      stripe_payment_method_id: b.payment_method_id || null,
      notes: cardSaveFailed ? `⚠ ${cardNote}` : null,
      customer_notes: b.customer_notes || sum.notes || null,
    })) || {};
  } catch (e) {
    console.error('[book-ha] mirror error:', e.message);
    return res.status(500).json({ error: 'Could not save booking', message: e.message });
  }
  const bookingId = result.booking_id || null;
  // Same race-fallback check as bookDoms above — see the comment there.
  if (technician_id && result.technician_id !== technician_id) {
    technicianName = null; technicianPhoto = null;
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
