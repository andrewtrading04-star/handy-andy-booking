// api/_lib/booking-confirm-sms.js
// Single source of truth for the customer-facing "you're booked" text sent
// immediately after a widget booking completes, and for the opt-in
// confirmation text (optInConfirmMessage) sent when someone opts in to texts
// without booking.
//
// Why this exists: until 2026-08-20 the widget booking path (api/book.js, both
// bookDoms and bookNative) sent the customer a confirmation EMAIL and nothing
// else. A "You're booked!" text did exist, but only on the unrelated
// estimate-approval auto-booking path in api/admin.js — so every customer who
// booked themselves through the widget, for every business, got no text at all.
// Found on Mile High (a real test booking on 2026-08-20 produced the email and
// no SMS), but it was never Mile High specific.
//
// The office New Booking and estimate-approval confirmations in api/admin.js
// build their text with bookingConfirmMessage too, so the three entry points
// can't drift into telling customers different things. Every one names the
// JOB's business, because a Mile High / Precision / Austin customer must not be
// greeted by whichever company the tech works for.
import { sendSMSResult, smsBrandName } from './sms.js';

// The window ("12pm - 3pm") is what the customer actually picked and what the
// confirmation email shows, so prefer it over a precise start time.
//
// A2P 10DLC: this is the FIRST text a customer gets after opting in, so it
// carries what carriers require of an opt-in confirmation: the brand name
// first, message frequency, the exact "Message and data rates may apply"
// phrase, HELP and STOP. It is quoted word for word as a campaign sample, so
// change the sample if you change this.
export function bookingConfirmMessage({ bizName, bizSlug, dateStr, timeWindow, techName }) {
  const biz = smsBrandName(bizSlug, bizName);
  const when = timeWindow ? `${dateStr} between ${timeWindow}` : dateStr;
  // "he" matches the existing wording in api/admin.js; revisit for both call
  // sites together if the roster ever needs it neutral.
  const techLine = techName
    ? `${String(techName).trim().split(/\s+/)[0]} will text you when he's on the way.`
    : `We'll text you when your tech is on the way.`;
  return `${biz}: You're booked for ${when}. ${techLine} Msg frequency varies. Message and data rates may apply. Reply HELP for help, STOP to opt out.`;
}

// The opt-in confirmation (A2P 10DLC / CTIA): every opt-in gets ONE immediate
// text naming the brand, the message frequency, "Message and data rates may
// apply", HELP and STOP. A booking confirmation (above) already carries all of
// that, so this is only for opt-ins that don't produce one: the estimate
// request form (api/estimate.js), the office's "Mark opted in" (booking_update
// in api/admin.js) and an office estimate sent after the customer's verbal yes
// (estimateCreate). Never add it to a booking path: the booker would get two.
export function optInConfirmMessage(bizSlug, bizName) {
  return `${smsBrandName(bizSlug, bizName)}: You're signed up for appointment and customer-care texts about your job. Msg frequency varies. Message and data rates may apply. Reply HELP for help, STOP to opt out.`;
}

// Best-effort and never throws, same as sendBookingConfirmSms below: the
// opt-in is already saved, so a Twilio hiccup must never fail the request that
// recorded it. Default From, like every other automated text. The CALLER
// checks consent. AWAIT it: an un-awaited send dies when the lambda freezes.
export async function sendOptInConfirmSms({ customerPhone, bizSlug, bizName, tag = 'opt-in' }) {
  if (!customerPhone) return { ok: false, skipped: 'no_customer_phone' };
  try {
    const r = await sendSMSResult(customerPhone, optInConfirmMessage(bizSlug, bizName));
    if (!r.ok) console.warn(`[${tag}] opt-in confirmation SMS not sent:`, r.skipped || r.error);
    return r;
  } catch (e) {
    console.error(`[${tag}] opt-in confirmation SMS error:`, e.message);
    return { ok: false, error: e.message };
  }
}

// Best-effort and never throws: the booking has already committed and been
// paid for by the time we're called, so a Twilio hiccup must never turn into a
// failed booking response.
//
// AWAIT this. An un-awaited send is silently killed when Vercel freezes the
// lambda on response — the tell is no log line at all. Same rule as
// _lib/en-route.js.
export async function sendBookingConfirmSms({
  customerPhone, smsConsent, bizName, bizSlug, techName, startUTC, tz, timeWindow, tag = 'book',
}) {
  if (!customerPhone) return { ok: false, skipped: 'no_customer_phone' };
  // Opt-in checkbox from the widget. Only an explicit true sends: a missing
  // value is no consent (A2P 10DLC: nobody is texted without a recorded
  // opt-in). The widget always posts a real boolean.
  if (smsConsent !== true) {
    console.log(`[${tag}] confirmation SMS skipped: customer did not opt in to texts`);
    return { ok: false, skipped: 'no_sms_consent' };
  }

  let dateStr;
  try {
    dateStr = startUTC.toLocaleDateString('en-US',
      { timeZone: tz || 'America/Denver', weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    dateStr = startUTC.toISOString().slice(0, 10);
  }

  const msg = bookingConfirmMessage({ bizName, bizSlug, dateStr, timeWindow, techName });
  try {
    const r = await sendSMSResult(customerPhone, msg);
    if (!r.ok) console.warn(`[${tag}] confirmation SMS not sent:`, r.skipped || r.error);
    return r;
  } catch (e) {
    console.error(`[${tag}] confirmation SMS error:`, e.message);
    return { ok: false, error: e.message };
  }
}
