import { createClient } from '@supabase/supabase-js';

const WIDGET = 'handy-andy';
const TZ = 'America/Denver';
const STEPS = [
  { key: 'zip',       label: 'ZIP Check' },
  { key: 'frame_tv',  label: 'TV Type' },
  { key: 'size',      label: 'TV Size' },
  { key: 'bracket',   label: 'Bracket' },
  { key: 'fireplace', label: 'Fireplace' },
  { key: 'surface',   label: 'Wall Surface' },
  { key: 'wires',     label: 'Wire Hiding' },
  { key: 'lifting',   label: 'Lifting Help' },
  { key: 'dismount',  label: 'Dismount Offer' },
  { key: 'extras',    label: 'Add-ons' },
  { key: 'terms',     label: 'Terms' },
  { key: 'slots',     label: 'Date & Time' },
  { key: 'customer',  label: 'Checkout' },
];
// Legacy event step names that map onto a canonical step key
const STEP_ALIAS = { zip_verify: 'zip' };

const STEP_INDEX = {};
STEPS.forEach((s, i) => { STEP_INDEX[s.key] = i; });
function stepIndexOf(name) {
  if (!name) return -1;
  const k = STEP_ALIAS[name] || name;
  return STEP_INDEX[k] ?? -1;
}

function parseBrowser(ua) {
  if (!ua) return 'unknown';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'other';
}

function tzHour(ts) {
  return Number(new Date(ts).toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24;
}
function tzDow(ts) {
  return new Date(ts).toLocaleString('en-US', { timeZone: TZ, weekday: 'short' });
}
function tzDate(ts) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ });
}
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function round1(n) { return Math.round(n * 10) / 10; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: 'Missing Supabase credentials' });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // 'from' ISO param takes priority (used for Denver-midnight "Today"); else fall back to rolling 'days'.
    const sinceISO = req.query.from
      ? new Date(req.query.from).toISOString()
      : (() => { const d = Math.max(0, parseInt(req.query.days ?? '30', 10) || 0); return d > 0 ? new Date(Date.now() - d * 86400000).toISOString() : null; })();

    // Pull all events in the range — Supabase caps responses at 1000 rows, so paginate
    const events = [];
    for (let page = 0; page < 30; page++) {
      let q = supabase.from('events').select('*').eq('widget', WIDGET)
        .order('created_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (sinceISO) q = q.gte('created_at', sinceISO);
      const { data, error } = await q;
      if (error) throw error;
      events.push(...data);
      if (data.length < 1000) break;
    }

    // ── Group events into sessions ──────────────────────────────────────────
    const sessions = new Map();
    let zipServed = 0, zipUnserved = 0;
    const unservedZips = {};

    for (const e of events) {
      let s = sessions.get(e.session_id);
      if (!s) {
        s = {
          id: e.session_id,
          visitor: e.session_id.includes('.') ? e.session_id.split('.')[0] : e.session_id,
          firstTs: null, lastTs: null,
          device: null, source: null, browser: null,
          city: null, state: null, zip: null,
          maxStep: -1, booked: false, bookedValue: null, bookedTs: null,
          priceShown: false, lastPrice: null,
          answers: [], errors: [], failed: false, eventCount: 0,
        };
        sessions.set(e.session_id, s);
      }
      const ts = new Date(e.created_at).getTime();
      if (s.firstTs === null || ts < s.firstTs) s.firstTs = ts;
      if (s.lastTs === null || ts > s.lastTs) s.lastTs = ts;
      s.eventCount++;
      if (!s.device && e.device_type) s.device = e.device_type;
      if (!s.source && e.traffic_source) s.source = e.traffic_source;
      if (!s.browser && e.browser) s.browser = parseBrowser(e.browser);
      if (e.city) s.city = e.city;
      if (e.state) s.state = e.state;
      if (e.zip_code) s.zip = e.zip_code;

      const t = e.event_type;
      if (t === 'step_view' || t === 'page_view') {
        const i = stepIndexOf(e.step_name);
        if (i > s.maxStep) s.maxStep = i;
      } else if (t === 'price_displayed') {
        s.priceShown = true;
        const v = Number(e.value);
        if (!isNaN(v) && v > 0) s.lastPrice = v;
        if (STEP_INDEX.customer > s.maxStep) s.maxStep = STEP_INDEX.customer;
      } else if (t === 'booking_confirmed') {
        s.booked = true;
        s.bookedTs = ts;
        const v = Number(e.value);
        if (!isNaN(v) && v > 0) s.bookedValue = v;
        if (STEP_INDEX.customer > s.maxStep) s.maxStep = STEP_INDEX.customer;
      } else if (t === 'answer' && e.step_name) {
        s.answers.push(e.step_name);
      } else if (t === 'booking_failed' || t === 'error' || t === 'form_error') {
        s.errors.push({ type: t, step: e.step_name, message: e.error_message, at: e.created_at });
        if (t === 'booking_failed') s.failed = true;
      } else if (t === 'zip_check') {
        if (e.step_name === 'served') zipServed++;
        else if (e.step_name === 'unserved') {
          zipUnserved++;
          const z = e.error_message || e.zip_code;
          if (z) unservedZips[z] = (unservedZips[z] || 0) + 1;
        }
      }
    }

    const sess = [...sessions.values()];
    const totalSessions = sess.length;
    const bookings = sess.filter(s => s.booked);
    const revenue = bookings.reduce((n, s) => n + (s.bookedValue || 0), 0);

    // ── Funnel with drop-off ────────────────────────────────────────────────
    const funnel = STEPS.map((st, i) => {
      const reached = sess.filter(s => s.maxStep >= i).length;
      const droppedHere = sess.filter(s => s.maxStep === i && !s.booked).length;
      return { key: st.key, label: st.label, reached, droppedHere };
    });

    // ── Breakdowns with per-segment conversion ──────────────────────────────
    function breakdown(keyFn, limit) {
      const m = {};
      for (const s of sess) {
        const k = keyFn(s) || 'unknown';
        if (!m[k]) m[k] = { sessions: 0, bookings: 0, revenue: 0 };
        m[k].sessions++;
        if (s.booked) { m[k].bookings++; m[k].revenue += s.bookedValue || 0; }
      }
      let rows = Object.entries(m).map(([k, v]) => ({
        key: k, ...v,
        conv: v.sessions ? round1(v.bookings / v.sessions * 100) : 0,
        revenue: Math.round(v.revenue * 100) / 100,
      })).sort((a, b) => b.sessions - a.sessions);
      if (limit) rows = rows.slice(0, limit);
      return rows;
    }
    const byDevice = breakdown(s => s.device);
    const bySource = breakdown(s => s.source, 12);
    const byBrowser = breakdown(s => s.browser, 8);
    const byCity = breakdown(s => s.city, 12);
    const byState = breakdown(s => s.state, 8);
    const byZip = breakdown(s => s.zip, 15);

    // ── Time patterns (Mountain Time) ───────────────────────────────────────
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, sessions: 0, bookings: 0 }));
    const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const byDow = DOWS.map(d => ({ day: d, sessions: 0, bookings: 0 }));
    const byDate = {};
    for (const s of sess) {
      if (s.firstTs === null) continue;
      byHour[tzHour(s.firstTs)].sessions++;
      const dw = byDow.find(x => x.day === tzDow(s.firstTs));
      if (dw) dw.sessions++;
      const ds = tzDate(s.firstTs);
      if (!byDate[ds]) byDate[ds] = { date: ds, sessions: 0, bookings: 0 };
      byDate[ds].sessions++;
      if (s.booked && s.bookedTs) {
        byHour[tzHour(s.bookedTs)].bookings++;
        const bw = byDow.find(x => x.day === tzDow(s.bookedTs));
        if (bw) bw.bookings++;
        const bds = tzDate(s.bookedTs);
        if (!byDate[bds]) byDate[bds] = { date: bds, sessions: 0, bookings: 0 };
        byDate[bds].bookings++;
      }
    }
    const timeline = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));

    // ── Session timing ──────────────────────────────────────────────────────
    const durations = sess
      .filter(s => s.eventCount > 1 && s.lastTs > s.firstTs)
      .map(s => Math.min((s.lastTs - s.firstTs) / 1000, 7200));
    const timesToBook = bookings
      .filter(s => s.bookedTs && s.bookedTs > s.firstTs)
      .map(s => Math.min((s.bookedTs - s.firstTs) / 1000, 7200));

    // ── Repeat visitors ─────────────────────────────────────────────────────
    const byVisitor = {};
    for (const s of sess) (byVisitor[s.visitor] = byVisitor[s.visitor] || []).push(s);
    const visitors = Object.keys(byVisitor).length;
    const repeatVisitorSessions = Object.values(byVisitor).filter(a => a.length > 1);
    const repeatVisitors = repeatVisitorSessions.length;
    const bookingsFromRepeat = repeatVisitorSessions.reduce((n, a) => n + a.filter(s => s.booked).length, 0);

    // ── Answers: what people picked on each question + conversion per answer ─
    const answersMap = {};
    for (const s of sess) {
      for (const a of new Set(s.answers)) {
        const ci = a.indexOf(':');
        if (ci < 1) continue;
        const q = a.slice(0, ci), ans = a.slice(ci + 1);
        if (!ans) continue;
        if (!answersMap[q]) answersMap[q] = {};
        if (!answersMap[q][ans]) answersMap[q][ans] = { picked: 0, booked: 0 };
        answersMap[q][ans].picked++;
        if (s.booked) answersMap[q][ans].booked++;
      }
    }
    const answers = Object.entries(answersMap).map(([question, opts]) => ({
      question,
      options: Object.entries(opts).map(([answer, v]) => ({
        answer, ...v,
        conv: v.picked ? round1(v.booked / v.picked * 100) : 0,
      })).sort((a, b) => b.picked - a.picked).slice(0, 20),
    }));

    // ── Errors ──────────────────────────────────────────────────────────────
    const allErrors = sess.flatMap(s => s.errors.map(e => ({ ...e, session: s.id })));
    allErrors.sort((a, b) => new Date(b.at) - new Date(a.at));
    const errorsByStep = {};
    for (const e of allErrors) {
      const k = e.step || 'unknown';
      errorsByStep[k] = (errorsByStep[k] || 0) + 1;
    }
    const failedNeverBooked = sess.filter(s => s.failed && !s.booked).length;

    // ── Abandoned carts (saw a price, never booked) ─────────────────────────
    const abandoned = sess.filter(s => s.priceShown && !s.booked);
    const lostValue = abandoned.reduce((n, s) => n + (s.lastPrice || 0), 0);

    // ── Recent sessions feed ────────────────────────────────────────────────
    const recentSessions = [...sess]
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 30)
      .map(s => ({
        when: new Date(s.lastTs).toISOString(),
        device: s.device, source: s.source, browser: s.browser,
        city: s.city, zip: s.zip,
        furthest: s.booked ? 'Booked' : (STEPS[s.maxStep]?.label || '—'),
        booked: s.booked,
        value: s.booked ? s.bookedValue : s.lastPrice,
        durationSec: s.lastTs > s.firstTs ? Math.round((s.lastTs - s.firstTs) / 1000) : 0,
        isRepeat: (byVisitor[s.visitor] || []).length > 1,
        hadError: s.errors.length > 0,
      }));

    res.json({
      widget: WIDGET,
      rangeDays: days,
      timezone: TZ,
      lastUpdated: new Date().toISOString(),
      totals: {
        sessions: totalSessions,
        visitors,
        repeatVisitors,
        bookings: bookings.length,
        bookingsFromRepeat,
        conversion: totalSessions ? round1(bookings.length / totalSessions * 100) : 0,
        priceShown: sess.filter(s => s.priceShown).length,
        priceToBooking: sess.filter(s => s.priceShown).length
          ? round1(bookings.length / sess.filter(s => s.priceShown).length * 100) : 0,
        revenue: Math.round(revenue * 100) / 100,
        avgTicket: bookings.length ? Math.round(revenue / bookings.length * 100) / 100 : 0,
        abandonedCarts: abandoned.length,
        lostValue: Math.round(lostValue * 100) / 100,
        medianSessionSec: median(durations) !== null ? Math.round(median(durations)) : null,
        medianTimeToBookSec: median(timesToBook) !== null ? Math.round(median(timesToBook)) : null,
        bounces: sess.filter(s => s.maxStep <= 0 && !s.booked).length,
        zipServed, zipUnserved,
        bookingFailures: allErrors.filter(e => e.type === 'booking_failed').length,
        failedNeverBooked,
      },
      funnel,
      byDevice, bySource, byBrowser, byCity, byState, byZip,
      byHour, byDow, timeline,
      answers,
      unservedZips: Object.entries(unservedZips).map(([zip, count]) => ({ zip, count }))
        .sort((a, b) => b.count - a.count).slice(0, 15),
      errors: { recent: allErrors.slice(0, 20), byStep: errorsByStep },
      recentSessions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
