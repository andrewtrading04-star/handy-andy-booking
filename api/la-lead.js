// /api/la-lead.js — lead-capture endpoint for tvmountinglosangeles.com, one
// of the "LA trio" (tvmountinglosangeles / latvpro / lainstall): real,
// active business rows in the CRM but deliberately UNSTAFFED demand-gauging
// funnels (see LAUNCH_NO_GBP_SLUGS / LAUNCH_NO_EMAIL_SLUGS in
// public/admin.html). No Stripe, no availability, no staff assignment, no
// native-business registration — the owner hasn't decided whether to staff
// this market yet, so this endpoint does exactly one thing: a visitor posts
// name/phone/zip/message and the owner gets an email + text. Modeled
// directly on api/quote.js (ihandyandy's quote form — spam-guard shape) and
// api/doms-lead.js (owner-only notification, no secretary cc). No DB save,
// same as both of those.
//
// IMPORTANT: emailConfig('tvmountinglosangeles') in ./_lib/email.js
// deliberately returns { apiKey: null, from: null } — the LA trio has no
// verified Resend sender on purpose, so a real CUSTOMER never receives a
// branded email that misrepresents this as a live staffed operation. That
// rule is about customer-facing mail. This endpoint never emails a customer
// — it only alerts the owner internally — so it sends through the shared
// 'handy-andy' Resend account (same one api/quote.js uses) straight to the
// owner's own inbox, the same way api/houstonperfectviewtvmounting-ask.js
// does for its own owner-only "ask a question" card. Passing
// slug:'tvmountinglosangeles' here instead would silently send nothing,
// forever.
import { sendEmail } from './_lib/email.js';
import { sendSMS } from './_lib/sms.js';
import { overSpeedLimit, clientIp } from './_lib/lead-guard.js';
import { isBlockedPhone } from './_lib/blocked.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Hosts the real site's JS runs on. Google's "Translate this page" link (from
// search results) serves the site from (www-)tvmountinglosangeles-com
// .translate.goog with its scripts still running, so a translated visitor's
// request carries that Origin — without these two, their request would be
// silently dropped as a bot. Same shape as api/quote.js's SITE_HOSTS.
const SITE_HOSTS = new Set([
  'tvmountinglosangeles.com',
  'tvmountinglosangeles-com.translate.goog',
  'www-tvmountinglosangeles-com.translate.goog',
  'localhost',
  '127.0.0.1',
]);

// The owner's own inbox — same address used directly by
// api/houstonperfectviewtvmounting-ask.js and listed as the owner's own
// contact in api/_lib/bot-filter.js's DEFAULT_INTERNAL_CONTACTS.
const OWNER_EMAIL = 'andrewtrading04@gmail.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // This endpoint has open CORS (posted to cross-origin from
  // tvmountinglosangeles.com), which also makes it trivially discoverable
  // and spammable by scripts that skip the real page entirely. Real browser
  // submissions always carry an Origin/Referer for a cross-origin fetch, so
  // anything claiming a different site (or none at all) is rejected here. A
  // silent 200 (no email/SMS sent) keeps bots from learning what tripped it
  // — same reasoning as api/quote.js.
  const originHeader = String(req.headers.origin || req.headers.referer || '');
  let fromSite = false;
  try {
    const host = new URL(originHeader).hostname.toLowerCase();
    fromSite = SITE_HOSTS.has(host) || host.endsWith('.tvmountinglosangeles.com');
  } catch {}
  // Invisible field bots fill in but the real form never shows.
  const isHoneypot = String(body.hp_website || '').trim() !== '';
  // fillMs is measured entirely on the visitor's own clock (performance.now()
  // at submit minus when the form was set up) — same contract as
  // api/quote.js / api/doms-lead.js. A missing/null fillMs (a page still open
  // from before this deploy) skips the check rather than reading as 0ms.
  const fillMs = typeof body.fillMs === 'number' && Number.isFinite(body.fillMs) ? body.fillMs : null;
  const tooFast = fillMs !== null && fillMs >= 0 && fillMs < 1500;

  const name = String(body.name || '').trim().slice(0, 200);
  const phone = String(body.phone || '').trim().slice(0, 40);
  // Logged on every block so a real lead that ever trips a check can still be
  // found in the Vercel logs and called back.
  const who = { name: name.slice(0, 80), phone: phone.slice(0, 40) };
  if (!fromSite || isHoneypot || tooFast) {
    console.warn('[la-lead] blocked suspected bot submission', { fromSite, isHoneypot, tooFast, fillMs, originHeader, ...who });
    return res.status(200).json({ ok: true });
  }

  const zip = String(body.zip || '').trim().slice(0, 12);
  const message = String(body.message || '').trim().slice(0, 4000);

  if (!name) return res.status(400).json({ error: 'Your name is required.' });
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });

  // Same connection or phone sending a 4th request inside 10 minutes — see
  // _lib/lead-guard.js for the bursts that prompted this. It is still
  // EMAILED (a real customer asking a second time must never be lost), just
  // not texted, so a flood can't keep buzzing the owner's phone. This form
  // has no `email` field in its contract, so tracked by ip + phone only.
  // Sitewide block list: a blocked number is a scammer on every business. Answer
  // like a success so it learns nothing, and do nothing (no record, no alert).
  if (await isBlockedPhone(phone)) return res.status(200).json({ ok: true });
  const ip = clientIp(req);
  const repeatSender = overSpeedLimit('la-lead', { ip, phone });
  if (repeatSender) console.warn('[la-lead] over the speed limit — emailed only, not texted', { ip, ...who });

  const rows = [
    ['Name', name],
    ['Phone', phone],
    ['Zip', zip],
  ].filter((r) => r[1]);
  const tbl = rows
    .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;color:#111;">${esc(v)}</td></tr>`)
    .join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
    <h2 style="margin:0 0 12px;">New lead from TV Mounting Los Angeles (tvmountinglosangeles.com)</h2>
    <table style="border-collapse:collapse;">${tbl}</table>
    <p style="margin:14px 0 0;"><b>What they need:</b> ${message ? esc(message) : '(no message provided)'}</p>
  </div>`;

  const smsText = [
    'New lead — TV Mounting Los Angeles',
    `${name}${phone ? ' · ' + phone : ''}`,
    zip ? `Zip: ${zip}` : null,
    message ? message.slice(0, 140) : null,
  ].filter(Boolean).join('\n');

  // Owner only — never Heather or Joey, who cover the existing Austin/Houston
  // brand set, not LA.
  if (!process.env.OWNER_PHONE_NUMBER) console.error('[la-lead] OWNER_PHONE_NUMBER not set — owner not texted');

  const results = await Promise.allSettled([
    sendEmail({
      slug: 'handy-andy',
      to: OWNER_EMAIL,
      subject: repeatSender ? 'New LA lead (repeat sender, not texted)' : 'New LA lead',
      html,
    }),
    ...(repeatSender || !process.env.OWNER_PHONE_NUMBER ? [] : [sendSMS(process.env.OWNER_PHONE_NUMBER, smsText)]),
  ]);

  // sendEmail reports a skip or provider error as {sent:false} rather than
  // throwing, so check both — otherwise a lost email logs nothing at all.
  const emailResult = results[0];
  if (emailResult.status === 'rejected') console.error('[la-lead] email failed:', emailResult.reason);
  else if (emailResult.value && emailResult.value.sent === false) console.error('[la-lead] email not sent:', emailResult.value.skipped || emailResult.value.error);

  return res.status(200).json({ ok: true });
}
