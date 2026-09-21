// Phone desk scoreboard: how phone-booked jobs (source 'manual', keyed by the
// office) compare with booking-form jobs (source 'widget'), week by week, for
// Handy Andy and Dom's. Behind Analytics > Phone Desk (owner only, read-only).
//
// Why it exists: the owner's first "fix first" item is the phone desk. Phone
// sales, average phone ticket and add-on rate are the three numbers that show
// whether a change at the desk is working, and the open-estimate pile shows
// how much money is waiting on a follow-up.
//
// Definitions (same as the analytics audit):
//   sales   = price + tip of a non-cancelled job scheduled in the week
//   week    = Sunday-first, in America/Denver
//   TV job  = a job with a TV-size line item
//   add-on  = a line with money on it: bracket (tilt/full motion/fixed/flat),
//             in-wall wire hiding, soundbar
import { localDateStr, dayOfWeekFor, todayStr } from './availability.js';
import { addDaysStr } from './time.js';

const TZ = 'America/Denver';
const BRANDS = [{ slug: 'handy-andy', name: 'Handy Andy' }, { slug: 'doms', name: "Dom's" }];
const WEEKS = 12;
const BASE_FROM = '2026-06-29', BASE_TO = '2026-08-02';   // owner's "summer baseline"

const RE_SIZE = /\d{2}\s*["“”″–-]|\binch\b/i;
const RE_BRACKET = /tilt|full.?motion|fixed|flat/i;
const RE_OWN_BRACKET = /\bown\b|customer|in the box|comes with|bring/i;
const RE_INWALL = /behind the wall|in-?wall/i;
const RE_SOUNDBAR = /soundbar/i;

const sundayOf = (ds) => addDaysStr(ds, -dayOfWeekFor(ds));
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

function blank() { return { jobs: 0, sales: 0, tv_jobs: 0, bracket: 0, inwall: 0, soundbar: 0 }; }
function fin(a) {
  return {
    jobs: a.jobs, sales: Math.round(a.sales),
    avg_ticket: a.jobs ? Math.round(a.sales / a.jobs) : null,
    tv_jobs: a.tv_jobs,
    bracket_pct: rate(a.bracket, a.tv_jobs), inwall_pct: rate(a.inwall, a.tv_jobs), soundbar_pct: rate(a.soundbar, a.tv_jobs),
  };
}
function add(a, j) {
  a.jobs++; a.sales += j.sales;
  if (j.tv) { a.tv_jobs++; if (j.bracket) a.bracket++; if (j.inwall) a.inwall++; if (j.soundbar) a.soundbar++; }
}
function merge(list) { const a = blank(); for (const x of list) { a.jobs += x.jobs; a.sales += x.sales; a.tv_jobs += x.tv_jobs; a.bracket += x.bracket; a.inwall += x.inwall; a.soundbar += x.soundbar; } return a; }

// Money on the estimate = sum of qty * unit_price across its line items.
function quoteOf(est) {
  const li = Array.isArray(est.line_items) ? est.line_items : [];
  return li.reduce((s, x) => s + (Number(x.qty) || 1) * (Number(x.unit_price) || 0), 0);
}

export async function phoneDesk(db) {
  const { data: biz } = await db.from('businesses').select('id, slug').in('slug', BRANDS.map(b => b.slug));
  const idBySlug = new Map((biz || []).map(b => [b.slug, b.id]));
  const slugById = new Map((biz || []).map(b => [b.id, b.slug]));
  const bizIds = [...idBySlug.values()];
  if (!bizIds.length) return { generated_at: new Date().toISOString(), brands: [] };

  const today = todayStr(TZ);
  const thisSunday = sundayOf(today);
  const firstWeek = addDaysStr(thisSunday, -7 * WEEKS);
  const from = new Date(Date.parse((firstWeek < BASE_FROM ? firstWeek : BASE_FROM) + 'T00:00:00Z') - 86400000).toISOString();

  const { data: bks, error } = await db.from('bookings')
    .select('id, business_id, source, price, tip, scheduled_at')
    .in('business_id', bizIds).in('source', ['manual', 'widget'])
    .not('status', 'in', '(cancelled,no_show)').gt('price', 0)
    .gte('scheduled_at', from).lt('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true }).limit(5000);
  if (error) throw error;

  // Line items, in chunks so the URL stays short.
  const flags = new Map();
  const ids = (bks || []).map(b => b.id);
  for (let i = 0; i < ids.length; i += 150) {
    const { data: li, error: lErr } = await db.from('booking_line_items')
      .select('booking_id, name, line_total').in('booking_id', ids.slice(i, i + 150));
    if (lErr) throw lErr;
    for (const l of (li || [])) {
      const f = flags.get(l.booking_id) || { tv: false, bracket: false, inwall: false, soundbar: false };
      const name = String(l.name || ''), paid = Number(l.line_total) > 0;
      if (RE_SIZE.test(name)) f.tv = true;
      if (paid && RE_BRACKET.test(name) && !RE_OWN_BRACKET.test(name)) f.bracket = true;
      if (paid && RE_INWALL.test(name)) f.inwall = true;
      if (paid && RE_SOUNDBAR.test(name)) f.soundbar = true;
      flags.set(l.booking_id, f);
    }
  }

  // Bucket: brand -> channel -> weekStart -> accumulator; plus period accumulators.
  const acc = new Map();
  const get = (slug, ch) => { const k = slug + ':' + ch; if (!acc.has(k)) acc.set(k, { weeks: new Map(), base: blank(), all: blank() }); return acc.get(k); };
  for (const b of (bks || [])) {
    const slug = slugById.get(b.business_id); if (!slug) continue;
    const ch = b.source === 'manual' ? 'phone' : 'form';
    const date = localDateStr(TZ, b.scheduled_at);
    const f = flags.get(b.id) || {};
    const j = { sales: (Number(b.price) || 0) + (Number(b.tip) || 0), tv: !!f.tv, bracket: !!f.bracket, inwall: !!f.inwall, soundbar: !!f.soundbar };
    const bucket = get(slug, ch);
    const ws = sundayOf(date);
    if (!bucket.weeks.has(ws)) bucket.weeks.set(ws, blank());
    add(bucket.weeks.get(ws), j);
    if (date >= BASE_FROM && date <= BASE_TO) add(bucket.base, j);
  }

  // Open estimates, last 90 days.
  const { data: ests } = await db.from('estimates')
    .select('business_id, status, created_at, customer_email, customer_phone, line_items, approved_at, contacted_at')
    .in('business_id', bizIds).gte('created_at', new Date(Date.now() - 90 * 86400000).toISOString()).limit(2000);

  const brands = BRANDS.filter(b => idBySlug.has(b.slug)).map(b => {
    const mk = (ch) => {
      const a = get(b.slug, ch);
      const weeks = [];
      for (let w = -WEEKS; w <= 0; w++) {
        const start = addDaysStr(thisSunday, 7 * w);
        const x = a.weeks.get(start) || blank();
        weeks.push({ start, current: w === 0, ...fin(x) });
      }
      const done = weeks.filter(w => !w.current).slice(-4);
      const doneRaw = [];
      for (let w = -4; w <= -1; w++) doneRaw.push(a.weeks.get(addDaysStr(thisSunday, 7 * w)) || blank());
      const eight = [];
      for (let w = -8; w <= -1; w++) eight.push(a.weeks.get(addDaysStr(thisSunday, 7 * w)) || blank());
      const l4 = merge(doneRaw);
      return { weeks, baseline: fin(a.base), last4: { ...fin(l4), jobs_per_week: +(l4.jobs / 4).toFixed(1), sales_per_week: Math.round(l4.sales / 4) }, last8: fin(merge(eight)), _n: done.length };
    };
    const phone = mk('phone'), form = mk('form');
    const baseWeeks = 5;   // Jun 29 - Aug 2 is five Sunday-first weeks
    phone.baseline.jobs_per_week = +(phone.baseline.jobs / baseWeeks).toFixed(1);
    phone.baseline.sales_per_week = Math.round(phone.baseline.sales / baseWeeks);
    form.baseline.jobs_per_week = +(form.baseline.jobs / baseWeeks).toFixed(1);
    form.baseline.sales_per_week = Math.round(form.baseline.sales / baseWeeks);

    // estimates
    const mine = (ests || []).filter(e => slugById.get(e.business_id) === b.slug);
    const open = mine.filter(e => e.status === 'contacted' || e.status === 'new' || e.status === 'pending');
    const bucketsDef = [['0 to 3 days', 0, 3], ['4 to 14 days', 4, 14], ['15 to 30 days', 15, 30], ['Over 30 days', 31, 9999]];
    const buckets = bucketsDef.map(([label, lo, hi]) => {
      const list = open.filter(e => { const age = (Date.now() - Date.parse(e.created_at)) / 86400000; return age >= lo && age < hi + 1; });
      return { label, count: list.length, quoted: Math.round(list.reduce((s, e) => s + quoteOf(e), 0)),
        no_email: list.filter(e => !e.customer_email).length };
    });
    const scheduled = mine.filter(e => e.status === 'scheduled').length;
    return {
      slug: b.slug, name: b.name, phone, form,
      estimates: {
        total: mine.length, scheduled, close_pct: rate(scheduled, mine.length),
        open: open.length, open_quoted: Math.round(open.reduce((s, e) => s + quoteOf(e), 0)),
        buckets,
        archived_no_contact: mine.filter(e => e.status === 'archived' && !e.contacted_at).length,
        archived: mine.filter(e => e.status === 'archived').length,
      },
    };
  });

  return {
    generated_at: new Date().toISOString(),
    baseline: { from: BASE_FROM, to: BASE_TO },
    note: 'Phone = jobs entered by the office (Heather, Joey, Admin). Form = jobs booked on the website. Weeks are Sunday to Saturday, Denver time, counted by the day the work is scheduled. Add-on rates are the share of TV jobs with a paid bracket, in-wall wire hiding, or soundbar line.',
    brands,
  };
}
