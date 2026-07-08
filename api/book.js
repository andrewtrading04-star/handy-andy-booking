import { mirrorBooking } from './_lib/mirror.js';
import { emailNotificationsOn } from './_lib/notify.js';
import { emailConfig, sendEmail, bookingConfirmationEmail, brandFor } from './_lib/email.js';
import { serviceClient } from './_lib/supabase.js';
import { parseSlotId, slotStartUTC, slotEndUTC, pickOpenTech, SLOTS, dayOfWeekFor } from './_lib/availability.js';
import { saveCardOnFile, stripeConfigured } from './_lib/stripe.js';
import { verifyToken } from './_lib/auth.js';
import { isLikelyStreetAddress } from './_lib/address.js';

const BAD_ADDRESS = 'Please enter a valid street address (with a house number) — not an email or phone number.';

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

// 1×1 transparent GIF for review-email open tracking.
const TRACKING_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// GET /api/book?action=review_open&token=<review_token> — records the first open
// of a "How did we do?" email, then returns the pixel. Never errors visibly.
async function serveReviewPixel(req, res) {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  try {
    const t = verifyToken(((req.query || {}).token || '').toString());
    if (t && t.kind === 'review' && t.booking_id) {
      const db = serviceClient();
      await db.from('bookings')
        .update({ review_email_opened_at: new Date().toISOString() })
        .eq('id', t.booking_id).is('review_email_opened_at', null);
    }
  } catch (e) { /* tracking is best-effort; always return the pixel */ }
  return res.status(200).send(TRACKING_GIF);
}

// After creating the Zenbooker job this handler does several more sequential
// calls (auto-assign check, Stripe card-on-file, CRM mirror, confirmation email).
// At Vercel's default ~10s timeout the function could die AFTER the job was
// created, leaving the customer with no confirmation — so they'd click again and
// create a duplicate. Give the post-booking work room to finish so the client
// always gets a clean success and never needs to retry.
export const config = { maxDuration: 60 };

// Format a slot id ("slot_<startEpochSec>_<endEpochSec>") into a friendly date +
// arrival window in the territory's local timezone. Used as a fallback so the
// confirmation email still has the date/time even if an older cached widget
// doesn't send the display summary.
function slotWhen(slotId, territoryId) {
  const m = /^slot_(\d+)_(\d+)/.exec(String(slotId || ''));
  if (!m) return { dateLong: '', timeWindow: '', startSec: 0, endSec: 0 };
  const startSec = Number(m[1]), endSec = Number(m[2]);
  const startMs = startSec * 1000, endMs = endSec * 1000;
  if (!startMs) return { dateLong: '', timeWindow: '', startSec: 0, endSec: 0 };
  const tz = TERRITORY_TZ[territoryId] || 'America/Denver';
  const dateLong = new Date(startMs).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const t = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  const timeWindow = endMs ? `${t(startMs)} – ${t(endMs)}` : t(startMs);
  return { dateLong, timeWindow, startSec, endSec };
}

// Valid coupon codes → discount in dollars (owner-provided, June 2026).
// Zenbooker has no native coupon support, so a valid code is applied to the
// job as a negative-price custom service line item.
const COUPONS = {
  MCDENVER20: 20, MP10: 10, AUS10: 10, HOU10: 10, DEN10: 10,
  ISREAL15: 15, STEVE15: 15, BATCITY10: 10, FBD15: 15, FB15: 15,
  ANNIVERSARY15: 15, BING10: 10, OLIVE10: 10, STV10: 10, G10TV: 10,
  TV2026: 10, HG20: 20, LA10: 10, AB20: 20, FBA20: 20, FB10: 10,
};

// Hard-coded after-hours fee: every job whose arrival window starts at 8 PM or
// later (territory-local time) is charged a flat $75, no matter what. Enforced
// here on the server so it applies even if a stale/cached widget doesn't send it.
const AFTER_HOURS_FEE = 75;
const TERRITORY_TZ = {
  '1707514546803x280800015001583600': 'America/Chicago',     // Houston #1
  '1685582903241x973573877706522600': 'America/Denver',      // Denver #1
  '1707513178246x806633139915194400': 'America/Denver',      // Denver #2
  '1687393551618x123774611115737090': 'America/Denver',      // Denver #3
  '1723559782141x609094402068185100': 'America/Denver',      // Denver #4 Boulder/CS
  '1724797832896x339501352491155460': 'America/Chicago',     // Austin
  '1760944311332x492178768310304800': 'America/Los_Angeles', // Los Angeles
};
// Slot ids are "slot_<startEpochSec>_<endEpochSec>"; derive the local start hour.
function afterHoursFeeFor(slotId, territoryId) {
  const m = /^slot_(\d+)_/.exec(String(slotId || ''));
  if (!m) return 0;
  const startMs = Number(m[1]) * 1000;
  if (!startMs) return 0;
  const tz = TERRITORY_TZ[territoryId] || 'America/Denver';
  const hour = Number(new Date(startMs).toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false })) % 24;
  if (hour < 20) return 0;
  // Mirror Zenbooker's after-hours config: $100 on Sundays, $75 every other day.
  const weekday = new Date(startMs).toLocaleString('en-US', { timeZone: tz, weekday: 'long' });
  return weekday === 'Sunday' ? 100 : AFTER_HOURS_FEE;
}

// Distance surcharge for the outer Denver territories. Zenbooker DOES have these
// configured as `service_territory` price adjustments, but it only applies them
// through its own hosted booking flow — jobs created via the API (this widget)
// are NOT charged the adjustment (confirmed: API-created Denver-outer jobs land at
// base price). The widget already shows this surcharge to the customer, so we
// charge it here to match. Mirrors Zenbooker's own values exactly. If Zenbooker
// ever starts applying these to API jobs, remove this to avoid a double-charge.
const TERRITORY_SURCHARGE = {
  '1707513178246x806633139915194400': 25,  // Denver #2
  '1687393551618x123774611115737090': 35,  // Denver #3
  '1723559782141x609094402068185100': 100, // Denver #4 Boulder/Colorado Springs
};
function territorySurchargeFor(territoryId) { return TERRITORY_SURCHARGE[territoryId] || 0; }

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
  try { technician_id = await pickOpenTech(db, { businessSlug: 'doms', dateStr, slotKey }); }
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
      address: { line1: customer.address, city: b.city || 'Denver', state: b.state || 'CO', postal_code: zip },
      line_items: lines, subtotal, price, tip,
      payment_status: paymentStatus,
      stripe_customer_id: stripeCustomerId,
      stripe_payment_method_id: b.payment_method_id || null,
      // Card status is logged server-side only — not written to office notes.
      notes: null,
      customer_notes: b.customer_notes || sum.notes || null,
    })) || {};
  } catch (e) {
    console.error('[book-doms] mirror error:', e.message);
    return res.status(500).json({ error: 'Could not save booking', message: e.message });
  }
  const bookingId = result.booking_id || null;

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
      }, brandFor('doms'));
      const sent = await sendEmail({ slug: 'doms', to: customer.email, subject, html, replyTo: domsEmail.from });
      if (!sent.sent) console.warn('[book-doms] confirmation email not sent:', sent.skipped || sent.error);
    } catch (e) {
      console.error('[book-doms] confirmation email error:', e.message);
    }
  }

  return res.status(200).json({
    success: true,
    booking_id: bookingId, job_id: bookingId,
    status: technician_id ? 'assigned' : 'confirmed',
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
async function bookHandyAndy(req, res) {
  const b = req.body || {};
  const customer = b.customer || {};
  if (!customer.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!isLikelyStreetAddress(customer.address)) return res.status(400).json({ error: BAD_ADDRESS });

  const parsed = parseSlotId(b.selectedSlot);
  if (!parsed || parsed.businessSlug !== 'handy-andy') {
    return res.status(400).json({ error: 'A valid time slot is required' });
  }
  const { dateStr, slotKey } = parsed;

  let db;
  try { db = serviceClient(); }
  catch (e) { return res.status(500).json({ error: 'Booking storage not configured', message: e.message }); }

  const { data: biz } = await db.from('businesses').select('id').eq('slug', 'handy-andy').single();
  if (!biz) return res.status(500).json({ error: 'Handy Andy business not configured' });

  // ZIP -> service area: timezone, tech roster scope, and per-zip surcharge.
  const zip = String(b.postal_code || customer.zip || '').trim();
  if (!zip) return res.status(400).json({ error: 'A ZIP code is required' });
  const { data: z } = await db.from('service_area_zips')
    .select('surcharge, service_area:service_areas ( id, name, state, timezone )')
    .eq('business_id', biz.id).eq('postal_code', zip).maybeSingle();
  if (!z || !z.service_area) {
    return res.status(400).json({ error: "Sorry — that ZIP code isn't in our service area." });
  }
  const area = z.service_area;
  const serviceAreaId = area.id;
  const tz = area.timezone || 'America/Denver';
  const surcharge = Number(z.surcharge) || 0;

  const startUTC = slotStartUTC(tz, dateStr, slotKey);
  const endUTC   = slotEndUTC(tz, dateStr, slotKey);
  if (!startUTC) return res.status(400).json({ error: 'Invalid time slot' });

  // After-hours fee: the 8 PM slot (s5) is charged $100 on Sundays, $75 otherwise.
  const dow = dayOfWeekFor(dateStr);
  const afterHours = slotKey === 's5' ? (dow === 0 ? 100 : 75) : 0;

  // Coupon (validated server-side; unknown codes are ignored, never trusted).
  const couponCode = String(b.coupon || '').trim().toUpperCase();
  const couponAmt = COUPONS[couponCode] || 0;

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
  if (couponAmt > 0 && !lines.some(l => /coupon|discount/i.test(l.name))) {
    lines.push({ kind: 'coupon', name: `Coupon ${couponCode}`, quantity: 1, unit_price: -couponAmt, line_total: -couponAmt });
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

  // ── Save the card on file in Handy Andy's Stripe account (best-effort), using
  // HANDY_ANDY_STRIPE_SECRET_KEY. The card is tokenized in the browser with the
  // matching publishable key, so the publishable/secret pair are the same account.
  let stripeCustomerId = null, paymentStatus = 'unpaid', cardNote = '';
  if (b.payment_method_id) {
    if (!stripeConfigured({ account: 'handy-andy' })) {
      cardNote = `Card captured (${b.payment_method_id}) but HANDY_ANDY_STRIPE_SECRET_KEY is not set — card was NOT saved on file.`;
    } else {
      try {
        const r = await saveCardOnFile({
          email: customer.email,
          name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
          phone: customer.phone, paymentMethodId: b.payment_method_id, account: 'handy-andy',
        });
        stripeCustomerId = r.customerId;
        paymentStatus = 'card_on_file';
        cardNote = 'Card is on file (Handy Andy Stripe).';
      } catch (e) {
        cardNote = `Card capture failed: ${e.message}`;
      }
    }
  }

  // ── Assign a tech from THIS metro's roster so the slot is occupied.
  let technician_id = null;
  try { technician_id = await pickOpenTech(db, { businessSlug: 'handy-andy', dateStr, slotKey, serviceAreaId, timezone: tz }); }
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

  // ── Write the booking (customer, booking, line items, status event, review token).
  let result = {};
  try {
    result = (await mirrorBooking({
      businessSlug: 'handy-andy', source: 'widget',
      service_area_id: serviceAreaId,
      technician_id,
      status: technician_id ? 'assigned' : 'confirmed',
      scheduled_at: startUTC.toISOString(),
      scheduled_end: endUTC ? endUTC.toISOString() : null,
      duration_minutes: 120,
      service_name: 'TV Mounting',
      idempotency_key: b.idempotency_key || null,
      stripe_account: 'handy-andy',
      customer: {
        first_name: customer.first_name, last_name: customer.last_name,
        name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
        email: customer.email, phone: customer.phone,
      },
      address: { line1: customer.address, city, state, postal_code: zip },
      line_items: lines, subtotal, price, tip,
      payment_status: paymentStatus,
      stripe_customer_id: stripeCustomerId,
      stripe_payment_method_id: b.payment_method_id || null,
      // Card status is logged server-side only — not written to office notes.
      notes: null,
      customer_notes: b.customer_notes || sum.notes || null,
    })) || {};
  } catch (e) {
    console.error('[book-ha] mirror error:', e.message);
    return res.status(500).json({ error: 'Could not save booking', message: e.message });
  }
  const bookingId = result.booking_id || null;

  // ── Handy Andy-branded confirmation email (best-effort; never fails booking).
  const haEmail = emailConfig('handy-andy');
  const willSend = emailNotificationsOn() && !!haEmail.apiKey && !!customer.email;
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
      }, brandFor('handy-andy'));
      const sent = await sendEmail({ slug: 'handy-andy', to: customer.email, subject, html, replyTo: haEmail.from });
      if (!sent.sent) console.warn('[book-ha] confirmation email not sent:', sent.skipped || sent.error);
    } catch (e) {
      console.error('[book-ha] confirmation email error:', e.message);
    }
  }

  return res.status(200).json({
    success: true,
    booking_id: bookingId, job_id: bookingId,
    status: technician_id ? 'assigned' : 'confirmed',
    card_saved: paymentStatus === 'card_on_file',
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
  if (req.method === 'GET' && (req.query || {}).action === 'review_open') return serveReviewPixel(req, res);
  // Public address-autocomplete proxy for the booking widget.
  if (req.method === 'GET' && (req.query || {}).action === 'places_autocomplete') return placesAutocompletePublic(req, res);
  if (req.method === 'GET' && (req.query || {}).action === 'place_details') return placeDetailsPublic(req, res);
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Native CRM businesses — branch before any Zenbooker work.
  if (req.body && req.body.business === 'doms') return bookDoms(req, res);
  if (req.body && req.body.business === 'handy-andy') return bookHandyAndy(req, res);

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const {
    territory_id, service_id, selectedSlot,
    customer, city, state, postal_code, zbk_selections, tip, payment_method_id,
    min_providers_needed, assignment_method, coupon, email_summary,
  } = req.body || {};

  if (!territory_id)      return res.status(400).json({ error: 'territory_id required' });
  if (!service_id)        return res.status(400).json({ error: 'service_id required' });
  if (!customer?.email)   return res.status(400).json({ error: 'customer.email required' });
  if (!customer?.phone)   return res.status(400).json({ error: 'customer.phone required' });
  if (!isLikelyStreetAddress(customer?.address)) return res.status(400).json({ error: BAD_ADDRESS });
  if (!selectedSlot) {
    return res.status(400).json({ error: 'selectedSlot required for a booking' });
  }

  const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();

  // ── Resolve city/state server-side if the widget didn't send them.
  // Zenbooker rejects bookings whose address lacks city or state, and older
  // cached copies of widget.js only knew city/state for 4 territories.
  let resolvedCity  = (city  || '').trim();
  let resolvedState = (state || '').trim();
  const zipForLookup = String(postal_code || customer.zip || '').trim();
  if ((!resolvedCity || !resolvedState) && zipForLookup) {
    try {
      const url = new URL('https://api.zenbooker.com/v1/scheduling/service_area_check');
      url.searchParams.set('postal_code', zipForLookup);
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
      const d = await r.json().catch(() => ({}));
      resolvedCity  = resolvedCity  || d.customer_location?.components?.city  || '';
      resolvedState = resolvedState || d.customer_location?.components?.state || '';
    } catch (e) { console.warn('[book] city/state lookup failed:', e.message); }
  }
  // Last resort: metro-level fallback by territory so the booking never fails on empty city/state.
  const TERRITORY_FALLBACK = {
    '1707514546803x280800015001583600': { city: 'Houston',     state: 'TX' }, // Houston #1
    '1685582903241x973573877706522600': { city: 'Denver',      state: 'CO' }, // Denver #1
    '1707513178246x806633139915194400': { city: 'Denver',      state: 'CO' }, // Denver #2
    '1687393551618x123774611115737090': { city: 'Denver',      state: 'CO' }, // Denver #3
    '1723559782141x609094402068185100': { city: 'Denver',      state: 'CO' }, // Denver #4 Boulder/CS
    '1724797832896x339501352491155460': { city: 'Austin',      state: 'TX' },
    '1760944311332x492178768310304800': { city: 'Los Angeles', state: 'CA' },
  };
  const fb = TERRITORY_FALLBACK[territory_id] || {};
  resolvedCity  = resolvedCity  || fb.city  || '';
  resolvedState = resolvedState || fb.state || '';

  // Validate coupon before anything else so the customer gets a clear error
  // instead of a silently-ignored code.
  const couponCode = String(coupon || '').trim().toUpperCase();
  let couponDiscount = 0;
  if (couponCode) {
    if (!(couponCode in COUPONS)) {
      return res.status(400).json({ error: `Invalid coupon code "${couponCode}". Please check the code or clear the field.` });
    }
    couponDiscount = COUPONS[couponCode];
  }

  const services = [{ service_id, selections: zbk_selections || [] }];
  // After-hours fee — flat $75 for any 8 PM-or-later arrival window (hard rule).
  const afterHoursFee = afterHoursFeeFor(selectedSlot, territory_id);
  if (afterHoursFee > 0) {
    services.push({ custom_service: { name: 'After-Hours Service Fee (8 PM)', price: afterHoursFee, duration: 0, taxable: true } });
  }
  // Distance surcharge for outer Denver territories (#2 +$25, #3 +$35, #4 +$100).
  // The widget displays it; Zenbooker does not apply it to API-created jobs, so
  // charge it here to match what the customer was quoted.
  const territorySurcharge = territorySurchargeFor(territory_id);
  if (territorySurcharge > 0) {
    services.push({ custom_service: { name: 'Service area surcharge', price: territorySurcharge, duration: 0, taxable: true } });
  }
  if (couponDiscount > 0) {
    services.push({ custom_service: { name: `Coupon ${couponCode} (-$${couponDiscount})`, price: -couponDiscount, duration: 0, taxable: false } });
  }
  if (tip && Number(tip) > 0) {
    services.push({ custom_service: { name: 'Tip for technician', price: Number(tip), duration: 0, taxable: false } });
  }

  // When we will send our own branded confirmation email (email notifications on
  // + Resend key configured), suppress Zenbooker's generic confirmation email so
  // the customer doesn't get two. If we won't send ours (kill switch off or no
  // key), leave Zenbooker's on as a fallback so the customer still gets one.
  const haEmail = emailConfig('handy-andy');
  const willSendBranded = emailNotificationsOn() && !!haEmail.apiKey && !!customer.email;

  const payload = {
    territory_id,
    services,
    customer: { name: fullName, email: customer.email, phone: customer.phone },
    address: {
      line1:       customer.address,
      city:        resolvedCity,
      state:       resolvedState,
      postal_code: zipForLookup,
      country:     'US',
    },
    email_notifications: !willSendBranded,
    sms_notifications:   true,
    // Denver 98"+ → require & auto-assign 2 technicians
    ...(min_providers_needed && { min_providers_needed: String(min_providers_needed) }),
    ...(assignment_method   && { assignment_method }),
    ...(selectedSlot && { timeslot_id: selectedSlot }),
  };

  try {
    const r = await fetch('https://api.zenbooker.com/v1/jobs', {
      method:  'POST',
      headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[book] Zenbooker error', r.status, JSON.stringify(data));
      return res.status(r.status).json({ error: data?.error?.message || data?.message || 'Booking failed', details: data });
    }

    const jobId = data.job_id || data.id;
    const zbkCustomerId = data.customer_id || data.customer?.id || null;

    // ---- Detect a job Zenbooker could not staff -------------------------------------
    // Zenbooker's territory availability can offer a timeslot that no qualified tech is
    // actually free for; it then creates the job but leaves it unassigned. Without this
    // check that job sits silently unstaffed at a time the tech is already booked. We
    // flag it on the job and in the response so the office is alerted to reassign/reschedule.
    let autoAssignFailed = false;
    let technicianName = null;
    try {
      let jobState = data;
      if (jobState.unable_to_auto_assign === undefined && jobState.assigned_providers === undefined && data.id) {
        const jr = await fetch(`https://api.zenbooker.com/v1/jobs/${data.id}`, { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
        jobState = await jr.json().catch(() => ({}));
      }
      autoAssignFailed = jobState.unable_to_auto_assign === true
        || (Array.isArray(jobState.assigned_providers) && jobState.assigned_providers.length === 0);
      // Capture the assigned tech name(s) for the confirmation email.
      const _provs = Array.isArray(jobState.assigned_providers) ? jobState.assigned_providers : [];
      if (_provs.length) technicianName = _provs.map(p => p.name || p.display_name || `${p.first_name || ''} ${p.last_name || ''}`.trim()).filter(Boolean).join(' & ') || null;
      if (autoAssignFailed && jobId) {
        await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}/notes`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: '⚠️ NO TECHNICIAN AUTO-ASSIGNED — Zenbooker reported no available qualified tech for this time slot, so this online booking is currently UNSTAFFED. Please manually assign a technician or contact the customer to reschedule.' }),
        });
      }
    } catch (e) { console.warn('[book] auto-assign check failed:', e.message); }

    // ---- Save the card on file in Stripe so it appears as a payment method and can be charged later ----
    let cardNote = '';
    if (payment_method_id) {
      const SK = process.env.STRIPE_SECRET_KEY;
      if (!SK) {
        cardNote = `Payment method captured (${payment_method_id}) but STRIPE_SECRET_KEY is not set on the server, so the card was NOT saved on file.`;
      } else {
        const sAuth = { Authorization: `Bearer ${SK}`, 'Content-Type': 'application/x-www-form-urlencoded' };
        try {
          // 1) Prefer the Zenbooker customer's existing Stripe customer (returning customer) so the card shows in Zenbooker.
          let stripeCustomerId = null;
          try {
            const cr = await fetch(`https://api.zenbooker.com/v1/customers?email=${encodeURIComponent(customer.email)}&limit=10`, { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
            const cj = await cr.json().catch(() => ({}));
            const results = cj.results || cj.data || [];
            const match = results.find(c => c.id === zbkCustomerId && c.stripe_customer_id)
                       || results.find(c => (c.email || '').toLowerCase() === (customer.email || '').toLowerCase() && c.stripe_customer_id);
            if (match) stripeCustomerId = match.stripe_customer_id;
          } catch (e) { /* lookup is best-effort */ }

          // 2) Otherwise create a Stripe customer on this account.
          if (!stripeCustomerId) {
            const cb = new URLSearchParams();
            cb.set('email', customer.email || '');
            if (fullName) cb.set('name', fullName);
            if (customer.phone) cb.set('phone', customer.phone);
            cb.set('description', 'Booking widget customer');
            const ccr = await fetch('https://api.stripe.com/v1/customers', { method: 'POST', headers: sAuth, body: cb });
            const cc = await ccr.json();
            if (!ccr.ok) throw new Error(cc?.error?.message || 'Stripe customer create failed');
            stripeCustomerId = cc.id;
          }

          // 3) Attach the payment method to that Stripe customer and make it the default.
          const ab = new URLSearchParams(); ab.set('customer', stripeCustomerId);
          const ar = await fetch(`https://api.stripe.com/v1/payment_methods/${payment_method_id}/attach`, { method: 'POST', headers: sAuth, body: ab });
          const pm = await ar.json();
          if (!ar.ok) throw new Error(pm?.error?.message || 'Attach failed');

          const db = new URLSearchParams(); db.set('invoice_settings[default_payment_method]', payment_method_id);

          // 4) Link the Zenbooker customer to this Stripe customer so Zenbooker displays the card in the Payment Methods section.
          if (zbkCustomerId) {
            try {
              await fetch(`https://api.zenbooker.com/v1/customers/${zbkCustomerId}`, {
                method: "PATCH",
                headers: { Authorization: `Bearer ${ZBK_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ stripe_customer_id: stripeCustomerId }),
              });
            } catch (updateErr) {
              console.warn("[book] Failed to link Zenbooker customer to Stripe:", updateErr.message);
            }
          }
          await fetch(`https://api.stripe.com/v1/customers/${stripeCustomerId}`, { method: 'POST', headers: sAuth, body: db });

          const brand = pm?.card?.brand || 'card';
          const last4 = pm?.card?.last4 || '????';
          // Customer-friendly card-on-file note shown on the job.
          cardNote = `Card is on file. To access card click "Payment method > Edit > Click card on file."`;
        } catch (e) {
          console.error('[book] stripe save error:', e.message);
          cardNote = `Payment method captured (${payment_method_id}) but saving on file failed: ${e.message}`;
        }
      }
    }

    // Write a note on the job describing the card-on-file status.
    if (jobId && cardNote) {
      try {
        await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}/notes`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${ZBK_KEY}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: cardNote }),
        });
      } catch (noteErr) {
        console.warn('[book] Failed to add note:', noteErr.message);
      }
    }

    // ---- Mirror into Supabase for the admin dashboard (best-effort, never fails the booking) ----
    const mirrorLines = [{ kind: 'service', name: 'TV Installation', quantity: 1 }];
    if (couponDiscount > 0) mirrorLines.push({ kind: 'coupon', name: `Coupon ${couponCode}`, unit_price: -couponDiscount, line_total: -couponDiscount });
    if (tip && Number(tip) > 0) mirrorLines.push({ kind: 'tip', name: 'Tip for technician', unit_price: Number(tip), line_total: Number(tip) });
    await mirrorBooking({
      businessSlug: 'handy-andy', source: 'widget', territory_id,
      zbkJob: data, zenbooker_job_id: jobId, zenbooker_customer_id: zbkCustomerId,
      customer: { first_name: customer.first_name, last_name: customer.last_name, name: fullName, email: customer.email, phone: customer.phone },
      address: { line1: customer.address, city: resolvedCity, state: resolvedState, postal_code: zipForLookup },
      tip: Number(tip) || 0, service_name: 'TV Installation', line_items: mirrorLines,
      stripe_customer_id: null,
    });

    // ---- Branded booking-confirmation email (best-effort; never fails the booking) ----
    // Awaited so it completes before the serverless function returns/freezes.
    // The widget sends `email_summary` (date, arrival window, line items, total)
    // so the email matches the thank-you page; we derive date/time server-side as
    // a fallback for older cached widgets.
    if (willSendBranded) {
      try {
        const sum = email_summary || {};
        const when = slotWhen(selectedSlot, territory_id);
        const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
        const { subject, html } = bookingConfirmationEmail({
          firstName:   customer.first_name || sum.firstName || '',
          dateLong:    sum.dateLong  || when.dateLong  || '',
          timeWindow:  sum.timeWindow || when.timeWindow || '',
          serviceName: 'TV Installation',
          technicianName,
          address:     { line1: customer.address, city: resolvedCity, state: resolvedState, zip: zipForLookup },
          lines:       Array.isArray(sum.lines) ? sum.lines : null,
          total:       sum.total != null ? sum.total : null,
          tip:         Number(sum.tip != null ? sum.tip : tip) || 0,
          twoTechs:    sum.twoTechs != null ? !!sum.twoTechs : !!min_providers_needed,
          startEpoch:  when.startSec || null,
          endEpoch:    when.endSec || null,
          baseUrl,
          jobId,
        }, brandFor('handy-andy'));
        const result = await sendEmail({ slug: 'handy-andy', to: customer.email, subject, html, replyTo: haEmail.from });
        if (!result.sent) console.warn('[book] confirmation email not sent:', result.skipped || result.error);
      } catch (e) {
        console.error('[book] confirmation email error:', e.message);
      }
    }

    return res.status(200).json({ success: true, job_id: jobId, status: data.status, card_saved: /Card is on file/.test(cardNote), auto_assign_failed: autoAssignFailed });
  } catch (err) {
    console.error('[book] fetch error:', err.message);
    return res.status(500).json({ error: 'Booking request failed', message: err.message });
  }
}
