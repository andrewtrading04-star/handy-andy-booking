// api/_lib/sms.js
// Shared outbound SMS sender for the booking, tech, and estimate flows.
//
// Provider-agnostic: sends via SimpleTexting when it's configured, and falls
// back to Twilio otherwise. Everything stays behind the SMS master switch
// (smsNotificationsOn), so nothing goes out until SMS_NOTIFICATIONS_ENABLED (or
// the master NOTIFICATIONS_ENABLED) is set. Swapping providers is now just an
// env-var change — no code edits at the call sites.
//
// Env vars:
//   SimpleTexting (preferred):  SIMPLETEXTING_API_KEY, SIMPLETEXTING_FROM
//   Twilio (fallback):          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
import { smsNotificationsOn } from './notify.js';
import { demoMode } from './demo.js';

// Normalize US/CA numbers to E.164 (+1XXXXXXXXXX), which both providers require.
export function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

function simpleTextingConfigured() {
  return !!(process.env.SIMPLETEXTING_API_KEY && process.env.SIMPLETEXTING_FROM);
}
function twilioConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
}

// True when SOME SMS provider is wired up. The dashboard uses this to show/hide
// the Send SMS buttons (independent of the on/off switch).
export function smsConfigured() {
  return demoMode() || simpleTextingConfigured() || twilioConfigured();
}

// SimpleTexting API v2 — single outbound message. The endpoint + body live here
// only; confirm the exact request against the live example in your SimpleTexting
// dashboard (Settings → API) on the first test, and adjust this one function if
// your account shows a different path/field names.
async function sendViaSimpleTexting(to, message) {
  const res = await fetch('https://api-app2.simpletexting.com/v2/api/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SIMPLETEXTING_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contactPhone: to,
      accountPhone: process.env.SIMPLETEXTING_FROM,
      mode: 'AUTO',
      text: message,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { ok: false, error: `SimpleTexting ${res.status}: ${t.slice(0, 300)}` };
  }
  return { ok: true };
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
// Only honored on the Twilio path — SimpleTexting has no per-message callback
// param in its API, so it's silently ignored there.
export async function sendSMSResult(phoneNumber, message, opts = {}) {
  // Demo mode: pretend the text sent (no provider call, nothing delivered).
  if (demoMode()) { console.log('[sms:demo] pretend-sent to', String(phoneNumber).slice(-4)); return { ok: true, demo: true }; }
  if (!smsNotificationsOn()) return { ok: false, skipped: 'notifications_off' };
  const to = toE164(phoneNumber);
  if (!to) return { ok: false, skipped: 'bad_phone' };
  if (!simpleTextingConfigured() && !twilioConfigured()) return { ok: false, skipped: 'not_configured' };
  try {
    const r = simpleTextingConfigured()
      ? await sendViaSimpleTexting(to, message)
      : await sendViaTwilio(to, message, opts.statusCallback);
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
