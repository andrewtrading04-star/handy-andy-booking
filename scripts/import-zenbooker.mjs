#!/usr/bin/env node
/**
 * Zenbooker → Supabase importer (historical data migration).
 *
 * Pulls EVERYTHING Zenbooker has — customers, jobs, line items, invoices,
 * paid status, reviews — and upserts it into the new `app` schema. Designed to
 * be run repeatedly (idempotent upserts keyed on the zenbooker_* columns).
 *
 * WHY A FORCED BUSINESS:
 *   Each Zenbooker API key belongs to ONE business. Territory-based routing only
 *   works for accounts whose territories were seeded with a zenbooker_territory_id
 *   (Handy Andy). Doms has none, so for Doms you MUST pass --business=doms to
 *   route every record into the Doms silo.
 *
 * USAGE (Node 20.6+ for --env-file):
 *   # 1) DRY RUN FIRST — prints the real API shape so the mapping can be verified
 *   node --env-file=.env scripts/import-zenbooker.mjs --business=doms --until=2026-06-19 --dry-run
 *
 *   # 2) REAL IMPORT — everything dated on/before the cutoff
 *   node --env-file=.env scripts/import-zenbooker.mjs --business=doms --until=2026-06-19
 *
 * FLAGS:
 *   --business=<slug>   Force every record into this business (slug, e.g. doms). Recommended.
 *   --since=YYYY-MM-DD  Earliest job date to import        (default 2000-01-01 = all history)
 *   --until=YYYY-MM-DD  Latest job date to import, inclusive (default today; cutoff e.g. 2026-06-19)
 *   --dry-run           Fetch + map but write nothing. Dumps first raw customer & job.
 *   --customers-only    Import the customer list only (skip jobs).
 *   --jobs-only         Import jobs only (skip the standalone customer pass).
 *   --limit=N           Stop after N records of each type (smoke test).
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZENBOOKER_API_KEY.
 * Active/future jobs are EXCLUDED via --until (jobs scheduled after the cutoff
 * are skipped). The full raw record is always stored in metadata.raw so nothing
 * is lost and re-mapping later never needs a re-fetch.
 */
import { createClient } from '@supabase/supabase-js';

// ── args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const DRY            = !!args['dry-run'];
const SINCE          = args.since || '2000-01-01';
const UNTIL          = args.until || new Date().toISOString().slice(0, 10);
const FORCE_BIZ_SLUG = args.business || null;
const CUSTOMERS_ONLY = !!args['customers-only'];
const JOBS_ONLY      = !!args['jobs-only'];
const LIMIT          = args.limit ? Number(args.limit) : Infinity;
const UNTIL_MS       = new Date(`${UNTIL}T23:59:59.999Z`).getTime(); // inclusive of the cutoff day
const SINCE_MS       = new Date(`${SINCE}T00:00:00.000Z`).getTime();

const ZBK    = process.env.ZENBOOKER_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ZBK || !SB_URL || !SB_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZENBOOKER_API_KEY');
  process.exit(1);
}
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false }, db: { schema: 'app' } });

// ── Zenbooker HTTP ───────────────────────────────────────────────────────────
const zbkGet = async (path) => {
  const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${ZBK}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Zenbooker ${path} -> ${r.status} ${body.slice(0, 300)}`);
  }
  return r.json();
};

/**
 * Generic paginator that copes with the shapes Zenbooker may return:
 *   { data:[...], has_more:bool }          (Stripe-style cursor via starting_after=<id>)
 *   { results:[...], cursor:N }            (numeric cursor)
 *   [ ... ]                                (bare array, single page)
 * Defensive: caps pages and bails if a page makes no progress.
 */
async function* paginate(basePath, pageSize = 100) {
  const sep = basePath.includes('?') ? '&' : '?';
  let starting_after = null;
  let numericCursor = 0;
  let seen = 0;
  for (let page = 0; page < 5000; page++) {
    let url = `${basePath}${sep}limit=${pageSize}`;
    if (starting_after) url += `&starting_after=${encodeURIComponent(starting_after)}`;
    else if (numericCursor) url += `&cursor=${numericCursor}`;
    const j = await zbkGet(url);
    const rows = Array.isArray(j) ? j : (j.data || j.results || []);
    if (!rows.length) return;
    for (const row of rows) yield row;
    seen += rows.length;

    const last = rows[rows.length - 1];
    const hasMore = Array.isArray(j) ? rows.length === pageSize
                  : (j.has_more === true || (j.has_more === undefined && rows.length === pageSize));
    if (!hasMore) return;
    // advance the cursor: prefer Stripe-style id, fall back to numeric.
    if (last && last.id != null) starting_after = String(last.id);
    else numericCursor = (j.cursor || 0) + rows.length;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function pick(obj, ...keys) { for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k]; return null; }
function digits(s) { return s == null ? null : String(s).replace(/[^\d+]/g, '') || null; }

// ── Resolve target business + lookup maps from the DB seed ───────────────────
async function loadMaps() {
  const { data: biz, error: bErr } = await db.from('businesses').select('id, slug, name');
  if (bErr) throw bErr;

  let forcedBusiness = null;
  if (FORCE_BIZ_SLUG) {
    forcedBusiness = (biz || []).find(b => b.slug === FORCE_BIZ_SLUG);
    if (!forcedBusiness) throw new Error(`--business=${FORCE_BIZ_SLUG} not found. Known slugs: ${(biz||[]).map(b=>b.slug).join(', ')}`);
  }

  const { data: areas, error: aErr } = await db.from('service_areas')
    .select('id, business_id, name, zenbooker_territory_id');
  if (aErr) throw aErr;
  const terr = {};                 // zbk territory id -> { business_id, service_area_id }
  const areaByBizName = {};        // `${business_id}:denver` -> service_area_id
  for (const a of areas || []) {
    if (a.zenbooker_territory_id) terr[a.zenbooker_territory_id] = { business_id: a.business_id, service_area_id: a.id };
    areaByBizName[`${a.business_id}:${(a.name || '').toLowerCase()}`] = a.id;
  }

  const { data: techs } = await db.from('technicians').select('id, business_id, name, zenbooker_provider_id');
  const techByProvider = {}, techByName = {};
  for (const t of techs || []) {
    if (t.zenbooker_provider_id) techByProvider[t.zenbooker_provider_id] = t;
    techByName[`${t.business_id}:${(t.name || '').toLowerCase()}`] = t;
  }

  // Default service per business, so line-item-less jobs still link a service.
  const { data: svcs } = await db.from('services').select('id, business_id, name');
  const svcByBiz = {};
  for (const s of svcs || []) (svcByBiz[s.business_id] ||= []).push(s);

  return { biz: biz || [], forcedBusiness, terr, areaByBizName, techByProvider, techByName, svcByBiz };
}

// Decide which business + service area a job belongs to.
function routeJob(job, maps) {
  if (maps.forcedBusiness) {
    const business_id = maps.forcedBusiness.id;
    // Forced business: try to match a Denver-ish area by territory name, else first area.
    const territoryName = (pick(job.territory || {}, 'name') || pick(job, 'territory_name') || '').toLowerCase();
    let service_area_id = territoryName ? maps.areaByBizName[`${business_id}:${territoryName}`] : null;
    if (!service_area_id) service_area_id = maps.areaByBizName[`${business_id}:denver`] || null;
    return { business_id, service_area_id };
  }
  const territory = pick(job, 'territory_id') || pick(job.territory || {}, 'id');
  const hit = maps.terr[territory];
  if (hit) return hit;
  return { business_id: null, service_area_id: null };
}

// ── Field mapping (adjust after inspecting --dry-run raw records) ────────────
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
    phone: digits(pick(c, 'phone', 'phone_number', 'mobile', 'mobile_phone')),
    email: pick(c, 'email', 'email_address'),
    address_line1: pick(addr, 'line1', 'address', 'street', 'address_line1', 'street_address'),
    address_line2: pick(addr, 'line2', 'address_line2', 'unit', 'apt'),
    city: pick(addr, 'city'),
    state: pick(addr, 'state', 'region'),
    postal_code: pick(addr, 'postal_code', 'zip', 'zip_code', 'postcode'),
    notes: pick(c, 'notes', 'note', 'customer_notes'),
    stripe_customer_id: pick(c, 'stripe_customer_id'),
    zenbooker_customer_id: pick(c, 'id', 'customer_id'),
    metadata: { raw: c },
  };
}

const STATUS_MAP = {
  scheduled: 'confirmed', confirmed: 'confirmed', assigned: 'assigned', booked: 'confirmed',
  in_progress: 'in_progress', en_route: 'on_the_way', on_the_way: 'on_the_way',
  completed: 'completed', finished: 'completed', complete: 'completed', done: 'completed',
  cancelled: 'cancelled', canceled: 'cancelled', no_show: 'no_show', noshow: 'no_show',
};

// Best-effort paid status from whatever payment fields the job/invoice carries.
function mapPaymentStatus(job) {
  const inv = job.invoice || job.payment || {};
  const explicit = (pick(job, 'payment_status') || pick(inv, 'status', 'payment_status') || '').toLowerCase();
  if (['paid', 'refunded', 'void', 'unpaid'].includes(explicit)) return explicit;
  if (explicit === 'partial' || explicit === 'partially_paid') return 'deposit_paid';
  if (job.paid === true || inv.paid === true) return 'paid';
  const balance = Number(pick(inv, 'balance_due', 'balance', 'amount_due'));
  const total   = Number(pick(job, 'total', 'price', 'amount') || pick(inv, 'total', 'amount') || 0);
  if (!Number.isNaN(balance)) {
    if (balance === 0 && total > 0) return 'paid';
    if (balance > 0 && balance < total) return 'deposit_paid';
  }
  return 'unpaid';
}

function mapBooking(job, ctx, customer_id) {
  const addr = job.address || job.location || {};
  const providers = job.assigned_providers || job.providers || job.team || [];
  const provider = providers[0] || {};
  const tech = ctx.techByProvider[pick(provider, 'id', 'provider_id')]
            || ctx.techByName[`${ctx.business_id}:${(pick(provider, 'name', 'display_name') || '').toLowerCase()}`]
            || null;

  const services = job.services || job.line_items || job.items || [];
  const rawStatus = (pick(job, 'status', 'state') || '').toLowerCase();
  const inv = job.invoice || job.payment || {};

  return {
    booking: {
      business_id: ctx.business_id,
      customer_id,
      technician_id: tech ? tech.id : null,
      service_id: ctx.service_id || null,
      service_area_id: ctx.service_area_id || null,
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
      postal_code: pick(addr, 'postal_code', 'zip', 'zip_code', 'postcode'),
      notes: pick(job, 'notes', 'internal_notes', 'office_notes'),
      customer_notes: pick(job, 'customer_notes', 'instructions', 'special_instructions'),
      review_rating: pick(job, 'rating', 'review_rating') || pick(job.review || {}, 'rating', 'stars'),
      review_text: pick(job, 'review_text') || pick(job.review || {}, 'text', 'comment', 'body'),
      reviewed_at: pick(job.review || {}, 'created_at', 'reviewed_at'),
      completed_at: STATUS_MAP[rawStatus] === 'completed'
        ? pick(job, 'completed_at', 'finished_at', 'end_time') : null,
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

// ── Upserts ──────────────────────────────────────────────────────────────────
async function upsertCustomer(custRow) {
  if (!custRow.zenbooker_customer_id) {
    // No zbk id → can't dedupe on it; fall back to email match, else insert.
    if (custRow.email) {
      const { data: found } = await db.from('customers').select('id')
        .eq('business_id', custRow.business_id).eq('email', custRow.email).maybeSingle();
      if (found) return found.id;
    }
    const { data, error } = await db.from('customers').insert(custRow).select('id').single();
    if (error) throw error;
    return data.id;
  }
  custRow.zenbooker_customer_id = String(custRow.zenbooker_customer_id);
  const { data, error } = await db.from('customers')
    .upsert(custRow, { onConflict: 'business_id,zenbooker_customer_id', ignoreDuplicates: false })
    .select('id').single();
  if (error) throw error;
  return data.id;
}

// ── Pass 1: every customer in the account (incl. ones with no jobs) ──────────
async function importCustomers(maps, custCache) {
  if (!maps.forcedBusiness) {
    console.log('• Skipping standalone customer pass (no --business given; customers come in via jobs).');
    return { count: 0 };
  }
  const business_id = maps.forcedBusiness.id;
  let count = 0, firstLogged = false;
  console.log('• Pass 1/2 — customers …');
  for await (const raw of paginate('/v1/customers')) {
    if (count >= LIMIT) break;
    if (DRY && !firstLogged) {
      console.log('\n— First raw CUSTOMER (verify mapping) —\n', JSON.stringify(raw, null, 2).slice(0, 2000), '\n');
      firstLogged = true;
    }
    const cust = mapCustomer(raw, business_id);
    const key = `${business_id}:${cust.zenbooker_customer_id}`;
    if (DRY) { custCache.set(key, 'dry'); count++; continue; }
    try {
      const id = await upsertCustomer(cust);
      if (cust.zenbooker_customer_id) custCache.set(key, id);
      count++;
      if (count % 100 === 0) console.log(`    …${count} customers`);
    } catch (e) { console.warn('  customer upsert:', e.message); }
  }
  console.log(`  customers imported: ${count}`);
  return { count };
}

// ── Pass 2: jobs in the date window (+ any customer embedded on the job) ─────
async function importJobs(maps, custCache) {
  let scanned = 0, imported = 0, skippedFuture = 0, skippedNoBiz = 0, skippedTerminal = 0, firstLogged = false;
  console.log(`• Pass 2/2 — jobs ${SINCE} → ${UNTIL} (inclusive) …`);
  const base = `/v1/jobs?start_date_after=${SINCE}&start_date_before=${UNTIL}`;
  for await (const job of paginate(base)) {
    if (imported >= LIMIT) break;
    scanned++;

    const route = routeJob(job, maps);
    if (!route.business_id) { skippedNoBiz++; continue; }

    // Hard date guard (don't trust the API's date filter): exclude future/active.
    const schedRaw = pick(job, 'start_time', 'scheduled_at', 'starts_at', 'start', 'date', 'appointment_at');
    const schedMs = schedRaw ? new Date(schedRaw).getTime() : null;
    if (schedMs != null && !Number.isNaN(schedMs)) {
      if (schedMs > UNTIL_MS) { skippedFuture++; continue; }
      if (schedMs < SINCE_MS) { continue; }
    }

    if (DRY && !firstLogged) {
      console.log('\n— First raw JOB (verify mapping) —\n', JSON.stringify(job, null, 2).slice(0, 3000), '\n');
      firstLogged = true;
    }

    // Resolve / create the customer this job belongs to.
    const embedded = job.customer || {};
    const zbkCustId = pick(embedded, 'id', 'customer_id') || pick(job, 'customer_id');
    const cacheKey = `${route.business_id}:${zbkCustId}`;
    let customer_id = zbkCustId ? custCache.get(cacheKey) : null;
    if (!customer_id) {
      const cust = mapCustomer(embedded, route.business_id);
      if (DRY) customer_id = 'dry';
      else {
        try { customer_id = await upsertCustomer(cust); }
        catch (e) { console.warn('  job-customer upsert:', e.message); continue; }
      }
      if (zbkCustId) custCache.set(cacheKey, customer_id);
    }

    // Pick a default service for the business (first one) to satisfy linkage.
    const svc = (maps.svcByBiz[route.business_id] || [])[0] || null;
    const ctx = { ...route, service_id: svc?.id || null, techByProvider: maps.techByProvider, techByName: maps.techByName };

    const { booking, lines } = mapBooking(job, ctx, customer_id);
    if (!booking.zenbooker_job_id) { continue; }
    if (DRY) { imported++; continue; }

    // Never let a reconcile run move a booking BACKWARD. The CRM is the source of
    // truth for completion; the live Zenbooker job status lags (a CRM-only
    // complete never syncs back). Re-importing would downgrade status, null
    // completed_at, revert payment_status (dropping it from the profit boxes),
    // and replace metadata (wiping metadata.review_email_sent_at → a duplicate
    // review email). Leave any CRM-terminal booking untouched.
    try {
      const { data: prev } = await db.from('bookings')
        .select('id, status, completed_at')
        .eq('business_id', route.business_id)
        .eq('zenbooker_job_id', booking.zenbooker_job_id)
        .maybeSingle();
      if (prev && (['completed', 'cancelled', 'no_show'].includes(prev.status) || prev.completed_at)) {
        skippedTerminal++;
        continue;
      }
    } catch (e) { /* best-effort: fall through to the normal upsert */ }

    try {
      const { data: bRow, error: bErr } = await db.from('bookings')
        .upsert(booking, { onConflict: 'business_id,zenbooker_job_id', ignoreDuplicates: false })
        .select('id').single();
      if (bErr) throw bErr;
      if (lines.length) {
        await db.from('booking_line_items').delete().eq('booking_id', bRow.id);
        await db.from('booking_line_items').insert(lines.map(l => ({ ...l, booking_id: bRow.id, business_id: route.business_id })));
      }
      imported++;
      if (imported % 50 === 0) console.log(`    …${imported} jobs`);
    } catch (e) { console.warn('  booking upsert:', e.message); }
  }
  console.log(`  jobs imported: ${imported} (scanned ${scanned}, skipped future ${skippedFuture}, no-business ${skippedNoBiz}, kept-CRM-complete ${skippedTerminal})`);
  return { scanned, imported, skippedFuture, skippedNoBiz, skippedTerminal };
}

async function main() {
  console.log(`Zenbooker import ${DRY ? '(DRY RUN — nothing written)' : ''}`);
  console.log(`  business: ${FORCE_BIZ_SLUG || '(territory-routed)'} · window: ${SINCE} → ${UNTIL} · limit: ${LIMIT}`);
  const maps = await loadMaps();
  if (maps.forcedBusiness) console.log(`  → routing ALL records into "${maps.forcedBusiness.name}" (${maps.forcedBusiness.id})`);

  const custCache = new Map();
  let cust = { count: 0 }, jobs = { imported: 0 };
  if (!JOBS_ONLY)      cust = await importCustomers(maps, custCache);
  if (!CUSTOMERS_ONLY) jobs = await importJobs(maps, custCache);

  console.log(`\nDone. customers: ${cust.count} · jobs: ${jobs.imported}`);
  if (DRY) console.log('Dry run — verify the raw shapes above, then re-run without --dry-run.');
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
