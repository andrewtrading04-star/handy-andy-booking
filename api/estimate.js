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
import { smsNotificationsOn } from './_lib/notify.js';
import { sendSMS } from './_lib/sms.js';
import { sendOwnerEstimateAlert } from './_lib/owner-notify.js';

const ALLOWED = new Set(['handy-andy', 'doms']);

// Pull a missing-column name out of either error wording Supabase can surface:
//   PostgREST schema cache: Could not find the 'customer_zip' column of 'estimates' …
//   Raw Postgres (42703):   column estimates.customer_zip does not exist
function missingColumn(msg) {
  let m = /Could not find the '([^']+)' column/.exec(msg || '');
  if (m) return m[1];
  m = /column\s+(?:\w+\.)?["']?(\w+)["']?\s+does not exist/i.exec(msg || '');
  return m ? m[1] : null;
}

// PostgREST/Postgres rejects an insert that references a column missing from
// this database (e.g. a migration not yet applied). Rather than lose the
// customer's request, strip the offending column and retry. Handles
// sms_consent, customer_zip, and any future column drift the same way.
async function insertResilient(db, table, row, returning = 'id') {
  const payload = { ...row };
  for (let i = 0; i < 8; i++) {
    const { data, error } = await db.from(table).insert(payload).select(returning).single();
    if (!error) return { data, error: null };
    const col = missingColumn(error.message);
    if (col && Object.prototype.hasOwnProperty.call(payload, col)) {
      console.warn(`[estimate] '${col}' column missing, retrying without it`);
      delete payload[col];
      continue;
    }
    return { data: null, error };
  }
  return { data: null, error: new Error(`insert into ${table} failed after stripping unknown columns`) };
}

// SMS sending (sendSMS) now lives in ./_lib/sms.js — provider-agnostic
// (SimpleTexting with Twilio fallback), still gated by smsNotificationsOn().

// Format a US phone number as "(222) 222-2222" for storage/display. Strips a
// leading country code; leaves anything that isn't a 10-digit US number as-is
// (e.g. international numbers) so we never mangle an unusual but valid input.
function formatPhoneUS(raw) {
  if (!raw) return raw;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return String(raw).trim();
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
  const phone = formatPhoneUS((customer.phone || '').toString().trim());
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

  // Email heads-up to the business's secretary (Heather/Joey) — the ONLY
  // per-request email they get for online activity now (real bookings no
  // longer email them; see mirror.js). Best-effort: never blocks the request.
  sendOwnerEstimateAlert({
    slug: biz.slug, businessName: biz.name,
    customer: { name, phone, email: customer.email || null },
    zip, serviceLabel: service_label, description,
    preferredSlots: preferred_slots, photoUrl: photo_url,
  }).catch(e => console.warn('[estimate] owner email failed:', e.message));

  return res.status(200).json({ ok: true, id: row.id });
}
