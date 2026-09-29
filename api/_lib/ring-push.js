// Screen pop (owner 2026-09-30): the instant a call is sent to a secretary's
// handset, push a tiny signal to her open CRM so the caller's card appears
// while the phone is still ringing. Supabase Realtime "broadcast" -- no table,
// no polling. Each handset has its own channel name, an HMAC of the number, so
// it can't be guessed; the browser only learns the names for its own login.
import { createHmac } from 'node:crypto';

const ten = (v) => String(v || '').replace(/\D/g, '').slice(-10);

export function ringTopic(handset) {
  const d = ten(handset);
  if (d.length !== 10) return null;
  const h = createHmac('sha256', process.env.SESSION_SECRET || 'dev-insecure-secret-change-me').update('ring:' + d).digest('hex').slice(0, 32);
  return 'ring-' + h;
}

// Fire and wait at most 600 ms: the call must never wait on the screen pop.
export async function pushRing(handset, payload) {
  const topic = ringTopic(handset);
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!topic || !url || !key) return false;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ topic, event: 'ring', payload, private: false }] }),
      signal: AbortSignal.timeout(600),
    });
    return r.ok;
  } catch (e) {
    console.warn('[ring-push]', e.message);
    return false;
  }
}
