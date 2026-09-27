// api/_lib/pipeline.js
// "Pipeline" -- every customer inquiry as one card, from the first touch to
// Paid (owner approved 2026-09-24: "build it"). Owner + secretaries; never
// the call auditor (refused here, and the action is deliberately NOT on
// admin.js AUDITOR_ADMIN_ACTIONS). One action (admin.js `pipeline`): GET
// builds the board, POST { op } records a person's decision about a card.
// Tables: migration 0141 (pipeline_marks, call_attempts, estimates.call_id,
// calls.inbound_call_id) and 0142 (pipeline_marks.closed_windows).
//
// There is no card table. Cards are computed on every read from rows the CRM
// already writes (calls, Take a Call rows, texts, estimates, bookings,
// callback attempts), so a card can never drift out of sync with the job it
// describes. The only stored state is what a person decided about a card
// (pipeline_marks) and each outbound callback try (call_attempts).
//
// Owner rules this encodes (2026-09-24):
//   - Stages: New lead -> Talked to -> Quoted -> Booked -> Done -> Paid, plus
//     Lost (with a reason).
//   - Card = one inquiry. Later touches from the same phone join the OPEN
//     card; once it is Paid or marked Lost, the next touch opens a new card.
//     Grouped by phone + brand FAMILY (Dom's family vs Handy Andy family vs
//     the owner-only brands): a shopper who rings both brands is two
//     inquiries, and each secretary only ever sees her own family's card.
//   - Every conversation must end in a booking or a sent estimate. Talked to
//     and neither an hour later = a red leak.
//   - Estimate not approved in 7 days -> Lost "No reply after estimate".
//     Missed caller not reached in 2 tries or 48 h -> Lost "Never reached".
//     Both are soft: the customer coming back within 14 days revives the
//     same card.
//   - "Not a lead" (existing customer's question, vendor, wrong number) is not
//     a Lost reason: it hides the card from the board and every count.
//   - Nothing before the phone port (PIPELINE_FLOOR) is shown or counted: the
//     main lines' calls before it never reached the database.
//
// Everything from buildTouches() to buildPipeline() is PURE (plain arrays in,
// a 'now' passed in, no DB) so scripts/pipeline-selftest.mjs can pin every
// rule with fixtures. Only the loaders and pipelineHandler touch Supabase.
import { paymentState } from './payroll.js';
import { allowedSlugsFor, mayUseBusiness, SECRETARY_EXTRA_BUSINESSES } from './staff-access.js';
import { localDayStartUTC } from './time.js';

export const PIPELINE_FLOOR = '2026-09-22T15:00:00Z';
// Exact list and order are the owner's (2026-09-24) -- do not reword.
export const LOST_REASONS = ['Too expensive', 'Went with someone else', 'Just shopping', 'Out of area', "We don't do that", 'No reply after estimate', 'Spam'];
export const STAGES = ['new', 'talked', 'quoted', 'booked', 'completed', 'paid', 'lost'];   // 'done' folded into Booked (owner, 2026-09-26)

const TOLL_FREE = '8889159967';          // the notification sender: every brand's automated texts
// Heather's own phone until 2026-09-18 (she changed numbers). Forwarded calls
// before then rang it, and it is not in staff_users any more.
const HEATHER_OLD_PHONE = '7203711561';
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const LEAK_AFTER_MS = HOUR;
const QUOTE_LOST_MS = 7 * DAY;
const NEVER_REACHED_MS = 48 * HOUR;
const NEW_CALLBACK_MS = 30 * 60 * 1000;   // new leads get a call back within 30 minutes
const NEVER_REACHED_TRIES = 2;
const SOFT_REVIVE_MS = 14 * DAY;
const NEW_CARD_GAP_MS = 30 * DAY;
// Answered-call length rules (owner/audit finding 2026-09-24): a Google Voice
// or carrier voicemail picking up the forwarded leg reads answered=true, so
// under 20 s is a miss, 2 min or more is a real talk, and the band between
// needs a person to say which (Talked / Voicemail buttons on the card).
const TALK_MIN_SEC = 20;
const TALK_SURE_SEC = 120;
// A forwarded call still ringing or in progress has answered=null until the
// <Dial> ends (analytics.js voice_status) -- only an OLD null is a voicemail
// line or the AI bot.
const IN_PROGRESS_MS = 30 * MIN;
const ATTEMPT_PENDING_MS = 5 * MIN;      // a bridge call this fresh may still be ringing
const LOOKBACK_DAYS = 120;               // grouping context kept behind the 30-day view
const CARD_CAP = 600;
const TIMELINE_CAP = 40;
const AUTO_TEXT_OTHER_CAP = 3;           // on-the-way / review / auto-ack texts shown per card
const CHICAGO = 'America/Chicago';       // "today" on the board (owner, 2026-09-24)
const RANGE_DAYS = { today: 0, yesterday: 1, 7: 6, 30: 29 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_KEY = /^c_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_NAME = /\(ignore\)|e2e test/i;
const REPEATED = /^(\d)\1{9}$/;

// ── Small helpers ───────────────────────────────────────────────────────────
function msOf(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}
const iso = (n) => (n == null ? null : new Date(n).toISOString());
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const cents = (n) => Math.round(Number(n) * 100) / 100;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const clean = (s, max) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').slice(0, max);
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// Any stored spelling -> the last 10 digits ('' when there aren't 10). An
// "ext 1234" tail is dropped first so it can't shift the digits.
export function phone10(p) {
  const s = String(p == null ? '' : p).replace(/\s*(?:ext\.?|extension|x)\s*\d+\s*$/i, '');
  const d = s.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? d : '';
}
// Call rows are stricter (owner rule 2026-09-24): 'unknown', a 12-digit
// foreign number or anything else that isn't a US 10-digit number opens nothing.
function strictPhone(p) {
  const d = String(p == null ? '' : p).replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return '';
}
export function prettyPhone10(d) {
  return d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
// The spellings phones are actually stored in (customers.phone and
// estimates.customer_phone are never normalised on write).
export function phoneVariants(d) {
  return [d, '+1' + d, '1' + d, `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`];
}
const DOMS_FAMILY = new Set(['doms', ...(SECRETARY_EXTRA_BUSINESSES.doms || [])]);
const HA_FAMILY = new Set(['handy-andy', ...(SECRETARY_EXTRA_BUSINESSES['handy-andy'] || [])]);
// Brand family: Dom's and the lead-gen brands Joey answers; Handy Andy and
// the lead-gen brands Heather answers; and 'owner' for every brand no
// secretary works (lainstall, latvpro, tvmountinglosangeles -- staff-access.js
// keeps them owner-only). An owner-only brand's calls must never fold into a
// Handy Andy card Heather can see: "showing her someone else's customer would
// be the real mistake" (admin.js businessForOurPhone; review 2026-09-24).
// website_form estimates are filed under doms on purpose (api/migrate.js) and
// so stay in the Dom's family.
export function familyOf(slug) {
  if (!slug) return null;
  if (DOMS_FAMILY.has(slug)) return 'doms';
  return HA_FAMILY.has(slug) ? 'handy-andy' : 'owner';
}
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function fmtAgo(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.round(ms / HOUR);
  return h < 48 ? `${h}h` : `${Math.round(ms / DAY)}d`;
}
const dollars = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
// A name that is really just the phone number again (36 of 82 estimates) is no name.
function realName(s) {
  const t = clean(s, 80);
  return t && !/^[\d\s()+.\-]+$/.test(t) ? t : null;
}
function lineTotal(items) {
  let sum = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const q = it && (it.qty != null ? it.qty : it.quantity);
    const qty = Number.isFinite(Number(q)) && Number(q) > 0 ? Number(q) : (q == null ? 1 : 0);
    sum += qty * (Number(it && it.unit_price) || 0);
  }
  return cents(sum);
}
function autoKind(body) {
  if (/sorry we missed your call/i.test(body)) return 'missed_call';
  if (/here.s your estimate/i.test(body)) return 'estimate';
  if (/you.re booked/i.test(body)) return 'booked';
  if (/thanks for your text/i.test(body)) return 'ack';
  if (/en route/i.test(body)) return 'en_route';
  if (/how did we do|review/i.test(body)) return 'review';
  return 'other';
}
const TYPE_RANK = { call_in: 0, text_in: 1, wizard: 2, estimate: 3, booking: 4, attempt: 5, text_out_staff: 6, text_auto: 7 };
function byTime(a, b) {
  return (a.atMs - b.atMs) || ((TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9)) || String(a.id).localeCompare(String(b.id));
}
const isCustomerTouch = (t) => t.type === 'call_in' || t.type === 'text_in' || t.type === 'wizard';

// ── Lookups shared by every step ────────────────────────────────────────────
export function makeContext(raw) {
  const bizById = new Map(), bizBySlug = new Map();
  for (const b of raw.businesses || []) { bizById.set(b.id, b); bizBySlug.set(b.slug, b); }
  const lines = new Map();
  for (const l of raw.tracking || []) {
    const p = phone10(l.phone); if (!p) continue;
    lines.set(p, { phone: p, slug: l.business_slug || null, name: l.display_name || null, active: l.active !== false });
  }
  // Who a handset belongs to: staff_users plus Heather's old phone.
  const handsetName = new Map(), handsetsOf = new Map();
  const addHandset = (p, name) => {
    if (!p || !name) return;
    handsetName.set(p, name);
    if (!handsetsOf.has(name)) handsetsOf.set(name, new Set());
    handsetsOf.get(name).add(p);
  };
  for (const s of raw.staff || []) addHandset(phone10(s.phone), s.name);
  addHandset(HEATHER_OLD_PHONE, 'Heather');
  // Never a customer (owner rule 2026-09-24): silent (the owner's own test
  // phone) and blocked numbers, staff handsets, our own lines.
  const excluded = new Set([TOLL_FREE, ...handsetName.keys(), ...lines.keys()]);
  for (const r of raw.silent || []) { const p = phone10(r.phone); if (p) excluded.add(p); }
  for (const r of raw.blocked || []) { const p = phone10(r.phone); if (p) excluded.add(p); }
  const slugOf = (row) => (row && row.business && row.business.slug) || (row && bizById.get(row.business_id) && bizById.get(row.business_id).slug) || null;
  const isExcluded = (p) => !p || excluded.has(p) || REPEATED.test(p);
  return { bizById, bizBySlug, lines, handsetName, handsetsOf, slugOf, isExcluded };
}

// ── Touches: every row that says something about an inquiry ─────────────────
// A touch = { type, id, atMs, phone, family, slug, canOpen, ... }.
//   call_in        inbound Twilio call            opens a card
//   wizard         Take a Call script row         opens a card (always a talk)
//   text_in        customer text                  opens only on a tracking line
//   text_out_staff staff text reply               joins only
//   text_auto      automated text                 joins only (timeline)
//   attempt        outbound callback try          joins only
//   estimate       estimate                       opens a card
//   booking        booking                        opens a card
export function buildTouches(raw, ctx = makeContext(raw), now = Date.now()) {
  const nowMs = msOf(now);
  const talkIds = new Set(), noTalkIds = new Set();
  for (const m of raw.marks || []) {
    for (const id of m.talk_call_ids || []) talkIds.add(id);
    for (const id of m.no_talk_call_ids || []) noTalkIds.add(id);
  }
  // Jiyah's "voicemail / not a call" skips in the audit queue.
  const skipIds = new Set((raw.auditSkips || []).map((s) => s.call_id));
  const bookingById = new Map((raw.bookings || []).map((b) => [b.id, b]));
  const estimateById = new Map((raw.estimates || []).map((e) => [e.id, e]));
  const estimatesByCall = new Map();
  for (const e of raw.estimates || []) if (e.call_id) (estimatesByCall.get(e.call_id) || estimatesByCall.set(e.call_id, []).get(e.call_id)).push(e);
  const eventsByCall = new Map();
  for (const ev of raw.callEvents || []) (eventsByCall.get(ev.call_id) || eventsByCall.set(ev.call_id, []).get(ev.call_id)).push(ev);
  const touches = [], noPhone = [];
  const calls = raw.calls || [];

  const inbound = [];
  for (const c of calls) {
    if (c.kind !== 'inbound' || (c.source && c.source !== 'twilio')) continue;
    if (c.status === 'ignored' && c.handled_by === 'Blocked number') continue;
    const phone = strictPhone(c.caller_phone);
    if (ctx.isExcluded(phone)) continue;
    const atMs = msOf(c.occurred_at); if (atMs == null) continue;
    const lineP = phone10(c.grasshopper_number); const line = ctx.lines.get(lineP);
    // An inactive line's row can carry no business_id -- fall back to the line's brand.
    const slug = ctx.slugOf(c) || (line && line.slug) || null;
    const biz = slug && ctx.bizBySlug.get(slug);
    // Still ringing / talking only while it could be: forwarded to a handset
    // (a line with no forward_to goes straight to voicemail and stays null
    // for good) and not ended yet (the recording callback writes duration_sec
    // when a voicemail or unforwarded call hangs up). Review 2026-09-24.
    const live = c.answered == null && c.duration_sec == null && !!phone10(c.forwarded_to) && c.status !== 'ignored';
    inbound.push({ c, id: c.id, phone, slug, family: familyOf(slug), atMs, fwd: phone10(c.forwarded_to), line: lineP || null,
      lineName: (line && line.name) || (biz && biz.name) || null, inProgress: live && nowMs - atMs < IN_PROGRESS_MS });
  }
  const inboundById = new Map(inbound.map((x) => [x.id, x]));

  // Take a Call rows first: an inbound call the script ran for is a real talk.
  const wizardLinked = new Set();
  for (const live of calls) {
    if (live.kind !== 'live') continue;
    // Opened on the greet card and closed again: a misclick, not a call.
    if (live.reached_step === 'greet' && !live.resolution && !live.booking_id) continue;
    const atMs = msOf(live.occurred_at); if (atMs == null) continue;
    const evs = eventsByCall.get(live.id) || [];
    const started = evs.find((e) => e.event === 'started');
    // Who ran it: the 'started' actor. handled_by is overwritten by whoever
    // resolves the row and nulled by Reopen (audit finding 2026-09-24).
    const person = (started && started.actor) || live.handled_by || null;
    const slug = ctx.slugOf(live), family = familyOf(slug);
    let phone = phone10(live.caller_phone);
    if (!phone && live.booking_id) { const b = bookingById.get(live.booking_id); phone = phone10(b && b.customer && b.customer.phone); }
    if (!phone) for (const ev of evs) {
      if (ev.event !== 'estimate_sent') continue;
      const e = estimateById.get(ev.meta && ev.meta.estimate_id);
      const p = e && phone10(e.customer_phone); if (p) { phone = p; break; }
    }
    if (!phone) for (const e of estimatesByCall.get(live.id) || []) { const p = phone10(e.customer_phone); if (p) { phone = p; break; } }
    let link = live.inbound_call_id ? inboundById.get(live.inbound_call_id) || null : null;
    // A stored link to a DIFFERENT customer's call (the start auto-linked
    // whatever rang her last, then she typed this customer's number) proves
    // nothing about that call: it must not turn it into a talk. Review 2026-09-24.
    if (link && phone && link.phone !== phone) link = null;
    if (!link) link = matchInbound(inbound, ctx, person, family, atMs, phone, nowMs);
    if (link) { wizardLinked.add(link.id); if (!phone) phone = link.phone; }
    if (phone && ctx.isExcluded(phone)) continue;
    const t = { type: 'wizard', id: live.id, atMs, phone: phone || null, slug, family, canOpen: true, staff: person, talk: 'yes', endMs: atMs,
      live: { resolution: live.resolution || null, step: live.reached_step || null, quoted: num(live.quoted_total), bookingId: live.booking_id || null, inboundId: link ? link.id : null } };
    if (phone) touches.push(t); else noPhone.push(t);
  }

  for (const x of inbound) {
    const c = x.c, dur = num(c.duration_sec);
    let talk = null, why;
    // Nobody picked up first: no stored Talked mark can turn a missed call, or
    // one no person ever answered, into a conversation (review 2026-09-24).
    if (c.answered === false) why = 'missed';
    else if (c.answered == null && !x.inProgress) why = 'no_person';   // voicemail-only line or the AI bot
    else if (talkIds.has(x.id)) { talk = 'yes'; why = 'marked_talk'; }
    else if (noTalkIds.has(x.id)) why = 'marked_voicemail';
    else if (skipIds.has(x.id)) why = 'audit_voicemail';
    else if (c.answered == null) { talk = wizardLinked.has(x.id) ? 'yes' : 'unconfirmed'; why = 'in_progress'; }
    else if (dur != null && dur < TALK_MIN_SEC) why = 'short';
    else if (wizardLinked.has(x.id)) { talk = 'yes'; why = 'wizard'; }
    else if (dur != null && dur >= TALK_SURE_SEC) { talk = 'yes'; why = 'long'; }
    else { talk = 'unconfirmed'; why = 'unconfirmed'; }
    touches.push({ type: 'call_in', id: x.id, atMs: x.atMs, phone: x.phone, slug: x.slug, family: x.family, canOpen: true,
      staff: ctx.handsetName.get(x.fwd) || null, talk, why, dur, answered: c.answered, line: x.line, lineName: x.lineName,
      endMs: x.atMs + (dur || 0) * 1000, wizard: wizardLinked.has(x.id), rec: !!c.recording_url,
      // Left a voicemail (owner, 2026-09-26): a missed call we recorded, or an
      // answered call the office/auditor marked as voicemail.
      vm: (c.answered === false && !!c.recording_url) || why === 'marked_voicemail' || why === 'audit_voicemail' });
  }

  for (const m of raw.messages || []) {
    const phone = phone10(m.customer_phone); if (ctx.isExcluded(phone)) continue;
    const atMs = msOf(m.created_at); if (atMs == null) continue;
    const our = phone10(m.our_phone); const line = ctx.lines.get(our);
    const slug = ctx.slugOf(m) || (line && line.slug) || null;
    const body = String(m.body || '').replace(/\s+/g, ' ').trim();
    const base = { id: m.id, atMs, phone, slug, family: familyOf(slug), our: our || null, lineName: (line && line.name) || null, body, endMs: atMs };
    if (m.direction === 'in') {
      // Texts to the toll-free are replies to our automated texts (existing
      // customers): they join a card but never open one.
      touches.push({ ...base, type: 'text_in', canOpen: !!line && our !== TOLL_FREE });
    } else if (!m.sent_by || m.sent_by === 'automated') {
      touches.push({ ...base, type: 'text_auto', canOpen: false, auto: autoKind(body), failed: m.status === 'failed' || m.status === 'undelivered' });
    } else {
      touches.push({ ...base, type: 'text_out_staff', canOpen: false, staff: m.sent_by });
    }
  }

  for (const e of raw.estimates || []) {
    const stamps = [e.texted_at, e.emailed_at, e.contacted_at].map(msOf).filter((v) => v != null);
    // A request nobody ever answered, auto-archived after 7 days (the
    // Estimates list does it on its own): not an inquiry we worked, so it
    // counts for nothing. It still stays a touch, so a card it opened keeps
    // its key -- and its Not a lead / Lost marks -- when the archive happens;
    // a card made of nothing else is dropped (groupCards). Review 2026-09-24.
    const archivedUnsent = e.status === 'archived' && !stamps.length;
    const phone = phone10(e.customer_phone); if (ctx.isExcluded(phone)) continue;
    if (TEST_NAME.test(e.customer_name || '')) continue;
    const atMs = msOf(e.created_at); if (atMs == null) continue;
    const slug = ctx.slugOf(e);
    const sent = e.status === 'contacted' || e.status === 'scheduled' || stamps.length > 0;
    // The quote clock (owner rule 2026-09-24): a phone estimate goes out the
    // moment it is created; a web one when it was FIRST sent. Resends
    // overwrite the stamps, so the earliest left is the best we have.
    const sentMs = !sent ? null : e.source === 'manual' ? atMs : (stamps.length ? Math.min(...stamps) : atMs);
    const sub = lineTotal(e.line_items);
    const total = num(e.approved_total) ?? cents(sub + Math.round(sub * (Number(e.tax_rate) || 0) * 100) / 100);
    const opened = [msOf(e.text_opened_at), msOf(e.email_opened_at)].filter((v) => v != null);
    touches.push({ type: 'estimate', id: e.id, atMs, phone, slug, family: familyOf(slug), canOpen: true, name: realName(e.customer_name), endMs: atMs,
      ...(archivedUnsent ? { archivedUnsent: true } : {}),
      est: { source: e.source || null, status: e.status || null, sentMs,
        webRequest: (e.source === 'widget' || e.source === 'website_form') && e.status === 'new' && !sent,
        approvedMs: archivedUnsent ? null : msOf(e.approved_at),
        // 'declined' is the office's "Not a fit" -- customers have no decline button.
        declinedMs: e.status === 'declined' ? (msOf(e.updated_at) ?? atMs) : null,
        total: total > 0 ? total : null, openedMs: opened.length ? Math.min(...opened) : null,
        couponMs: msOf(e.followup_emailed_at), callId: e.call_id || null, label: e.service_label || null, bounced: e.email_status === 'bounced',
        items: (Array.isArray(e.line_items) ? e.line_items : []).slice(0, 30).map((it) => ({ name: String((it && (it.name || it.description)) || 'Item').slice(0, 120), qty: Number(it && (it.qty ?? it.quantity)) || 1, price: Number(it && it.unit_price) || 0 })) } });
  }

  for (const b of raw.bookings || []) {
    if (b.source === 'import') continue;
    // bookings has no phone column -- the customer row's phone is the key.
    const phone = phone10(b.customer && b.customer.phone); if (ctx.isExcluded(phone)) continue;
    if (TEST_NAME.test((b.customer && b.customer.name) || '')) continue;
    const atMs = msOf(b.created_at); if (atMs == null) continue;
    const slug = ctx.slugOf(b);
    const completed = b.status === 'completed';
    const completedMs = completed ? (msOf(b.completed_at) ?? msOf(b.paid_at) ?? msOf(b.updated_at) ?? atMs) : null;
    // Paid = completed and payroll's paymentState isn't 'deferred' (owner rule
    // 2026-09-24): a $0 warranty/GDS job counts once it's done, a FUTURE $0
    // job does not, and a priced job needs its payment. Done = completed but
    // still deferred.
    const paid = completed && paymentState(b) !== 'deferred';
    const paidAt = msOf(b.paid_at);
    const paidMs = paid ? Math.max(completedMs, paidAt ?? completedMs) : null;
    const cancelledMs = b.status === 'cancelled' ? (msOf(b.cancelled_at) ?? msOf(b.updated_at) ?? atMs) : null;
    const md = b.metadata || {};
    touches.push({ type: 'booking', id: b.id, atMs, phone, slug, family: familyOf(slug), canOpen: true, name: realName(b.customer && b.customer.name), endMs: atMs,
      staff: md.booked_by || null,
      bk: { status: b.status || null, source: b.source || null, scheduledMs: msOf(b.scheduled_at), price: num(b.price), amountPaid: num(b.amount_paid),
        paid, paidMs, completedMs, cancelledMs, tech: (b.technician && b.technician.name) || null,
        estimateId: md.source_estimate_id || null, bookedBy: md.booked_by || null,
        reviewMs: msOf(b.reviewed_at) ?? msOf(b.review_clicked_at), reviewRating: num(b.review_rating),
        gotReview: !!(b.reviewed_at || num(b.review_rating)),
        rv: { sms_sent: b.review_sms_sent_at || null, sms_delivered: b.review_sms_delivered_at || null, sms_status: b.review_sms_status || null, sms_clicked: b.review_sms_clicked_at || null,
          email_sent: b.review_email_sent_at || null, email_count: b.review_email_count || 0, email_delivered: b.review_email_delivered_at || null, email_status: b.review_email_status || null, email_clicked: b.review_email_clicked_at || null,
          page_opened: b.review_clicked_at || null, call_status: b.review_call_status || null, call_at: b.review_call_at || null, call_by: b.review_call_by || null } } });
  }

  for (const a of raw.attempts || []) {
    const phone = phone10(a.phone); if (ctx.isExcluded(phone)) continue;
    const atMs = msOf(a.started_at); if (atMs == null) continue;
    const slug = ctx.slugOf(a);
    const dur = num(a.duration_sec);
    touches.push({ type: 'attempt', id: a.id, atMs, phone, slug, family: familyOf(slug), canOpen: false, staff: a.staff_name || null,
      cardKey: CARD_KEY.test(a.card_key || '') ? a.card_key : null, talk: a.talked === true ? 'yes' : null, endMs: atMs + (dur || 0) * 1000,
      att: { talked: a.talked == null ? null : !!a.talked, dur, source: a.source || null, staffStatus: a.staff_status || null,
        dialStatus: a.dial_status || null, endedMs: msOf(a.ended_at), setBy: a.talked_set_by || null,
        // Her own phone never connected, so the customer was never dialed:
        // not a try at reaching them. Her own "No answer" tap on the Did you
        // talk to them? chips doesn't change that -- nobody rang the customer
        // (review 2026-09-24); only her "Yes" does. Manual log_attempt rows
        // have no staff_status and always count.
        noRing: !!a.staff_status && a.staff_status !== 'completed' && a.talked !== true } });
  }

  // A touch with no brand of its own (a reply to the toll-free, an automated
  // text with no business) takes the family of that phone's nearest earlier
  // touch, else its first later one.
  touches.sort(byTime);
  const firstFam = new Map(), lastFam = new Map();
  for (const t of touches) if (t.family && !firstFam.has(t.phone)) firstFam.set(t.phone, t.family);
  for (const t of touches) {
    if (t.family) { lastFam.set(t.phone, t.family); continue; }
    t.family = lastFam.get(t.phone) || firstFam.get(t.phone) || (t.canOpen ? 'handy-andy' : null);
  }
  return { touches: touches.filter((t) => t.family), noPhone, ctx };
}

// Which inbound call a Take a Call row was for, when the row doesn't say
// (calls.inbound_call_id): same person, whose handset the call rang, answered
// (or still in progress), started 10 min before to 1 min after the script,
// same brand family; the nearest one before it wins. Checked against the
// script's own customer phone when it has one.
function matchInbound(inbound, ctx, person, family, atMs, phone, nowMs) {
  const hs = person ? ctx.handsetsOf.get(person) : null;
  if (!hs) return null;
  let best = null;
  for (const x of inbound) {
    if (!hs.has(x.fwd) || x.family !== family) continue;
    if (x.c.answered === true) { const d = num(x.c.duration_sec); if (d != null && d < TALK_MIN_SEC) continue; }
    else if (!(x.c.answered == null && x.inProgress)) continue;
    if (x.atMs < atMs - 10 * MIN || x.atMs > atMs + MIN) continue;
    if (phone && x.phone !== phone) continue;
    if (!best || x.atMs > best.atMs) best = x;
  }
  return best;
}

// ── Stage at a moment (first match wins) ────────────────────────────────────
function talksOf(S) {
  const out = []; let texted = false;
  for (const t of S) {
    if (t.type === 'text_in') texted = true;
    if (t.type === 'wizard') out.push({ t, atMs: t.atMs, endMs: t.atMs, sure: true });
    else if (t.type === 'call_in' && t.talk) out.push({ t, atMs: t.atMs, endMs: t.endMs, sure: t.talk === 'yes' });
    else if (t.type === 'attempt' && t.talk === 'yes') out.push({ t, atMs: t.atMs, endMs: t.endMs, sure: true });
    // A staff text is a conversation only once the customer has texted in on this card.
    else if (t.type === 'text_out_staff' && texted) out.push({ t, atMs: t.atMs, endMs: t.atMs, sure: true });
  }
  return out;
}
function isFailedTry(t, atMs) {
  const a = t.att;
  if (a.talked === true || a.noRing) return false;
  if (a.talked == null && a.endedMs == null && atMs - t.atMs < ATTEMPT_PENDING_MS) return false;   // still ringing
  return true;
}
// The customer coming back after a quote (a call, a text, a script call, or
// us reaching them) is a reply: the 7-day clock runs from the latest one.
function lastReply(S, afterMs) {
  let last = null;
  for (const t of S) if (t.atMs > afterMs && (isCustomerTouch(t) || (t.type === 'attempt' && t.talk === 'yes'))) last = t.atMs;
  return last;
}
// A customer call we missed (or a text to one of our lines nobody answered)
// after `sinceMs` that nobody has talked to / replied to since: the card
// still owes a callback. Replies to the toll-free ("Thanks!" to a booking
// confirmation) are left to the Messages tab rather than turning a card red.
function openCallback(S, sinceMs) {
  let pending = null;
  for (const t of S) {
    if (t.atMs <= sinceMs) continue;
    if ((t.type === 'call_in' && !t.talk) || (t.type === 'text_in' && t.canOpen)) pending = t;
    // Opening the script ON the voicemail call itself is not a reply (owner 2026-09-27).
    else if (pending && ((t.type === 'wizard' && t.live.inboundId !== pending.id) || (t.type === 'call_in' && t.talk) || (t.type === 'attempt' && t.talk === 'yes') || t.type === 'text_out_staff')) pending = null;
  }
  return pending;
}

export function evalStage(card, at, mark) {
  const atMs = msOf(at);
  const T = card.touches.filter((t) => !t.timelineOnly && t.atMs <= atMs);
  const m = mark || null;
  // 1. Not a lead: gone from the board and every count.
  if (m && m.not_a_lead) {
    const n = msOf(m.not_a_lead_at);
    if (n == null || n <= atMs) return { stage: 'hidden', stageMs: n ?? card.openedMs };
  }
  const r = m ? msOf(m.reopened_at) : null;
  const reop = r != null && r <= atMs ? r : null;
  // 2. Marked lost by a person (and not reopened since).
  const lostMs = m && m.lost_reason ? msOf(m.lost_at) : null;
  if (lostMs != null && lostMs <= atMs && !(reop != null && reop >= lostMs)) {
    return { stage: 'lost', stageMs: lostMs, lost: { reason: m.lost_reason, auto: false, note: m.lost_note || '', by: m.lost_by || null, atMs: lostMs } };
  }
  // Automatic Lost is soft: a Reopen after the moment cancels it.
  const autoLost = (reason, whenMs) => (reop != null && reop >= whenMs) ? null
    : { stage: 'lost', stageMs: whenMs, lost: { reason, auto: true, note: '', by: null, atMs: whenMs } };

  // 3. Bookings: the latest one still standing decides.
  let S = T;
  const bks = T.filter((t) => t.type === 'booking');
  if (bks.length) {
    const standing = bks.filter((t) => t.bk.cancelledMs == null || t.bk.cancelledMs > atMs);
    if (standing.length) {
      const b = standing[standing.length - 1];
      if (b.bk.paidMs != null && b.bk.paidMs <= atMs) return { stage: 'paid', stageMs: b.bk.paidMs, booking: b };
      if (b.bk.completedMs != null && b.bk.completedMs <= atMs) return { stage: 'booked', doneUnpaid: true, stageMs: b.bk.completedMs, booking: b, callback: openCallback(T, b.bk.completedMs) };
      return { stage: 'booked', stageMs: b.atMs, booking: b, callback: openCallback(T, b.atMs) };
    }
    // Every booking cancelled. Unless the customer came back after (a new
    // estimate, call or text -- judged afresh from there), it's Lost. A reply
    // to the toll-free ("ok thanks" to the cancellation text) is not coming
    // back, and neither is an archived request nobody answered (review 2026-09-24).
    const lastCancel = Math.max(...bks.map((t) => t.bk.cancelledMs));
    const after = T.filter((t) => t.atMs > lastCancel && t.type !== 'booking');
    if (!after.some((t) => (t.type === 'estimate' && !t.archivedUnsent) || t.type === 'call_in' || t.type === 'wizard' || (t.type === 'text_in' && t.canOpen))) {
      const l = autoLost('Job cancelled', lastCancel); if (l) return l;
      S = T.filter((t) => t.type !== 'booking');
    } else S = after;
  }
  const ests = S.filter((t) => t.type === 'estimate' && !t.archivedUnsent);
  // 4. Approved but not on the schedule yet (office "Convert to job" pending).
  const approved = ests.filter((t) => t.est.approvedMs != null && t.est.approvedMs <= atMs);
  if (approved.length) {
    const e = approved[approved.length - 1];
    return { stage: 'booked', stageMs: e.est.approvedMs, estimate: e, approvedNoJob: true, callback: openCallback(T, e.est.approvedMs) };
  }
  // 5. The office's "Not a fit".
  const lastEst = ests[ests.length - 1];
  if (lastEst && lastEst.est.declinedMs != null && lastEst.est.declinedMs <= atMs) {
    const l = autoLost("We don't do that", lastEst.est.declinedMs); if (l) return l;
  }
  // 6. Quoted; 7 days with no approval and no word from them -> Lost.
  let sent = ests.filter((t) => t.est.sentMs != null && t.est.sentMs <= atMs);
  if (sent.length) {
    const e = sent[sent.length - 1];
    const clock = Math.max(e.est.sentMs, reop ?? -Infinity, lastReply(S, e.est.sentMs) ?? -Infinity);
    if (atMs - clock > QUOTE_LOST_MS) { const l = autoLost('No reply after estimate', clock + QUOTE_LOST_MS); if (l) return l; }
    return { stage: 'quoted', stageMs: e.est.sentMs, estimate: e, clockMs: clock, callback: openCallback(S, e.est.sentMs) };
  }
  // 7. A web estimate request nobody has answered yet.
  const web = ests.filter((t) => t.est.webRequest);
  if (web.length) return { stage: 'new', stageMs: web[0].atMs, webRequest: web[web.length - 1] };
  // 8. Talked to, but no booking or sent estimate: a leak after an hour.
  const talks = talksOf(S);
  if (talks.length) {
    const first = talks[0];
    const leakFrom = Math.max(first.endMs, reop ?? -Infinity);
    return { stage: 'talked', stageMs: first.atMs, leak: atMs - leakFrom > LEAK_AFTER_MS, unconfirmed: talks.every((x) => !x.sure),
      onCall: talks.every((x) => x.t.why === 'in_progress'), firstTalk: first };
  }
  // 9. Only missed touches. The callback clock (2 failed tries or 48 h) runs
  // from their LATEST call/text -- ringing again restarts it -- or a Reopen.
  const opened = S.length ? S[0].atMs : card.openedMs;
  let lastCust = null;
  for (const t of S) if (t.type === 'call_in' || t.type === 'text_in') lastCust = t;
  const restart = Math.max(opened, reop ?? -Infinity, lastCust ? lastCust.atMs : -Infinity);
  const tries = S.filter((t) => t.type === 'attempt' && t.atMs >= restart && isFailedTry(t, atMs));
  if (tries.length >= NEVER_REACHED_TRIES) {
    const l = autoLost('Never reached', tries[NEVER_REACHED_TRIES - 1].atMs); if (l) return { ...l, tries: tries.length };
  }
  if (atMs - restart > NEVER_REACHED_MS) {
    const l = autoLost('Never reached', restart + NEVER_REACHED_MS); if (l) return { ...l, tries: tries.length };
  }
  return { stage: 'new', stageMs: opened, tries: tries.length, lastCustomer: lastCust };
}

// ── Grouping touches into cards ─────────────────────────────────────────────
function newCard(t, index) {
  return { key: 'c_' + t.id, phone: t.phone || null, family: t.family, opener: t, openedMs: t.atMs, lastMs: t.atMs, touches: [t], index };
}
function addTouch(card, t, timelineOnly) {
  card.touches.push(timelineOnly ? { ...t, timelineOnly: true } : t);
  if (!timelineOnly) card.lastMs = Math.max(card.lastMs, t.atMs);
}
// Every span the card sat closed (marked Lost or Not a lead) before a Reopen
// or a fresh mark replaced it (pipelineOp keeps them, migration 0142). The
// marks row only remembers the LATEST lost_at / reopened_at, so without these
// a card marked Lost again later would look open back then and quietly
// swallow the separate card a touch in that span opened (review 2026-09-24).
function inClosedWindow(mark, atMs) {
  const ws = mark && Array.isArray(mark.closed_windows) ? mark.closed_windows : [];
  return ws.some((w) => { const f = msOf(w && w.from), to = msOf(w && w.to); return f != null && to != null && f <= atMs && atMs < to; });
}
// May a touch at atMs still join this card? Not once it's Paid, marked Lost,
// Not a lead, auto-Lost more than 14 days ago, or quiet for 30 days.
function canJoin(card, atMs, mark) {
  if (inClosedWindow(mark, atMs)) return false;
  // "Quiet" runs from the job date while a job is still standing (not
  // cancelled, not paid): a job booked 5 weeks out, or done and awaiting
  // payment, has no touches while it waits, and the customer calling about
  // it is the same inquiry (review 2026-09-24).
  let active = card.lastMs;
  for (const t of card.touches) {
    if (t.type !== 'booking' || t.timelineOnly || t.atMs > atMs) continue;
    const b = t.bk;
    if ((b.cancelledMs != null && b.cancelledMs <= atMs) || (b.paidMs != null && b.paidMs <= atMs)) continue;
    active = Math.max(active, b.scheduledMs ?? t.atMs);
  }
  if (atMs - active > NEW_CARD_GAP_MS) return false;
  const st = evalStage(card, atMs, mark);
  if (st.stage === 'hidden' || st.stage === 'paid') return false;
  if (st.stage === 'lost') return st.lost.auto && atMs - st.lost.atMs <= SOFT_REVIVE_MS;
  return true;
}
// Closed by a person (or Paid) at atMs -- nothing may join it then, whatever it's about.
function hardClosed(card, atMs, mark) {
  if (inClosedWindow(mark, atMs)) return true;
  const st = evalStage(card, atMs, mark);
  return st.stage === 'hidden' || st.stage === 'paid' || (st.stage === 'lost' && !st.lost.auto);
}

// Touches -> cards, each with its stage evaluated at `now`. Pure.
export function groupCards(touches, marks = [], now = Date.now(), noPhone = []) {
  const nowMs = msOf(now);
  const markBy = new Map((marks || []).map((m) => [m.card_key, m]));
  const byId = new Map(touches.map((t) => [t.id, t]));
  const groups = new Map();
  for (let t of [...touches].sort(byTime)) {
    if (!t.phone || !t.family || t.atMs > nowMs) continue;
    // A try from a card's Call button follows that card even if the line it
    // rang from sits in the other brand family.
    if (t.cardKey) { const op = byId.get(t.cardKey.slice(2)); if (op && op.phone === t.phone && op.family !== t.family) t = { ...t, family: op.family }; }
    const k = t.phone + '|' + t.family;
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }
  const cards = [];
  for (const list of groups.values()) {
    const mine = []; let open = null;
    for (const t of list) {
      // A try placed from a card's own Call button belongs to that card.
      if (t.cardKey) { const target = mine.find((c) => c.key === t.cardKey); if (target) { addTouch(target, t, false); continue; } }
      // An estimate-approval booking belongs to its estimate's card. The
      // booking row is written ~3 s BEFORE approved_at is stamped, so judged
      // by time alone a quote auto-Lost over 14 days ago would get a second,
      // Booked card and keep "Approved — put it on the schedule" forever
      // (review 2026-09-24). Not onto a card a person closed, or one Paid.
      if (t.type === 'booking' && t.bk.estimateId) {
        const target = mine.find((c) => c.touches.some((x) => x.type === 'estimate' && x.id === t.bk.estimateId));
        if (target && !hardClosed(target, t.atMs, markBy.get(target.key))) { addTouch(target, t, false); continue; }
      }
      if (open && canJoin(open, t.atMs, markBy.get(open.key))) { addTouch(open, t, false); continue; }
      if (t.canOpen) { open = newCard(t, mine.length); mine.push(open); continue; }
      // Can't open a card: kept on the latest one's timeline (it has closed), else dropped.
      if (open) addTouch(open, t, true);
    }
    // A card made of nothing but archived, never-answered requests was no
    // inquiry (buildTouches) -- it only kept the grouping and keys stable.
    const kept = mine.filter((c) => c.touches.some((t) => !t.timelineOnly && !t.archivedUnsent));
    kept.forEach((c, i) => { c.index = i; });
    cards.push(...kept);
  }
  // A script call we could not tie to any phone still counts: its own card.
  for (const t of noPhone) if (t.atMs <= nowMs) cards.push(newCard(t, 0));
  for (const c of cards) c.st = evalStage(c, nowMs, markBy.get(c.key));
  return cards;
}

// Cards plus the brands on each (for scoping and the brand filter). Pure.
export function computeCards(raw, now = Date.now()) {
  const nowMs = msOf(now);
  const ctx = makeContext(raw);
  const { touches, noPhone } = buildTouches(raw, ctx, nowMs);
  // Calls answered for under 20 s with nothing else from that caller stay off
  // the board (owner, 2026-09-26).
  const cards = groupCards(touches, raw.marks || [], nowMs, noPhone)
    .filter((c) => !c.touches.every((t) => t.type === 'call_in' && t.why === 'short'));
  for (const c of cards) {
    const deal = c.touches.filter((t) => !t.timelineOnly && (t.type === 'booking' || t.type === 'estimate') && t.slug);
    c.openSlug = c.opener.slug || null;
    c.dealSlugs = [...new Set(deal.map((t) => t.slug))];
    const bk = [...deal].reverse().find((t) => t.type === 'booking');
    const est = [...deal].reverse().find((t) => t.type === 'estimate');
    // Brand shown = the booking's or estimate's brand if any, else the opener's.
    c.shownSlug = (bk && bk.slug) || (est && est.slug) || c.openSlug;
  }
  return { cards, ctx, nowMs };
}

// Owner rule 2026-09-24: a secretary sees a card when the brand that opened
// it OR its booking/estimate brand is one she works. Owner (null) sees all.
export function cardVisible(card, allowed) {
  if (allowed == null) return true;
  return [card.openSlug, ...(card.dealSlugs || [])].some((s) => s && allowed.includes(s));
}
function brandMatches(card, brand) {
  if (!brand || brand === 'all') return true;
  if (brand.startsWith('family:')) return card.family === brand.slice(7);
  return [card.openSlug, ...(card.dealSlugs || [])].includes(brand);
}
export function rangeStartMs(range, nowMs = Date.now()) {
  const back = RANGE_DAYS[String(range)] ?? RANGE_DAYS[7];
  return Math.max(msOf(PIPELINE_FLOOR), localDayStartUTC(CHICAGO, -back, new Date(nowMs)).getTime());
}
// 'yesterday' stops at the start of today; every other range runs to now.
export function rangeEndMs(range, nowMs = Date.now()) {
  return String(range) === 'yesterday' ? localDayStartUTC(CHICAGO, 0, new Date(nowMs)).getTime() : Infinity;
}
function normRange(r) { const s = String(r == null ? '' : r); return Object.prototype.hasOwnProperty.call(RANGE_DAYS, s) ? s : '7'; }

// The tracking line to call/text from: the latest real line on the card.
function cardLine(card, ctx) {
  let best = null;
  for (const t of card.touches) {
    const p = t.type === 'call_in' ? t.line : (t.type === 'text_in' || t.type === 'text_out_staff') ? t.our : null;
    const l = p && ctx.lines.get(p);
    if (l && l.active && p !== TOLL_FREE && (!best || t.atMs >= best.atMs)) best = { p, atMs: t.atMs };
  }
  return best ? best.p : null;
}

// ── Audits (owner only) ─────────────────────────────────────────────────────
// By call_id when the audit names one of the card's calls, else by phone with
// the audit inside the card's window +-3 h (call_audits times run ~1 h early).
function attachAudits(audits, cards) {
  const byCall = new Map(), byPhone = new Map();
  for (const c of cards) {
    for (const t of c.touches) if (t.type === 'call_in' || t.type === 'wizard') byCall.set(t.id, c);
    if (c.phone) (byPhone.get(c.phone) || byPhone.set(c.phone, []).get(c.phone)).push(c);
  }
  const out = new Map();
  for (const a of audits || []) {
    let card = a.call_id ? byCall.get(a.call_id) || null : null;
    if (!card) {
      const p = phone10(a.caller_phone), aMs = msOf(a.occurred_at);
      if (p && aMs != null) {
        let gap = Infinity;
        for (const c of byPhone.get(p) || []) {
          if (aMs < c.openedMs - 3 * HOUR || aMs > c.lastMs + 3 * HOUR) continue;
          const g = Math.abs(aMs - c.openedMs); if (g < gap) { gap = g; card = c; }
        }
      }
    }
    if (card) (out.get(card.key) || out.set(card.key, []).get(card.key)).push(a);
  }
  return out;
}
// Score = % yes of yes+no, leaving out the cust_* answers (those grade the
// customer, not the secretary) -- the audit portal's own formula (audit.html scoreOf).
export function auditSummary(list) {
  if (!list || !list.length) return null;
  const a = [...list].sort((x, y) => (msOf(x.occurred_at) || 0) - (msOf(y.occurred_at) || 0)).pop();
  let yes = 0, no = 0;
  for (const [k, v] of Object.entries(a.answers || {})) {
    if (k.startsWith('cust_')) continue;
    if (v === 'yes' || v === true) yes++; else if (v === 'no' || v === false) no++;
  }
  const n = yes + no;
  return { score: n ? Math.round((100 * yes) / n) : null, yes, n, flagged: !!a.flagged,
    listen_reason: a.flagged ? (a.listen_reason || null) : null, complaint: a.complaint || null,
    ratings: a.ratings || {}, by: a.handled_by || null, at: iso(msOf(a.occurred_at)), count: list.length };
}

// ── Card -> response shape ──────────────────────────────────────────────────
function sourceLabel(t, ctx) {
  const biz = t.slug && ctx.bizBySlug.get(t.slug);
  const bizName = (biz && biz.name) || null;
  switch (t.type) {
    case 'call_in': return `Phone call · ${t.lineName || bizName || 'tracking line'}`;
    case 'wizard': return `Phone call · ${bizName || 'Take a Call'}`;
    case 'text_in': return `Text · ${t.lineName || bizName || 'tracking line'}`;
    case 'estimate': return t.est.source === 'manual' ? `Estimate · ${bizName || 'office'}` : 'Website estimate';
    case 'booking': return t.bk.source === 'widget' ? 'Booked online' : t.bk.source === 'estimate' ? 'Estimate approval' : `Booked by office · ${bizName || ''}`.replace(/ · $/, '');
    default: return bizName || 'Other';
  }
}

function nextFor(st, card, nowMs) {
  const cb = st.callback;
  const callbackNext = cb ? { text: `${cb.type === 'text_in' ? 'Text back — texted' : cb.vm ? 'Call back — voicemail' : 'Call back — missed'} ${fmtAgo(nowMs - cb.atMs)} ago`, tone: 'danger' } : null;
  switch (st.stage) {
    case 'lost': return { text: `Lost · ${st.lost.reason}`, tone: 'mute' };
    case 'paid': {
      const b = st.booking.bk; const amt = b.amountPaid ?? b.price;
      return { text: amt ? `Paid · ${dollars(amt)}` : 'Paid', tone: 'ok' };
    }
    case 'booked': {
      if (callbackNext) return callbackNext;
      if (st.doneUnpaid) return { text: 'Job done — payment not collected', tone: 'warn' };
      if (st.approvedNoJob) return { text: 'Approved — put it on the schedule', tone: 'warn' };
      const b = st.booking.bk;
      if (b.scheduledMs != null && b.scheduledMs + 6 * HOUR < nowMs) return { text: 'Job time passed — not marked done', tone: 'warn' };
      return { text: b.source === 'widget' ? 'Booked online' : 'Booked', tone: 'ok' };
    }
    case 'quoted': {
      if (callbackNext) return callbackNext;
      const e = st.estimate.est; const age = nowMs - e.sentMs;
      if (e.bounced) return { text: 'Estimate email BOUNCED — listen to the call and check the email address', tone: 'danger' };
      // Owner 2026-09-27: age up front, opened or not, and the 3-hour follow-up email.
      const fu = e.couponMs ? 'follow-up email sent' : age > 4 * HOUR ? 'NO follow-up email' : 'follow-up email due at 3h';
      const text = `Sent ${fmtAgo(age)} ago · ${e.openedMs ? 'opened' : 'not opened'} · ${fu}`;
      // Red is only for emergencies like a bounced email (owner 2026-09-27).
      const tone = age >= 3 * HOUR || (!e.couponMs && age > 4 * HOUR) ? 'warn' : 'ok';
      return { text, tone };
    }
    case 'talked': {
      if (st.onCall && !st.leak) return { text: 'On the phone now', tone: 'ok' };
      const text = st.unconfirmed ? 'No booking or estimate — or was it voicemail?' : st.leak ? 'No booking or estimate yet' : 'Talking — send estimate or book';
      return { text, tone: st.leak ? 'danger' : 'warn' };
    }
    case 'new': {
      // Owner, 2026-09-26: call new leads back within 30 minutes; orange once
      // that's passed. Red is kept for real problems, not every new lead.
      const late = (ms) => nowMs - ms > NEW_CALLBACK_MS;
      if (st.webRequest) return { text: late(st.webRequest.atMs) ? 'Needs a response — over 30 min' : 'Needs a response', tone: late(st.webRequest.atMs) ? 'warn' : 'ok' };
      if (st.tries >= 1) return { text: 'Call back — 2nd try left', tone: 'warn' };
      const c = st.lastCustomer || card.opener;
      const what = c.type === 'text_in' ? `Text back — texted ${fmtAgo(nowMs - c.atMs)} ago` : `Call back — ${c.vm ? 'voicemail' : 'missed'} ${fmtAgo(nowMs - c.atMs)} ago`;
      return { text: what, tone: late(c.atMs) ? 'warn' : 'ok' };
    }
    default: return { text: '', tone: 'mute' };
  }
}

const item = (atMs, icon, text, who, tone) => ({ at: iso(atMs), icon, text, who: who || null, tone });
function timelineFor(card, st, mark, audits) {
  const out = []; let autoOther = 0;
  for (const t of card.touches) {
    const line = t.lineName ? ` · ${t.lineName}` : '';
    switch (t.type) {
      case 'call_in':
        if (t.why === 'in_progress') out.push(item(t.atMs, 'phone', `Call in progress${line}`, t.staff, 'warn'));
        else if (t.talk === 'yes') out.push(item(t.atMs, 'phone', `Call answered · ${fmtDur(t.dur)}${line}`, t.staff, 'ok'));
        else if (t.talk === 'unconfirmed') out.push(item(t.atMs, 'phone', `Call answered · ${fmtDur(t.dur)}${line} · talk or voicemail?`, t.staff, 'warn'));
        else if (t.why === 'missed') out.push(item(t.atMs, 'missed', `Missed call${line}`, t.staff, 'danger'));
        else if (t.why === 'no_person') out.push(item(t.atMs, 'missed', `Call not answered by a person${line}`, t.staff, 'danger'));
        else if (t.why === 'short') out.push(item(t.atMs, 'missed', `Answered ${fmtDur(t.dur)} — too short, likely voicemail${line}`, t.staff, 'danger'));
        else out.push(item(t.atMs, 'missed', `Answered ${fmtDur(t.dur)} — marked voicemail${line}`, t.staff, 'mute'));
        // Owner 2026-09-27: voicemails + recordings playable right on the card.
        if (t.vm && t.why === 'missed') out[out.length - 1].text = `Voicemail left${line}`;
        if (t.rec) { out[out.length - 1].call_id = t.id; out[out.length - 1].rec = true; }
        break;
      case 'wizard': {
        const r = t.live.resolution;
        // Only a real sent estimate moves a card to Quoted (owner 2026-09-27).
        const how = r === 'booked' ? ' · booked' : r === 'estimate_sent' ? (card.touches.some((x) => x.type === 'estimate' && x.est.sentMs != null) ? ' · estimate sent' : ' · marked estimate sent, but none was sent') : r === 'refused' ? ' · customer declined'
          : r === 'other' ? ' · other outcome' : t.live.step ? ` · stopped at ${t.live.step}` : '';
        const q = t.live.quoted ? ` · quoted ${dollars(t.live.quoted)}` : '';
        out.push(item(t.atMs, 'script', `Take a Call script${how}${q}`, t.staff, r === 'refused' ? 'warn' : 'ok'));
        break;
      }
      case 'text_in': out.push(item(t.atMs, 'text', `Text: ${clip(t.body, 600)}`, null, 'ok')); break;
      case 'text_out_staff': out.push(item(t.atMs, 'text', `Text reply: ${clip(t.body, 600)}`, t.staff, 'ok')); break;
      case 'text_auto': {
        const label = { missed_call: 'Auto-text sent (missed call)', estimate: 'Estimate link texted', booked: 'Booking confirmation texted' }[t.auto];
        if (!label && autoOther >= AUTO_TEXT_OTHER_CAP) break;
        if (!label) autoOther++;
        const text = label || ({ ack: 'Auto-reply to their text', en_route: 'On-the-way text', review: 'Review request texted' }[t.auto] || `Auto-text: ${clip(t.body, 50)}`);
        out.push(item(t.atMs, 'auto', t.failed ? `${text} · not delivered` : text, null, t.failed ? 'danger' : 'mute'));
        break;
      }
      case 'attempt': {
        const a = t.att; const who = a.source === 'manual' ? 'Called from own phone' : 'Called back';
        if (a.talked === true) out.push(item(t.atMs, 'callout', `${who} · talked${a.dur ? ' ' + fmtDur(a.dur) : ''}`, t.staff, 'ok'));
        else if (a.noRing) out.push(item(t.atMs, 'callout', `Call didn't connect — your phone ${a.staffStatus}`, t.staff, 'mute'));
        else if (a.talked === false) {
          const why = a.dialStatus && a.dialStatus !== 'completed' ? a.dialStatus.replace(/-/g, ' ') : a.dialStatus === 'completed' && a.dur != null ? `${fmtDur(a.dur)}, no real talk` : 'no answer';
          out.push(item(t.atMs, 'callout', `${who} · ${why}`, t.staff, 'danger'));
        } else out.push(item(t.atMs, 'callout', `${who} · outcome not confirmed`, t.staff, 'warn'));
        break;
      }
      case 'estimate': {
        const e = t.est;
        const amt = e.total ? ` · ${dollars(e.total)}` : '';
        if (t.archivedUnsent) { out.push(item(t.atMs, 'estimate', `${e.source === 'manual' ? 'Estimate saved' : 'Website estimate request'}${e.label ? ' · ' + e.label : ''} · archived, never sent`, null, 'mute')); break; }
        if (e.webRequest) out.push(item(t.atMs, 'estimate', `Website estimate request${e.label ? ' · ' + e.label : ''}`, null, 'danger'));
        else if (e.sentMs != null) out.push(item(e.sentMs, 'estimate', `Estimate sent${amt}`, null, 'ok'));
        else out.push(item(t.atMs, 'estimate', `Estimate saved, not sent${amt}`, null, 'warn'));
        if (e.bounced) out.push(item(e.sentMs ?? t.atMs, 'estimate', 'Estimate email bounced — wrong address?', null, 'danger'));
        if (e.openedMs) out.push(item(e.openedMs, 'estimate', 'Customer opened the estimate', null, 'ok'));
        if (e.couponMs) out.push(item(e.couponMs, 'auto', 'Coupon email sent', null, 'mute'));
        if (e.approvedMs) out.push(item(e.approvedMs, 'estimate', `Estimate approved${amt}`, null, 'ok'));
        if (e.declinedMs) out.push(item(e.declinedMs, 'lost', 'Not a fit — declined by the office', null, 'mute'));
        break;
      }
      case 'booking': {
        const b = t.bk;
        const label = b.source === 'widget' ? 'Booked online' : b.source === 'estimate' ? 'Booked from estimate approval' : 'Booked';
        const by = b.bookedBy && !/estimate approval/i.test(b.bookedBy) ? b.bookedBy : null;
        out.push(item(t.atMs, 'booking', `${label}${b.tech ? ' · ' + b.tech : ''}${b.price ? ' · ' + dollars(b.price) : ''}`, by, 'ok'));
        if (b.completedMs != null) out.push(item(b.completedMs, 'done', 'Job done', b.tech, 'ok'));
        if (b.paidMs != null) { const amt = b.amountPaid ?? b.price; out.push(item(b.paidMs, 'paid', amt ? `Paid ${dollars(amt)}` : 'Paid', null, 'ok')); }
        if (b.cancelledMs != null) out.push(item(b.cancelledMs, 'cancel', 'Job cancelled', null, 'danger'));
        break;
      }
      default: break;
    }
  }
  if (mark) {
    if (mark.lost_reason && mark.lost_at) out.push(item(msOf(mark.lost_at), 'lost', `Marked lost · ${mark.lost_reason}${mark.lost_note ? ' — ' + clip(mark.lost_note, 80) : ''}`, mark.lost_by, 'mute'));
    if (mark.not_a_lead && mark.not_a_lead_at) out.push(item(msOf(mark.not_a_lead_at), 'lost', 'Marked not a lead', mark.not_a_lead_by, 'mute'));
    if (mark.reopened_at) out.push(item(msOf(mark.reopened_at), 'reopen', 'Reopened', mark.reopened_by, 'ok'));
  }
  if (st.lost && st.lost.auto) out.push(item(st.lost.atMs, 'lost', `Lost automatically · ${st.lost.reason}`, null, 'mute'));
  for (const a of audits || []) {
    const s = auditSummary([a]);
    out.push(item(msOf(a.occurred_at), 'audit', `Call audited${s.score != null ? ' · ' + s.score + '%' : ''}${a.flagged ? ' · flagged' : ''}`, a.handled_by, a.flagged ? 'danger' : 'mute'));
  }
  out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return out.slice(-TIMELINE_CAP);
}

function shapeCard(c, ctx, { nowMs, isOwner, mark, history, audits }) {
  const st = c.st;
  const T = c.touches.filter((t) => !t.timelineOnly);
  const bookings = T.filter((t) => t.type === 'booking');
  const ests = T.filter((t) => t.type === 'estimate');
  const standing = bookings.filter((t) => t.bk.cancelledMs == null);
  const bk = st.booking || standing[standing.length - 1] || bookings[bookings.length - 1] || null;
  const sentEsts = ests.filter((t) => t.est.sentMs != null);
  const liveEsts = ests.filter((t) => !t.archivedUnsent);
  const est = st.estimate || sentEsts[sentEsts.length - 1] || liveEsts[liveEsts.length - 1] || ests[ests.length - 1] || null;
  const wizards = T.filter((t) => t.type === 'wizard');
  const callsIn = T.filter((t) => t.type === 'call_in');
  const talks = talksOf(T);

  let name = null;
  for (const t of [...bookings].reverse()) if (t.name) { name = t.name; break; }
  if (!name) for (const t of [...ests].reverse()) if (t.name) { name = t.name; break; }
  if (!c.phone && !name) name = 'Caller (no phone saved)';

  let amount = null;
  if (bk && bk.bk.price) amount = bk.bk.price;
  else if (est && est.est.total) amount = est.est.total;
  else { const w = [...wizards].reverse().find((t) => t.live.quoted); if (w) amount = w.live.quoted; }

  // Who owns it: the person on the first conversation (the script's runner
  // first, then the handset the call rang, then a callback, then a text
  // reply); untalked = whose handset the line rang that day.
  const firstOf = (type) => { const x = talks.find((k) => k.t.type === type && k.t.staff); return x ? x.t.staff : null; };
  let secretary = firstOf('wizard') || firstOf('call_in') || firstOf('attempt') || firstOf('text_out_staff');
  if (!secretary) { const f = callsIn.find((t) => t.staff); secretary = f ? f.staff : null; }
  if (!secretary) { const b = bookings.find((t) => t.bk.bookedBy && ctx.handsetsOf.has(t.bk.bookedBy)); secretary = b ? b.bk.bookedBy : null; }

  const shown = c.shownSlug && ctx.bizBySlug.get(c.shownSlug);
  const lastCall = callsIn[callsIn.length - 1] || null;
  // The answered call the card's buttons are about (review 2026-09-24): while
  // it asks "or was it voicemail?", the unconfirmed 20-119 s call; on a
  // confirmed talk, the call that made it one by its length or a Talked tap
  // (not a script's -- the script proves it). Only then the latest answered
  // call, so a later short pickup never hides the call in question.
  const revIn = [...callsIn].reverse();
  const answered = (st.unconfirmed ? revIn.find((t) => t.why === 'unconfirmed') : revIn.find((t) => t.answered === true && t.talk === 'yes' && !t.wizard))
    || revIn.find((t) => t.answered === true) || null;
  const failed = typeof st.tries === 'number' ? st.tries
    : T.filter((t) => t.type === 'attempt' && isFailedTry(t, nowMs)).length;

  const jobs = (history || []).filter((h) => h.completedMs != null && h.completedMs < c.openedMs && !bookings.some((b) => b.id === h.id));
  const spent = cents(jobs.reduce((s, h) => s + (h.amount || 0), 0));

  const out = {
    key: c.key,
    // Paid shows in Booked on the board (owner, 2026-09-26); 'paid' stays internal
    // because it closes the card (the next touch opens a new one).
    stage: st.stage === 'paid' || (st.stage === 'booked' && st.doneUnpaid) ? 'completed' : st.stage,
    paid: st.stage === 'paid',
    leak: st.stage === 'talked' && !!st.leak,
    voicemail: c.touches.some((t) => t.type === 'call_in' && t.vm),
    review: st.booking && st.booking.bk ? { ...st.booking.bk.rv, booking_id: st.booking.id, completed_at: iso(st.booking.bk.completedMs) } : null,
    // Customer reached out and nobody replied (owner 2026-09-27): drives the red banner.
    unanswered: st.callback && nowMs - st.callback.atMs > 30 * MIN
      ? { at: iso(st.callback.atMs), kind: st.callback.type === 'text_in' ? 'text' : st.callback.vm ? 'voicemail' : 'missed', hours: Math.floor((nowMs - st.callback.atMs) / HOUR), mins: Math.floor((nowMs - st.callback.atMs) / MIN) }
      : null,
    phone: c.phone,
    phone_pretty: prettyPhone10(c.phone),
    name,
    business: shown ? { slug: shown.slug, name: shown.name } : (c.shownSlug ? { slug: c.shownSlug, name: c.shownSlug } : null),
    family: c.family,
    source: sourceLabel(c.opener, ctx),
    our_phone: cardLine(c, ctx),
    secretary,
    amount: amount != null ? cents(amount) : null,
    opened_at: iso(c.openedMs),
    last_at: iso(c.lastMs),
    stage_at: iso(st.stageMs),
    next: nextFor(st, c, nowMs),
    lost: st.stage === 'lost' ? { reason: st.lost.reason, auto: st.lost.auto, note: st.lost.note || '', by: st.lost.by || null, at: iso(st.lost.atMs) } : null,
    tries: failed,
    estimate: est ? { id: est.id, total: est.est.total, sent_at: iso(est.est.sentMs), opened: est.est.openedMs != null, coupon_at: iso(est.est.couponMs),
      approved_at: iso(est.est.approvedMs), status: est.est.status, slug: est.slug || null, label: est.est.label || null, bounced: !!est.est.bounced, items: est.est.items || [] } : null,
    booking: bk ? { id: bk.id, scheduled_at: iso(bk.bk.scheduledMs), status: bk.bk.status, price: bk.bk.price, tech: bk.bk.tech, paid_at: iso(bk.bk.paidMs),
      completed_at: iso(bk.bk.completedMs), created_at: iso(bk.atMs), review_at: iso(bk.bk.reviewMs), review_rating: bk.bk.reviewRating,
      slug: bk.slug || null } : null,
    inbound_call_id: lastCall ? lastCall.id : null,
    // The answered inbound call the card is about (see above) and how it was
    // read, for the card's Talked / Voicemail buttons (talk / no_talk ops):
    // Talked + Voicemail only when state is 'unconfirmed'; "Voicemail, not a
    // talk" only on a talked card whose state is 'talked' and not wizard.
    // inbound_call_id is the latest call in ANY state -- never the one to mark.
    answered_call: answered ? { id: answered.id, duration_sec: answered.dur,
      state: answered.talk === 'yes' ? 'talked' : answered.talk === 'unconfirmed' ? 'unconfirmed'
        : (answered.why === 'marked_voicemail' || answered.why === 'audit_voicemail') ? 'voicemail' : 'short',
      wizard: !!answered.wizard } : null,
    history: { prior_cards: c.index || 0, prior_jobs: jobs.length, spent, returning: jobs.length > 0 },
    audit: isOwner ? auditSummary(audits) : null,
    timeline: timelineFor(c, st, mark, isOwner ? audits : null),
  };
  // Internal: for the tiles/scoreboard only, stripped before sending.
  Object.defineProperty(out, '_talked', { value: talks.length > 0 });
  Object.defineProperty(out, '_converted', { value: bookings.length > 0 || ests.some((t) => t.est.sentMs != null || t.est.approvedMs != null) });
  return out;
}

// Completed jobs before a card opened (any source, imports included -- history only).
function historyIndex(rows, ctx) {
  const by = new Map();
  for (const r of rows || []) {
    const p = phone10(r.customer && r.customer.phone); if (!p) continue;
    const fam = familyOf(ctx.slugOf(r));
    const k = p + '|' + fam;
    // Imported (Zenbooker) jobs carry amount_paid 0 even when paid: fall back to the price.
    const paidAmt = num(r.amount_paid);
    (by.get(k) || by.set(k, []).get(k)).push({ id: r.id, completedMs: msOf(r.completed_at) ?? msOf(r.scheduled_at) ?? msOf(r.created_at), amount: paidAmt > 0 ? paidAmt : (num(r.price) ?? 0) });
  }
  return by;
}

// The whole GET response. Pure: raw rows in (see loadPipelineRaw), a clock in.
// opts: { isOwner, allowed (allowedSlugsFor: null = all), viewerName, range, business }
export function buildPipeline(raw, now = Date.now(), opts = {}) {
  const { cards, ctx, nowMs } = computeCards(raw, now);
  const isOwner = !!opts.isOwner;
  const allowed = opts.allowed === undefined ? null : opts.allowed;
  const range = normRange(opts.range);
  const fromMs = rangeStartMs(range, nowMs);
  const toMs = rangeEndMs(range, nowMs);
  const brand = String(opts.business || 'all');
  const markBy = new Map((raw.marks || []).map((m) => [m.card_key, m]));
  const hist = historyIndex(raw.history, ctx);
  const auditsBy = isOwner ? attachAudits(raw.audits, cards) : new Map();

  const activePhones = new Set((raw.activeBookings || []).map((b) => phone10(b.customer && b.customer.phone)).filter(Boolean));
  let shaped = [];
  for (const c of cards) {
    // Not a lead: this caller already has an active appointment (and this card isn't that booking).
    if (c.phone && activePhones.has(c.phone) && !c.touches.some((t) => t.type === 'booking')) continue;
    if (c.st.stage === 'hidden') continue;
    // Owner 2026-09-27: Lost is off the board; Completed (done, no review yet)
    // replaces it for review tracking. Any review removes the card.
    if (!opts.legacyBoard && c.st.stage === 'lost') continue;
    const doneJob = !opts.legacyBoard && (c.st.stage === 'paid' || (c.st.stage === 'booked' && c.st.doneUnpaid));
    if (doneJob) {
      const b = c.st.booking && c.st.booking.bk;
      if (!b || b.gotReview) continue;
      if (nowMs - (b.completedMs ?? b.paidMs ?? 0) > 14 * DAY) continue;
      if (!cardVisible(c, allowed) || !brandMatches(c, brand)) continue;
      shaped.push(shapeCard(c, ctx, { nowMs, isOwner, mark: markBy.get(c.key), history: c.phone ? hist.get(c.phone + '|' + c.family) : null, audits: auditsBy.get(c.key) || null }));
      continue;
    }
    // In range if it started in range OR was booked in range (owner 2026-09-27:
    // a lead from Sep 25 that booked yesterday counts in Yesterday's Booked).
    const inRange = (ms) => ms >= fromMs && ms < toMs;
    if (!inRange(c.openedMs) && !c.touches.some((t) => t.type === 'booking' && !t.timelineOnly && inRange(t.atMs))) continue;
    if (!cardVisible(c, allowed) || !brandMatches(c, brand)) continue;
    shaped.push(shapeCard(c, ctx, { nowMs, isOwner, mark: markBy.get(c.key), history: c.phone ? hist.get(c.phone + '|' + c.family) : null, audits: auditsBy.get(c.key) || null }));
  }
  if (opts.legacyBoard) for (const c of shaped) if (c.stage === 'completed') c.stage = 'booked';
  const stages = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const board = new Map();
  let calls = 0, converted = 0, leaks = 0;
  for (const c of shaped) {
    stages[c.stage] = (stages[c.stage] || 0) + 1;
    if (c.leak) leaks++;
    if (!c._talked) continue;
    calls++; if (c._converted) converted++;
    if (!c.secretary) continue;
    const row = board.get(c.secretary) || { name: c.secretary, talked: 0, converted: 0, pct: 0 };
    row.talked++; if (c._converted) row.converted++;
    board.set(c.secretary, row);
  }
  let scoreboard = [...board.values()].map((r) => ({ ...r, pct: r.talked ? Math.round((100 * r.converted) / r.talked) : 0 }))
    .sort((a, b) => b.talked - a.talked || a.name.localeCompare(b.name));
  // A secretary sees only her own row (owner rule 2026-09-24).
  if (!isOwner) scoreboard = scoreboard.filter((r) => r.name === opts.viewerName);
  shaped.sort((a, b) => (Number(b.leak) - Number(a.leak)) || (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
  if (shaped.length > CARD_CAP) shaped = shaped.slice(0, CARD_CAP);
  return {
    floor: PIPELINE_FLOOR,
    generated_at: iso(nowMs),
    is_owner: isOwner,
    range,
    range_start: iso(fromMs),
    metrics: { calls, converted, leaks },
    stages,
    scoreboard,
    lost_reasons: LOST_REASONS,
    cards: shaped.map((c) => ({ ...c })),
  };
}

// Phones of every touch since `sinceMs` -- the cards on the board -- for the
// one prior-history lookup.
export function phonesSince(raw, sinceMs) {
  const out = new Set();
  const add = (p, at) => { if (p && (msOf(at) ?? 0) >= sinceMs) out.add(p); };
  for (const c of raw.calls || []) if (c.kind === 'inbound') add(strictPhone(c.caller_phone), c.occurred_at);
  for (const m of raw.messages || []) add(phone10(m.customer_phone), m.created_at);
  for (const e of raw.estimates || []) add(phone10(e.customer_phone), e.created_at);
  for (const b of raw.bookings || []) add(phone10(b.customer && b.customer.phone), b.created_at);
  return [...out];
}

// ── Loading (the only part that reads the database) ─────────────────────────
// PostgREST caps every response at its max-rows (1000 by default) whatever
// .limit() says, so everything is read in pages; a table that would need more
// than `max` rows is cut there and logged rather than silently truncated.
async function fetchAll(label, build, max = 20000, pageSize = 1000) {
  const out = [];
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < pageSize) return out;
  }
  console.warn(`[pipeline] ${label}: stopped at ${max} rows -- older rows were not read`);
  return out;
}
async function inChunks(values, size, run) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return (await Promise.all(chunks.map(run))).flat();
}

const CALL_COLS = 'id, business_id, kind, source, caller_phone, grasshopper_number, forwarded_to, occurred_at, answered, duration_sec, recording_url, status, handled_by, booking_id, resolution, reached_step, quoted_total, inbound_call_id';
const MESSAGE_COLS = 'id, business_id, customer_phone, our_phone, direction, body, sent_by, status, created_at';
const ESTIMATE_COLS = 'id, business_id, source, status, customer_name, customer_phone, created_at, updated_at, texted_at, emailed_at, contacted_at, approved_at, approved_total, line_items, tax_rate, text_opened_at, email_opened_at, followup_emailed_at, call_id, service_label, email_status';
const BOOKING_COLS = `id, business_id, customer_id, status, source, scheduled_at, created_at, updated_at, completed_at, paid_at, cancelled_at,
  price, amount_paid, payment_status, notes, customer_notes, metadata, review_rating, reviewed_at, review_clicked_at,
  review_email_sent_at, review_email_count, review_email_delivered_at, review_email_status, review_email_clicked_at,
  review_sms_sent_at, review_sms_delivered_at, review_sms_status, review_sms_clicked_at, review_call_status, review_call_at, review_call_by,
  customer:customers ( name, phone ), technician:technicians!technician_id ( name )`;
const AUDIT_COLS = 'id, call_id, caller_phone, occurred_at, handled_by, answers, ratings, flagged, listen_reason, complaint, business_id, direction';

// Everything since the floor (bounded to LOOKBACK_DAYS so grouping context
// never grows without limit; card keys stay stable inside that window).
// Backup tables (*_bak_*) are never read.
export async function loadPipelineRaw(db, { nowMs = Date.now(), withAudits = false } = {}) {
  const sinceMs = Math.max(msOf(PIPELINE_FLOOR), nowMs - LOOKBACK_DAYS * DAY);
  const since = iso(sinceMs);
  const [calls, messages, estimates, bookings, attempts, marks, auditSkips, staff, silent, blocked, tracking, businesses, audits] = await Promise.all([
    fetchAll('calls', () => db.from('calls').select(CALL_COLS).in('kind', ['inbound', 'live']).gte('occurred_at', since).order('occurred_at').order('id')),
    fetchAll('messages', () => db.from('messages').select(MESSAGE_COLS).gte('created_at', since).order('created_at').order('id')),
    fetchAll('estimates', () => db.from('estimates').select(ESTIMATE_COLS).gte('created_at', since).order('created_at').order('id')),
    fetchAll('bookings', () => db.from('bookings').select(BOOKING_COLS).neq('source', 'import').gte('created_at', since).order('created_at').order('id')),
    fetchAll('call_attempts', () => db.from('call_attempts').select('*').gte('started_at', since).order('started_at').order('id')),
    fetchAll('pipeline_marks', () => db.from('pipeline_marks').select('*').order('card_key')),
    fetchAll('audit_skips', () => db.from('audit_skips').select('call_id, reason, created_at').order('call_id')),
    fetchAll('staff_users', () => db.from('staff_users').select('name, phone, active').order('id')),
    fetchAll('silent_numbers', () => db.from('silent_numbers').select('phone').order('id')),
    fetchAll('blocked_numbers', () => db.from('blocked_numbers').select('phone').order('id')),
    fetchAll('tracking_numbers', () => db.from('tracking_numbers').select('phone, business_slug, display_name, active, forward_to, created_at').order('phone')),
    fetchAll('businesses', () => db.from('businesses').select('id, slug, name').order('slug')),
    withAudits
      ? fetchAll('call_audits', () => db.from('call_audits').select(AUDIT_COLS).gte('occurred_at', iso(sinceMs - 3 * HOUR)).order('occurred_at').order('id'))
      : Promise.resolve([]),
  ]);
  const liveIds = calls.filter((c) => c.kind === 'live').map((c) => c.id);
  const callEvents = await inChunks(liveIds, 150, (ids) => fetchAll('call_events',
    () => db.from('call_events').select('call_id, event, actor, meta, created_at').in('call_id', ids).in('event', ['started', 'estimate_sent']).order('created_at').order('id')));
  // Upcoming appointments (any age of booking): a caller who already has one
  // is not a lead (owner rule 2026-09-27).
  const activeBookings = await fetchAll('active bookings', () => db.from('bookings').select('id, customer:customers ( phone )')
    .not('status', 'in', '(completed,cancelled)').is('completed_at', null).is('cancelled_at', null)
    .gte('scheduled_at', iso(nowMs - DAY)).order('id'));
  return { calls, callEvents, messages, estimates, bookings, attempts, marks, auditSkips, staff, silent, blocked, tracking, businesses, audits, activeBookings, history: [] };
}

// Completed bookings (any time, any source) of these phones: one customers
// lookup in the stored spellings, then their completed jobs.
export async function loadHistory(db, phones) {
  if (!phones || !phones.length) return [];
  const customers = await inChunks(phones.flatMap(phoneVariants), 150, (vals) =>
    fetchAll('history customers', () => db.from('customers').select('id, phone').in('phone', vals).order('id')));
  const phoneById = new Map(customers.map((c) => [c.id, c.phone]));
  const jobs = await inChunks([...phoneById.keys()], 150, (ids) =>
    fetchAll('history bookings', () => db.from('bookings').select('id, customer_id, business_id, price, amount_paid, completed_at, scheduled_at, created_at')
      .eq('status', 'completed').in('customer_id', ids).order('id')));
  return jobs.map((j) => ({ ...j, customer: { phone: phoneById.get(j.customer_id) } }));
}

// ── The action ──────────────────────────────────────────────────────────────
const OPS = new Set(['mark_lost', 'not_a_lead', 'reopen', 'no_talk', 'talk', 'log_attempt', 'attempt_outcome']);

export async function pipelineHandler(req, res, db, auth, body) {
  // The auditor never reaches CRM customer data (api/audit.js header).
  if (!auth || auth.role === 'auditor' || auth.auditor) return res.status(403).json({ error: 'Not available for this login' });
  if (req.method === 'GET') {
    const nowMs = Date.now();
    const isOwner = auth.role === 'owner';
    const range = normRange(req.query.range);
    const raw = await loadPipelineRaw(db, { nowMs, withAudits: isOwner });
    raw.history = await loadHistory(db, phonesSince(raw, rangeStartMs(range, nowMs)));
    return res.status(200).json(buildPipeline(raw, nowMs, {
      isOwner, allowed: allowedSlugsFor(auth), viewerName: auth.name || null, range, business: (req.query.business || 'all').toString(), legacyBoard: req.query.board === 'legacy',
    }));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    return await pipelineOp(res, db, auth, body || {});
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
}

async function pipelineOp(res, db, auth, body) {
  const op = String(body.op || '');
  if (!OPS.has(op)) return res.status(400).json({ error: 'Unknown op' });
  const who = auth.name || auth.role || 'office';
  const nowIso = new Date().toISOString();

  // "Did you talk to them?" after a bridge call: confirm or correct the
  // automatic read of the customer leg.
  if (op === 'attempt_outcome') {
    const id = String(body.attempt_id || '');
    if (!UUID.test(id)) return res.status(400).json({ error: 'attempt_id is required' });
    if (typeof body.talked !== 'boolean') return res.status(400).json({ error: 'talked must be true or false' });
    const { data: a, error } = await db.from('call_attempts').select('id, business_id, staff_name, ended_at').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!a) return res.status(404).json({ error: 'Call attempt not found' });
    if (auth.role !== 'owner') {
      let slug = null;
      if (a.business_id) { const { data: b } = await db.from('businesses').select('slug').eq('id', a.business_id).maybeSingle(); slug = b && b.slug; }
      if (slug ? !mayUseBusiness(auth, slug) : a.staff_name !== auth.name) return res.status(403).json({ error: 'Forbidden for this business' });
    }
    const { error: e2 } = await db.from('call_attempts').update({ talked: body.talked, talked_set_by: who, ended_at: a.ended_at || nowIso }).eq('id', id);
    if (e2) throw e2;
    return res.status(200).json({ ok: true });
  }

  // Every card op: rebuild the cards server-side and check the card is one
  // this login may see -- the key alone proves nothing.
  const key = String(body.card_key || '');
  if (!CARD_KEY.test(key)) return res.status(400).json({ error: 'card_key is required' });
  const nowMs = Date.now();
  const raw = await loadPipelineRaw(db, { nowMs });
  const { cards, ctx } = computeCards(raw, nowMs);
  const card = cards.find((c) => c.key === key);
  if (!card) return res.status(404).json({ error: 'That card is no longer on the board. Refresh and try again.' });
  if (!cardVisible(card, allowedSlugsFor(auth))) return res.status(403).json({ error: 'Forbidden for this business' });
  const biz = card.shownSlug && ctx.bizBySlug.get(card.shownSlug);
  const bizId = biz ? biz.id : null;

  if (op === 'log_attempt') {
    // She rang them from her own phone: nothing on our side saw it.
    if (!card.phone) return res.status(400).json({ error: 'This card has no phone number' });
    if (body.phone != null && body.phone !== '' && phone10(body.phone) !== card.phone) return res.status(400).json({ error: 'That number is not on this card' });
    if (typeof body.talked !== 'boolean') return res.status(400).json({ error: 'talked must be true or false' });
    const { error } = await db.from('call_attempts').insert({
      phone: card.phone, business_id: bizId, our_phone: cardLine(card, ctx), staff_name: who, source: 'manual',
      talked: body.talked, talked_set_by: who, started_at: nowIso, ended_at: nowIso, card_key: key,
    });
    if (error) throw error;
    return res.status(200).json({ ok: true });
  }

  let patch;
  const cur = await readMark(db, key);
  switch (op) {
    case 'mark_lost': {
      const reason = String(body.reason || '');
      if (!LOST_REASONS.includes(reason)) return res.status(400).json({ error: 'Pick one of the lost reasons' });
      patch = { lost_reason: reason, lost_note: clean(body.note, 500) || null, lost_at: nowIso, lost_by: who };
      break;
    }
    case 'not_a_lead': patch = { not_a_lead: true, not_a_lead_by: who, not_a_lead_at: nowIso }; break;
    case 'reopen': patch = { reopened_at: nowIso, reopened_by: who, not_a_lead: false }; break;
    case 'no_talk':
    case 'talk': {
      const callId = String(body.call_id || '');
      const hit = card.touches.find((t) => t.type === 'call_in' && t.id === callId);
      if (!hit) return res.status(400).json({ error: 'That call is not on this card' });
      // A missed call, or one nobody answered, was never a conversation
      // (review 2026-09-24): Talked needs a call a person picked up.
      if (op === 'talk' && hit.answered !== true) return res.status(400).json({ error: 'Only an answered call can be marked as a talk' });
      const talk = new Set(cur ? cur.talk_call_ids || [] : []), noTalk = new Set(cur ? cur.no_talk_call_ids || [] : []);
      if (op === 'talk') { talk.add(callId); noTalk.delete(callId); } else { noTalk.add(callId); talk.delete(callId); }
      patch = { talk_call_ids: [...talk], no_talk_call_ids: [...noTalk] };
      break;
    }
    default: return res.status(400).json({ error: 'Unknown op' });
  }
  // Reopening (or re-marking) a card that is closed right now: keep the span
  // it sat closed, so touches that arrived then stay on their own cards
  // whatever later marks say (canJoin; migration 0142, review 2026-09-24).
  const closedFrom = op === 'reopen' || op === 'mark_lost' || op === 'not_a_lead' ? closedSince(cur) : null;
  if (closedFrom != null && closedFrom < msOf(nowIso)) {
    patch.closed_windows = [...(Array.isArray(cur.closed_windows) ? cur.closed_windows : []), { from: iso(closedFrom), to: nowIso }];
  }
  const row = { card_key: key, business_id: bizId, phone: card.phone || null, ...patch, updated_at: nowIso };
  let { error } = await db.from('pipeline_marks').upsert(row, { onConflict: 'card_key' });
  // Migration 0142 not applied yet: the person's decision still saves; only
  // the closed span is not kept (the card behaves as it did before 0142).
  if (error && row.closed_windows && ['42703', 'PGRST204'].includes(error.code) && /closed_windows/.test(error.message || '')) {
    console.warn('[pipeline] pipeline_marks.closed_windows missing (migration 0142) -- saved without it');
    const rest = { ...row }; delete rest.closed_windows;
    ({ error } = await db.from('pipeline_marks').upsert(rest, { onConflict: 'card_key' }));
  }
  if (error) throw error;
  return res.status(200).json({ ok: true });
}
// When the card is closed by a person right now (marked Lost and not reopened
// since, or Not a lead): the moment it closed (ms). Else null.
function closedSince(m) {
  if (!m) return null;
  const from = [];
  const n = m.not_a_lead ? msOf(m.not_a_lead_at) : null;
  if (n != null) from.push(n);
  const l = m.lost_reason ? msOf(m.lost_at) : null, r = msOf(m.reopened_at);
  if (l != null && !(r != null && r >= l)) from.push(l);
  return from.length ? Math.min(...from) : null;
}
async function readMark(db, key) {
  const { data, error } = await db.from('pipeline_marks').select('*').eq('card_key', key).maybeSingle();
  if (error) throw error;
  return data || null;
}

// ── Helpers admin.js uses for the call hooks ────────────────────────────────
// call_start source 'pipeline' (amendment 14, 2026-09-24): which line to ring
// the customer From, and proof the number is one this login already works.
// The number must appear on an inbound call, a text, an estimate or a booking
// in a business she may use. Line: the latest inbound call's line -> the
// latest text thread's tracking line -> the card brand's first active
// forwarded line -> the toll-free. Returns { phone, line, businessId } (10-digit).
export async function pipelineCallTarget(db, auth, rawPhone, cardSlugIn) {
  const phone = phone10(rawPhone);
  if (!phone || REPEATED.test(phone)) throw httpErr(400, 'A 10-digit customer number is required');
  // The card's brand only steers which line is picked; one this login can't
  // use is ignored (the proof below is scoped to her businesses anyway).
  const bizSlug = cardSlugIn && mayUseBusiness(auth, cardSlugIn) ? cardSlugIn : null;
  const fam = bizSlug ? familyOf(bizSlug) : null;
  const allowed = allowedSlugsFor(auth);
  const [bizR, linesR] = await Promise.all([
    db.from('businesses').select('id, slug'),
    db.from('tracking_numbers').select('phone, business_slug, active, forward_to, created_at').order('created_at'),
  ]);
  if (bizR.error) throw bizR.error;
  if (linesR.error) throw linesR.error;
  const slugById = new Map((bizR.data || []).map((b) => [b.id, b.slug]));
  const idBySlug = new Map((bizR.data || []).map((b) => [b.slug, b.id]));
  const okIds = (bizR.data || []).filter((b) => allowed === null || allowed.includes(b.slug)).map((b) => b.id);
  if (!okIds.length) throw httpErr(403, 'Forbidden for this business');
  // An empty .in() list would mean "no filter" -- okIds is never empty here.
  const scoped = (q) => (allowed === null ? q : q.in('business_id', okIds));
  const variants = phoneVariants(phone);
  const lineBy = new Map((linesR.data || []).map((l) => [phone10(l.phone), l]));
  const [callsR, msgsR, estsR, custsR] = await Promise.all([
    // Calls are read unscoped and judged below: a row on an inactive line
    // can carry no business_id, and the board shows it by its line's brand.
    db.from('calls').select('business_id, grasshopper_number, occurred_at').eq('kind', 'inbound').eq('caller_phone', phone).order('occurred_at', { ascending: false }).limit(50),
    scoped(db.from('messages').select('business_id, our_phone, created_at').eq('customer_phone', phone)).order('created_at', { ascending: false }).limit(50),
    scoped(db.from('estimates').select('business_id').in('customer_phone', variants)).limit(1),
    scoped(db.from('customers').select('id').in('phone', variants)).limit(200),
  ]);
  for (const r of [callsR, msgsR, estsR, custsR]) if (r.error) throw r.error;
  // The same rule the board's visibility uses (buildTouches: business_id,
  // else the line's brand), so every card she can see has a working Call
  // button (review 2026-09-24).
  const callRows = [];
  for (const r of callsR.data || []) {
    const lineSlug = (lineBy.get(phone10(r.grasshopper_number)) || {}).business_slug || null;
    const bizId = r.business_id || (lineSlug && idBySlug.get(lineSlug)) || null;
    if (allowed !== null && !(r.business_id ? okIds.includes(r.business_id) : allowed.includes(lineSlug))) continue;
    callRows.push({ ...r, business_id: bizId });
  }
  let bookingBiz = null;
  const custIds = (custsR.data || []).map((c) => c.id);
  if (custIds.length) {
    const { data, error } = await scoped(db.from('bookings').select('business_id').in('customer_id', custIds)).limit(1);
    if (error) throw error;
    if (data && data.length) bookingBiz = data[0].business_id;
  }
  const evidence = [...callRows, ...(msgsR.data || []), ...(estsR.data || [])].map((r) => r.business_id).filter(Boolean);
  if (bookingBiz) evidence.push(bookingBiz);
  if (!callRows.length && !(msgsR.data || []).length && !(estsR.data || []).length && !bookingBiz) {
    throw httpErr(404, 'No call, text, estimate or booking from this number in your businesses.');
  }
  // A line of the card's own brand family, so the try and the caller ID match
  // the inquiry the card is about.
  const usable = (p) => {
    const l = p && lineBy.get(p);
    return l && l.active !== false && p !== TOLL_FREE && (allowed === null || allowed.includes(l.business_slug))
      && (!fam || familyOf(l.business_slug) === fam) ? l : null;
  };
  for (const c of callRows) {
    const p = phone10(c.grasshopper_number); const l = usable(p);
    if (l) return { phone, line: p, businessId: c.business_id || idBySlug.get(l.business_slug) || null };
  }
  for (const m of msgsR.data || []) {
    const p = phone10(m.our_phone); const l = usable(p);
    if (l) return { phone, line: p, businessId: m.business_id || idBySlug.get(l.business_slug) || null };
  }
  const cardSlug = bizSlug || (evidence.length ? slugById.get(evidence[0]) : null) || null;
  if (cardSlug) {
    const l = (linesR.data || []).find((x) => x.business_slug === cardSlug && x.active !== false && x.forward_to && phone10(x.phone) !== TOLL_FREE);
    if (l) return { phone, line: phone10(l.phone), businessId: idBySlug.get(cardSlug) || null };
  }
  const tollFree = phone10(process.env.TWILIO_PHONE_NUMBER || '');
  if (!tollFree) throw httpErr(500, 'No line to call from');
  return { phone, line: tollFree, businessId: (cardSlug && idBySlug.get(cardSlug)) || null };
}

// call_live_start (amendment 5, 2026-09-24): tie a Take a Call row to the
// inbound call it is for, so the card joins cleanly. An explicit
// inbound_call_id (the script opened from a card) must be an inbound call
// this login may use; otherwise the latest inbound call that rang this
// person's handset in the last 15 min and isn't already another script's --
// from the script's own customer number when it knows one.
// That call is normally still IN PROGRESS when the script starts (answered is
// only written when the forward ends), so "not missed" -- answered true or
// still null -- is the test, not answered=true. Best-effort: never throws,
// returns {} when nothing fits. Returns { inbound_call_id?, caller_phone? }.
export async function inboundForLiveStart(db, auth, body) {
  const out = {};
  try {
    const typed = strictPhone(body && body.caller_phone);
    if (typed && !REPEATED.test(typed)) out.caller_phone = typed;
    // A call row on an inactive line can carry no business_id: judge it by
    // the line's brand, the same rule the board uses to show it (review 2026-09-24).
    const lineSlugs = new Map();
    const slugOfCall = async (c) => {
      if (c.business && c.business.slug) return c.business.slug;
      const p = phone10(c.grasshopper_number); if (!p) return null;
      if (!lineSlugs.has(p)) {
        const { data: l } = await db.from('tracking_numbers').select('business_slug').eq('phone', p).maybeSingle();
        lineSlugs.set(p, (l && l.business_slug) || null);
      }
      return lineSlugs.get(p);
    };
    const wanted = body && body.inbound_call_id != null ? String(body.inbound_call_id) : '';
    if (wanted) {
      if (!UUID.test(wanted)) return out;
      const { data } = await db.from('calls').select('id, kind, caller_phone, grasshopper_number, business:businesses ( slug )').eq('id', wanted).maybeSingle();
      if (data && data.kind === 'inbound' && mayUseBusiness(auth, await slugOfCall(data))) {
        out.inbound_call_id = data.id;
        if (!out.caller_phone) { const p = strictPhone(data.caller_phone); if (p) out.caller_phone = p; }
      } else console.warn('[call_live_start] inbound_call_id is not a call this login may use -- not linked');
      return out;
    }
    const name = String((auth && auth.name) || '').trim();
    if (!name) return out;
    const { data: staff } = await db.from('staff_users').select('phone').eq('name', name);
    const hs = new Set((staff || []).map((s) => phone10(s.phone)).filter(Boolean));
    if (name === 'Heather') hs.add(HEATHER_OLD_PHONE);
    if (!hs.size) return out;
    const fwd = [...hs].flatMap((p) => [p, '+1' + p, '1' + p]);
    const { data: cands } = await db.from('calls').select('id, caller_phone, answered, duration_sec, status, grasshopper_number, business:businesses ( slug )')
      .eq('kind', 'inbound').in('forwarded_to', fwd).gte('occurred_at', new Date(Date.now() - 15 * MIN).toISOString())
      .order('occurred_at', { ascending: false }).limit(10);
    const list = [];
    for (const c of cands || []) {
      if (c.answered === false || c.status === 'ignored') continue;
      // A pickup under 20 s was voicemail or a hang-up, not the call she is
      // scripting -- the board's own bar (matchInbound).
      if (c.answered === true && c.duration_sec != null && c.duration_sec < TALK_MIN_SEC) continue;
      // The script already knows the customer's number (opened from a card,
      // or typed): only THAT customer's call. Linking whoever rang her last
      // would turn another customer's call into a confirmed talk on their
      // card and use it up (review 2026-09-24).
      if (out.caller_phone && strictPhone(c.caller_phone) !== out.caller_phone) continue;
      if (!mayUseBusiness(auth, await slugOfCall(c))) continue;
      list.push(c);
    }
    if (!list.length) return out;
    const { data: used } = await db.from('calls').select('inbound_call_id').in('inbound_call_id', list.map((c) => c.id));
    const usedIds = new Set((used || []).map((u) => u.inbound_call_id));
    const pick = list.find((c) => !usedIds.has(c.id));
    if (pick) {
      out.inbound_call_id = pick.id;
      if (!out.caller_phone) { const p = strictPhone(pick.caller_phone); if (p && !REPEATED.test(p)) out.caller_phone = p; }
    }
  } catch (e) {
    console.warn('[call_live_start] inbound call link skipped:', e.message);
  }
  return out;
}
