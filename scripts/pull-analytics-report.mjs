#!/usr/bin/env node
// ============================================================================
// pull-analytics-report.mjs — generate 4 separated 30-day analytics documents
// ----------------------------------------------------------------------------
// Pulls the SAME live endpoints the admin dashboard reads (public + CORS) and
// writes four Markdown documents, one per (business × analytics type):
//   reports/doms-website-analytics-30d.md
//   reports/handy-andy-website-analytics-30d.md
//   reports/doms-booking-analytics-30d.md
//   reports/handy-andy-booking-analytics-30d.md
//
// Booking analytics  -> /api/analytics?days=N     (the "📊 Booking" tab)
// Website analytics  -> /api/analytics/* sub-APIs (the "🌐 Website" tab)
//
// Requires outbound HTTPS to the four backend hosts (see BOOKING/WEB below). In
// this repo's cloud sessions that needs the environment's network policy to
// allow them; locally or in an allow-all session it just works.
//
//   node scripts/pull-analytics-report.mjs [--days 30] [--out reports]
// ============================================================================

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const DAYS = parseInt(getArg('days', '30'), 10) || 30;
const OUT_DIR = getArg('out', 'reports');

const fs = await import('node:fs/promises');
const path = await import('node:path');

// ── Endpoints (mirror admin.html: ANA_ORIGIN + WEB_ANA_ORIGIN) ───────────────
const BOOKING = {
  doms:         { name: "Dom's TV Mounting", base: 'https://doms-tv-mounting.vercel.app/api/analytics', widget: null },
  'handy-andy': { name: 'Handy Andy',        base: 'https://handy-andy-booking.vercel.app/api/analytics', widget: 'handy-andy' },
};
const WEBSITE = {
  doms:         { name: "Dom's TV Mounting", base: 'https://doms-backend.vercel.app' },
  'handy-andy': { name: 'Handy Andy',        base: 'https://backend-beryl-seven-95.vercel.app' },
};

const nowIso = new Date().toISOString();
const fromIso = new Date(Date.now() - DAYS * 86400000).toISOString();

// ── Formatting helpers (mirror the dashboard's anaMoney / anaDur / webNum) ────
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const pct = (n) => (n == null ? '—' : n + '%');
function dur(s) {
  if (s == null) return '—';
  s = Math.round(Number(s) || 0);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60) return ss ? `${m}m ${ss}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
const shortPath = (u) => { try { const p = new URL(u); return (p.pathname + (p.search || '')) || '/'; } catch { return u || '/'; } };

async function getJson(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) { console.warn(`  ! ${r.status} ${url}`); return fallback; }
    return await r.json();
  } catch (e) { console.warn(`  ! ${e.message} ${url}`); return fallback; }
}

// ── Booking analytics document ───────────────────────────────────────────────
function bookingUrl(cfg) {
  const w = cfg.widget ? `widget=${encodeURIComponent(cfg.widget)}&` : '';
  return `${cfg.base}?${w}days=${DAYS}`;
}
function renderBooking(cfg, d) {
  const t = d.totals || {};
  const L = [];
  L.push(`# ${cfg.name} — Booking Analytics (Last ${DAYS} Days)`);
  L.push('');
  L.push(`_Generated ${nowIso} · source: \`${bookingUrl(cfg)}\`_`);
  if (d.error) { L.push(''); L.push(`> ⚠ endpoint returned an error: ${d.error}`); }
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Metric | Value | Detail |');
  L.push('| --- | --- | --- |');
  L.push(`| Sessions | ${num(t.sessions)} | ${num(t.visitors)} unique visitors |`);
  L.push(`| Bookings | ${num(t.bookings)} | ${t.bookingFailures > 0 ? `${t.bookingFailures} failed attempts` : 'no failed attempts'} |`);
  L.push(`| Conversion | ${pct(t.conversion)} | of all sessions |`);
  L.push(`| Revenue (booked) | ${money(t.revenue)} | avg ticket ${money(t.avgTicket)} |`);
  L.push(`| Saw a Price | ${num(t.priceShown)} | ${pct(t.priceToBooking)} then booked |`);
  L.push(`| Abandoned Carts | ${num(t.abandonedCarts)} | ${money(t.lostValue)} quoted, not booked |`);
  L.push(`| Median Time to Book | ${dur(t.medianTimeToBookSec)} | session length ${dur(t.medianSessionSec)} |`);
  L.push(`| Repeat Visitors | ${num(t.repeatVisitors)} | ${num(t.bookingsFromRepeat)} bookings from returners |`);
  L.push(`| Bounced | ${num(t.bounces)} | left on first step |`);
  L.push(`| ZIP Checks | ${num((t.zipServed || 0) + (t.zipUnserved || 0))} | ${num(t.zipUnserved)} outside service area |`);
  L.push('');

  // Funnel
  L.push('## Step-by-Step Funnel');
  L.push('');
  const funnel = d.funnel || [];
  const start = funnel[0]?.reached || 0;
  if (!start) { L.push('_No sessions in this period._'); }
  else {
    L.push('| Step | Reached | % of start | Dropped here |');
    L.push('| --- | ---: | ---: | ---: |');
    funnel.forEach(f => {
      const p = start ? Math.round(f.reached / start * 100) : 0;
      L.push(`| ${f.label} | ${num(f.reached)} | ${p}% | ${f.droppedHere > 0 ? '−' + f.droppedHere : '—'} |`);
    });
  }
  L.push('');

  // Segments
  const seg = (title, rows) => {
    if (!rows || !rows.length) return;
    L.push(`## ${title}`); L.push('');
    L.push('| ' + title + ' | Sessions | Bookings | Conv |');
    L.push('| --- | ---: | ---: | ---: |');
    rows.forEach(r => L.push(`| ${r.key} | ${num(r.sessions)} | ${num(r.bookings)} | ${pct(r.conv)} |`));
    L.push('');
  };
  seg('Traffic Source', d.bySource);
  seg('Device', d.byDevice);
  seg('Browser', d.byBrowser);
  seg('Top Cities', d.byCity);
  seg('Top ZIP Codes', d.byZip);

  // Turned-away ZIPs
  if (d.unservedZips && d.unservedZips.length) {
    L.push('## ZIPs We Turned Away'); L.push('');
    L.push('| ZIP | Times Checked |'); L.push('| --- | ---: |');
    d.unservedZips.forEach(r => L.push(`| ${r.zip} | ${num(r.count)} |`));
    L.push(''); L.push('_Demand from outside your service area — possible expansion targets._'); L.push('');
  }

  // Answers
  if (d.answers && d.answers.length) {
    L.push('## What People Choose on Each Question'); L.push('');
    d.answers.forEach(a => {
      L.push(`### ${a.question}`); L.push('');
      L.push('| Answer | Picked | Booked | Conv |'); L.push('| --- | ---: | ---: | ---: |');
      (a.options || []).forEach(o => L.push(`| ${o.answer} | ${num(o.picked)} | ${num(o.booked)} | ${pct(o.conv)} |`));
      L.push('');
    });
  }

  // Errors
  const byStep = (d.errors && d.errors.byStep) || {};
  const errRows = Object.entries(byStep).sort((a, b) => b[1] - a[1]);
  if (errRows.length) {
    L.push('## Errors by Step'); L.push('');
    L.push('| Step | Errors |'); L.push('| --- | ---: |');
    errRows.forEach(([k, v]) => L.push(`| ${k} | ${num(v)} |`));
    L.push('');
  }
  return L.join('\n') + '\n';
}

// ── Website analytics document ───────────────────────────────────────────────
async function fetchWebsite(cfg) {
  const qs = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(nowIso)}`;
  const get = (p, fb) => getJson(cfg.base + p + (p.includes('?') ? '&' : '?') + qs, fb);
  const [pv, clk, form, fun, scr, ses, top, dev, ref, bounce, exit] = await Promise.all([
    get('/api/analytics/page-views', { total: 0, events: [] }),
    get('/api/analytics/clicks', { total: 0, by_button: {} }),
    get('/api/analytics/form-interactions', { total: 0, by_field: {} }),
    get('/api/analytics/funnel', { funnel: [], total_sessions: 0 }),
    get('/api/analytics/scroll-depth', { total: 0, depth_distribution: {}, average_depth: 0 }),
    get('/api/analytics/sessions?limit=200', { total: 0, sessions: [] }),
    get('/api/analytics/top-pages', { total: 0, pages: [] }),
    get('/api/analytics/devices', {}),
    get('/api/analytics/referrers', { referrers: [] }),
    get('/api/analytics/pages-bounce', { pages_bounce: [] }),
    get('/api/analytics/exit-pages', { exit_pages: [] }),
  ]);
  return { pv, clk, form, fun, scr, ses, top, dev, ref, bounce, exit };
}
function renderWebsite(cfg, d) {
  const L = [];
  const sessions = d.fun.total_sessions || d.ses.total || 0;
  const funMap = {}; (d.fun.funnel || []).forEach(f => { funMap[f.step] = f; });
  const formStep = funMap['Form / Booking'] || funMap['Form/Booking'] || null;
  const formSessions = formStep ? formStep.sessions : 0;
  const conv = sessions ? Math.round(formSessions / sessions * 100) : 0;
  const pagesPer = sessions ? (d.pv.total / sessions).toFixed(1) : '—';

  L.push(`# ${cfg.name} — Website Analytics (Last ${DAYS} Days)`);
  L.push('');
  L.push(`_Generated ${nowIso} · source: \`${cfg.base}/api/analytics/*\` · window ${fromIso.slice(0, 10)} → ${nowIso.slice(0, 10)}_`);
  L.push('');
  L.push('## Summary');
  L.push('');
  L.push('| Metric | Value | Detail |');
  L.push('| --- | --- | --- |');
  L.push(`| Sessions | ${num(sessions)} | visitor sessions tracked |`);
  L.push(`| Page Views | ${num(d.pv.total)} | ${pagesPer} pages / session |`);
  L.push(`| Clicks | ${num(d.clk.total)} | button & link clicks |`);
  L.push(`| Form / Booking Starts | ${num(formSessions)} | ${conv}% of sessions |`);
  L.push(`| Avg Scroll Depth | ${(d.scr.average_depth ?? 0)}% | average page scroll |`);
  L.push('');

  // Funnel
  L.push('## Visitor Funnel — Page View → Click → Booking'); L.push('');
  const steps = d.fun.funnel || [];
  if (!steps.length || !sessions) { L.push('_No sessions in this period._'); }
  else {
    L.push('| Step | Sessions | % of sessions | Events |'); L.push('| --- | ---: | ---: | ---: |');
    steps.forEach(f => {
      const p = sessions ? Math.round(f.sessions / sessions * 100) : 0;
      L.push(`| ${f.step} | ${num(f.sessions)} | ${p}% | ${num(f.count)} |`);
    });
  }
  L.push('');

  // Device type
  const dev = d.dev || {};
  const devLabels = ['Mobile', 'Desktop', 'Tablet'], devCounts = [dev.mobile || 0, dev.desktop || 0, dev.tablet || 0];
  const devTotal = devCounts.reduce((s, c) => s + c, 0);
  if (devTotal) {
    L.push('## Device Type'); L.push('');
    L.push('| Device | Sessions | Share |'); L.push('| --- | ---: | ---: |');
    devLabels.forEach((l, i) => { if (devCounts[i] > 0) L.push(`| ${l} | ${num(devCounts[i])} | ${Math.round(devCounts[i] / devTotal * 100)}% |`); });
    L.push('');
  }

  // Scroll depth distribution
  const buckets = [0, 0, 0, 0];
  Object.entries(d.scr.depth_distribution || {}).forEach(([p, c]) => {
    const pp = Number(p), cc = Number(c) || 0;
    if (pp <= 25) buckets[0] += cc; else if (pp <= 50) buckets[1] += cc; else if (pp <= 75) buckets[2] += cc; else buckets[3] += cc;
  });
  if (buckets.some(b => b)) {
    L.push('## Scroll Depth Distribution'); L.push('');
    L.push('| Depth | Sessions |'); L.push('| --- | ---: |');
    ['0–25%', '26–50%', '51–75%', '76–100%'].forEach((lab, i) => L.push(`| ${lab} | ${num(buckets[i])} |`));
    L.push('');
  }

  // Top pages
  if (d.top.pages && d.top.pages.length) {
    L.push('## Top Pages'); L.push('');
    L.push('| Page | Views | Sessions |'); L.push('| --- | ---: | ---: |');
    d.top.pages.slice(0, 12).forEach(p => L.push(`| ${shortPath(p.url)} | ${num(p.views)} | ${num(p.unique_sessions)} |`));
    L.push('');
  }

  // Referrers
  if (d.ref.referrers && d.ref.referrers.length) {
    L.push('## Referrers / Traffic Sources'); L.push('');
    L.push('| Source | Visits | Sessions |'); L.push('| --- | ---: | ---: |');
    d.ref.referrers.slice(0, 12).forEach(r => L.push(`| ${r.name} | ${num(r.count)} | ${num(r.unique_sessions)} |`));
    L.push('');
  }

  // Most clicked
  const clkRows = Object.entries(d.clk.by_button || {}).map(([k, v]) => ({ k: (k || '').replace(/\s+/g, ' ').trim() || '(unnamed)', v })).sort((a, b) => b.v - a.v).slice(0, 15);
  if (clkRows.length) {
    L.push('## Most Clicked Buttons & Links'); L.push('');
    L.push('| Button / Link | Clicks |'); L.push('| --- | ---: |');
    clkRows.forEach(r => L.push(`| ${r.k.slice(0, 60)} | ${num(r.v)} |`));
    L.push('');
  }

  // Bounce
  if (d.bounce.pages_bounce && d.bounce.pages_bounce.length) {
    L.push('## Pages by Bounce Rate'); L.push('');
    L.push('| Page | Sessions | Bounce |'); L.push('| --- | ---: | ---: |');
    d.bounce.pages_bounce.slice(0, 12).forEach(r => L.push(`| ${shortPath(r.url)} | ${num(r.sessions)} | ${r.bounce_rate}% |`));
    L.push('');
  }

  // Exit pages
  if (d.exit.exit_pages && d.exit.exit_pages.length) {
    L.push('## Exit Pages'); L.push('');
    L.push('| Page | Exits |'); L.push('| --- | ---: |');
    d.exit.exit_pages.slice(0, 12).forEach(r => L.push(`| ${shortPath(r.url)} | ${num(r.exits)} |`));
    L.push('');
  }
  return L.join('\n') + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────────────
await fs.mkdir(OUT_DIR, { recursive: true });
const written = [];

for (const slug of ['doms', 'handy-andy']) {
  // Booking
  console.log(`\n▶ Booking analytics — ${BOOKING[slug].name}`);
  const bUrl = bookingUrl(BOOKING[slug]);
  const bData = await getJson(bUrl, { error: 'fetch failed', totals: {}, funnel: [] });
  const bMd = renderBooking(BOOKING[slug], bData);
  const bFile = path.join(OUT_DIR, `${slug}-booking-analytics-30d.md`);
  await fs.writeFile(bFile, bMd);
  written.push(bFile);
  const bt = bData.totals || {};
  console.log(`  sessions=${bt.sessions ?? '—'} bookings=${bt.bookings ?? '—'} conv=${bt.conversion ?? '—'}% revenue=${money(bt.revenue)}`);

  // Website
  console.log(`▶ Website analytics — ${WEBSITE[slug].name}`);
  const wData = await fetchWebsite(WEBSITE[slug]);
  const wMd = renderWebsite(WEBSITE[slug], wData);
  const wFile = path.join(OUT_DIR, `${slug}-website-analytics-30d.md`);
  await fs.writeFile(wFile, wMd);
  written.push(wFile);
  const ws = wData.fun.total_sessions || wData.ses.total || 0;
  console.log(`  sessions=${ws} pageViews=${wData.pv.total} clicks=${wData.clk.total}`);
}

console.log('\n✅ Wrote 4 documents:');
written.forEach(f => console.log('   ' + f));
