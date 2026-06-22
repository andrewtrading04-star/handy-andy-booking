import { mirrorBooking } from './_lib/mirror.js';
import { emailNotificationsOn } from './_lib/notify.js';
import { emailConfig, sendEmail, bookingConfirmationEmail, brandFor } from './_lib/email.js';

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
  return hour >= 20 ? AFTER_HOURS_FEE : 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

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
  if (!customer?.address) return res.status(400).json({ error: 'customer.address required' });
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
    try {
      let jobState = data;
      if (jobState.unable_to_auto_assign === undefined && jobState.assigned_providers === undefined && data.id) {
        const jr = await fetch(`https://api.zenbooker.com/v1/jobs/${data.id}`, { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
        jobState = await jr.json().catch(() => ({}));
      }
      autoAssignFailed = jobState.unable_to_auto_assign === true
        || (Array.isArray(jobState.assigned_providers) && jobState.assigned_providers.length === 0);
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
