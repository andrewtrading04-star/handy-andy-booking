import crypto from 'node:crypto';
import { signToken, verifyToken } from './auth.js';

// 16-byte booking UUID + 4-byte expiry + 12-byte MAC = 43 URL-safe characters.
// Domain-separated from session tokens; the code grants review access only.
function mac(body) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-insecure-secret-change-me')
    .update('review-code:v1:').update(body).digest().subarray(0, 12);
}

export function compactReviewToken(token) {
  const payload = verifyToken(token);
  if (!payload || (payload.kind && payload.kind !== 'review') ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.booking_id || '') ||
      !Number.isInteger(payload.exp) || payload.exp > 0xffffffff) return token;
  const body = Buffer.alloc(20);
  Buffer.from(payload.booking_id.replaceAll('-', ''), 'hex').copy(body);
  body.writeUInt32BE(payload.exp, 16);
  return Buffer.concat([body, mac(body)]).toString('base64url');
}

export function expandReviewCode(code) {
  // Existing emailed and texted links retain their original validation path.
  if (typeof code !== 'string') return null;
  if (code.includes('.')) return code;
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return null;
  const bytes = Buffer.from(code, 'base64url');
  if (bytes.toString('base64url') !== code || bytes.length !== 32) return null;
  const body = bytes.subarray(0, 20);
  if (!crypto.timingSafeEqual(mac(body), bytes.subarray(20))) return null;
  const ttl = body.readUInt32BE(16) - Math.floor(Date.now() / 1000);
  if (ttl <= 0) return null;
  const hex = body.subarray(0, 16).toString('hex');
  const booking_id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return signToken({ kind: 'review', booking_id }, ttl);
}
