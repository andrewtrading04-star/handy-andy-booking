// api/_lib/tech-invite.js
// Technician sign-up invites (migration 0111). Shared by api/admin.js (the
// owner creates / re-texts / cancels invites on the Technicians tab) and
// api/tech.js (the two public calls public/join.html makes), so the link
// shape, the SMS copy and the state rules can't drift between the two.
// _lib is not a route, so this does not count against Vercel's function cap.
import crypto from 'crypto';
import { sendSMSResult, smsBrandName } from './sms.js';
import { signToken } from './auth.js';
import { EMAIL_BRANDS } from './email.js';

// A link is good for a week. Resend on an expired invite pushes this out again
// on the SAME code, so the tech never has to be told "use the new link".
export const INVITE_TTL_DAYS = 7;

// 20 characters of Crockford base32 (no I, L, O or U, so a code retyped from a
// screenshot can't be misread) = 100 random bits. Each byte's low 5 bits index
// the alphabet; 256 is a multiple of 32, so there is no modulo bias.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newInviteCode() {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) out += CODE_ALPHABET[bytes[i] & 31];
  return out;
}

// Shape check BEFORE any query, so junk never reaches the database and a
// malformed code gets exactly the same answer as an unknown one.
export function normalizeInviteCode(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(c) ? c : null;
}

// Same PUBLIC_URL -> VERCEL_URL -> prod fallback chain reviewInviteSend uses.
export function appBaseUrl() {
  return (process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://handy-andy-booking.vercel.app'))
    .replace(/\/+$/, '');
}
// vercel.json rewrites /join to /join.html; the short form keeps the text short.
export function inviteLink(code) {
  return `${appBaseUrl()}/join?c=${code}`;
}

export function digits10(phone) { return String(phone || '').replace(/\D/g, '').slice(-10); }
export function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }

// "Handy Andy TV Mounting" / "Dom's TV Mounting": the same brand prefix every
// customer text carries, so an invite from the 888 line reads as coming from
// the company rather than a stranger.
export function inviteBrand(slug, fallbackName) {
  return smsBrandName(slug, (EMAIL_BRANDS[slug] && EMAIL_BRANDS[slug].name) || fallbackName);
}

// pending -> joined | revoked. Expired is derived, so no cron is needed.
export function inviteState(row) {
  if (!row) return 'invalid';
  if (row.status === 'joined') return 'joined';
  if (row.status === 'revoked') return 'revoked';
  return new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'open';
}

// The PIN is the only secret on a tech login and /api/tech login has no
// lockout, so refuse the handful of PINs anyone would try first.
const WEAK_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '0123', '1234', '2345', '3456', '4567', '5678', '6789', '4321', '9876', '1212', '2580',
]);
export function weakPin(pin) { return WEAK_PINS.has(String(pin || '')); }

export function fmtExpiry(iso, tz) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { timeZone: tz || 'America/Chicago', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// Plain ASCII on purpose (no curly quotes or dashes) so each text stays GSM-7.
// The invite is first contact from the 888 line with someone who is neither a
// tech nor a customer yet, so it carries the brand.
export function inviteSmsText({ brand, name, metro, link, expiresLabel }) {
  const who = firstName(name) ? `Hi ${firstName(name)}, you're` : "You're";
  return `${brand}: ${who} invited to join our technician team in ${metro}. `
    + `Create your login and pick the times you can work (about 2 min): ${link} `
    + (expiresLabel ? `Link expires ${expiresLabel}.` : '');
}

// Sent the moment they tap Start. Deliberately no STOP line: a reflexive STOP
// here would also silence the "You got a job!" texts they now depend on.
export function welcomeSmsText({ brand, name, metro, unstaffed }) {
  const middle = unstaffed
    ? `We're getting ${metro} ready for online bookings and will text you here as soon as jobs start.`
    : `You can now get jobs in ${metro} during the times you picked. We'll text this number every time you're booked.`;
  return `${brand}: You're in, ${firstName(name)}! ${middle} `
    + `Tech app: ${appBaseUrl()}/tech.html (sign in with this number + your 4-digit PIN).`;
}

// Text a (would-be) technician and record it in app.tech_sms_log with a Twilio
// status callback, the same log-first / send / patch pattern as
// notifyTechAssigned (tech-notify.js), so an invite that never arrived shows
// up as Failed on the owner's invite list instead of vanishing. booking_id is
// null, so these rows never appear on a job card. Never throws for logging.
export async function sendTechSms(db, { kind, technicianId = null, businessId = null, phone, message }) {
  let logId = null;
  try {
    const { data } = await db.from('tech_sms_log')
      .insert({ booking_id: null, technician_id: technicianId, business_id: businessId, kind, status: 'pending', to_phone: phone })
      .select('id').maybeSingle();
    logId = data?.id || null;
  } catch { /* logging must never block the text */ }
  const statusCallback = logId
    ? `${appBaseUrl()}/api/analytics?action=sms_status&token=${encodeURIComponent(signToken({ kind: 'tech_sms', tech_sms_log_id: logId }, 86400))}`
    : undefined;
  const r = await sendSMSResult(phone, message, statusCallback ? { statusCallback } : {});
  if (logId) {
    const patch = r.ok
      ? { status: 'pending' }                                   // the callback upgrades it to delivered
      : r.skipped
        ? { status: 'skipped', skip_reason: r.skipped }
        : { status: 'failed', error: String(r.error || 'unknown').slice(0, 500) };
    try { await db.from('tech_sms_log').update(patch).eq('id', logId); } catch { /* best effort */ }
  }
  return { ...r, logId };
}

// A send outcome in words the owner can act on.
export function smsFailReason(r) {
  if (!r || r.ok) return null;
  if (r.skipped === 'notifications_off') return 'texting is switched off';
  if (r.skipped === 'not_configured') return 'texting is not set up';
  if (r.skipped === 'bad_phone') return 'that is not a valid US cell number';
  if (r.skipped) return r.skipped;
  return String(r.error || 'unknown error').replace(/^Twilio \d+:\s*/, 'Twilio: ').slice(0, 160);
}
