// /api/estimate.js — public estimate (quote request) endpoint.
//
// Powers the standalone /estimate.html page for both businesses. Runs
// server-side with the SERVICE ROLE key (RLS denies anon on app.estimates),
// so the page itself ships no secret.
//
//   GET  ?action=services&business=<slug>   -> list Handyman estimate services
//   POST ?action=submit                     -> create estimate + notify staff
//
// On submit, an SMS is sent to each number in
// businesses.settings.estimate_notify_phones (owner + secretary).
import { serviceClient } from './_lib/supabase.js';
import { uploadImage } from './_lib/storage.js';

const ALLOWED = new Set(['handy-andy', 'doms']);

// PostgREST rejects an insert that references a column missing from its schema
// cache (e.g. a migration not yet applied to this database). Rather than lose
// the customer's request, strip the offending column and retry. Handles
// sms_consent, customer_zip, and any future column drift the same way.
async function insertResilient(db, table, row, returning = 'id') {
  const payload = { ...row };
  for (let i = 0; i < 8; i++) {
    const { data, error } = await db.from(table).insert(payload).select(returning).single();
    if (!error) return { data, error: null };
    const m = /Could not find the '([^']+)' column/.exec(error.message || '');
    if (m && Object.prototype.hasOwnProperty.call(payload, m[1])) {
      console.warn(`[estimate] '${m[1]}' column not in schema cache, retrying without it`);
      delete payload[m[1]];
      continue;
    }
    return { data: null, error };
  }
  return { data: null, error: new Error(`insert into ${table} failed after stripping unknown columns`) };
}

// ── Twilio SMS (same shape as admin.js / tech.js) ────────────────────────────
function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('+')) return s.replace(/[^\d+]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : null;
}

async function sendSMS(phoneNumber, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.warn('[SMS] Twilio not configured; message not sent:', message);
    return;
  }
  const to = toE164(phoneNumber);
  if (!to) { console.warn('[SMS] Unusable phone, not sent:', phoneNumber); return; }
  const formData = new URLSearchParams();
  formData.append('From', process.env.TWILIO_PHONE_NUMBER);
  formData.append('To', to);
  formData.append('Body', message);
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST', headers: { Authorization: `Basic ${auth}` }, body: formData,
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`Twilio ${r.status}: ${t.slice(0, 300)}`); }
    console.log('[SMS] estimate alert sent to', to.slice(-4));
  } catch (e) { console.error('[SMS]', e.message); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  try {
    const db = serviceClient();
    if (action === 'services') return await listServices(req, res, db);
    if (action === 'submit')   return await submit(req, res, db);
    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    console.error('[estimate]', action, err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}

async function resolveBusiness(db, slug) {
  if (!ALLOWED.has(slug)) { const e = new Error('Unknown business'); e.status = 400; throw e; }
  const { data, error } = await db.from('businesses').select('id, slug, name, settings').eq('slug', slug).single();
  if (error || !data) { const e = new Error('Business not found'); e.status = 404; throw e; }
  return data;
}

// GET ?action=services&business=<slug>
async function listServices(req, res, db) {
  const slug = (req.query.business || '').toString();
  let biz; try { biz = await resolveBusiness(db, slug); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { data, error } = await db.from('services')
    .select('id, name, description, sort_order, settings')
    .eq('business_id', biz.id).eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  const services = (data || [])
    .filter(s => s.settings && s.settings.estimate_service === true)
    .map(s => ({ id: s.id, name: s.name, description: s.description || '' }));
  return res.status(200).json({ business: { slug: biz.slug, name: biz.name }, services });
}

// POST ?action=submit
async function submit(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  let biz; try { biz = await resolveBusiness(db, (body.business || '').toString()); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const description = (body.description || '').toString().trim();
  if (!description) return res.status(400).json({ error: 'Please tell us what you need help with.' });
  if (description.length > 4000) return res.status(400).json({ error: 'Description is too long.' });

  const customer = body.customer || {};
  const name = (customer.name || '').toString().trim();
  const phone = (customer.phone || '').toString().trim();
  const zip = (customer.zip || '').toString().trim() || null;
  if (!name)  return res.status(400).json({ error: 'Your name is required.' });
  if (!phone) return res.status(400).json({ error: 'A phone number is required.' });

  // Validate the chosen service belongs to this business (optional but tidy).
  let service_id = null, service_label = (body.service_label || '').toString().trim() || null;
  if (body.service_id) {
    const { data: svc } = await db.from('services')
      .select('id, name').eq('id', body.service_id).eq('business_id', biz.id).maybeSingle();
    if (svc) { service_id = svc.id; service_label = svc.name; }
  }

  // Preferred slots — cap at 5, keep only the shape we expect.
  let preferred_slots = [];
  if (Array.isArray(body.preferred_slots)) {
    preferred_slots = body.preferred_slots.slice(0, 5).map(s => ({
      date: (s && s.date) ? String(s.date).slice(0, 10) : null,
      slot_key: (s && s.slot_key) ? String(s.slot_key).slice(0, 8) : null,
      label: (s && s.label) ? String(s.label).slice(0, 80) : null,
    })).filter(s => s.date && s.slot_key);
  }

  // Optional single photo (data URL from the browser, already compressed).
  let photo_url = null, photo_path = null;
  if (body.image) {
    try {
      const up = await uploadImage(body.image, `estimates/${biz.id}`);
      photo_url = up.url; photo_path = up.path;
    } catch (e) {
      // A bad photo shouldn't lose the whole request — log and continue.
      console.warn('[estimate] photo upload failed:', e.message);
    }
  }

  // Insert the estimate. insertResilient() tolerates columns that a not-yet-applied
  // migration hasn't added to this database (e.g. sms_consent, customer_zip) by
  // stripping them and retrying, so a request is never lost to schema drift.
  const estimateInsert = {
    business_id: biz.id,
    service_id, service_label,
    customer_name: name, customer_phone: phone,
    customer_email: (customer.email || '').toString().trim() || null,
    customer_zip: zip,
    description, photo_url, photo_path,
    preferred_slots,
    source: 'widget',
    sms_consent: body.sms_consent !== false,
  };

  const { data: row, error } = await insertResilient(db, 'estimates', estimateInsert);
  if (error) throw error;

  // Notify staff (owner + secretary) per business settings.
  const phones = Array.isArray(biz.settings?.estimate_notify_phones) ? biz.settings.estimate_notify_phones : [];
  if (phones.length) {
    const when = preferred_slots.length
      ? ' Preferred: ' + preferred_slots.map(s => `${s.label || s.slot_key}`).slice(0, 2).join(', ') + (preferred_slots.length > 2 ? '…' : '')
      : '';
    const svcTxt = service_label ? `${service_label} — ` : '';
    const snippet = description.length > 90 ? description.slice(0, 90) + '…' : description;
    const zipTxt = zip ? ` ZIP: ${zip}.` : '';
    const msg = `New ${biz.name} estimate request from ${name} (${phone})${zipTxt}: ${svcTxt}${snippet}.${when} Check the dashboard.`;
    for (const p of phones) sendSMS(p, msg).catch(console.error);
  }

  return res.status(200).json({ ok: true, id: row.id });
}
