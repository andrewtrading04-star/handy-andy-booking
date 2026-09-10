// /api/doms-lead.js — notification-only endpoint for domstvmounting.com's
// "Don't Want to Call?" contact form.
//
// The form itself still POSTs to landingsite.ai's own lambda, which emails the
// submission to Andrew. That email is then picked up from the mailbox by
// api/migrate.js website_lead_sync, which files it in the Estimates tab and
// texts Joey (DOMS_SECRETARY_PHONE). The one person nothing texted was Andrew,
// so this endpoint -- called in PARALLEL by the site's own JS
// (doms-tv-mounting-site/app/layout.tsx) -- texts Andrew (OWNER_PHONE_NUMBER).
// Never blocks or breaks the existing form submission if it fails.
//
// History: written 2026-09-04 to text Andrew + Joey and email Joey, and the
// site started calling it that same day -- but this file was never committed,
// so the endpoint 404'd in production and texted nobody (found 2026-09-10).
// It shipped then texting Andrew only: Joey already gets the website_lead_sync
// text for every one of these leads, and texting him here as well would double
// each one.
import { sendSMS } from './_lib/sms.js';
import { overSpeedLimit, clientIp } from './_lib/lead-guard.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const name = (body.name || '').toString().trim().slice(0, 200);
  const phone = (body.phone || '').toString().trim().slice(0, 40);
  const email = (body.email || '').toString().trim().slice(0, 200);
  const zip = (body.zipcode || body.zip || '').toString().trim().slice(0, 12);
  const message = (body.message || '').toString().trim().slice(0, 4000);

  // Only the real site calls this (a cross-origin fetch, so the browser always
  // sends Origin). The same open-CORS shape let a bot spam api/quote.js with 13
  // fake requests in Sept 2026; a silent 200 tells a script nothing.
  const originHeader = String(req.headers.origin || req.headers.referer || '');
  let fromSite = false;
  try {
    const host = new URL(originHeader).hostname.toLowerCase();
    // (www-)domstvmounting-com.translate.goog is Google's "Translate this page"
    // proxy from search results; the site's JS still runs there.
    fromSite = host === 'domstvmounting.com' || host.endsWith('.domstvmounting.com')
      || host === 'domstvmounting-com.translate.goog' || host === 'www-domstvmounting-com.translate.goog'
      || host === 'localhost' || host === '127.0.0.1';
  } catch {}
  if (!fromSite) {
    console.warn('[doms-lead] blocked: not from domstvmounting.com', { originHeader, name: name.slice(0, 80), phone });
    return res.status(200).json({ ok: true });
  }

  if (!name || !phone) {
    return res.status(400).json({ error: 'name and phone are required' });
  }

  const ip = clientIp(req);
  if (overSpeedLimit('doms-lead', { ip, email, phone })) {
    console.warn('[doms-lead] blocked: over the speed limit', { ip, name: name.slice(0, 80), phone });
    return res.status(200).json({ ok: true });
  }

  const smsText = [
    'New Dom\'s TV Mounting website lead',
    `${name} — ${phone}`,
    zip ? `Zip: ${zip}` : null,
    message ? message.slice(0, 200) : null,
  ].filter(Boolean).join('\n');

  if (process.env.OWNER_PHONE_NUMBER) {
    // AWAITED: a lambda that has already responded can be frozen mid-send.
    await sendSMS(process.env.OWNER_PHONE_NUMBER, smsText).catch((e) => console.error('[doms-lead] owner sms failed:', e.message));
  } else {
    console.error('[doms-lead] OWNER_PHONE_NUMBER not set — owner not texted');
  }

  return res.status(200).json({ ok: true });
}
