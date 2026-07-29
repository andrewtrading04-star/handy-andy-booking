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
import { sendSMS, toE164 } from './_lib/sms.js';
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

// SMS sending (sendSMS) now lives in ./_lib/sms.js — Twilio, still gated by
// smsNotificationsOn().

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
// Sanitize an incoming line-item array into the estimate line-item shape used
// EVERYWHERE else in the app: { description, qty, unit_price }. This exact
// shape matters — the dashboard's estimate card, quote builder, totals math
// and convert-to-job all read `description` and `qty` (see admin.html's
// estCard()/estLineTotal()). Emitting `name`/`quantity` instead renders every
// row as a literal "Item" at $0.00 with a $0.00 subtotal, which is precisely
// what happened to the first real DFW request.
//
// Accepts either spelling on input so a caller sending {name, quantity} still
// stores correctly. Used by the online-booking "request" flow (unstaffed
// service areas — public/widget.js) to carry the customer's real priced TV
// selections into the estimate, instead of a free-text description. Optional:
// the original /estimate.html quick-quote form never sends this.
function sanitizeEstimateLineItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 40).map(it => {
    const raw = it || {};
    const descRaw = raw.description != null ? raw.description
                  : (raw.name != null ? raw.name : raw.label);
    const description = String(descRaw || '').trim().slice(0, 200);
    const qtyRaw = raw.qty != null ? raw.qty : raw.quantity;
    const qty = Math.min(20, Math.max(1, Math.round(Number(qtyRaw) || 1)));
    const unit_price = Math.round((Number(raw.unit_price) || 0) * 100) / 100;
    return { description, qty, unit_price };
  }).filter(it => it.description);
}

// Subtotal of sanitized line items — same math as the dashboard's estLineTotal().
function estimateLineItemsTotal(items) {
  return Math.round(items.reduce((s, li) => s + li.qty * li.unit_price, 0) * 100) / 100;
}

async function submit(req, res, db) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = req.body || {};
  let biz; try { biz = await resolveBusiness(db, (body.business || '').toString()); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const line_items = sanitizeEstimateLineItems(body.line_items);
  // description is normally free text the customer typed; the request flow
  // has no such box (it's all structured TV selections), so build a readable
  // summary from the line items instead of forcing a redundant text field.
  const description = (body.description || '').toString().trim()
    || (line_items.length ? `Online booking request: ${line_items.map(li => li.description).slice(0, 8).join(', ')}` : '');
  if (!description) return res.status(400).json({ error: 'Please tell us what you need help with.' });
  if (description.length > 4000) return res.status(400).json({ error: 'Description is too long.' });

  const customer = body.customer || {};
  const name = (customer.name || '').toString().trim();
  const phone = formatPhoneUS((customer.phone || '').toString().trim());
  const zip = (customer.zip || '').toString().trim() || null;
  // Full address — optional (the original quick-quote form only ever asked
  // for a zip). Populated by the request flow, which reuses the same address
  // step as a normal booking.
  const address = (customer.address || '').toString().trim().slice(0, 300) || null;
  const city = (customer.city || '').toString().trim().slice(0, 100) || null;
  const state = (customer.state || '').toString().trim().slice(0, 2).toUpperCase() || null;
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
    customer_address: address, customer_city: city, customer_state: state,
    description, photo_url, photo_path,
    preferred_slots,
    line_items,
    source: 'widget',
    sms_consent: body.sms_consent !== false,
  };

  // Quote at the rate the customer was actually shown (the widget sends its own
  // TAX_RATE), instead of letting the column default apply a different one and
  // make the office's total disagree with the customer's screen. Clamped, and
  // only honored when sane — an absent/garbage value keeps the DB default.
  const taxRate = Number(body.tax_rate);
  if (Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 0.25) estimateInsert.tax_rate = taxRate;

  const { data: row, error } = await insertResilient(db, 'estimates', estimateInsert);
  if (error) throw error;

  // ── Notifications ────────────────────────────────────────────────────────
  // ALL of these are collected and AWAITED before responding. They used to be
  // fire-and-forget (`sendSMS(...).catch()` with no await), which silently
  // loses the send on Vercel: once the handler returns its response the lambda
  // is frozen, so an in-flight Twilio/Resend fetch never completes and never
  // even logs why. That's why the first real DFW request produced no owner
  // text and no [SMS] log line at all. Awaiting costs ~1s on a form submit and
  // makes delivery (and its logging) deterministic.
  const notifications = [];

  // Notify staff (owner + secretary) per business settings, PLUS the
  // business's secretary (Heather/Joey) directly via env var — guarantees they
  // always get texted even if estimate_notify_phones was never configured or
  // doesn't include their number. Deduped so a number set both ways only texts once.
  const phones = new Set(Array.isArray(biz.settings?.estimate_notify_phones) ? biz.settings.estimate_notify_phones : []);
  if (biz.slug === 'handy-andy' && process.env.HANDY_ANDY_SECRETARY_PHONE) phones.add(process.env.HANDY_ANDY_SECRETARY_PHONE);
  if (biz.slug === 'doms' && process.env.DOMS_SECRETARY_PHONE) phones.add(process.env.DOMS_SECRETARY_PHONE);

  // On an unstaffed-area request the owner gets their own, richer text below
  // (address + all preferred windows + estimate total). Their number is
  // usually also in estimate_notify_phones, so drop it from the generic staff
  // text here — otherwise they'd get the same request twice, and the weaker
  // message of the two. Compared in E.164 so "(337) 499-7817" and
  // "+13374997817" are recognized as the same phone.
  const isUnstaffedRequest = body.request_type === 'unstaffed_area';
  const ownerE164 = toE164(process.env.OWNER_PHONE_NUMBER || '');
  if (isUnstaffedRequest && ownerE164) {
    for (const p of [...phones]) if (toE164(p) === ownerE164) phones.delete(p);
  }

  if (phones.size) {
    const when = preferred_slots.length
      ? ' Preferred: ' + preferred_slots.map(s => `${s.label || s.slot_key}`).slice(0, 2).join(', ') + (preferred_slots.length > 2 ? '…' : '')
      : '';
    const svcTxt = service_label ? `${service_label} — ` : '';
    const snippet = description.length > 90 ? description.slice(0, 90) + '…' : description;
    const zipTxt = zip ? ` ZIP: ${zip}.` : '';
    const msg = `New ${biz.name} estimate request from ${name} (${phone})${zipTxt}: ${svcTxt}${snippet}.${when} Check the dashboard.`;
    for (const p of phones) notifications.push(sendSMS(p, msg).catch(e => console.error('[estimate] staff sms failed:', e.message)));
  } else if (!isUnstaffedRequest) {
    console.warn(`[estimate] no staff notify phones configured for ${biz.slug} — nobody was texted`);
  }

  // A request from an unstaffed service area (public/widget.js's request
  // flow, service_areas.unstaffed) ALWAYS texts the owner directly, in
  // addition to the normal secretary notification above — the owner asked
  // for personal visibility into these specifically, since there is no tech
  // there yet to just auto-assign the job to. Marked by the widget via
  // request_type; never set by the original /estimate.html quick-quote form.
  if (isUnstaffedRequest) {
    if (ownerE164) {
      const total = estimateLineItemsTotal(line_items);
      const windows = preferred_slots.map(s => s.label || s.slot_key).slice(0, 3).join(', ') || 'none given';
      const addrTxt = address ? ` ${address},` : '';
      const msg = `New service request: ${name} (${phone}).${addrTxt} ${zip || 'zip unknown'}. Prefers ${windows}. Est. $${Math.round(total)}. No tech assigned — call to confirm.`;
      notifications.push(sendSMS(process.env.OWNER_PHONE_NUMBER, msg).catch(e => console.error('[estimate] owner sms failed:', e.message)));
    } else {
      // Loud, because this is the owner's only real-time signal for these.
      console.error('[estimate] OWNER_PHONE_NUMBER is not set — unstaffed-area request went un-texted');
    }
  }

  // Email heads-up to the business's secretary (Heather/Joey) — the ONLY
  // per-request email they get for online activity now (real bookings no
  // longer email them; see mirror.js).
  notifications.push(sendOwnerEstimateAlert({
    slug: biz.slug, businessName: biz.name,
    customer: { name, phone, email: customer.email || null },
    zip, serviceLabel: service_label, description,
    preferredSlots: preferred_slots, photoUrl: photo_url,
  }).catch(e => console.warn('[estimate] owner email failed:', e.message)));

  // A notification failure must never lose the request — it's already stored.
  await Promise.allSettled(notifications);

  return res.status(200).json({ ok: true, id: row.id });
}
