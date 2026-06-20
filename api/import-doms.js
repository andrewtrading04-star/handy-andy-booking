// ONE-TIME import endpoint — pulls all Doms historical data from Zenbooker
// and upserts into the app database. Secured by IMPORT_SECRET env var.
// DELETE THIS FILE after the import completes successfully.
import { serviceClient } from './_lib/supabase.js';
import { applyCors } from './_lib/auth.js';

const PAGE = 100;

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
}
function digits(s) { return s == null ? null : String(s).replace(/[^\d]/g, '') || null; }

async function zbkGet(path, key) {
  const r = await fetch('https://api.zenbooker.com' + path, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Zenbooker ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function* paginate(basePath, key) {
  const sep = basePath.includes('?') ? '&' : '?';
  let starting_after = null;
  let numericCursor = 0;
  for (let page = 0; page < 5000; page++) {
    let url = `${basePath}${sep}limit=${PAGE}`;
    if (starting_after) url += `&starting_after=${encodeURIComponent(starting_after)}`;
    else if (numericCursor) url += `&cursor=${numericCursor}`;
    const j = await zbkGet(url, key);
    const rows = Array.isArray(j) ? j : (j.data || j.results || []);
    if (!rows.length) return;
    for (const row of rows) yield row;
    const hasMore = Array.isArray(j) ? rows.length === PAGE
                  : (j.has_more === true || (j.has_more === undefined && rows.length === PAGE));
    if (!hasMore) return;
    const last = rows[rows.length - 1];
    if (last?.id != null) starting_after = String(last.id);
    else numericCursor = (j.cursor || 0) + rows.length;
  }
}

function mapCustomer(raw, business_id) {
  const c = raw || {};
  const addr = c.address || c.location || {};
  const name = pick(c, 'name', 'full_name')
    || `${pick(c, 'first_name') || ''} ${pick(c, 'last_name') || ''}`.trim()
    || 'Unknown';
  return {
    business_id,
    name,
    first_name: pick(c, 'first_name'),
    last_name: pick(c, 'last_name'),
    phone: digits(pick(c, 'phone', 'phone_number', 'mobile')),
    email: pick(c, 'email', 'email_address'),
    address_line1: pick(addr, 'line1', 'address', 'street', 'address_line1', 'street_address'),
    address_line2: pick(addr, 'line2', 'address_line2', 'unit', 'apt'),
    city: pick(addr, 'city'),
    state: pick(addr, 'state', 'region'),
    postal_code: pick(addr, 'postal_code', 'zip', 'zip_code'),
    notes: pick(c, 'notes', 'note', 'customer_notes'),
    stripe_customer_id: pick(c, 'stripe_customer_id'),
    zenbooker_customer_id: String(pick(c, 'id', 'customer_id') || ''),
    metadata: { raw: c },
  };
}

const STATUS_MAP = {
  scheduled: 'confirmed', confirmed: 'confirmed', assigned: 'assigned', booked: 'confirmed',
  in_progress: 'in_progress', en_route: 'on_the_way', on_the_way: 'on_the_way',
  completed: 'completed', finished: 'completed', complete: 'completed', done: 'completed',
  cancelled: 'cancelled', canceled: 'cancelled', no_show: 'no_show', noshow: 'no_show',
};

function mapPaymentStatus(job) {
  const inv = job.invoice || job.payment || {};
  const explicit = (pick(job, 'payment_status') || pick(inv, 'status', 'payment_status') || '').toLowerCase();
  if (['paid', 'refunded', 'void', 'unpaid'].includes(explicit)) return explicit;
  if (explicit === 'partial' || explicit === 'partially_paid') return 'deposit_paid';
  if (job.paid === true || inv.paid === true) return 'paid';
  const balance = Number(pick(inv, 'balance_due', 'balance', 'amount_due'));
  const total   = Number(pick(job, 'total', 'price', 'amount') || pick(inv, 'total', 'amount') || 0);
  if (!Number.isNaN(balance) && balance === 0 && total > 0) return 'paid';
  if (!Number.isNaN(balance) && balance > 0 && balance < total) return 'deposit_paid';
  return 'unpaid';
}

function mapBooking(job, business_id, customer_id, techByProvider, techByName, service_area_id, service_id) {
  const addr = job.address || job.location || {};
  const providers = job.assigned_providers || job.providers || job.team || [];
  const provider = providers[0] || {};
  const tech = techByProvider[pick(provider, 'id', 'provider_id')]
            || techByName[`${business_id}:${(pick(provider, 'name', 'display_name') || '').toLowerCase()}`]
            || null;
  const services = job.services || job.line_items || job.items || [];
  const rawStatus = (pick(job, 'status', 'state') || '').toLowerCase();
  const inv = job.invoice || job.payment || {};
  return {
    booking: {
      business_id, customer_id,
      technician_id: tech ? tech.id : null,
      service_id: service_id || null,
      service_area_id: service_area_id || null,
      status: STATUS_MAP[rawStatus] || 'completed',
      source: 'import',
      scheduled_at: pick(job, 'start_time', 'scheduled_at', 'starts_at', 'start', 'date', 'appointment_at'),
      subtotal: Number(pick(job, 'subtotal') || pick(inv, 'subtotal') || 0),
      discount: Number(pick(job, 'discount', 'discount_total') || pick(inv, 'discount') || 0),
      tip:      Number(pick(job, 'tip', 'tip_amount', 'gratuity') || pick(inv, 'tip') || 0),
      price:    Number(pick(job, 'total', 'price', 'amount', 'grand_total') || pick(inv, 'total', 'amount') || 0),
      payment_status: mapPaymentStatus(job),
      address_line1: pick(addr, 'line1', 'address', 'street', 'address_line1', 'street_address'),
      address_line2: pick(addr, 'line2', 'address_line2', 'unit', 'apt'),
      city: pick(addr, 'city'),
      state: pick(addr, 'state', 'region'),
      postal_code: pick(addr, 'postal_code', 'zip', 'zip_code'),
      notes: pick(job, 'notes', 'internal_notes', 'office_notes'),
      customer_notes: pick(job, 'customer_notes', 'instructions', 'special_instructions'),
      review_rating: pick(job, 'rating', 'review_rating') || pick(job.review || {}, 'rating', 'stars'),
      review_text: pick(job, 'review_text') || pick(job.review || {}, 'text', 'comment', 'body'),
      reviewed_at: pick(job.review || {}, 'created_at', 'reviewed_at'),
      completed_at: STATUS_MAP[rawStatus] === 'completed' ? pick(job, 'completed_at', 'finished_at', 'end_time') : null,
      cancelled_at: STATUS_MAP[rawStatus] === 'cancelled' ? pick(job, 'cancelled_at', 'canceled_at') : null,
      zenbooker_job_id: String(pick(job, 'id', 'job_id') || ''),
      zenbooker_job_number: pick(job, 'job_number', 'number') ? String(pick(job, 'job_number', 'number')) : null,
      metadata: {
        raw: job,
        invoice_number: pick(inv, 'number', 'invoice_number', 'id') || pick(job, 'invoice_number') || null,
        invoice_url: pick(inv, 'url', 'hosted_url', 'pdf_url') || null,
      },
    },
    lines: (Array.isArray(services) ? services : []).map(s => ({
      kind: 'service',
      name: pick(s, 'name', 'title', 'description') || 'Service',
      description: pick(s, 'description'),
      quantity: Number(pick(s, 'quantity', 'qty') || 1),
      unit_price: Number(pick(s, 'unit_price', 'price', 'amount', 'rate') || 0),
      line_total: Number(pick(s, 'total', 'line_total', 'amount', 'price') || 0),
      zenbooker_ref: pick(s, 'id', 'service_id', 'option_id') ? String(pick(s, 'id', 'service_id', 'option_id')) : null,
    })),
  };
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Simple security: require ?secret=IMPORT_SECRET env var
  const secret = process.env.IMPORT_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized. Pass ?secret=YOUR_IMPORT_SECRET' });
  }
  if (!secret) {
    return res.status(400).json({ error: 'IMPORT_SECRET env var not set. Add it to Vercel first.' });
  }

  const ZBK = process.env.ZENBOOKER_API_KEY;
  if (!ZBK) return res.status(400).json({ error: 'ZENBOOKER_API_KEY env var not set' });

  const CUTOFF = new Date('2026-06-19T23:59:59.999Z').getTime();

  try {
    const db = serviceClient();

    // Load Doms business
    const { data: biz } = await db.from('businesses').select('id, name').eq('slug', 'doms').single();
    if (!biz) return res.status(500).json({ error: 'Doms business not found in database' });
    const business_id = biz.id;

    // Load service area (Denver for Doms)
    const { data: area } = await db.from('service_areas')
      .select('id').eq('business_id', business_id).eq('name', 'Denver').maybeSingle();
    const service_area_id = area?.id || null;

    // Load default service
    const { data: svc } = await db.from('services')
      .select('id').eq('business_id', business_id).limit(1).maybeSingle();
    const service_id = svc?.id || null;

    // Load technicians for matching
    const { data: techs } = await db.from('technicians')
      .select('id, name, zenbooker_provider_id').eq('business_id', business_id);
    const techByProvider = {}, techByName = {};
    for (const t of techs || []) {
      if (t.zenbooker_provider_id) techByProvider[t.zenbooker_provider_id] = t;
      techByName[`${business_id}:${(t.name || '').toLowerCase()}`] = t;
    }

    const custCache = new Map();
    let custImported = 0, custFailed = 0;
    let jobImported = 0, jobSkipped = 0, jobFailed = 0;

    // ── Pass 1: All customers ────────────────────────────────────────────────
    for await (const raw of paginate('/v1/customers', ZBK)) {
      const cust = mapCustomer(raw, business_id);
      if (!cust.zenbooker_customer_id) continue;
      const key = `${business_id}:${cust.zenbooker_customer_id}`;
      try {
        const { data, error } = await db.from('customers')
          .upsert(cust, { onConflict: 'business_id,zenbooker_customer_id', ignoreDuplicates: false })
          .select('id').single();
        if (error) throw error;
        custCache.set(key, data.id);
        custImported++;
      } catch (e) {
        console.warn('[import] customer failed:', e.message);
        custFailed++;
      }
    }

    // ── Pass 2: All jobs up to cutoff ────────────────────────────────────────
    for await (const job of paginate('/v1/jobs?start_date_before=2026-06-19', ZBK)) {
      const schedRaw = pick(job, 'start_time', 'scheduled_at', 'starts_at', 'start', 'date', 'appointment_at');
      const schedMs = schedRaw ? new Date(schedRaw).getTime() : null;
      if (schedMs != null && !Number.isNaN(schedMs) && schedMs > CUTOFF) { jobSkipped++; continue; }

      // Resolve customer
      const embedded = job.customer || {};
      const zbkCustId = String(pick(embedded, 'id', 'customer_id') || pick(job, 'customer_id') || '');
      const cacheKey = `${business_id}:${zbkCustId}`;
      let customer_id = zbkCustId ? custCache.get(cacheKey) : null;

      if (!customer_id && zbkCustId) {
        // Try DB lookup (may have been imported in pass 1)
        const { data: found } = await db.from('customers').select('id')
          .eq('business_id', business_id).eq('zenbooker_customer_id', zbkCustId).maybeSingle();
        customer_id = found?.id || null;
        if (customer_id) custCache.set(cacheKey, customer_id);
      }

      if (!customer_id) {
        // Customer not yet in DB — upsert from embedded job data
        const cust = mapCustomer(embedded, business_id);
        if (!cust.zenbooker_customer_id) {
          // No id at all, try email fallback
          if (cust.email) {
            const { data: found } = await db.from('customers').select('id')
              .eq('business_id', business_id).eq('email', cust.email).maybeSingle();
            customer_id = found?.id || null;
          }
          if (!customer_id) {
            const { data } = await db.from('customers').insert(cust).select('id').single();
            customer_id = data?.id || null;
          }
        } else {
          const { data } = await db.from('customers')
            .upsert(cust, { onConflict: 'business_id,zenbooker_customer_id', ignoreDuplicates: false })
            .select('id').single();
          customer_id = data?.id || null;
          if (customer_id) custCache.set(cacheKey, customer_id);
        }
      }

      if (!customer_id) { jobFailed++; continue; }

      const { booking, lines } = mapBooking(job, business_id, customer_id, techByProvider, techByName, service_area_id, service_id);
      if (!booking.zenbooker_job_id) { jobSkipped++; continue; }

      try {
        const { data: bRow, error: bErr } = await db.from('bookings')
          .upsert(booking, { onConflict: 'business_id,zenbooker_job_id', ignoreDuplicates: false })
          .select('id').single();
        if (bErr) throw bErr;
        if (lines.length) {
          await db.from('booking_line_items').delete().eq('booking_id', bRow.id);
          await db.from('booking_line_items').insert(
            lines.map(l => ({ ...l, booking_id: bRow.id, business_id }))
          );
        }
        jobImported++;
      } catch (e) {
        console.warn('[import] job failed:', e.message);
        jobFailed++;
      }
    }

    return res.status(200).json({
      ok: true,
      business: 'doms',
      customers: { imported: custImported, failed: custFailed },
      jobs: { imported: jobImported, skipped: jobSkipped, failed: jobFailed },
      message: `Import complete. ${custImported} customers + ${jobImported} jobs imported into Doms CRM.`,
    });

  } catch (e) {
    console.error('[import-doms]', e);
    return res.status(500).json({ error: e.message });
  }
}
