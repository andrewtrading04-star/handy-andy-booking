// /api/quote.js — public "Request a Quote" endpoint for the ihandyandy.com
// site clone (data-landingsite-contact-form on ~44 service pages). The
// original landingsite.ai lead form posted to a lambda URL this project
// doesn't own, so submissions went nowhere. This is a small, dedicated
// replacement: on submit it ALWAYS emails contact@ihandyandy.com and texts
// Heather and the owner, independent of the shared /api/estimate flow's
// per-business routing (which this quote form doesn't need — no line items,
// no dashboard row, just "someone asked a question, go tell a human").
import { sendEmail } from './_lib/email.js';
import { sendSMS, toE164 } from './_lib/sms.js';
import { overSpeedLimit, clientIp } from './_lib/lead-guard.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Hosts the real site's JS runs on. Google's "Translate this page" link (from
// search results) serves the site from (www-)ihandyandy-com.translate.goog with
// its scripts still running, so a translated visitor's request carries that
// Origin — without these two, their request was silently dropped as a bot.
const SITE_HOSTS = new Set(['ihandyandy.com', 'ihandyandy-com.translate.goog', 'www-ihandyandy-com.translate.goog', 'localhost', '127.0.0.1']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // The /faq page's form — the only one of the 45 — splits the name into
  // firstName/lastName (and adds service/location selects), so its requests
  // arrived with no "name" at all and were refused "Your name is required."
  // however they were filled in (found 2026-09-10). Accept either shape.
  const name = String(body.name || [body.firstName, body.lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' '))
    .trim().slice(0, 200);

  // This endpoint has open CORS (it's posted to cross-origin from
  // ihandyandy.com), which also makes it trivially discoverable and
  // spammable by scripts that skip the real page entirely. Real browser
  // submissions always carry an Origin/Referer for a cross-origin fetch, so
  // anything claiming a different site (or none at all) is rejected here.
  // A silent 200 (no email/SMS sent) keeps bots from learning what tripped.
  const originHeader = String(req.headers.origin || req.headers.referer || '');
  let fromSite = false;
  try {
    const host = new URL(originHeader).hostname.toLowerCase();
    fromSite = SITE_HOSTS.has(host) || host.endsWith('.ihandyandy.com');
  } catch {}
  // Invisible field bots fill in but the real form never shows.
  const isHoneypot = String(body.hp_website || '').trim() !== '';
  // Real users take at least ~2s to read+fill the form; scripted bots that
  // do fetch the page and replay its fields post almost instantly.
  // fillMs is measured entirely on the visitor's own clock by
  // QuoteFormHandler (performance.now() at submit minus when the form was set
  // up). The first version sent the browser's Date.now() as "renderedAt" and
  // subtracted it from the SERVER's clock, so a visitor whose computer clock ran
  // fast had every real request silently dropped as "too fast" while being shown
  // "Thanks!". renderedAt is ignored for that reason. Only a real number counts:
  // a missing/null fillMs (a page still open from before this deploy) skips the
  // check rather than reading as 0 ms.
  const fillMs = typeof body.fillMs === 'number' && Number.isFinite(body.fillMs) ? body.fillMs : null;
  const tooFast = fillMs !== null && fillMs >= 0 && fillMs < 1500;
  // Logged on every block so a real lead that ever trips a check can still be
  // found in the Vercel logs and called back.
  const who = { name: name.slice(0, 80), phone: String(body.phone || '').trim().slice(0, 40) };
  if (!fromSite || isHoneypot || tooFast) {
    console.warn('[quote] blocked suspected bot submission', { fromSite, isHoneypot, tooFast, fillMs, originHeader, ...who });
    return res.status(200).json({ ok: true });
  }

  const phone = String(body.phone || '').trim().slice(0, 40);
  const email = String(body.email || '').trim().slice(0, 200);
  const zipcode = String(body.zipcode || '').trim().slice(0, 10);
  const service = String(body.service || '').trim().slice(0, 80);
  const city = String(body.location || '').trim().slice(0, 80);
  const tvSize = String(body['tv-size'] || body.tvSize || '').trim().slice(0, 40);
  const hasBracket = String(body['has-bracket'] || body.hasBracket || '').trim().slice(0, 40);
  const message = String(body.message || '').trim().slice(0, 4000);
  const pageUrl = String(body.pageUrl || '').trim().slice(0, 300);

  if (!name) return res.status(400).json({ error: 'Your name is required.' });
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
  if (!message) return res.status(400).json({ error: 'Please tell us what you need help with.' });

  // Same connection, inbox or phone sending a 4th request inside 10 minutes —
  // see _lib/lead-guard.js for the bursts that prompted this. It is still
  // EMAILED (a real customer asking about a 4th job must never be lost), just
  // not texted, so a flood can't keep buzzing two phones.
  const ip = clientIp(req);
  const repeatSender = overSpeedLimit('quote', { ip, email, phone });
  if (repeatSender) console.warn('[quote] over the speed limit — emailed only, not texted', { ip, ...who });

  const rows = [
    ['Name', name],
    ['Phone', phone],
    ['Email', email],
    ['Zip', zipcode],
    ['City', city],
    ['Service', service],
    ['TV size', tvSize],
    ['Has bracket', hasBracket],
    ['Page', pageUrl],
  ].filter((r) => r[1]);
  const tbl = rows
    .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;color:#111;">${esc(v)}</td></tr>`)
    .join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
    <h2 style="margin:0 0 12px;">New quote request from ihandyandy.com</h2>
    <table style="border-collapse:collapse;">${tbl}</table>
    <p style="margin:14px 0 0;"><b>What they need:</b> ${esc(message)}</p>
  </div>`;

  const smsText = [
    'New quote request — ihandyandy.com',
    `${name}${phone ? ' · ' + phone : ''}`,
    tvSize ? `TV: ${tvSize}` : null,
    message.slice(0, 140),
  ].filter(Boolean).join('\n');

  // Heather (the Handy Andy line) AND the owner. The owner was never on this
  // list, so he only ever learned of a quote request by happening to open the
  // contact@ihandyandy.com mailbox — found 2026-09-09, when 13 spam requests
  // had texted Heather and nobody else. A missing env var is logged instead of
  // silently skipped, and one number configured under both gets one text.
  const textTo = new Map();
  for (const [label, envName] of [['Heather', 'HEATHER_PHONE_NUMBER'], ['owner', 'OWNER_PHONE_NUMBER']]) {
    const raw = process.env[envName];
    if (!raw) { console.error(`[quote] ${envName} not set — ${label} not texted`); continue; }
    const key = toE164(raw) || raw;
    if (!textTo.has(key)) textTo.set(key, raw);
  }

  const results = await Promise.allSettled([
    sendEmail({
      slug: 'handy-andy',
      to: 'contact@ihandyandy.com',
      subject: repeatSender ? 'New quote request (repeat sender, not texted)' : 'New quote request',
      html,
    }),
    ...(repeatSender ? [] : [...textTo.values()].map((p) => sendSMS(p, smsText))),
  ]);

  // sendEmail reports a skip or provider error as {sent:false} rather than
  // throwing, so check both — otherwise a lost email logs nothing at all.
  const emailResult = results[0];
  if (emailResult.status === 'rejected') console.error('[quote] email failed:', emailResult.reason);
  else if (emailResult.value && emailResult.value.sent === false) console.error('[quote] email not sent:', emailResult.value.skipped || emailResult.value.error);

  return res.status(200).json({ ok: true });
}
