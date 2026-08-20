// api/_lib/booking-confirm-sms.js
// Single source of truth for the customer-facing "you're booked" text sent
// immediately after a widget booking completes.
//
// Why this exists: until 2026-08-20 the widget booking path (api/book.js, both
// bookDoms and bookNative) sent the customer a confirmation EMAIL and nothing
// else. A "You're booked!" text did exist, but only on the unrelated
// estimate-approval auto-booking path in api/admin.js — so every customer who
// booked themselves through the widget, for every business, got no text at all.
// Found on Mile High (a real test booking on 2026-08-20 produced the email and
// no SMS), but it was never Mile High specific.
//
// Wording deliberately mirrors the estimate-approval text in api/admin.js so
// the two entry points can't drift into telling customers different things.
// Difference: this one names the BUSINESS, because a Mile High / Precision /
// Austin customer must not be greeted by whichever company the tech works for.
import { sendSMSResult } from './sms.js';

// The window ("12pm - 3pm") is what the customer actually picked and what the
// confirmation email shows, so prefer it over a precise start time.
export function bookingConfirmMessage({ bizName, dateStr, timeWindow, techName }) {
  const biz = bizName || 'We';
  const when = timeWindow ? `${dateStr} between ${timeWindow}` : dateStr;
  // "he" matches the existing wording in api/admin.js; revisit for both call
  // sites together if the roster ever needs it neutral.
  const techLine = techName
    ? `${String(techName).trim().split(/\s+/)[0]} will text you when he's on the way.`
    : `We'll text you when your tech is on the way.`;
  return `You're booked! ✅ ${biz} will see you ${when}. ${techLine} Reply STOP to opt out.`;
}

// Best-effort and never throws: the booking has already committed and been
// paid for by the time we're called, so a Twilio hiccup must never turn into a
// failed booking response.
//
// AWAIT this. An un-awaited send is silently killed when Vercel freezes the
// lambda on response — the tell is no log line at all. Same rule as
// _lib/en-route.js.
export async function sendBookingConfirmSms({
  customerPhone, smsConsent, bizName, techName, startUTC, tz, timeWindow, tag = 'book',
}) {
  if (!customerPhone) return { ok: false, skipped: 'no_customer_phone' };
  // Opt-in checkbox from the widget. Undefined (older callers) is treated as
  // consent, matching the bookings.sms_consent column default.
  if (smsConsent === false) return { ok: false, skipped: 'no_sms_consent' };

  let dateStr;
  try {
    dateStr = startUTC.toLocaleDateString('en-US',
      { timeZone: tz || 'America/Denver', weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    dateStr = startUTC.toISOString().slice(0, 10);
  }

  const msg = bookingConfirmMessage({ bizName, dateStr, timeWindow, techName });
  try {
    const r = await sendSMSResult(customerPhone, msg);
    if (!r.ok) console.warn(`[${tag}] confirmation SMS not sent:`, r.skipped || r.error);
    return r;
  } catch (e) {
    console.error(`[${tag}] confirmation SMS error:`, e.message);
    return { ok: false, error: e.message };
  }
}
