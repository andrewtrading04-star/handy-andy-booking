import { serviceClientPublic, serviceClient } from './_lib/supabase.js';
import { verifyToken, signToken } from './_lib/auth.js';
import { sendSMS } from './_lib/sms.js';
import { ALL_BUSINESS_SLUGS } from './_lib/native-businesses.js';
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
    // Same dual-shape acceptance as api/book.js review_click: legacy review
    // tokens from mirror.js carry NO kind (every widget booking until Jul
    // 2026), so requiring kind === 'review' silently dropped their delivery
    // updates — review texts showed "Delivery pending" forever. A kindless
    // token with a booking_id can only be a review token; on_the_way tokens
    // always carry their kind and still route to the branch below.
    if (t && t.booking_id && (t.kind === 'review' || !t.kind)) {
      const status = (params.MessageStatus || '').toLowerCase();
      const db = serviceClient();
      if (status === 'delivered') {
        await db.from('bookings')
          .update({ review_sms_delivered_at: new Date().toISOString(), review_sms_status: 'delivered' })
          .eq('id', t.booking_id).is('review_sms_delivered_at', null);
      } else if (status === 'failed' || status === 'undelivered') {
        await db.from('bookings').update({ review_sms_status: status }).eq('id', t.booking_id);
      }
    } else if (t && t.kind === 'on_the_way' && t.booking_id) {
      // Same delivery-tracking pattern as the review SMS above, for the
      // tech's "on the way" text — admin/secretary dashboard only, never
      // shown to techs.
      const status = (params.MessageStatus || '').toLowerCase();
      const db = serviceClient();
      if (status === 'delivered') {
        await db.from('bookings')
          .update({ on_the_way_sms_delivered_at: new Date().toISOString(), on_the_way_sms_status: 'delivered' })
          .eq('id', t.booking_id).is('on_the_way_sms_delivered_at', null);
      } else if (status === 'failed' || status === 'undelivered') {
        await db.from('bookings').update({ on_the_way_sms_status: status }).eq('id', t.booking_id);
      }
    } else if (t && t.kind === 'tech_sms' && t.tech_sms_log_id) {
      // The "You got a job!" text to a TECHNICIAN (api/_lib/tech-notify.js).
      // Until this existed, tech texts had no delivery tracking at all — a
      // failed send left no trace anywhere the owner could see it.
      const status = (params.MessageStatus || '').toLowerCase();
      const db = serviceClient();
      if (status === 'delivered') {
        await db.from('tech_sms_log')
          .update({ status: 'delivered', delivered_at: new Date().toISOString() })
          .eq('id', t.tech_sms_log_id).is('delivered_at', null);
      } else if (status === 'failed' || status === 'undelivered') {
        // ErrorCode is the actionable part (30034 = unregistered A2P 10DLC,
        // 21610 = the tech replied STOP) — without it a carrier block looks
        // identical to any other failure.
        const errCode = (params.ErrorCode || '').toString();
        await db.from('tech_sms_log')
          .update({ status, error: errCode ? `Twilio ErrorCode ${errCode}` : null })
          .eq('id', t.tech_sms_log_id);
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

// ── Twilio Voice: tracking numbers ──────────────────────────────────────────
// A real local number we own on Twilio, forwarded to a person's phone. Unlike
// Grasshopper (migration 0080 / api/_lib/grasshopper.js — email-only, and only
// for voicemails), Twilio posts a webhook the moment the phone rings, so
// app.calls gets a row whether or not anybody picked up, with a duration and an
// answered flag. Because each number is its own line, putting a distinct one on
// an ad or a location page turns the Calls tab into campaign attribution.
//
// Three POST actions, all from Twilio, all signature-verified:
//   voice_inbound    the call arrives     -> log it, return TwiML that forwards
//   voice_status     the forward finished -> answered? how long? else voicemail
//   voice_recording  the voicemail is in  -> attach recording + transcript
//
// Each one answers 200 with TwiML even on an internal error: a non-2xx makes
// Twilio play its own "application error" recording to a live customer, which
// is a far worse outcome than a missing analytics row.
function xml(res, twiml) {
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>${twiml}`);
}
function xmlEsc(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}
function publicBase() {
  return process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
}
// Twilio signs against the EXACT callback URL string it was given, so every
// callback URL is built here and verified against the same builder — a
// mismatch in parameter order or escaping is the classic cause of a webhook
// that silently fails verification.
function voiceUrl(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  return `${publicBase()}/api/analytics?${qs}`;
}
function tenDigits(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

// Reads and verifies a Twilio POST. On a bad signature it has already
// responded, and returns null, so callers can `if (!params) return;`.
//
// Two candidate URLs, because the one Twilio signed is not always the one we
// would build. The status and recording callbacks come from TwiML we wrote, so
// PUBLIC_URL matches by construction — but the FIRST hit (voice_inbound) uses
// whatever URL is typed into the number's config in the Twilio console, which
// may be a different host than PUBLIC_URL (a custom domain, or a bare
// *.vercel.app). Accepting either keeps a host mismatch from silently sending
// every caller to voicemail. The signature itself is still required and still
// checked against the auth token, so this widens which URL is accepted, not
// who is allowed to call.
async function twilioVoiceParams(req, res, action, extraQuery = {}) {
  const rawBody = await readRawBody(req);
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  const sig = req.headers['x-twilio-signature'];
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0];
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0];
  const candidates = [voiceUrl(action, extraQuery)];
  if (host) candidates.push(`${proto}://${host}${req.url}`);
  if (!candidates.some(u => verifyTwilioSignature(u, params, sig))) {
    console.warn(`[${action}] signature verification failed; tried ${candidates.join(' , ')}`);
    xml(res, '<Response><Reject/></Response>');
    return null;
  }
  return params;
}

// The voicemail leg, used whenever nobody picks up.
function voicemailTwiml(sid) {
  const done = voiceUrl('voice_recording', { sid });
  return '<Response>'
    + '<Say voice="Polly.Joanna">Sorry we missed you. Please leave your name, number and what you need after the tone, and we will call you right back.</Say>'
    + `<Record maxLength="120" playBeep="true" timeout="4" transcribe="true" transcribeCallback="${xmlEsc(done)}" action="${xmlEsc(done)}" method="POST"/>`
    + '<Say voice="Polly.Joanna">We did not get a message. Goodbye.</Say>'
    + '</Response>';
}

// POST /api/analytics?action=voice_whisper&label=... — fetched when the person
// being forwarded to picks up, and played only to them. The caller is still
// hearing ringing while this plays, so keep it to a couple of words: it is the
// delay between "hello?" and being connected.
//
// The label is carried in the query rather than looked up by CallSid on
// purpose. It is inside the signed URL, so it cannot be tampered with, and a
// database round-trip here would be dead air on a live call.
async function handleVoiceWhisper(req, res) {
  const sid = (req.query.sid || '').toString();
  const label = (req.query.label || '').toString();
  const params = await twilioVoiceParams(req, res, 'voice_whisper', { label, sid });
  if (!params) return;
  if (!label) return xml(res, '<Response/>');
  return xml(res, `<Response><Say voice="Polly.Joanna">${xmlEsc(label)}</Say></Response>`);
}

// Which handset a line rings RIGHT NOW.
//
// A line with an after-hours number splits the day at [hours_start, hours_end)
// read in that line's OWN market timezone (migration 0099) — so a Houston
// customer dialing at 7pm their time reaches the daytime handset regardless of
// where the server, or the office, happens to be. Austin and Houston are both
// Central, which is why the eight lead-gen lines share one window.
//
// A line with no window configured (the default, and every line before this)
// returns forward_to unchanged, so nothing that was working changes.
function destinationFor(line) {
  if (!line) return null;
  const primary = line.forward_to || null;
  if (!line.after_hours_forward_to || !line.hours_timezone) return primary;

  let hour;
  try {
    // hourCycle 'h23' rather than hour12:false — the latter reports midnight as
    // "24" on some ICU builds, which would read as outside every window.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: line.hours_timezone, hourCycle: 'h23', hour: '2-digit',
    }).formatToParts(new Date());
    hour = parseInt((parts.find(p => p.type === 'hour') || {}).value, 10);
  } catch (e) {
    // A bad timezone must never drop a customer's call: fall back to the
    // primary handset, which is exactly what this line did before it had a
    // window at all. Loud, because it means the row needs fixing.
    console.error(`[voice_inbound] bad hours_timezone "${line.hours_timezone}" on ${line.phone}:`, e.message);
    return primary;
  }
  if (!Number.isInteger(hour)) return primary;

  const open = Number(line.hours_start), close = Number(line.hours_end);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return primary;
  return (hour >= open && hour < close) ? primary : line.after_hours_forward_to;
}

// Shared by the direct path (IVR gate off) and handleVoiceGather (gate
// passed): builds the actual forwarding <Dial>. Split out so the gate can sit
// in FRONT of this without duplicating the disclosure/recording/whisper logic.
function dialTwiml(line, callerFrom, sid) {
  const dialTo = destinationFor(line);
  if (!line || !dialTo) return voicemailTwiml(sid);

  // callerId is the CALLER's own number, not ours, so whoever picks up sees who
  // is really calling and can just hit redial. Twilio permits this for straight
  // call forwarding. The tradeoff is that the handset cannot show WHICH line
  // was dialed — that lives in the Calls tab, which is the point of logging it.
  const action = voiceUrl('voice_status', { sid });
  const rec = line.record_calls ? ' record="record-from-answer-dual"' : '';
  // recordingStatusCallback is the RELIABLE recording signal — the action
  // callback above also carries RecordingUrl, but Twilio's own docs warn the
  // file "may not yet be accessible" when that fires. Reuses the existing
  // voice_recording handler (same one the voicemail <Record> already posts
  // to) keyed by the same sid, so this is one code path, not two.
  const recStatusCb = line.record_calls
    ? ` recordingStatusCallback="${xmlEsc(voiceUrl('voice_recording', { sid }))}" recordingStatusCallbackEvent="completed"`
    : '';
  // Spoken consent notice, gated on record_calls ALONE — not on this line's
  // own market/area code. A caller's true location can't be known from which
  // tracking number they dialed (an out-of-state cell keeps its old area
  // code), and a cross-state call is generally held to the strictest law in
  // play — so area-code-based gating would not actually guarantee compliance
  // in a two-party-consent state (California, since the LA line, and
  // whichever states the next 10-20 numbers land in). Announcing whenever
  // recording is on costs nothing in one-party states and is correct
  // everywhere, with no state lookup table to maintain as the fleet grows.
  const disclosure = line.record_calls
    ? '<Say voice="Polly.Joanna">This call may be recorded for quality and training purposes.</Say>'
    : '';
  // The whisper: because callerId is the customer's number, the handset cannot
  // say WHICH line rang, and with a dozen numbers across several cities that
  // matters more than it does with one. The url on <Number> is fetched the
  // moment the person picks up and plays only to THEM — the caller hears
  // ringing throughout — so you answer already knowing what you picked up.
  const whisper = voiceUrl('voice_whisper', { label: line.label || '', sid });
  return `<Response>${disclosure}<Dial timeout="${Number(line.ring_seconds) || 20}" answerOnBridge="true" callerId="${xmlEsc(callerFrom || '')}" action="${xmlEsc(action)}" method="POST"${rec}${recStatusCb}><Number url="${xmlEsc(whisper)}" method="POST">${xmlEsc(dialTo)}</Number></Dial></Response>`;
}

// "Press 1 to continue" — a real caller taps one key and never notices the
// delay; a robocall/scam autodialer plays a pre-recorded message into dead
// air and gets nothing back, so it never reaches a human or a voicemail box.
// Per-line, defaulting on (tracking_numbers.ivr_gate_enabled, migration 0101 —
// owner call 2026-08-29, scammer volume on the tracking lines).
function ivrGateTwiml(sid) {
  const action = voiceUrl('voice_gather', { sid });
  return '<Response><Gather numDigits="1" timeout="8" action="' + xmlEsc(action) + '" method="POST">'
    + '<Say voice="Polly.Joanna">To reduce spam calls, press 1 to continue.</Say>'
    + '</Gather><Say voice="Polly.Joanna">We did not get a response. Goodbye.</Say><Hangup/></Response>';
}

// POST /api/analytics?action=voice_inbound — someone dialed a tracking number.
async function handleVoiceInbound(req, res) {
  const params = await twilioVoiceParams(req, res, 'voice_inbound');
  if (!params) return;
  const sid = params.CallSid || '';
  const from = tenDigits(params.From);
  const to = tenDigits(params.To);
  let line = null;
  let blocked = false;
  try {
    const db = serviceClient();
    const { data } = await db.from('tracking_numbers')
      .select('phone, label, business_slug, market, forward_to, ring_seconds, record_calls, active, after_hours_forward_to, hours_start, hours_end, hours_timezone, ivr_gate_enabled, ai_bot_enabled')
      .eq('phone', to).maybeSingle();
    line = data && data.active ? data : null;

    if (from) {
      const { data: b } = await db.from('blocked_numbers').select('id').eq('phone', from).maybeSingle();
      blocked = !!b;
    }

    // Log first, forward second — but the whole block is wrapped, because if
    // logging throws the call must still connect. A customer reaching a human
    // matters more than the analytics row.
    let business_id = null;
    if (line && line.business_slug) {
      const { data: biz } = await db.from('businesses').select('id').eq('slug', line.business_slug).maybeSingle();
      business_id = biz?.id || null;
    }
    let customer_id = null;
    if (from) {
      const { data: c } = await db.from('customers').select('id').eq('phone', from).limit(1);
      customer_id = (c || [])[0]?.id || null;
    }
    await db.from('calls').insert({
      business_id,
      source: 'twilio',
      kind: 'inbound',
      caller_phone: from || 'unknown',
      grasshopper_number: to || null,   // the line dialed; same meaning as in 0080
      tracking_label: line?.label || null,
      market: line?.market || null,
      // The handset actually dialed for THIS call, not the line's daytime
      // default — on an after-hours line those differ, and the Calls tab's
      // "routed to" (plus the missed-call text, which is sent to this number)
      // must name whoever really rang. A blocked number never actually rings
      // anyone, so this stays descriptive metadata only for those rows.
      forwarded_to: destinationFor(line),
      twilio_call_sid: sid,
      occurred_at: new Date().toISOString(),
      customer_id,
      // Blocked calls are pre-resolved — nobody needs to call a blocked
      // number back, so this never sits in the Needs-callback queue.
      status: blocked ? 'ignored' : 'new',
      handled_by: blocked ? 'Blocked number' : null,
      handled_at: blocked ? new Date().toISOString() : null,
      // An unmapped number is a config gap, never a reason to drop a caller —
      // same rule as GRASSHOPPER_LINES. The office sees the warning on the card.
      warnings: blocked ? ['Blocked number — call was rejected before ringing'] : (line ? null : ['Number is not in tracking_numbers - call still connected']),
    });
  } catch (e) {
    console.error('[voice_inbound] log failed:', e.message);
  }

  // Rejected with no ring, no voicemail prompt, nothing for a scammer to work
  // with — same principle as the IVR gate below, just skipping the prompt
  // entirely for a number that's already proven itself unwanted.
  if (blocked) return xml(res, '<Response><Reject/></Response>');

  // AI voice-bot pilot (2026-09-03): a line with ai_bot_enabled routes into the
  // bot flow instead of ringing a human at all. Deliberately bypasses the IVR
  // spam gate — this is a single zero-traffic test number for now, not a
  // public-facing line yet; add the gate back here before ever enabling this
  // on a real ad-driven number.
  if (line && line.ai_bot_enabled) return xml(res, '<Response><Redirect method="POST">' + xmlEsc(voiceUrl('voice_bot_start', { sid })) + '</Redirect></Response>');

  if (line && line.ivr_gate_enabled) return xml(res, ivrGateTwiml(sid));
  return xml(res, dialTwiml(line, params.From, sid));
}

// POST /api/analytics?action=voice_gather&sid=... — the caller either pressed
// a key or the Gather above timed out. Re-looks-up the line itself (Twilio's
// gather POST doesn't carry it) rather than trusting anything client-supplied.
async function handleVoiceGather(req, res) {
  const sid = (req.query.sid || '').toString();
  const params = await twilioVoiceParams(req, res, 'voice_gather', { sid });
  if (!params) return;
  const to = tenDigits(params.To);
  let line = null;
  try {
    const db = serviceClient();
    const { data } = await db.from('tracking_numbers')
      .select('phone, label, business_slug, market, forward_to, ring_seconds, record_calls, active, after_hours_forward_to, hours_start, hours_end, hours_timezone')
      .eq('phone', to).maybeSingle();
    line = data && data.active ? data : null;
  } catch (e) {
    console.error('[voice_gather] line lookup failed:', e.message);
  }
  if ((params.Digits || '').toString() !== '1') {
    // No key, or the wrong key — never voicemail here: a real customer who
    // mis-taps gets a second chance by simply calling back, and giving a
    // scam dialer a record/transcribe prompt is exactly the thing the gate
    // exists to deny it.
    try {
      const db = serviceClient();
      await db.from('calls').update({ status: 'ignored', handled_by: 'No response to IVR prompt', handled_at: new Date().toISOString() })
        .eq('twilio_call_sid', params.CallSid || '').eq('status', 'new');
    } catch (e) { console.error('[voice_gather] resolve failed:', e.message); }
    return xml(res, '<Response><Hangup/></Response>');
  }
  return xml(res, dialTwiml(line, params.From, sid));
}

// POST /api/analytics?action=voice_status&sid=... — the <Dial> finished.
// DialCallStatus says whether a human picked up; anything else means the call
// was missed, and the caller is still on the line, so we take a message.
async function handleVoiceStatus(req, res) {
  const sid = (req.query.sid || '').toString();
  const params = await twilioVoiceParams(req, res, 'voice_status', { sid });
  if (!params) return;
  const status = (params.DialCallStatus || '').toLowerCase();
  const answered = status === 'completed';
  const dur = parseInt(params.DialCallDuration, 10);
  try {
    const db = serviceClient();
    await db.from('calls').update({
      answered,
      duration_sec: Number.isFinite(dur) ? dur : null,
      ...(params.RecordingUrl ? { recording_url: params.RecordingUrl, has_recording: true } : {}),
      // An answered call needs no callback-queue entry — somebody already spoke
      // to them. A missed one stays 'new' until the office clears it.
      ...(answered ? { status: 'resolved', handled_by: 'Answered', handled_at: new Date().toISOString() } : {}),
    }).eq('twilio_call_sid', sid);
  } catch (e) {
    console.error('[voice_status] update failed:', e.message);
  }
  if (answered) return xml(res, '<Response><Hangup/></Response>');
  return xml(res, voicemailTwiml(sid));
}

// POST /api/analytics?action=voice_recording&sid=... — fires twice: once when
// the recording is stored (RecordingUrl) and again when transcription finishes
// (TranscriptionText). Both patch the same row, so arrival order does not
// matter and a missing transcription never loses the recording.
async function handleVoiceRecording(req, res) {
  const sid = (req.query.sid || '').toString();
  const params = await twilioVoiceParams(req, res, 'voice_recording', { sid });
  if (!params) return;
  const patch = {};
  if (params.RecordingUrl) { patch.recording_url = params.RecordingUrl; patch.has_recording = true; }
  if (params.RecordingSid) patch.recording_sid = params.RecordingSid;
  if (params.TranscriptionText) patch.transcript = params.TranscriptionText;
  if (params.RecordingDuration) patch.duration_sec = parseInt(params.RecordingDuration, 10) || null;
  try {
    const db = serviceClient();
    let row = null;
    if (Object.keys(patch).length) {
      const { data } = await db.from('calls').update(patch).eq('twilio_call_sid', sid)
        .select('id, caller_phone, tracking_label, forwarded_to, notified_at').maybeSingle();
      row = data || null;
    }
    // Text whoever the line forwards to, once, and only on the recording
    // callback — the transcription callback lands minutes later and would
    // otherwise double-alert. Awaited, never fire-and-forget: an un-awaited
    // send is killed the moment this function responds.
    if (row && params.RecordingUrl && row.forwarded_to && !row.notified_at) {
      const p = row.caller_phone || '';
      const pretty = p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p;
      const sent = await sendSMS(row.forwarded_to,
        `Missed call${row.tracking_label ? ` on ${row.tracking_label}` : ''} from ${pretty}. They left a voicemail - it is in the Calls tab.`);
      if (sent) await db.from('calls').update({ notified_at: new Date().toISOString() }).eq('id', row.id);
    }
  } catch (e) {
    console.error('[voice_recording] update failed:', e.message);
  }
  return xml(res, '<Response><Say voice="Polly.Joanna">Thanks. We will call you right back.</Say><Hangup/></Response>');
}

// ── AI Voice Bot (pilot, 2026-09-03) ─────────────────────────────────────────
// A turn-based Twilio <Gather>/<Say> loop that walks a caller through the same
// booking conversation the Call Wizard scripts for a human secretary (see
// public/admin.html renderCallWiz()): category -> zip -> TV questions (or a
// handyman description) -> real availability -> priced recap -> customer info
// -> booking_create. Deliberately NOT Media Streams / ConversationRelay — every
// turn is a plain webhook round-trip, so it costs nothing beyond ordinary
// Twilio voice minutes plus the included Gather speech recognition. No LLM in
// the loop at all: every question is a numbered menu matched deterministically
// against the SAME service catalog the office prices from (api/admin.js's
// `services`/`service_options` actions), so pricing can never drift from what
// a human would quote, and there's no API key to configure for this to work.
//
// Session state lives in app.voice_bot_sessions (one row per CallSid) because
// serverless functions are stateless between webhook hits. Gated per-line by
// tracking_numbers.ai_bot_enabled (default false everywhere) — see the branch
// in handleVoiceInbound above. Pilot scope is intentionally narrow: no
// discount negotiation, no GDS/Assurion/cross-company, no card collection
// (books with card_skipped-equivalent, same as the human "collect at service"
// escape hatch) — any of those, or two failed/ambiguous answers in a row on
// any single question, transfers the live call to the line's own forward_to
// human, reusing dialTwiml() so nothing about human fallback is reimplemented.

const AFTER_HOURS_SLOT_KEY = 's5';
function botAfterHoursFee(slotKey, dateStr) {
  if (slotKey !== AFTER_HOURS_SLOT_KEY) return 0;
  const isSunday = dateStr ? new Date(dateStr + 'T12:00:00').getDay() === 0 : false;
  return isSunday ? 100 : 75;
}
const BOT_TAX_RATE = 0.0825;     // matches New Booking / Call Wizard's TAX_RATE
const BOT_MIN_TICKET = 139;      // matches MIN_TICKET_PRICE in api/admin.js/api/book.js
const BOT_HANDYMAN_HOURLY = 85;  // matches HANDYMAN_HOURLY in public/admin.html

// A short-lived internal admin token, minted in-process (same SESSION_SECRET
// the real dashboard login signs with) so the bot can call the office's own
// authenticated actions — zip/availability/pricing/booking — instead of
// reimplementing any of that logic. role:'owner', scope:'all' so it can act
// on ANY business (the bot may be answering for a lead-gen brand that isn't
// 'handy-andy' or 'doms'), same as a real owner login would.
function botToken() {
  return signToken({ kind: 'admin', role: 'owner', scope: 'all', name: 'AI Voice Bot' }, 3600);
}
async function adminApi(action, { method = 'GET', params = {}, body = null } = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const url = `${publicBase()}/api/admin?${qs}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${botToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (_) { /* non-JSON error page */ }
  if (!r.ok) {
    const e = new Error(data.error || `admin ${action} failed (${r.status})`);
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}

async function botSessionGet(db, callSid) {
  const { data } = await db.from('voice_bot_sessions').select('*').eq('call_sid', callSid).maybeSingle();
  return data;
}
async function botSessionSave(db, callSid, patch) {
  await db.from('voice_bot_sessions').update({ ...patch, updated_at: new Date().toISOString() }).eq('call_sid', callSid);
}

// ── TwiML builders (bot-specific; reuses xml/xmlEsc/voiceUrl from above) ─────
function botMenuTwiml(action, sayIntro, options) {
  const lines = options.map((o, i) => `Press or say ${i + 1} for ${o.say}.`).join(' ');
  return '<Response><Gather input="speech dtmf" numDigits="1" timeout="6" speechTimeout="auto" action="'
    + xmlEsc(action) + '" method="POST"><Say voice="Polly.Joanna">' + xmlEsc(`${sayIntro} ${lines}`) + '</Say></Gather>'
    + '<Redirect method="POST">' + xmlEsc(action) + '</Redirect></Response>';
}
function botOpenTwiml(action, sayIntro) {
  return '<Response><Gather input="speech dtmf" timeout="8" speechTimeout="auto" action="'
    + xmlEsc(action) + '" method="POST"><Say voice="Polly.Joanna">' + xmlEsc(sayIntro) + '</Say></Gather>'
    + '<Redirect method="POST">' + xmlEsc(action) + '</Redirect></Response>';
}
function botSayRedirect(sayText, action) {
  return '<Response><Say voice="Polly.Joanna">' + xmlEsc(sayText) + '</Say><Redirect method="POST">' + xmlEsc(action) + '</Redirect></Response>';
}
function botHangup(sayText) {
  return '<Response>' + (sayText ? '<Say voice="Polly.Joanna">' + xmlEsc(sayText) + '</Say>' : '') + '<Hangup/></Response>';
}
// Escalation: reuses dialTwiml() verbatim (whisper/disclosure/recording/
// voicemail fallback all come along for free), just prefixes one spoken line.
function botTransfer(line, callerFrom, sid, sayFirst) {
  const twiml = dialTwiml(line, callerFrom, sid);
  return sayFirst ? twiml.replace('<Response>', '<Response><Say voice="Polly.Joanna">' + xmlEsc(sayFirst) + '</Say>') : twiml;
}

// ── Menu answer matching (deterministic — no LLM) ────────────────────────────
const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const BOT_STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'has', 'have', 'will', 'with', 'for', 'and', 'or', 'to', 'of', 'tv', 'on', 'in', 'my', 'i']);
function botTermsFor(label) {
  const bare = String(label || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9\s]/g, ' ').trim();
  const words = bare.split(/\s+/).filter(w => w.length >= 3 && !BOT_STOPWORDS.has(w));
  const terms = new Set(words);
  for (let i = 0; i < words.length - 1; i++) terms.add(words[i] + ' ' + words[i + 1]);
  return [...terms];
}
// options: [{ say, terms, ...anything }]. digits/speech come straight off the
// Twilio Gather POST (params.Digits / params.SpeechResult).
function botMatchMenu(options, { digits, speech }) {
  if (digits) {
    const idx = parseInt(digits, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx];
  }
  const s = (speech || '').toLowerCase().trim();
  if (!s) return null;
  const asNum = parseInt(s, 10);
  if (Number.isFinite(asNum) && asNum >= 1 && asNum <= options.length) return options[asNum - 1];
  const firstWord = s.split(/\s+/)[0];
  const wIdx = NUM_WORDS.indexOf(firstWord);
  if (wIdx >= 1 && wIdx <= options.length) return options[wIdx - 1];
  let best = null, bestLen = 0;
  for (const o of options) {
    for (const t of (o.terms || [])) {
      if (t && s.includes(t) && t.length > bestLen) { bestLen = t.length; best = o; }
    }
  }
  return best;
}
function botYes(speech, digits) {
  if (digits === '1') return true;
  if (digits === '2') return false;
  const s = (speech || '').toLowerCase();
  if (/\b(yes|yeah|yep|sure|correct|that works|sounds good|book it)\b/.test(s)) return true;
  if (/\b(no|nope|not|different|change)\b/.test(s)) return false;
  return null;
}
function botParseDigitsFrom(speech, digits, count) {
  if (digits && new RegExp(`^\\d{${count}}$`).test(digits)) return digits;
  const stripped = String(speech || '').replace(/\D/g, '');
  if (stripped.length === count) return stripped;
  if (count === 10 && stripped.length === 11 && stripped.startsWith('1')) return stripped.slice(1);
  const DIGIT_WORDS = { zero: '0', oh: '0', one: '1', two: '2', to: '2', too: '2', three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
  let out = '';
  for (const w of String(speech || '').toLowerCase().split(/\s+/)) {
    if (/^\d$/.test(w)) out += w;
    else if (DIGIT_WORDS[w] != null) out += DIGIT_WORDS[w];
  }
  return out.length === count ? out : null;
}
function botSpokenMoney(n) {
  const v = Math.round(Number(n) || 0);
  return `${v} dollar${v === 1 ? '' : 's'}`;
}

// Fetches the TV-mounting option catalog once (at the zip step) and caches it
// on the session so every later question is a plain lookup, not a re-fetch.
// Mirrors exactly what serviceOptions() returns; only the fields the bot
// needs (id, label, price, sizecat) survive into the cached copy.
async function botLoadCatalog(businessSlug, serviceId) {
  const { groups } = await adminApi('service_options', { params: { business: businessSlug, service_id: serviceId } });
  const byKey = {};
  for (const g of (groups || [])) {
    byKey[g.key] = (g.options || []).map(o => ({
      id: o.id, label: o.label, price: Number(o.price) || 0,
      sizecat: o.metadata && o.metadata.sizecat || null,
    }));
  }
  return byKey;
}
function botMenuOptionsFrom(catalogGroup) {
  return (catalogGroup || []).map(o => ({ say: o.label, terms: botTermsFor(o.label), catalogOpt: o }));
}

// Builds the priced selections array in the same shape booking_create expects
// (mirrors nbCollectSelections()'s output shape: option_id/label/price/qty),
// plus travel surcharge and after-hours fee as their own lines, plus a
// "Service minimum" top-up if the raw total is under the $139 floor — the
// exact same auto-topup behavior nbMinimumTopUp() applies in the office tool.
function botBuildSelections(d) {
  const out = [];
  if (d.category === 'tv') {
    for (const key of ['size', 'bracket', 'fireplace', 'surface', 'wires', 'lifting', 'extras']) {
      const picked = d.answers && d.answers[key];
      if (picked && picked.price > 0) out.push({ option_id: picked.id || null, label: picked.label, price: picked.price, quantity: 1 });
      else if (picked) out.push({ option_id: picked.id || null, label: picked.label, price: 0, quantity: 1 });
    }
  } else if (d.category === 'handyman') {
    const hrs = Math.max(2, Number(d.handymanHours) || 2);
    out.push({ option_id: null, label: `Handyman Labor: ${d.handymanDesc || 'as described'} — ${hrs} hour${hrs === 1 ? '' : 's'}`, price: BOT_HANDYMAN_HOURLY, quantity: hrs });
  }
  if (d.surcharge > 0) out.push({ option_id: null, label: 'Travel', price: d.surcharge, quantity: 1 });
  const ahFee = botAfterHoursFee(d.slotKey, d.date);
  if (ahFee > 0) out.push({ option_id: null, label: 'After-Hours Service Fee (8 PM)', price: ahFee, quantity: 1 });
  const rawSum = out.filter(x => x.label !== 'Service minimum').reduce((s, x) => s + x.price * x.quantity, 0);
  if (rawSum > 0 && rawSum < BOT_MIN_TICKET) out.push({ option_id: null, label: 'Service minimum', price: Math.round((BOT_MIN_TICKET - rawSum) * 100) / 100, quantity: 1 });
  return out;
}

// POST /api/analytics?action=voice_bot_start — the very first turn on a
// bot-enabled line (redirected here from handleVoiceInbound).
async function handleVoiceBotStart(req, res) {
  const sid = (req.query.sid || '').toString();
  const params = await twilioVoiceParams(req, res, 'voice_bot_start', { sid });
  if (!params) return;
  const to = tenDigits(params.To);
  const from = params.From || '';
  const db = serviceClient();
  let line = null;
  try {
    const { data } = await db.from('tracking_numbers')
      .select('phone, label, business_slug, market, forward_to, ring_seconds, record_calls, after_hours_forward_to, hours_start, hours_end, hours_timezone, ai_bot_enabled')
      .eq('phone', to).maybeSingle();
    line = data || null;
    // Safety net: got redirected here but the flag is off (race with someone
    // flipping it mid-call) — fall back to the normal human-forwarding path
    // rather than dead-ending the caller.
    if (!line || !line.ai_bot_enabled) return xml(res, dialTwiml(line, from, params.CallSid || ''));

    const { data: biz } = await db.from('businesses').select('id, slug, name, timezone').eq('slug', line.business_slug).maybeSingle();
    if (!biz) return xml(res, botHangup("Sorry, we're having trouble right now. Please call back in a few minutes."));

    const { services: svcs } = await adminApi('services', { params: { business: biz.slug } }).catch(() => ({ services: [] }));
    const tvService = (svcs || []).find(s => /tv\s*mount|tv\s*install/i.test(s.category || s.name || ''));
    const handymanService = (svcs || []).find(s => /handyman/i.test(s.category || s.name || ''));
    if (!tvService && !handymanService) return xml(res, botHangup("Sorry, we're having trouble right now. Please call back in a few minutes."));

    const onlyOne = (tvService && !handymanService) ? 'tv' : (!tvService && handymanService) ? 'handyman' : null;
    const session = {
      call_sid: params.CallSid || '',
      business_id: biz.id, business_slug: biz.slug,
      tracking_number: line.phone, caller_phone: tenDigits(from),
      step: onlyOne ? 'zip' : 'category',
      data: {
        tvServiceId: tvService ? tvService.id : null,
        handymanServiceId: handymanService ? handymanService.id : null,
        category: onlyOne, businessName: biz.name, timezone: biz.timezone || 'America/Denver',
        forwardTo: line.forward_to, answers: {},
      },
      retry_count: 0,
    };
    await db.from('voice_bot_sessions').upsert(session, { onConflict: 'call_sid' });

    const greetName = biz.name || 'our company';
    const turnAction = voiceUrl('voice_bot_turn', { sid: session.call_sid });
    if (!onlyOne) {
      return xml(res, botMenuTwiml(turnAction, `Thanks for calling ${greetName}! I can help you book an appointment.`,
        [{ say: 'TV mounting' }, { say: 'handyman services' }]));
    }
    return xml(res, botOpenTwiml(turnAction,
      `Thanks for calling ${greetName}! I can help you book a ${onlyOne === 'tv' ? 'TV mounting' : 'handyman'} appointment. What's your 5 digit zip code?`));
  } catch (e) {
    console.error('[voice_bot_start] failed:', e.message);
    return xml(res, botTransfer(line, from, params.CallSid || '', "Sorry, I'm having trouble right now — let me connect you with someone."));
  }
}

// POST /api/analytics?action=voice_bot_turn&sid=... — every subsequent Gather
// result on a bot call lands here. Loads the session by CallSid, dispatches on
// session.step, and returns the next question (or books / transfers / hangs
// up). One big step switch, matching the size of everything else this file's
// voice handlers already do inline — see the file-level comment above for the
// overall design.
async function handleVoiceBotTurn(req, res) {
  const sid = (req.query.sid || '').toString();
  const params = await twilioVoiceParams(req, res, 'voice_bot_turn', { sid });
  if (!params) return;
  const digits = (params.Digits || '').toString().trim();
  const speech = (params.SpeechResult || '').toString().trim();
  const callerFrom = params.From || '';
  const db = serviceClient();
  const action = voiceUrl('voice_bot_turn', { sid });

  const session = await botSessionGet(db, sid);
  if (!session) return xml(res, botHangup('Sorry, this call has expired. Please call back.'));
  const d = session.data || {};
  const step = session.step;

  // Line row, re-fetched fresh (needed for any transfer on this turn — never
  // trust a stale copy of forward_to/recording settings from session start).
  const { data: line } = await db.from('tracking_numbers')
    .select('phone, label, business_slug, forward_to, ring_seconds, record_calls, after_hours_forward_to, hours_start, hours_end, hours_timezone')
    .eq('phone', session.tracking_number).maybeSingle();

  const retry = async (sayText) => {
    const n = (session.retry_count || 0) + 1;
    if (n > 2) {
      await botSessionSave(db, sid, { retry_count: 0 });
      return xml(res, botTransfer(line, callerFrom, sid, "Let me connect you with someone who can help with that."));
    }
    await botSessionSave(db, sid, { retry_count: n });
    return xml(res, botSayRedirect(sayText, action));
  };
  const goto = async (nextStep, patch, sayText, twimlFn) => {
    const newData = { ...d, ...(patch || {}) };
    // Awaited: some twimlFns (schedule/recap/booking) are async, and passing an
    // un-awaited Promise straight to xml() would send "[object Promise]" as
    // the TwiML body instead of the real markup.
    const twiml = await twimlFn(newData);
    await botSessionSave(db, sid, { step: nextStep, data: newData, retry_count: 0 });
    return xml(res, twiml);
  };

  try {
    switch (step) {

      case 'category': {
        const opt = botMatchMenu([
          { say: 'tv', terms: ['tv', 'mount', 'mounting', 'television'] },
          { say: 'handyman', terms: ['handyman', 'handy', 'handywork'] },
        ], { digits, speech });
        if (!opt) return retry("Sorry, I didn't catch that. Press or say 1 for TV mounting, or 2 for handyman services.");
        const cat = opt.say === 'tv' ? 'tv' : 'handyman';
        return goto('zip', { category: cat },
          null, () => botOpenTwiml(action, `Great. What's your 5 digit zip code?`));
      }

      case 'zip': {
        const zip = botParseDigitsFrom(speech, digits, 5);
        if (!zip) return retry("Sorry, I need your 5 digit zip code. You can say it or enter it on the keypad.");
        let za;
        try { za = await adminApi('zip_area', { params: { business: session.business_slug, postal_code: zip } }); }
        catch (e) { return retry("Sorry, I couldn't check that zip code. Could you say it again?"); }
        if (!za.service_area_id) {
          await botSessionSave(db, sid, { retry_count: 0 });
          return xml(res, botTransfer(line, callerFrom, sid, "That zip code is outside our normal service area — let me connect you with someone who can take a closer look."));
        }
        const nd = { ...d, zip, surcharge: Number(za.surcharge) || 0 };
        if (nd.category === 'tv') {
          let catalog;
          try { catalog = await botLoadCatalog(session.business_slug, nd.tvServiceId); }
          catch (e) { return retry("Sorry, I'm having trouble pulling up pricing. Could you give me a moment and repeat your last answer?"); }
          nd.catalog = catalog;
          return goto('tv_size', nd, null, (nn) => botMenuTwiml(action, "What size is your TV?", botMenuOptionsFrom(nn.catalog.size)));
        }
        return goto('handyman_desc', nd, null, () => botOpenTwiml(action, "What do you need done?"));
      }

      // ── TV Mounting path ──────────────────────────────────────────────────
      case 'tv_size': {
        const opts = botMenuOptionsFrom(d.catalog.size);
        const opt = botMatchMenu(opts, { digits, speech });
        if (!opt) return retry("Sorry, which size TV is it — you can say the size, like 60 to 69 inches?");
        const answers = { ...d.answers, size: opt.catalogOpt };
        const bracketOpts = d.catalog.bracket || [];
        if (!bracketOpts.length) {
          return goto('tv_fireplace', { answers }, null, (nn) => botMenuTwiml(action, "Is your TV going over a fireplace?", [{ say: 'no, not over a fireplace' }, { say: 'yes, over a fireplace' }]));
        }
        return goto('tv_bracket', { answers }, null, (nn) => botMenuTwiml(action, "Do you already have a mounting bracket, or would you like us to bring one?", botMenuOptionsFrom(nn.catalog.bracket)));
      }
      case 'tv_bracket': {
        const opts = botMenuOptionsFrom(d.catalog.bracket);
        const opt = botMatchMenu(opts, { digits, speech });
        if (!opt) return retry("Sorry, do you have your own bracket, or should we bring a flat, tilting, or full motion bracket?");
        const answers = { ...d.answers, bracket: opt.catalogOpt };
        return goto('tv_fireplace', { answers }, null, () => botMenuTwiml(action, "Is your TV going over a fireplace?", [{ say: 'no, not over a fireplace' }, { say: 'yes, over a fireplace' }]));
      }
      case 'tv_fireplace': {
        const yn = botYes(speech, digits);
        if (yn === null) return retry("Sorry, is the TV going over a fireplace — yes or no?");
        const fpOpts = d.catalog.fireplace || [];
        // "TV NOT above a fireplace" contains the substring "above a
        // fireplace" too, so a plain regex test can't tell the two options
        // apart — a label only counts as the POSITIVE one if it also lacks "not".
        const isAboveFireplace = (label) => /above a fireplace/i.test(label) && !/\bnot\b/i.test(label);
        const picked = fpOpts.find(o => isAboveFireplace(o.label) === yn);
        const answers = { ...d.answers, fireplace: picked || { label: yn ? 'TV above a fireplace' : 'TV NOT above a fireplace', price: 0 } };
        return goto('tv_surface', { answers }, null, (nn) => botMenuTwiml(action, "What kind of wall is it going on?", botMenuOptionsFrom(nn.catalog.surface)));
      }
      case 'tv_surface': {
        const opts = botMenuOptionsFrom(d.catalog.surface);
        const opt = botMatchMenu(opts, { digits, speech });
        if (!opt) return retry("Sorry, is the wall drywall, brick, stone or tile, or stucco?");
        const answers = { ...d.answers, surface: opt.catalogOpt };
        const wireOpts = d.catalog.wires || [];
        if (!wireOpts.length) return goto('tv_extras', { answers }, null, (nn) => botOpenTwiml(action, "Would you like to add anything else, like a soundbar install or an Apple TV setup? Just say what you'd like, or say no."));
        return goto('tv_wires', { answers }, null, (nn) => botMenuTwiml(action, "Would you like to hide the wires?", botMenuOptionsFrom(nn.catalog.wires)));
      }
      case 'tv_wires': {
        const opts = botMenuOptionsFrom(d.catalog.wires);
        const opt = botMatchMenu(opts, { digits, speech });
        if (!opt) return retry("Sorry, would you like the wires hidden behind the wall, hidden outside the wall, or left hanging?");
        const answers = { ...d.answers, wires: opt.catalogOpt };
        const sizecat = answers.size && answers.size.sizecat;
        const needsLifting = sizecat && sizecat !== 'small' && (d.catalog.lifting || []).length;
        if (needsLifting) {
          return goto('tv_lifting', { answers }, null, (nn) => botMenuTwiml(action, "Since it's a larger TV, will you be able to help lift it, or should we send a second technician?", botMenuOptionsFrom(nn.catalog.lifting)));
        }
        return goto('tv_extras', { answers }, null, () => botOpenTwiml(action, "Would you like to add anything else, like a soundbar install or an Apple TV setup? Just say what you'd like, or say no."));
      }
      case 'tv_lifting': {
        const opts = botMenuOptionsFrom(d.catalog.lifting);
        const opt = botMatchMenu(opts, { digits, speech });
        if (!opt) return retry("Sorry, will you be able to help lift the TV, or would you like a second technician?");
        const answers = { ...d.answers, lifting: opt.catalogOpt };
        return goto('tv_extras', { answers }, null, () => botOpenTwiml(action, "Would you like to add anything else, like a soundbar install or an Apple TV setup? Just say what you'd like, or say no."));
      }
      case 'tv_extras': {
        const s = speech.toLowerCase();
        let answers = d.answers;
        if (!/\b(no|none|nothing|that's it|that is it|nope)\b/.test(s) && !digits) {
          const opts = botMenuOptionsFrom((d.catalog.extras || []).filter(o => !/^other$/i.test(o.label)));
          const opt = botMatchMenu(opts, { digits: '', speech });
          if (opt) answers = { ...d.answers, extras: opt.catalogOpt };
        }
        return goto('schedule_date', { answers }, null, (nn) => botAskDate(nn, action, session.business_slug));
      }

      // ── Handyman path ──────────────────────────────────────────────────────
      case 'handyman_desc': {
        if (!speech) return retry("Sorry, could you describe what you need done?");
        return goto('handyman_hours', { handymanDesc: speech }, null, () => botOpenTwiml(action, `Got it. About how many hours of work is that, at ${BOT_HANDYMAN_HOURLY} dollars an hour, with a 2 hour minimum? You can say a number.`));
      }
      case 'handyman_hours': {
        const n = parseInt(digits || speech, 10);
        if (!Number.isFinite(n) || n < 1) return retry("Sorry, about how many hours — you can just say a number like 2 or 3?");
        return goto('schedule_date', { handymanHours: Math.max(2, n) }, null, (nn) => botAskDate(nn, action, session.business_slug));
      }

      // ── Scheduling ──────────────────────────────────────────────────────────
      case 'schedule_date': {
        const dates = d._dateChoices || [];
        // Terms include the weekday name (lowercased) so "Thursday" matches
        // even though the menu is numbered — a caller answering with the day
        // name instead of "1/2/3" is at least as likely as using the number.
        const opt = botMatchMenu(dates.map((ds, i) => ({ say: botSpokenDate(ds), terms: [botSpokenDate(ds).split(',')[0].toLowerCase()], dateStr: ds })), { digits, speech });
        if (!opt) return retry("Sorry, which day works best — you can say the number?");
        return goto('schedule_slot', { date: opt.dateStr, _dateChoices: null }, null, (nn) => botAskSlot(nn, session.business_slug, action));
      }
      case 'schedule_slot': {
        const slots = d._slotChoices || [];
        const opt = botMatchMenu(slots.map((s, i) => ({ say: s.label + (botAfterHoursFee(s.slot_key, d.date) > 0 ? ` — that one has an after-hours fee` : ''), terms: [], slot: s })), { digits, speech });
        if (!opt) return retry("Sorry, which time works best — you can say the number?");
        const answers = { ...d.answers };
        return goto('recap', { slotKey: opt.slot.slot_key, slotLabel: opt.slot.label, _slotChoices: null }, null, (nn) => botRecap(nn, action));
      }

      case 'recap': {
        const yn = botYes(speech, digits);
        if (yn === null) return retry("Sorry, does that work for you — yes or no?");
        if (!yn) {
          await botSessionSave(db, sid, { retry_count: 0 });
          return xml(res, botTransfer(line, callerFrom, sid, "No problem — let me connect you with someone who can go over some options."));
        }
        return goto('customer_name', {}, null, () => botOpenTwiml(action, "Great, let's get you booked. Can I get your first and last name?"));
      }

      // ── Customer info ────────────────────────────────────────────────────
      case 'customer_name': {
        if (!speech) return retry("Sorry, could you say your first and last name?");
        const name = speech.replace(/\b\w/g, c => c.toUpperCase());
        const last4 = (session.caller_phone || '').slice(-4);
        return goto('customer_phone', { name }, null, () => last4
          ? botMenuTwiml(action, `Thanks. Is the best number to reach you the one you're calling from, ending in ${last4.split('').join(' ')}?`, [{ say: 'yes, that one' }, { say: 'no, a different number' }])
          : botOpenTwiml(action, "What's the best phone number to reach you?"));
      }
      case 'customer_phone': {
        if (session.caller_phone && !d._phoneAsked) {
          const yn = botYes(speech, digits);
          if (yn === null) return retry("Sorry, is that the right number — yes or no?");
          if (yn) return goto('customer_email', { phone: session.caller_phone }, null, () => botOpenTwiml(action, "What's your email? You can also just say skip."));
          return goto('customer_phone', { _phoneAsked: true }, null, () => botOpenTwiml(action, "What's the best number to reach you?"));
        }
        const phone = botParseDigitsFrom(speech, digits, 10);
        if (!phone) return retry("Sorry, could you say your 10 digit phone number again?");
        return goto('customer_email', { phone }, null, () => botOpenTwiml(action, "What's your email? You can also just say skip."));
      }
      case 'customer_email': {
        const s = speech.toLowerCase();
        const email = /\b(skip|no email|none|don't have)\b/.test(s) ? null : (speech || null);
        return goto('customer_address', { email }, null, () => botOpenTwiml(action, "And what's the street address for the appointment?"));
      }
      case 'customer_address': {
        if (!speech) return retry("Sorry, could you give me the street address again?");
        return goto('book', { address: speech }, null, (nn) => botDoBooking(db, session, nn, line, callerFrom));
      }

      default:
        return xml(res, botTransfer(line, callerFrom, sid, "Sorry, something went wrong on my end — let me connect you with someone."));
    }
  } catch (e) {
    console.error(`[voice_bot_turn] step=${step} failed:`, e.message);
    return xml(res, botTransfer(line, callerFrom, sid, "Sorry, I'm having trouble right now — let me connect you with someone."));
  }
}

// Fetches the soonest 3 open dates (this month, spilling into next month if
// this month is nearly out) and stashes them on the session so schedule_date
// can match the caller's answer against exactly what was just read aloud.
async function botAskDate(d, action, businessSlug) {
  const now = new Date();
  const months = [now, new Date(now.getFullYear(), now.getMonth() + 1, 1)];
  let dates = [];
  for (const m of months) {
    const month = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    try {
      const r = await adminApi('available_dates', { params: { business: businessSlug, month, technician_id: 'any', pool: 'own', postal_code: d.zip } });
      dates = dates.concat(r.dates || []);
    } catch (e) { /* try the next month anyway */ }
    if (dates.length >= 3) break;
  }
  dates = dates.slice(0, 3);
  d._dateChoices = dates;
  if (!dates.length) return botHangup("I'm sorry, we don't have any openings in your area right now. Please call back soon or we'll follow up by text.");
  const menu = dates.map((ds, i) => ({ say: botSpokenDate(ds) }));
  return botMenuTwiml(action, "Let me check the calendar.", menu);
}
function botSpokenDate(dateStr) {
  try {
    const dt = new Date(dateStr + 'T12:00:00');
    return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } catch (_) { return dateStr; }
}
async function botAskSlot(d, businessSlug, action) {
  let slots = [];
  try {
    const r = await adminApi('available_slots', { params: { business: businessSlug, date: d.date, technician_id: 'any', pool: 'own', postal_code: d.zip } });
    slots = r.slots || [];
  } catch (e) { /* fall through to empty */ }
  d._slotChoices = slots;
  if (!slots.length) return botSayRedirect("Sorry, that day just filled up.", action);
  const menu = slots.map(s => ({ say: s.label + (botAfterHoursFee(s.slot_key, d.date) > 0 ? `, which has an after-hours fee` : '') }));
  return botMenuTwiml(action, `Here's what's open ${botSpokenDate(d.date)}.`, menu);
}
function botRecap(d, action) {
  const selections = botBuildSelections(d);
  const subtotal = selections.reduce((s, x) => s + x.price * x.quantity, 0);
  const tax = Math.round(subtotal * BOT_TAX_RATE * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  d._priced = { selections, subtotal, tax, total };
  const what = d.category === 'tv' ? (d.answers.size ? d.answers.size.label + ' TV mount' : 'TV mount') : `${d.handymanHours || 2} hours of handyman work`;
  return botMenuTwiml(action,
    `Okay, I have ${what} on ${botSpokenDate(d.date)}, ${d.slotLabel}. The total before tax is ${botSpokenMoney(total)}. Does that work for you?`,
    [{ say: 'yes, that works' }, { say: 'no' }]);
}
// The actual booking_create call. Runs at the END of a step (not its own
// step) so the caller never sits through a bare "processing" turn — the write
// happens inline and the very next TwiML is either the confirmation or the
// transfer. Returns a TwiML string like every other step (does NOT call
// xml(res,...) itself) so goto()'s single await-then-xml() stays the one
// place a response is ever sent for a turn.
async function botDoBooking(db, session, d, line, callerFrom) {
  const priced = d._priced || (() => { const sel = botBuildSelections(d); const sub = sel.reduce((s, x) => s + x.price * x.quantity, 0); const tax = Math.round(sub * BOT_TAX_RATE * 100) / 100; return { selections: sel, subtotal: sub, tax, total: Math.round((sub + tax) * 100) / 100 }; })();
  const body = {
    business: session.business_slug,
    idempotency_key: `voicebot-${session.call_sid}`,
    customer: {
      name: d.name || 'Phone Customer', phone: d.phone || session.caller_phone || null,
      email: d.email || null, postal_code: d.zip, address_line1: d.address || null,
    },
    service_id: d.category === 'tv' ? d.tvServiceId : d.handymanServiceId,
    technician_id: 'any', pool: 'own',
    scheduled_date: d.date, scheduled_slot: d.slotKey,
    selections: priced.selections, subtotal: priced.subtotal, tax: priced.tax, price: priced.total,
    payment_method: 'card',   // no payment_method_id — same "collect at service" path the human Skip-for-now checkbox uses
    notes: 'Booked by AI Voice Bot (pilot)',
    sms_consent: true,
  };
  try {
    await adminApi('booking_create', { method: 'POST', body });
    await botSessionSave(db, session.call_sid, { step: 'done' });
    return botHangup(`You're all set for ${botSpokenDate(d.date)}, ${d.slotLabel}. The total is ${botSpokenMoney(priced.total)}, and we'll text you a confirmation. Thanks for calling, and we'll see you then!`);
  } catch (e) {
    console.error('[voice_bot] booking_create failed:', e.message, e.data || '');
    await botSessionSave(db, session.call_sid, { retry_count: 0 });
    return botTransfer(line, callerFrom, session.call_sid, "I'm sorry, that time just became unavailable — let me connect you with someone who can find another slot.");
  }
}

// POST /api/analytics?action=sms_inbound — someone texted a tracking number.
// Same shape as handleVoiceInbound: look the number up, log it, then relay the
// text content to whoever the line forwards to (as a plain SMS, not a call) so
// a customer text doesn't just vanish into a number nobody reads. Replies to
// the customer with a short auto-ack so they know a human is coming.
async function handleSmsInbound(req, res) {
  const params = await twilioVoiceParams(req, res, 'sms_inbound');
  if (!params) return;
  const from = tenDigits(params.From);
  const to = tenDigits(params.To);
  const body = (params.Body || '').toString().trim();
  let line = null;
  try {
    const db = serviceClient();
    const { data } = await db.from('tracking_numbers')
      .select('phone, label, business_slug, forward_to, active, after_hours_forward_to, hours_start, hours_end, hours_timezone')
      .eq('phone', to).maybeSingle();
    line = data && data.active ? data : null;

    let business_id = null;
    if (line && line.business_slug) {
      const { data: biz } = await db.from('businesses').select('id').eq('slug', line.business_slug).maybeSingle();
      business_id = biz?.id || null;
    }
    let customer_id = null;
    if (from) {
      const { data: c } = await db.from('customers').select('id').eq('phone', from).limit(1);
      customer_id = (c || [])[0]?.id || null;
    }
    await db.from('calls').insert({
      business_id,
      source: 'twilio',
      kind: 'sms',
      caller_phone: from || 'unknown',
      grasshopper_number: to || null,
      tracking_label: line?.label || null,
      transcript: body || null,
      occurred_at: new Date().toISOString(),
      customer_id,
      status: 'new',
      warnings: line ? null : ['Number is not in tracking_numbers - text still relayed if possible'],
    });
  } catch (e) {
    console.error('[sms_inbound] log failed:', e.message);
  }

  // Same day/night split the call path uses: a text landing at 3am must not
  // wake whoever answers that line during the day.
  const smsTo = destinationFor(line);
  if (line && smsTo && body) {
    try {
      const pretty = from.length === 10 ? `(${from.slice(0, 3)}) ${from.slice(3, 6)}-${from.slice(6)}` : from;
      await sendSMS(smsTo, `Text${line.label ? ` on ${line.label}` : ''} from ${pretty}: ${body}`);
    } catch (e) {
      console.error('[sms_inbound] relay failed:', e.message);
    }
  }

  return xml(res, '<Response><Message>Thanks for reaching out! We got your text and will call you back shortly.</Message></Response>');
}

export default async function handler(req, res) {
  const action = (req.query.action || '').toString();
  if (req.method === 'POST' && action === 'sms_status') return handleTwilioStatus(req, res);
  if (req.method === 'POST' && action === 'sms_inbound') return handleSmsInbound(req, res);
  if (req.method === 'POST' && action === 'email_webhook') return handleResendWebhook(req, res);
  if (req.method === 'POST' && action === 'voice_inbound') return handleVoiceInbound(req, res);
  if (req.method === 'POST' && action === 'voice_whisper') return handleVoiceWhisper(req, res);
  if (req.method === 'POST' && action === 'voice_status') return handleVoiceStatus(req, res);
  if (req.method === 'POST' && action === 'voice_recording') return handleVoiceRecording(req, res);
  if (req.method === 'POST' && action === 'voice_gather') return handleVoiceGather(req, res);
  if (req.method === 'POST' && action === 'voice_bot_start') return handleVoiceBotStart(req, res);
  if (req.method === 'POST' && action === 'voice_bot_turn') return handleVoiceBotTurn(req, res);

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
    if (![...ALL_BUSINESS_SLUGS, 'handy-andy-handyman', 'doms-handyman'].includes(WIDGET)) {
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
          device: null, source: null, browser: null, customer: null, coupon: null, couponSeen: false,
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
        // The exit-intent coupon popup was shown to this visitor ("coupon seen").
        // exit_intent_shown fires the moment the popup renders; applied/dismissed
        // follow it, so shown alone is the trigger signal.
        if (e.step_name === 'exit_intent_shown') s.couponSeen = true;
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
        device: s.device, source: s.source, browser: s.browser, customer: s.customer, coupon: s.coupon, couponSeen: s.couponSeen,
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
