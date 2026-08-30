// /api/quote.js — public "Request a Quote" endpoint for the ihandyandy.com
// site clone (data-landingsite-contact-form on ~44 service pages). The
// original landingsite.ai lead form posted to a lambda URL this project
// doesn't own, so submissions went nowhere. This is a small, dedicated
// replacement: on submit it ALWAYS emails contact@ihandyandy.com and texts
// Heather, independent of the shared /api/estimate flow's per-business
// routing (which this quote form doesn't need — no line items, no dashboard
// row, just "someone asked a question, go tell a human").
import { sendEmail } from './_lib/email.js';
import { sendSMS } from './_lib/sms.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 200);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const email = String(body.email || '').trim().slice(0, 200);
  const zipcode = String(body.zipcode || '').trim().slice(0, 10);
  const tvSize = String(body['tv-size'] || body.tvSize || '').trim().slice(0, 40);
  const hasBracket = String(body['has-bracket'] || body.hasBracket || '').trim().slice(0, 40);
  const message = String(body.message || '').trim().slice(0, 4000);
  const pageUrl = String(body.pageUrl || '').trim().slice(0, 300);

  if (!name) return res.status(400).json({ error: 'Your name is required.' });
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });
  if (!message) return res.status(400).json({ error: 'Please tell us what you need help with.' });

  const rows = [
    ['Name', name],
    ['Phone', phone],
    ['Email', email],
    ['Zip', zipcode],
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

  const results = await Promise.allSettled([
    sendEmail({ slug: 'handy-andy', to: 'contact@ihandyandy.com', subject: 'New quote request', html }),
    process.env.HEATHER_PHONE_NUMBER ? sendSMS(process.env.HEATHER_PHONE_NUMBER, smsText) : Promise.resolve(),
  ]);

  const emailResult = results[0];
  if (emailResult.status === 'rejected') console.error('[quote] email failed:', emailResult.reason);

  return res.status(200).json({ ok: true });
}
