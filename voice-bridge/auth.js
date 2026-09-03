// Same dependency-free HMAC-SHA256 token scheme as the main app's
// api/_lib/auth.js — mirrored here (not imported) because this is a
// separate Node process/deploy from the Vercel app. Must stay byte-for-byte
// compatible with that file, or tokens minted here won't verify there.
import crypto from 'crypto';

function secret() {
  return process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
}

export function signToken(payload, ttlSeconds = 3600) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Same request-URL + sorted-params HMAC scheme Twilio itself uses, and the
// same one twilioVoiceParams() in api/analytics.js verifies against — needed
// here because ConversationRelay's WebSocket handshake carries an
// X-Twilio-Signature header we must check before trusting the connection.
export function verifyTwilioSignature(url, params, signature) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !signature) return false;
  const sorted = Object.keys(params || {}).sort();
  let data = url;
  for (const k of sorted) data += k + params[k];
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function botToken() {
  return signToken({ kind: 'admin', role: 'owner', scope: 'all', name: 'AI Voice Bot v2' }, 3600);
}
