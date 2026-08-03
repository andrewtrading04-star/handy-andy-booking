// api/_lib/en-route.js
// Single source of truth for the customer-facing "your tech is on the way"
// text and its delivery tracking.
//
// Two callers produce the SAME customer experience:
//   * api/tech.js  — the tech taps "On My Way" inside the tech app
//   * api/book.js  — the tech taps the one-tap link sent by the pre-job nudge
//                    (see _lib/tech-late.js). No app login required.
// The wording and the Twilio status-callback wiring live here precisely so the
// two paths can't drift into saying different things to the customer.
import { sendSMSResult } from './sms.js';
import { signToken } from './auth.js';

// Matches the tech app's existing default (api/tech.js passed 30 when the tech
// didn't pick an ETA). The nudge link has no ETA picker, so it lands here too.
export const DEFAULT_ETA_MINUTES = 30;

function baseUrl() {
  return process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}

export function enRouteMessage(techName, bizName, etaMinutes) {
  const who = (techName && String(techName).trim().split(/\s+/)[0]) || 'Your tech';
  const biz = bizName || 'us';
  return `Heads up! ${who} from ${biz} is en route (ETA ~${etaMinutes} min). Please prepare for his arrival. STOP to opt out.`;
}

// Send the customer their en-route text and record delivery status on the
// booking.
//
//   db            service-role Supabase client
//   bookingId     job the text is about
//   technicianId  whose first name goes in the message
//   customerPhone destination (falsy = nothing to do)
//   smsConsent    the booking's opt-in flag; false means we stay silent
//   etaMinutes    optional override
//
// Best-effort and never throws: the status change that triggered this has
// already committed by the time we're called, so a provider hiccup must not
// surface as a failure to the tech. AWAIT it anyway — Vercel can freeze the
// lambda the instant the HTTP response goes out, and an un-awaited send simply
// never happens.
export async function sendEnRouteSms(db, opts = {}) {
  const {
    bookingId,
    technicianId,
    customerPhone,
    smsConsent,
    etaMinutes = DEFAULT_ETA_MINUTES,
  } = opts;

  if (!customerPhone) return { ok: false, skipped: 'no_customer_phone' };
  if (!smsConsent) return { ok: false, skipped: 'no_sms_consent' };

  // The company name must be the JOB's business, not the tech's home company.
  // Handy Andy and Dom's cross-hire each other, and every Mile High job is
  // worked by a Handy Andy tech — looking it up off the technician row (as the
  // tech app used to) told a Mile High customer that a Handy Andy man was on
  // the way. Caller can pass bizName when it already has it.
  let techName = null;
  let bizName = opts.bizName || null;
  try {
    const [techRes, bookRes] = await Promise.all([
      db.from('technicians').select('name').eq('id', technicianId).maybeSingle(),
      bizName ? Promise.resolve({ data: null })
              : db.from('bookings').select('business:businesses ( name )').eq('id', bookingId).maybeSingle(),
    ]);
    if (techRes?.data?.name) techName = techRes.data.name;
    if (!bizName && bookRes?.data?.business?.name) bizName = bookRes.data.business.name;
  } catch { /* best-effort: fall back to generic wording */ }

  const msg = enRouteMessage(techName, bizName, etaMinutes);

  // Delivery tracking (admin dashboard only, never shown to techs): a signed
  // token carries the booking id through Twilio's status callback, the same
  // pattern the review SMS uses. 'pending' is written on a successful send;
  // the callback later flips it to delivered/failed.
  const token = signToken({ kind: 'on_the_way', booking_id: bookingId }, 3600);
  const statusCallback = `${baseUrl()}/api/analytics?action=sms_status&token=${encodeURIComponent(token)}`;

  try {
    const r = await sendSMSResult(customerPhone, msg, { statusCallback });
    await db.from('bookings').update({
      on_the_way_sms_status: r.ok ? 'pending' : 'failed',
      on_the_way_sms_sent_at: new Date().toISOString(),
    }).eq('id', bookingId);
    return r;
  } catch (e) {
    console.error('[en-route sms]', e.message);
    return { ok: false, error: e.message };
  }
}
