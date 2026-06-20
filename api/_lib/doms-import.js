// Doms Zenbooker import — shared library (NOT a serverless function; files under
// /api/_lib are ignored by Vercel's function builder, so this does not count
// against the Hobby-plan 12-function limit). Triggered from api/migrate.js via
// ?action=import_doms&secret=IMPORT_SECRET[&phase=customers|jobs].
//
// Uses BATCHED upserts (chunks of 500) so the whole account imports in a handful
// of round-trips and finishes inside the function time limit. Idempotent: keyed
// on zenbooker_customer_id / zenbooker_job_id, so re-running is safe.

const PAGE = 100;
const CHUNK = 500;
const DEFAULT_CUTOFF = new Date('2026-06-19T23:59:59.999Z').getTime();

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
}
function digits(s) { return s == null ? null : String(s).replace(/[^\d]/g, '') || null; }
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

async function zbkGet(path, key) {
  const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Zenbooker ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchAll(basePath, key) {
  const sep = basePath.includes('?') ? '&' : '?';
  const all = [];
  let starting_after = null, numericCursor = 0;
  for (let page = 0; page < 5000; page++) {
    let url = `${basePath}${sep}limit=${PAGE}`;
    if (starting_after) url += `&starting_after=${encodeURIComponent(starting_after)}`;
    else if (numericCursor) url += `&cursor=${numericCursor}`;
    const j = await zbkGet(url, key);
    const rows = Array.isArray(j) ? j : (j.data || j.results || []);
    if (!rows.length) break;
    all.push(...rows);
    const hasMore = Array.isArray(j) ? rows.length === PAGE
                  : (j.has_more === true || (j.has_more === undefined && rows.length === PAGE));
    if (!hasMore) break;
    const last = rows[rows.length - 1];
    if (last?.id != null) starting_after = String(last.id);
    else numericCursor = (j.cursor || 0) + rows.length;
  }
  return all;
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

function scheduledMs(job) {
  const raw = pick(job, 'start_time', 'scheduled_at', 'starts_at', 'start', 'date', 'appointment_at');
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
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
  const mappedStatus = STATUS_MAP[rawStatus] || 'completed';
  return {
    booking: {
      business_id, customer_id,
      technician_id: tech ? tech.id : null,
      service_id: service_id || null,
      service_area_id: service_area_id || null,
      status: mappedStatus,
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
      completed_at: mappedStatus === 'completed' ? pick(job, 'completed_at', 'finished_at', 'end_time') : null,
      cancelled_at: mappedStatus === 'cancelled' ? pick(job, 'cancelled_at', 'canceled_at') : null,
      zenbooker_job_id: String(pick(job, 'id', 'job_id') || ''),
      zenbooker_job_number: pick(job, 'job_number', 'number') ? String(pick(job, 'job_number', 'number')) : null,
      metadata: {
        raw: job,
        invoice_number: pick(inv, 'number', 'invoice_number', 'id') || pick(job, 'invoice_number') || null,
        invoice_url: pick(inv, 'url', 'hosted_url', 'pdf_url') || null,
      },
    },
    rawLines: (Array.isArray(services) ? services : []).map(s => ({
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

// Batch-upsert customer rows (keyed on zbk id) and return a Map zbkId -> row id.
async function upsertCustomers(db, business_id, rows, cache) {
  let imported = 0, failed = 0;
  const withId = rows.filter(r => r.zenbooker_customer_id);
  for (const part of chunk(withId, CHUNK)) {
    try {
      const { data, error } = await db.from('customers')
        .upsert(part, { onConflict: 'business_id,zenbooker_customer_id', ignoreDuplicates: false })
        .select('id, zenbooker_customer_id');
      if (error) throw error;
      for (const r of data) cache.set(`${business_id}:${r.zenbooker_customer_id}`, r.id);
      imported += data.length;
    } catch (e) {
      console.warn('[import] customer chunk failed:', e.message);
      failed += part.length;
    }
  }
  return { imported, failed };
}

export async function runDomsImport(db, zbkKey, opts = {}) {
  const phase = opts.phase || 'all';            // 'all' | 'customers' | 'jobs'
  const cutoffMs = opts.cutoffMs || DEFAULT_CUTOFF;

  // Resolve Doms business + lookups.
  const { data: biz } = await db.from('businesses').select('id, name').eq('slug', 'doms').single();
  if (!biz) throw new Error('Doms business not found');
  const business_id = biz.id;

  const { data: area } = await db.from('service_areas')
    .select('id').eq('business_id', business_id).eq('name', 'Denver').maybeSingle();
  const service_area_id = area?.id || null;

  const { data: svc } = await db.from('services')
    .select('id').eq('business_id', business_id).limit(1).maybeSingle();
  const service_id = svc?.id || null;

  const { data: techs } = await db.from('technicians')
    .select('id, name, zenbooker_provider_id').eq('business_id', business_id);
  const techByProvider = {}, techByName = {};
  for (const t of techs || []) {
    if (t.zenbooker_provider_id) techByProvider[t.zenbooker_provider_id] = t;
    techByName[`${business_id}:${(t.name || '').toLowerCase()}`] = t;
  }

  const cache = new Map();   // `${business_id}:${zbkCustId}` -> customer row id
  const result = { business: biz.name, customers: { imported: 0, failed: 0 }, jobs: { imported: 0, skipped: 0, failed: 0 } };

  // ── Customers ──────────────────────────────────────────────────────────────
  if (phase === 'all' || phase === 'customers') {
    const raw = await fetchAll('/v1/customers', zbkKey);
    const rows = raw.map(r => mapCustomer(r, business_id));
    const r = await upsertCustomers(db, business_id, rows, cache);
    result.customers = r;
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────
  if (phase === 'all' || phase === 'jobs') {
    // If jobs run standalone, prime the cache from already-imported customers.
    if (phase === 'jobs') {
      const { data: existing } = await db.from('customers')
        .select('id, zenbooker_customer_id')
        .eq('business_id', business_id)
        .not('zenbooker_customer_id', 'is', null);
      for (const c of existing || []) cache.set(`${business_id}:${c.zenbooker_customer_id}`, c.id);
    }

    const rawJobs = await fetchAll('/v1/jobs?start_date_before=2026-06-19', zbkKey);
    const jobs = rawJobs.filter(j => {
      const ms = scheduledMs(j);
      if (ms != null && ms > cutoffMs) { result.jobs.skipped++; return false; }
      return true;
    });

    // Ensure every job's customer exists. Batch-upsert embedded customers we
    // haven't seen yet (covers customers that aren't in /v1/customers).
    const missing = [];
    const seenMissing = new Set();
    for (const job of jobs) {
      const emb = job.customer || {};
      const id = String(pick(emb, 'id', 'customer_id') || pick(job, 'customer_id') || '');
      if (id && !cache.has(`${business_id}:${id}`) && !seenMissing.has(id)) {
        seenMissing.add(id);
        missing.push(mapCustomer(emb, business_id));
      }
    }
    if (missing.length) {
      const r = await upsertCustomers(db, business_id, missing, cache);
      result.customers.imported += r.imported;
      result.customers.failed += r.failed;
    }

    // Map jobs -> booking rows + remember their raw line items.
    const bookingRows = [];
    const linesByJobId = new Map();
    for (const job of jobs) {
      const emb = job.customer || {};
      const custId = String(pick(emb, 'id', 'customer_id') || pick(job, 'customer_id') || '');
      let customer_id = custId ? cache.get(`${business_id}:${custId}`) : null;
      if (!customer_id) { result.jobs.failed++; continue; }
      const { booking, rawLines } = mapBooking(job, business_id, customer_id, techByProvider, techByName, service_area_id, service_id);
      if (!booking.zenbooker_job_id) { result.jobs.skipped++; continue; }
      bookingRows.push(booking);
      linesByJobId.set(booking.zenbooker_job_id, rawLines);
    }

    // Batch-upsert bookings, collecting their new ids.
    const jobIdToBookingId = new Map();
    for (const part of chunk(bookingRows, CHUNK)) {
      try {
        const { data, error } = await db.from('bookings')
          .upsert(part, { onConflict: 'business_id,zenbooker_job_id', ignoreDuplicates: false })
          .select('id, zenbooker_job_id');
        if (error) throw error;
        for (const b of data) jobIdToBookingId.set(b.zenbooker_job_id, b.id);
        result.jobs.imported += data.length;
      } catch (e) {
        console.warn('[import] booking chunk failed:', e.message);
        result.jobs.failed += part.length;
      }
    }

    // Replace line items for the imported bookings (batch delete + batch insert).
    const bookingIds = [...jobIdToBookingId.values()];
    for (const part of chunk(bookingIds, CHUNK)) {
      try { await db.from('booking_line_items').delete().in('booking_id', part); }
      catch (e) { console.warn('[import] line delete failed:', e.message); }
    }
    const allLines = [];
    for (const [jobId, lines] of linesByJobId) {
      const bId = jobIdToBookingId.get(jobId);
      if (!bId) continue;
      for (const l of lines) allLines.push({ ...l, booking_id: bId, business_id });
    }
    for (const part of chunk(allLines, CHUNK)) {
      try { await db.from('booking_line_items').insert(part); }
      catch (e) { console.warn('[import] line insert failed:', e.message); }
    }
  }

  result.ok = true;
  result.message = `Doms import complete — ${result.customers.imported} customers, ${result.jobs.imported} jobs.`;
  return result;
}
