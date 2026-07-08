// ============================================================================
// ZIP system scan — verifies the LIVE service-area lookup against the intended
// zip → tier table.
// ----------------------------------------------------------------------------
// The New Booking "What's the customer's ZIP Code?" card (and the public
// booking widgets) answer from the production service_area_zips table via
// /api/service-area. This script rebuilds the INTENDED table by parsing every
// zip-seed migration (0032 reseeded everything; later files override via
// ON CONFLICT DO UPDATE, so later files win), then probes the live endpoint
// for every (business, zip) pair and reports any answer that differs —
// missing zips, wrong travel fee, wrong metro — plus latency stats.
//
// Run in CI (GitHub Actions has open egress): node scripts/zip-scan.mjs
// Optional env: SCAN_BASE_URL (default https://handy-andy-booking.vercel.app)
// Exits non-zero if any mismatch is found, so the workflow run shows red.
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.SCAN_BASE_URL || 'https://handy-andy-booking.vercel.app';
const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const CONCURRENCY = 10;

// ── 1) Expected table from the migrations ────────────────────────────────────
// Only files from 0032 onward count: 0032 wiped and reseeded the whole table,
// so anything earlier (0031's placeholder list) never survives in production.
const files = readdirSync(MIG_DIR)
  .filter(f => /^\d{4}_.*\.sql$/.test(f) && parseInt(f.slice(0, 4), 10) >= 32)
  .sort();

const ROW_RE = /\(\s*'(handy-andy|doms)'\s*,\s*'([^']+)'\s*,\s*'(\d{5})'\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
const expected = new Map();   // "slug|zip" -> { slug, zip, area, surcharge, payout, src }
for (const f of files) {
  const sql = readFileSync(join(MIG_DIR, f), 'utf8');
  // Skip commented-out rows: strip SQL line comments before matching.
  const live = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  for (const m of live.matchAll(ROW_RE)) {
    const [, slug, area, zip, surcharge, payout] = m;
    expected.set(`${slug}|${zip}`, { slug, zip, area, surcharge: Number(surcharge), payout: Number(payout), src: f });
  }
}
const rows = [...expected.values()];
console.log(`Expected table: ${rows.length} (business, zip) pairs from ${files.length} migrations (0032+).`);
const byBiz = rows.reduce((a, r) => ((a[r.slug] = (a[r.slug] || 0) + 1), a), {});
console.log(`  ${Object.entries(byBiz).map(([k, v]) => `${k}: ${v}`).join(' · ')}\n`);

// ── 2) Probe the live endpoint ───────────────────────────────────────────────
async function probe(slug, zip) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/service-area`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zip, business: slug }),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json, ms: Date.now() - t0 };
}

const failures = [];
const latencies = [];
let done = 0;

async function checkRow(r) {
  let res;
  try { res = await probe(r.slug, r.zip); }
  catch (e) { res = null; }
  if (!res || res.status !== 200) {           // one retry on transient failure
    try { res = await probe(r.slug, r.zip); } catch (e) { res = { status: 0, json: {}, ms: 0 }; }
  }
  latencies.push(res.ms);
  const j = res.json || {};
  if (res.status !== 200) {
    failures.push(`${r.slug} ${r.zip}: HTTP ${res.status} (expected ${r.area} $${r.surcharge}) [${r.src}]`);
  } else if (!j.in_service_area) {
    failures.push(`${r.slug} ${r.zip}: NOT FOUND in production (expected ${r.area} $${r.surcharge}) [${r.src}]`);
  } else if ((Number(j.surcharge) || 0) !== r.surcharge) {
    failures.push(`${r.slug} ${r.zip}: fee $${Number(j.surcharge) || 0} ≠ expected $${r.surcharge} (${r.area}) [${r.src}]`);
  } else if (r.slug === 'handy-andy' && j.territory_name && j.territory_name !== r.area) {
    failures.push(`${r.slug} ${r.zip}: metro "${j.territory_name}" ≠ expected "${r.area}" [${r.src}]`);
  }
  done++;
  if (done % 100 === 0) console.log(`  …${done}/${rows.length} checked`);
}

// Simple concurrency pool.
const queue = [...rows];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await checkRow(queue.shift());
}));

// ── 3) Negative probes: unknown zips must cleanly report "not in area" ───────
for (const zip of ['99999', '10001', '60601']) {
  for (const slug of ['handy-andy', 'doms']) {
    const res = await probe(slug, zip).catch(() => null);
    if (!res || res.status !== 200 || res.json.in_service_area !== false) {
      failures.push(`${slug} ${zip}: expected a clean "not in service area" answer, got HTTP ${res?.status} ${JSON.stringify(res?.json)}`);
    }
  }
}

// ── 4) Report ────────────────────────────────────────────────────────────────
latencies.sort((a, b) => a - b);
const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1));
const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
console.log(`\nLatency: avg ${avg}ms · p95 ${p95}ms · max ${latencies[latencies.length - 1] || 0}ms over ${latencies.length} lookups`);

if (failures.length) {
  console.log(`\n✗ ${failures.length} MISMATCH(ES):\n`);
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
} else {
  console.log(`\n✓ All ${rows.length} zips answer correctly (metro + travel fee), and unknown zips correctly report "new area".`);
}
