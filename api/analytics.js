import { serviceClientPublic, serviceClient } from './_lib/supabase.js';
import { verifyToken } from './_lib/auth.js';
import crypto from 'crypto';

// Delivery-status webhooks (Twilio + Resend) live in THIS file rather than a
// new api/*.js — Vercel's Hobby plan caps a project at 12 functions and this
// repo is already at that cap (see the comment on the `ics`/`review_click`
// actions consolidated into book.js for the same reason). analytics.js is the
// one router that's GET-only and never reads req.body today, so disabling
// Vercel's automatic body parsing here to get the RAW request body — required
// for both providers' signature verification — carries zero risk to its
// existing behavior.
export const config = { api: { bodyParser: false } };

// Reads the raw request body as a string. GET requests (the analytics
// endpoint's normal traffic) have no body and resolve to ''.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const TZ = 'America/Denver';
// The TV-mounting booking widget funnel.
const BOOKING_STEPS = [
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
// The handyman estimate widget funnel (public/estimate.html, 5 steps).
const HANDYMAN_STEPS = [
  { key: 'service',  label: 'Service' },
  { key: 'describe', label: 'Describe Job' },
  { key: 'photo',    label: 'Photo' },
  { key: 'times',    label: 'Preferred Times' },
  { key: 'contact',  label: 'Contact Info' },
];
// Legacy event step names that map onto a canonical step key
const STEP_ALIAS = { zip_verify: 'zip' };

// Build the per-request step config for a widget. A "-handyman" widget uses the
// handyman funnel; everything else uses the booking funnel. Returns the step
// list, an index lookup, and the index of the final step (set when a session
// reaches price/booking).
function stepConfigFor(widget) {
  const STEPS = String(widget).endsWith('-handyman') ? HANDYMAN_STEPS : BOOKING_STEPS;
  const index = {};
  STEPS.forEach((s, i) => { index[s.key] = i; });
  const stepIndexOf = (name) => {
    if (!name) return -1;
    const k = STEP_ALIAS[name] || name;
    return index[k] ?? -1;
  };
  return { STEPS, stepIndexOf, lastStepIdx: STEPS.length - 1 };
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

// Twilio signs its webhook POSTs with X-Twilio-Signature: base64(HMAC-SHA1(
// authToken, url + sorted "key"+"value" concatenation of every POST param)).
// We reconstruct the exact URL we set as the StatusCallback (see sendSMSResult
// callers in admin.js/tech.js) rather than trusting request headers for host/
// proto, which a proxy could rewrite — verification shouldn't depend on how
// the request physically arrived.
function verifyTwilioSignature(url, params, signature) {
  if (!signature || !process.env.TWILIO_AUTH_TOKEN) return false;
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = crypto.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(data, 'utf8').digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/analytics?action=sms_status&token=<review_token> — Twilio's
// message-status callback. Records delivered/failed/undelivered on the
// booking the token points at. Always responds 200 (Twilio retries on
// non-2xx; this is a bonus signal, never worth a retry storm over).
async function handleTwilioStatus(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  try {
    const rawBody = await readRawBody(req);
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    const token = (req.query.token || '').toString();
    const base = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
    const url = `${base}/api/analytics?action=sms_status&token=${encodeURIComponent(token)}`;
    if (!verifyTwilioSignature(url, params, req.headers['x-twilio-signature'])) {
      console.warn('[sms_status] signature verification failed');
      return res.status(200).send('ok');
    }
    const t = verifyToken(token);
    if (t && t.kind === 'review' && t.booking_id) {
      const status = (params.MessageStatus || '').toLowerCase();
      const db = serviceClient();
      if (status === 'delivered') {
        await db.from('bookings')
          .update({ review_sms_delivered_at: new Date().toISOString(), review_sms_status: 'delivered' })
          .eq('id', t.booking_id).is('review_sms_delivered_at', null);
      } else if (status === 'failed' || status === 'undelivered') {
        await db.from('bookings').update({ review_sms_status: status }).eq('id', t.booking_id);
      }
    }
  } catch (e) {
    console.error('[sms_status] error:', e.message);
  }
  return res.status(200).send('ok');
}

// Resend webhooks are Svix-signed: signature = base64(HMAC-SHA256(secret_bytes,
// `${svix-id}.${svix-timestamp}.${rawBody}`)), checked against one or more
// "v1,<sig>" entries in svix-signature (space-separated — more than one only
// during a secret rotation). The secret arrives as "whsec_<base64>"; only the
// part after the prefix is real key material. Rejects anything outside a
// 5-minute timestamp window to block replay of a captured request.
function verifySvixSignature({ id, timestamp, rawBody, signatureHeader, secret }) {
  if (!id || !timestamp || !signatureHeader || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const secretBytes = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = crypto.createHmac('sha256', secretBytes).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');
  return signatureHeader.split(' ').some((entry) => {
    const sig = entry.includes(',') ? entry.split(',')[1] : entry;
    if (!sig) return false;
    const sigBuf = Buffer.from(sig, 'base64');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

// POST /api/analytics?action=email_webhook — Resend's delivery webhook.
// Configure at https://resend.com/webhooks pointing here, subscribed to
// email.delivered / email.bounced / email.complained. Handy Andy and Doms each
// have their own Resend account/webhook, so their signing secrets are set as
// RESEND_WEBHOOK_SECRET_Handy_Andy and RESEND_WEBHOOK_SECRET_Doms in Vercel
// (RESEND_WEBHOOK_SECRET / DOMS_RESEND_WEBHOOK_SECRET are also accepted for a
// shared-account setup). We only ever act on an email_id WE issued (stored as
// review_email_id at send time) — a forged webhook can't touch an arbitrary
// booking without guessing a live Resend message id (an unguessable UUID).
async function handleResendWebhook(req, res) {
  res.setHeader('Content-Type', 'text/plain');
  try {
    const rawBody = await readRawBody(req);
    const secrets = [
      process.env.RESEND_WEBHOOK_SECRET,
      process.env.DOMS_RESEND_WEBHOOK_SECRET,
      process.env.RESEND_WEBHOOK_SECRET_Handy_Andy,
      process.env.RESEND_WEBHOOK_SECRET_Doms,
    ].filter(Boolean);
    const verified = secrets.some((secret) => verifySvixSignature({
      id: req.headers['svix-id'], timestamp: req.headers['svix-timestamp'],
      rawBody, signatureHeader: req.headers['svix-signature'], secret,
    }));
    if (!verified) {
      console.warn('[email_webhook] signature verification failed (or no secret configured)');
      return res.status(200).send('ok');
    }
    const payload = JSON.parse(rawBody);
    const emailId = payload?.data?.email_id;
    const type = payload?.type;
    if (emailId && type) {
      const db = serviceClient();
      if (type === 'email.delivered') {
        await db.from('bookings')
          .update({ review_email_delivered_at: new Date().toISOString(), review_email_status: 'delivered' })
          .eq('review_email_id', emailId).is('review_email_delivered_at', null);
      } else if (type === 'email.bounced') {
        await db.from('bookings').update({ review_email_status: 'bounced' }).eq('review_email_id', emailId);
      } else if (type === 'email.complained') {
        await db.from('bookings').update({ review_email_status: 'complained' }).eq('review_email_id', emailId);
      }
      // Other event types (sent, delivery_delayed, opened, clicked) are ignored
      // on purpose — "opened"/"clicked" are already answered more reliably by
      // our own click-tracking redirect (api/book.js action=review_click).
    }
  } catch (e) {
    console.error('[email_webhook] error:', e.message);
  }
  return res.status(200).send('ok');
}

export default async function handler(req, res) {
  const action = (req.query.action || '').toString();
  if (req.method === 'POST' && action === 'sms_status') return handleTwilioStatus(req, res);
  if (req.method === 'POST' && action === 'email_webhook') return handleResendWebhook(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Missing Supabase credentials' });
    }
    // Service-role (public schema): reads the analytics `events` table after RLS
    // is FORCED on it. This endpoint is server-side only; the key never ships.
    const supabase = serviceClientPublic();

    const WIDGET = (req.query.widget || 'handy-andy').toString();
    if (!['handy-andy', 'doms', 'handy-andy-handyman', 'doms-handyman'].includes(WIDGET)) {
      return res.status(400).json({ error: 'Invalid widget' });
    }
    // Pick the funnel for this widget (booking vs handyman estimate).
    const { STEPS, stepIndexOf, lastStepIdx } = stepConfigFor(WIDGET);

    // 'from'/'to' ISO params take priority (used for Denver calendar-day "Today"); else rolling 'days'.
    const days = Math.max(0, parseInt(req.query.days ?? '30', 10) || 0);
    const sinceISO = req.query.from
      ? new Date(req.query.from).toISOString()
      : (days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null);
    const untilISO = req.query.to ? new Date(req.query.to).toISOString() : null;

    // Pull all events in the range — Supabase caps responses at 1000 rows, so paginate
    const events = [];
    for (let page = 0; page < 30; page++) {
      let q = supabase.from('events').select('*').eq('widget', WIDGET)
        .order('created_at', { ascending: true })
        .range(page * 1000, page * 1000 + 999);
      if (sinceISO) q = q.gte('created_at', sinceISO);
      if (untilISO) q = q.lte('created_at', untilISO);
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
          device: null, source: null, browser: null, customer: null, coupon: null,
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
      // Customer name once they enter it on the booking form (or book). Keep the
      // latest non-empty value for the session.
      if (e.customer_name && String(e.customer_name).trim()) s.customer = String(e.customer_name).trim();
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
        if (lastStepIdx > s.maxStep) s.maxStep = lastStepIdx;
      } else if (t === 'booking_confirmed') {
        s.booked = true;
        s.bookedTs = ts;
        const v = Number(e.value);
        if (!isNaN(v) && v > 0) s.bookedValue = v;
        if (lastStepIdx > s.maxStep) s.maxStep = lastStepIdx;
      } else if (t === 'answer' && e.step_name) {
        s.answers.push(e.step_name);
        // Coupon events are tracked as "coupon:CODE" (see widget.js logEvent
        // call at checkout) — keep the latest one applied this session.
        if (e.step_name.startsWith('coupon:')) s.coupon = e.step_name.slice(7);
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
        device: s.device, source: s.source, browser: s.browser, customer: s.customer, coupon: s.coupon,
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
