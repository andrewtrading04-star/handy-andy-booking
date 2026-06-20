// Doms Zenbooker import — shared library (NOT a serverless function; files under
// /api/_lib are ignored by Vercel's function builder, so this does not count
// against the Hobby-plan 12-function limit). Triggered from api/migrate.js via
// ?action=import_doms&secret=IMPORT_SECRET&phase=customers|jobs[&cursor=...].
//
// RESUMABLE + STREAMING + BATCHED. Two earlier failure modes are handled here:
//   1. OOM (FUNCTION_INVOCATION_FAILED): a load-everything-then-write approach
//      blew past Hobby's 1 GB limit. Fixed by streaming one 100-record page at a
//      time — each page is mapped, written, and discarded before the next fetch,
//      so memory stays flat.
//   2. TIMEOUT (FUNCTION_INVOCATION_FAILED): 420+ customers + 1000+ jobs across
//      ~20 paginated fetches (each with several DB writes) cannot finish inside
//      the 60s Hobby budget. Fixed by `runDomsImportChunk`, which processes only
//      a handful of pages per HTTP request and returns a cursor. The driver page
//      (public/import-doms.html) calls it in a loop until done.
//
// Idempotent: upserts keyed on zenbooker_customer_id / zenbooker_job_id, so
// re-running any chunk (e.g. after a retry) is safe.

const PAGE = 100;
const DEFAULT_CUTOFF = new Date('2026-06-19T23:59:59.999Z').getTime();
// Pages handled per HTTP request. Small enough that one request stays well under
// the 60s Hobby limit even when Zenbooker / Supabase are slow.
const DEFAULT_MAX_PAGES = 3;

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

// Fetch ONE page given an opaque cursor token, and return the token for the next
// page. Token encodes the pagination strategy so resumption survives across HTTP
// requests:  "a:<id>" = id-based starting_after,  "n:<n>" = numeric cursor.
async function fetchPage(basePath, key, cursorToken) {
  const sep = basePath.includes('?') ? '&' : '?';
  let url = `${basePath}${sep}limit=${PAGE}`;
  let mode = null, val = null;
  if (cursorToken) {
    const i = cursorToken.indexOf(':');
    mode = cursorToken.slice(0, i);
    val = cursorToken.slice(i + 1);
    if (mode === 'a') url += `&starting_after=${encodeURIComponent(val)}`;
    else if (mode === 'n') url += `&cursor=${encodeURIComponent(val)}`;
  }
  const j = await zbkGet(url, key);
  const rows = Array.isArray(j) ? j : (j.data || j.results || []);
  if (!rows.length) return { rows: [], nextCursor: null, hasMore: false };

  const last = rows[rows.length - 1];
  const hasMore = Array.isArray(j)
    ? rows.length === PAGE
    : (j.has_more === true || (j.has_more === undefined && rows.length === PAGE));

  let nextCursor = null;
  if (last && last.id != null) nextCursor = `a:${String(last.id)}`;
  else {
    const base = (mode === 'n' && val != null) ? Number(val) : (j.cursor || 0);
    nextCursor = `n:${base + rows.length}`;
  }
  return { rows, nextCursor, hasMore };
}

// Yield Zenbooker results ONE PAGE AT A TIME (used by the full, non-chunked run).
async function* pages(basePath, key) {
  let cursor = null;
  for (let p = 0; p < 5000; p++) {
    const { rows, nextCursor, hasMore } = await fetchPage(basePath, key, cursor);
    if (!rows.length) return;
    yield rows;
    if (!hasMore) return;
    cursor = nextCursor;
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

// Resolve the Doms business id + the lookup tables a booking import needs.
async function resolveContext(db) {
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
  return { businessName: biz.name, business_id, service_area_id, service_id, techByProvider, techByName };
}

// Process ONE page of jobs: cutoff filter, ensure embedded customers exist, upsert
// bookings, then replace their line items. Mutates `result` counters and `cache`.
async function processJobsPage(db, ctx, page, cache, cutoffMs, result) {
  const { business_id, techByProvider, techByName, service_area_id, service_id } = ctx;

  // Cutoff filter (June 19 and earlier).
  const jobs = [];
  for (const j of page) {
    const ms = scheduledMs(j);
    if (ms != null && ms > cutoffMs) { result.jobs.skipped++; continue; }
    jobs.push(j);
  }
  if (!jobs.length) return;

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

  // Map jobs -> booking rows + remember line items.
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
  if (!bookingRows.length) return;

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
    return;
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

// Prime the customer-id cache from the DB (needed before importing jobs).
async function primeCustomerCache(db, business_id, cache) {
  const { data: existing } = await db.from('customers')
    .select('id, zenbooker_customer_id')
    .eq('business_id', business_id)
    .not('zenbooker_customer_id', 'is', null);
  for (const c of existing || []) cache.set(`${business_id}:${c.zenbooker_customer_id}`, c.id);
}

// ── RESUMABLE chunk: process up to `maxPages` pages of one phase, then return a
// cursor so the caller can continue. This is what the driver page loops on. ──────
export async function runDomsImportChunk(db, zbkKey, opts = {}) {
  const phase = opts.phase === 'jobs' ? 'jobs' : 'customers';
  const cursor = opts.cursor || null;
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages) || DEFAULT_MAX_PAGES, 20));
  const cutoffMs = opts.cutoffMs || DEFAULT_CUTOFF;

  const ctx = await resolveContext(db);
  const cache = new Map();
  if (phase === 'jobs') await primeCustomerCache(db, ctx.business_id, cache);

  const result = {
    business: ctx.businessName,
    customers: { imported: 0, failed: 0 },
    jobs: { imported: 0, skipped: 0, failed: 0 },
  };

  const basePath = phase === 'customers' ? '/v1/customers' : '/v1/jobs?start_date_before=2026-06-19';
  let nextCursor = cursor;
  let pagesProcessed = 0;
  let done = false;

  while (pagesProcessed < maxPages) {
    const { rows, nextCursor: nc, hasMore } = await fetchPage(basePath, zbkKey, nextCursor);
    if (!rows.length) { done = true; nextCursor = null; break; }
    if (phase === 'customers') {
      const mapped = rows.map(r => mapCustomer(r, ctx.business_id));
      const r = await upsertCustomerPage(db, ctx.business_id, mapped, cache);
      result.customers.imported += r.imported;
      result.customers.failed += r.failed;
    } else {
      await processJobsPage(db, ctx, rows, cache, cutoffMs, result);
    }
    pagesProcessed++;
    nextCursor = nc;
    if (!hasMore) { done = true; nextCursor = null; break; }
  }

  return {
    ok: true,
    phase,
    done,
    nextCursor: done ? null : nextCursor,
    pagesProcessed,
    counts: result,
    message: done
      ? `Phase "${phase}" complete.`
      : `Phase "${phase}" in progress — processed ${pagesProcessed} page(s), more remain.`,
  };
}

// ── DIAGNOSTIC: isolate which dependency is failing, returning readable JSON
// (never throwing) so a runtime 500 can't hide the real cause. ───────────────────
export async function domsDiag(db, zbkKey, which) {
  if (which === 'db') {
    try {
      const ctx = await resolveContext(db);
      const { count } = await db.from('customers')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', ctx.business_id);
      return {
        ok: true, step: 'db',
        business: ctx.businessName, business_id: ctx.business_id,
        service_area_id: ctx.service_area_id, service_id: ctx.service_id,
        existing_customers: count ?? null,
      };
    } catch (e) {
      return { ok: false, step: 'db', error: String((e && e.message) || e), stack: String((e && e.stack) || '') };
    }
  }
  if (which === 'zbk') {
    try {
      const { rows, nextCursor, hasMore } = await fetchPage('/v1/customers', zbkKey, null);
      return {
        ok: true, step: 'zbk',
        got: rows.length, hasMore, nextCursor,
        sampleKeys: rows[0] ? Object.keys(rows[0]) : [],
      };
    } catch (e) {
      return { ok: false, step: 'zbk', error: String((e && e.message) || e), stack: String((e && e.stack) || '') };
    }
  }
  return { ok: false, error: `unknown diag step: ${which}` };
}

// ── FULL run (single request): streams everything in one go. Fine for local/CLI
// use or small datasets, but can exceed the 60s serverless budget on large
// accounts — prefer runDomsImportChunk + the driver page for the server import. ──
export async function runDomsImport(db, zbkKey, opts = {}) {
  const phase = opts.phase || 'all';            // 'all' | 'customers' | 'jobs'
  const cutoffMs = opts.cutoffMs || DEFAULT_CUTOFF;

  const ctx = await resolveContext(db);
  const cache = new Map();
  const result = {
    business: ctx.businessName,
    customers: { imported: 0, failed: 0 },
    jobs: { imported: 0, skipped: 0, failed: 0 },
  };

  if (phase === 'all' || phase === 'customers') {
    for await (const page of pages('/v1/customers', zbkKey)) {
      const rows = page.map(r => mapCustomer(r, ctx.business_id));
      const r = await upsertCustomerPage(db, ctx.business_id, rows, cache);
      result.customers.imported += r.imported;
      result.customers.failed += r.failed;
    }
  }

  if (phase === 'all' || phase === 'jobs') {
    await primeCustomerCache(db, ctx.business_id, cache);
    for await (const page of pages('/v1/jobs?start_date_before=2026-06-19', zbkKey)) {
      await processJobsPage(db, ctx, page, cache, cutoffMs, result);
    }
  }

  result.ok = true;
  result.message = `Doms import complete — ${result.customers.imported} customers, ${result.jobs.imported} jobs.`;
  return result;
}
