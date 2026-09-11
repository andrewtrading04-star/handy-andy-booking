// /api/houstonperfectviewtvmounting-ask.js — homepage "ask a question"
// card on houstonperfectviewtvmounting.com (not the booking widget: a
// visitor who isn't ready to book yet). On submit, emails the owner
// directly. No SMS here on purpose — this is a lower-urgency "someone has
// a question" note, not a lead that needs a same-day callback.
import { sendEmail } from './_lib/email.js';
import { overSpeedLimit, clientIp } from './_lib/lead-guard.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const SITE_HOSTS = new Set(['houstonperfectviewtvmounting.com', 'www.houstonperfectviewtvmounting.com', 'localhost', '127.0.0.1']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Same anti-bot shape as api/quote.js: real cross-origin browser
  // submissions always carry an Origin/Referer, and a real visitor takes at
  // least ~2s to fill this in. A silent 200 keeps bots from learning what
  // tripped.
  const originHeader = String(req.headers.origin || req.headers.referer || '');
  let fromSite = false;
  try {
    const host = new URL(originHeader).hostname.toLowerCase();
    fromSite = SITE_HOSTS.has(host);
  } catch {}
  const isHoneypot = String(body.hp_website || '').trim() !== '';
  const fillMs = typeof body.fillMs === 'number' && Number.isFinite(body.fillMs) ? body.fillMs : null;
  const tooFast = fillMs !== null && fillMs >= 0 && fillMs < 1500;
  const who = { name: String(body.name || '').trim().slice(0, 80), phone: String(body.phone || '').trim().slice(0, 40) };
  if (!fromSite || isHoneypot || tooFast) {
    console.warn('[houstonperfectviewtvmounting-ask] blocked suspected bot submission', { fromSite, isHoneypot, tooFast, fillMs, originHeader, ...who });
    return res.status(200).json({ ok: true });
  }

  const name = String(body.name || '').trim().slice(0, 200);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const message = String(body.message || '').trim().slice(0, 4000);
  const pageUrl = String(body.pageUrl || '').trim().slice(0, 300);

  if (!name) return res.status(400).json({ error: 'Your name is required.' });
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
  if (!message) return res.status(400).json({ error: 'Please enter your question.' });

  // Same connection/phone sending several in ten minutes gets flagged in the
  // logs but is still emailed — a real customer's second question must never
  // be dropped, this only stops a flood from being worth running.
  const ip = clientIp(req);
  const repeatSender = overSpeedLimit('houstonperfectviewtvmounting-ask', { ip, phone });
  if (repeatSender) console.warn('[houstonperfectviewtvmounting-ask] over the speed limit', { ip, ...who });

  const rows = [
    ['Name', name],
    ['Phone', phone],
    ['Page', pageUrl],
  ].filter((r) => r[1]);
  const tbl = rows
    .map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;color:#111;">${esc(v)}</td></tr>`)
    .join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
    <h2 style="margin:0 0 12px;">New question from houstonperfectviewtvmounting.com</h2>
    <table style="border-collapse:collapse;">${tbl}</table>
    <p style="margin:14px 0 0;"><b>Question:</b> ${esc(message)}</p>
  </div>`;

  const result = await sendEmail({
    slug: 'houstonperfectviewtvmounting',
    to: 'andrewtrading04@gmail.com',
    subject: repeatSender ? 'New homepage question (repeat sender)' : 'New homepage question',
    html,
    replyTo: undefined,
  });

  if (result && result.sent === false) console.error('[houstonperfectviewtvmounting-ask] email not sent:', result.skipped || result.error);

  return res.status(200).json({ ok: true });
}
