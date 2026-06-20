// Doms Zenbooker import — shared library (NOT a serverless function; files under
// /api/_lib are ignored by Vercel's function builder, so this does not count
// against the Hobby-plan 12-function limit). Triggered from api/migrate.js via
// ?action=import_doms&secret=IMPORT_SECRET[&phase=customers|jobs].
//
// STREAMING + BATCHED: each Zenbooker page (100 records) is mapped, written, and
// then discarded before the next page is fetched, so memory stays flat (the
// previous load-everything-then-write approach OOM'd on Hobby's 1 GB limit,
// crashing with FUNCTION_INVOCATION_FAILED). Idempotent: keyed on
// zenbooker_customer_id / zenbooker_job_id, so re-running is safe.

const PAGE = 100;
const DEFAULT_CUTOFF = new Date('2026-06-19T23:59:59.999Z').getTime();

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
}
function digits(s) { return s == null ? null : String(s).replace(/[^\d]/g, '') || null; }

async function zbkGet(path, key) {
  const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Zenbooker ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

// Yield Zenbooker results ONE PAGE AT A TIME (array of up to PAGE rows).
async function* pages(basePath, key) {
  const sep = basePath.includes('?') ? '&' : '?';
  let starting_after = null, numericCursor = 0;
  for (let p = 0; p < 5000; p++) {
    let url = `${basePath}${sep}limit=${PAGE}`;
    if (starting_after) url += `&starting_after=${encodeURIComponent(starting_after)}`;
    else if (numericCursor) url += `&cursor=${numericCursor}`;
    const j = await zbkGet(url, key);
    const rows = Array.isArray(j) ? j : (j.data || j.results || []);
    if (!rows.length) return;
    yield rows;
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

// Upsert a page of customer rows (keyed on zbk id); update cache with ids.
async function upsertCustomerPage(db, business_id, rows, cache) {
  const withId = rows.filter(r => r.zenbooker_customer_id);
  if (!withId.length) return { imported: 0, failed: 0 };
  try {
    const { data, error } = await db.from('customers')
      .upsert(withId, { onConflict: 'business_id,zenbooker_customer_id', ignoreDuplicates: false })
      .select('id, zenbooker_customer_id');
    if (error) throw error;
    for (const r of data) cache.set(`${business_id}:${r.zenbooker_customer_id}`, r.id);
    return { imported: data.length, failed: 0 };
  } catch (e) {
    console.warn('[import] customer page failed:', e.message);
    return { imported: 0, failed: withId.length };
  }
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

  // ── Customers (stream page-by-page) ──────────────────────────────────────────
  if (phase === 'all' || phase === 'customers') {
    for await (const page of pages('/v1/customers', zbkKey)) {
      const rows = page.map(r => mapCustomer(r, business_id));
      const r = await upsertCustomerPage(db, business_id, rows, cache);
      result.customers.imported += r.imported;
      result.customers.failed += r.failed;
    }
  }

  // ── Jobs (stream page-by-page) ───────────────────────────────────────────────
  if (phase === 'all' || phase === 'jobs') {
    // Prime the cache with already-imported customer ids (small: id + zbk id).
    const { data: existing } = await db.from('customers')
      .select('id, zenbooker_customer_id')
      .eq('business_id', business_id)
      .not('zenbooker_customer_id', 'is', null);
    for (const c of existing || []) cache.set(`${business_id}:${c.zenbooker_customer_id}`, c.id);

    for await (const page of pages('/v1/jobs?start_date_before=2026-06-19', zbkKey)) {
      // Cutoff filter.
      const jobs = [];
      for (const j of page) {
        const ms = scheduledMs(j);
        if (ms != null && ms > cutoffMs) { result.jobs.skipped++; continue; }
        jobs.push(j);
      }
      if (!jobs.length) continue;

      // Ensure each job's customer exists (upsert embedded ones we haven't seen).
      const missing = [];
      const seen = new Set();
      for (const job of jobs) {
        const emb = job.customer || {};
        const id = String(pick(emb, 'id', 'customer_id') || pick(job, 'customer_id') || '');
        if (id && !cache.has(`${business_id}:${id}`) && !seen.has(id)) {
          seen.add(id);
          missing.push(mapCustomer(emb, business_id));
        }
      }
      if (missing.length) {
        const r = await upsertCustomerPage(db, business_id, missing, cache);
        result.customers.imported += r.imported;
        result.customers.failed += r.failed;
      }

      // Map this page's jobs -> booking rows + remember line items.
      const bookingRows = [];
      const linesByJobId = new Map();
      for (const job of jobs) {
        const emb = job.customer || {};
        const custId = String(pick(emb, 'id', 'customer_id') || pick(job, 'customer_id') || '');
        const customer_id = custId ? cache.get(`${business_id}:${custId}`) : null;
        if (!customer_id) { result.jobs.failed++; continue; }
        const { booking, rawLines } = mapBooking(job, business_id, customer_id, techByProvider, techByName, service_area_id, service_id);
        if (!booking.zenbooker_job_id) { result.jobs.skipped++; continue; }
        bookingRows.push(booking);
        linesByJobId.set(booking.zenbooker_job_id, rawLines);
      }
      if (!bookingRows.length) continue;

      // Upsert this page's bookings, collect ids.
      let pageBookings = [];
      try {
        const { data, error } = await db.from('bookings')
          .upsert(bookingRows, { onConflict: 'business_id,zenbooker_job_id', ignoreDuplicates: false })
          .select('id, zenbooker_job_id');
        if (error) throw error;
        pageBookings = data;
        result.jobs.imported += data.length;
      } catch (e) {
        console.warn('[import] booking page failed:', e.message);
        result.jobs.failed += bookingRows.length;
        continue;
      }

      // Replace line items for this page's bookings.
      const ids = pageBookings.map(b => b.id);
      try { if (ids.length) await db.from('booking_line_items').delete().in('booking_id', ids); }
      catch (e) { console.warn('[import] line delete failed:', e.message); }

      const lineRows = [];
      for (const b of pageBookings) {
        const lines = linesByJobId.get(b.zenbooker_job_id) || [];
        for (const l of lines) lineRows.push({ ...l, booking_id: b.id, business_id });
      }
      if (lineRows.length) {
        try { await db.from('booking_line_items').insert(lineRows); }
        catch (e) { console.warn('[import] line insert failed:', e.message); }
      }
    }
  }

  result.ok = true;
  result.message = `Doms import complete — ${result.customers.imported} customers, ${result.jobs.imported} jobs.`;
  return result;
}
