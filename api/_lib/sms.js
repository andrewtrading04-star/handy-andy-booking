// api/_lib/sms.js
// Shared outbound SMS sender for the booking, tech, and estimate flows.
// Twilio only. Everything stays behind the SMS master switch
// (smsNotificationsOn), so nothing goes out until SMS_NOTIFICATIONS_ENABLED (or
// the master NOTIFICATIONS_ENABLED) is set.
//
// Env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
import { smsNotificationsOn } from './notify.js';
import { demoMode } from './demo.js';

// Normalize US/CA numbers to E.164 (+1XXXXXXXXXX), which Twilio requires.
export function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
}

// True when Twilio is wired up. The dashboard uses this to show/hide the Send
// SMS buttons (independent of the on/off switch).
export function smsConfigured() {
  return demoMode() || twilioConfigured();
}

// Hard cap on how long the provider call may hang. Sends are now AWAITED on the
// tech app's status path (repair #9), so an unresponsive provider would
// otherwise hold that HTTP response open until Vercel kills the function —
// the tech would see "failed" for a status change that already committed.
// 10s is generous for a normal send; an abort is reported as ok:false so the
// booking records sms_status 'failed' exactly like any other provider error.
const SMS_TIMEOUT_MS = 10000;
function smsTimeoutSignal() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), SMS_TIMEOUT_MS);
  // Don't let the timer keep the lambda alive after a fast response.
  if (typeof t.unref === 'function') t.unref();
  return c.signal;
}

async function sendViaTwilio(to, message, statusCallback) {
  const formData = new URLSearchParams();
  formData.append('From', process.env.TWILIO_PHONE_NUMBER);
  formData.append('To', to);
  formData.append('Body', message);
  // Twilio POSTs delivery-status updates (queued/sent/delivered/failed/undelivered)
  // to this URL as the message progresses — see api/analytics.js action=sms_status.
  if (statusCallback) formData.append('StatusCallback', statusCallback);
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: 'POST',
    signal: smsTimeoutSignal(),
    headers: { Authorization: `Basic ${auth}` },
    body: formData,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `Twilio ${res.status}: ${t.slice(0, 300)}` };
  }
  return { ok: true };
}

// Low-level send that REPORTS its outcome instead of swallowing it. Returns
// { ok:true } or { ok:false, skipped?, error? } so callers that need to tell the
// user why a text didn't go out (e.g. the Estimates tab) can surface a real
// reason. `skipped` is a config/precondition miss; `error` is a live provider
// failure (the message string is safe to show).
// opts.statusCallback: a URL for Twilio to POST delivery-status updates to.
export async function sendSMSResult(phoneNumber, message, opts = {}) {
  // Demo mode: pretend the text sent (no provider call, nothing delivered).
  if (demoMode()) { console.log('[sms:demo] pretend-sent to', String(phoneNumber).slice(-4)); return { ok: true, demo: true }; }
  if (!smsNotificationsOn()) return { ok: false, skipped: 'notifications_off' };
  const to = toE164(phoneNumber);
  if (!to) return { ok: false, skipped: 'bad_phone' };
  if (!twilioConfigured()) return { ok: false, skipped: 'not_configured' };
  try {
    const r = await sendViaTwilio(to, message, opts.statusCallback);
    if (r.ok) console.log('[SMS] Sent to', to.slice(-4));
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Fire-and-forget SMS for notifications (tech assigned, confirmations, etc.).
// Swallows-and-logs so existing callers are unaffected.
export async function sendSMS(phoneNumber, message) {
  const r = await sendSMSResult(phoneNumber, message);
  if (r.ok) return;
  if (r.error) console.error('[SMS]', r.error);
  else console.warn(`[SMS] not sent (${r.skipped}):`, message);
}
