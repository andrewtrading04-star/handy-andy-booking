#!/usr/bin/env node
/**
 * Zenbooker → Supabase importer.
 *
 * Pulls historical jobs (and the customers attached to them) out of Zenbooker
 * and upserts them into the new schema. Jobs are the source of truth because
 * each job carries the territory we use to decide which BUSINESS it belongs to.
 *
 * USAGE (Node 20.6+ for --env-file):
 *   node --env-file=.env scripts/import-zenbooker.js --since=2023-01-01 --dry-run
 *   node --env-file=.env scripts/import-zenbooker.js --since=2023-01-01
 *
 * Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZENBOOKER_API_KEY.
 *
 * NOTE: Zenbooker's exact field names vary by account. This script logs the
 * first raw job it sees (--dry-run) so you can confirm the mapping below before
 * a real run. The full raw record is also stored in bookings.metadata.raw so
 * nothing is lost and re-mapping later is possible without re-fetching.
 */
import { createClient } from '@supabase/supabase-js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const DRY = !!args['dry-run'];
const SINCE = args.since || '2023-01-01';
const UNTIL = args.until || new Date().toISOString().slice(0, 10);

const ZBK = process.env.ZENBOOKER_API_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ZBK || !SB_URL || !SB_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZENBOOKER_API_KEY');
  process.exit(1);
}
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const zbkGet = async (path) => {
  const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${ZBK}` } });
  if (!r.ok) throw new Error(`Zenbooker ${path} -> ${r.status}`);
  return r.json();
};

// ── Map territory_id -> { business_id, service_area_id } from the DB seed ────
async function loadMaps() {
  const { data: areas, error } = await db.from('service_areas')
    .select('id, business_id, zenbooker_territory_id');
  if (error) throw error;
  const terr = {};
  for (const a of areas) if (a.zenbooker_territory_id) terr[a.zenbooker_territory_id] = { business_id: a.business_id, service_area_id: a.id };

  const { data: techs } = await db.from('technicians').select('id, business_id, name, zenbooker_provider_id');
  const techByProvider = {}, techByName = {};
  for (const t of techs || []) {
    if (t.zenbooker_provider_id) techByProvider[t.zenbooker_provider_id] = t;
    techByName[`${t.business_id}:${(t.name || '').toLowerCase()}`] = t;
  }

  // default business = the only one, if a job has no recognizable territory
  const { data: biz } = await db.from('businesses').select('id, slug');
  return { terr, techByProvider, techByName, biz: biz || [] };
}

// ── Field mapping (adjust here after inspecting a --dry-run raw job) ─────────
function pick(obj, ...keys) { for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k]; return null; }

function mapCustomer(job, business_id) {
  const c = job.customer || {};
  const addr = job.address || c.address || {};
  const name = pick(c, 'name', 'full_name') || `${pick(c,'first_name')||''} ${pick(c,'last_name')||''}`.trim() || 'Unknown';
  return {
    business_id,
    name,
    first_name: pick(c, 'first_name'),
    last_name: pick(c, 'last_name'),
    phone: pick(c, 'phone', 'phone_number'),
    email: pick(c, 'email'),
    address_line1: pick(addr, 'line1', 'address', 'street'),
    address_line2: pick(addr, 'line2'),
    city: pick(addr, 'city'),
    state: pick(addr, 'state'),
    postal_code: pick(addr, 'postal_code', 'zip'),
    stripe_customer_id: pick(c, 'stripe_customer_id'),
    zenbooker_customer_id: pick(c, 'id', 'customer_id') || pick(job, 'customer_id'),
    metadata: { raw: c },
  };
}

const STATUS_MAP = {
  scheduled: 'confirmed', confirmed: 'confirmed', assigned: 'assigned',
  in_progress: 'in_progress', en_route: 'on_the_way', completed: 'completed',
  finished: 'completed', cancelled: 'cancelled', canceled: 'cancelled', no_show: 'no_show',
};

function mapBooking(job, ctx, customer_id) {
  const addr = job.address || {};
  const providers = job.assigned_providers || job.providers || [];
  const provider = providers[0] || {};
  let tech = ctx.techByProvider[pick(provider, 'id', 'provider_id')]
          || ctx.techByName[`${ctx.business_id}:${(pick(provider, 'name', 'display_name') || '').toLowerCase()}`]
          || null;

  const services = job.services || job.line_items || [];
  const rawStatus = (pick(job, 'status', 'state') || '').toLowerCase();

  return {
    booking: {
      business_id: ctx.business_id,
      customer_id,
      technician_id: tech ? tech.id : null,
      service_area_id: ctx.service_area_id || null,
      status: STATUS_MAP[rawStatus] || 'completed',
      source: 'import',
      scheduled_at: pick(job, 'start_time', 'scheduled_at', 'starts_at', 'date'),
      price: Number(pick(job, 'total', 'price', 'amount') || 0),
      address_line1: pick(addr, 'line1', 'address', 'street'),
      city: pick(addr, 'city'),
      state: pick(addr, 'state'),
      postal_code: pick(addr, 'postal_code', 'zip'),
      notes: pick(job, 'notes', 'internal_notes'),
      customer_notes: pick(job, 'customer_notes', 'instructions'),
      review_rating: pick(job, 'rating', 'review_rating') || pick(job.review || {}, 'rating'),
      review_text: pick(job, 'review_text') || pick(job.review || {}, 'text', 'comment'),
      reviewed_at: pick(job.review || {}, 'created_at'),
      zenbooker_job_id: String(pick(job, 'id', 'job_id') || ''),
      zenbooker_job_number: pick(job, 'job_number') ? String(job.job_number) : null,
      metadata: { raw: job },
    },
    lines: services.map(s => ({
      kind: 'service',
      name: pick(s, 'name', 'title') || 'Service',
      quantity: Number(pick(s, 'quantity') || 1),
      unit_price: Number(pick(s, 'price', 'amount') || 0),
      line_total: Number(pick(s, 'total', 'price', 'amount') || 0),
      zenbooker_ref: pick(s, 'id', 'service_id') ? String(pick(s, 'id', 'service_id')) : null,
    })),
  };
}

// ── Fetch every job in the date window (cursor pagination) ──────────────────
async function* allJobs() {
  let cursor = 0;
  for (let page = 0; page < 1000; page++) {
    const j = await zbkGet(`/v1/jobs?limit=50&cursor=${cursor}&start_date_after=${SINCE}&start_date_before=${UNTIL}`);
    const results = j.results || j.data || [];
    for (const job of results) yield job;
    if (results.length < 50) break;
    cursor = (j.cursor || 0) + results.length;
  }
}

async function main() {
  console.log(`Zenbooker import ${DRY ? '(DRY RUN)' : ''} — ${SINCE} → ${UNTIL}`);
  const maps = await loadMaps();
  const onlyBiz = maps.biz.length === 1 ? maps.biz[0].id : null;

  const custCache = new Map();      // `${biz}:${zbkCustomerId}` -> customer_id
  let jobs = 0, imported = 0, skipped = 0, firstLogged = false;

  for await (const job of allJobs()) {
    jobs++;
    const territory = pick(job, 'territory_id') || pick(job.territory || {}, 'id');
    const hit = maps.terr[territory];
    const business_id = hit ? hit.business_id : onlyBiz;
    const service_area_id = hit ? hit.service_area_id : null;
    if (!business_id) { skipped++; continue; }

    if (DRY && !firstLogged) { console.log('\n— First raw job (verify mapping) —\n', JSON.stringify(job, null, 2).slice(0, 2500), '\n'); firstLogged = true; }

    const ctx = { business_id, service_area_id, techByProvider: maps.techByProvider, techByName: maps.techByName };

    // upsert customer
    const cust = mapCustomer(job, business_id);
    const cacheKey = `${business_id}:${cust.zenbooker_customer_id}`;
    let customer_id = custCache.get(cacheKey);
    if (!customer_id) {
      if (DRY) { customer_id = 'dry'; }
      else {
        const { data, error } = await db.from('customers')
          .upsert(cust, { onConflict: 'business_id,zenbooker_customer_id', ignoreDuplicates: false })
          .select('id').single();
        if (error) { console.warn('customer upsert:', error.message); skipped++; continue; }
        customer_id = data.id;
      }
      custCache.set(cacheKey, customer_id);
    }

    const { booking, lines } = mapBooking(job, ctx, customer_id);
    if (!booking.zenbooker_job_id) { skipped++; continue; }

    if (DRY) { imported++; continue; }
    const { data: bRow, error: bErr } = await db.from('bookings')
      .upsert(booking, { onConflict: 'business_id,zenbooker_job_id', ignoreDuplicates: false })
      .select('id').single();
    if (bErr) { console.warn('booking upsert:', bErr.message); skipped++; continue; }

    if (lines.length) {
      await db.from('booking_line_items').delete().eq('booking_id', bRow.id);
      await db.from('booking_line_items').insert(lines.map(l => ({ ...l, booking_id: bRow.id, business_id })));
    }
    imported++;
    if (imported % 50 === 0) console.log(`  …${imported} imported`);
  }

  console.log(`\nDone. Scanned ${jobs} jobs · imported ${imported} · skipped ${skipped}.`);
  if (DRY) console.log('Dry run — nothing written. Re-run without --dry-run to import.');
}

main().catch(e => { console.error(e); process.exit(1); });
