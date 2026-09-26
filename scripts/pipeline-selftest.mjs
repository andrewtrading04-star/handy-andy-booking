// node scripts/pipeline-selftest.mjs -- the Pipeline's card rules (api/_lib/pipeline.js)
// against plain fixtures: grouping, stages, leaks, the soft Lost rules, brand
// families, visibility, the POST ops and the call helpers (in-memory db).
// No network, no real database.
import assert from 'node:assert/strict';
import {
  buildPipeline, computeCards, pipelineHandler, pipelineCallTarget, inboundForLiveStart,
  phone10, familyOf, auditSummary, LOST_REASONS, PIPELINE_FLOOR,
} from '../api/_lib/pipeline.js';
import { allowedSlugsFor } from '../api/_lib/staff-access.js';

// A Friday afternoon in Houston, well after the floor.
const NOW = Date.parse('2026-11-20T18:00:00Z');
const H = 3600000, D = 24 * H, M = 60000;
const ago = (ms) => new Date(NOW - ms).toISOString();

let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const BIZ = [
  { id: 'b-ha', slug: 'handy-andy', name: 'Handy Andy' },
  { id: 'b-doms', slug: 'doms', name: "Dom's TV Mounting" },
  { id: 'b-hm', slug: 'houstonmounting', name: 'Houston Mounting' },
  { id: 'b-la', slug: 'lainstall', name: 'LA Install' },
];
const TRACKING = [
  { phone: '2816388419', business_slug: 'handy-andy', display_name: 'HA Greenway', active: true, forward_to: '+17207223653', created_at: '2026-08-01T00:00:00Z' },
  { phone: '7208006095', business_slug: 'doms', display_name: "Dom's", active: true, forward_to: '+13032190118', created_at: '2026-08-02T00:00:00Z' },
  { phone: '3466604850', business_slug: 'houstonmounting', display_name: 'Houston Mounting', active: true, forward_to: '+17207223653', created_at: '2026-08-03T00:00:00Z' },
];
const STAFF = [{ name: 'Heather', phone: '7207223653', active: true }, { name: 'Joey', phone: '3032190118', active: true }, { name: 'Andrew', phone: '3374997817', active: true }];
const CUST = '8325550101', CUST2 = '8325550202';

function raw(over = {}) {
  return { businesses: BIZ, tracking: TRACKING, staff: STAFF, silent: [{ phone: '3374997817' }], blocked: [],
    calls: [], callEvents: [], messages: [], estimates: [], bookings: [], attempts: [], marks: [], auditSkips: [], audits: [], history: [], ...over };
}
const inbound = (o = {}) => ({ id: uid(), kind: 'inbound', source: 'twilio', business_id: 'b-ha', caller_phone: CUST, grasshopper_number: '2816388419',
  forwarded_to: '+17207223653', occurred_at: ago(2 * H), answered: true, duration_sec: 180, status: 'resolved', handled_by: 'Answered',
  booking_id: null, resolution: null, reached_step: null, quoted_total: null, inbound_call_id: null, ...o });
const missed = (o = {}) => inbound({ answered: false, duration_sec: null, status: 'new', handled_by: null, ...o });
const liveRow = (o = {}) => ({ id: uid(), kind: 'live', source: 'grasshopper', business_id: 'b-ha', caller_phone: null, grasshopper_number: null, forwarded_to: null,
  occurred_at: ago(2 * H), answered: null, duration_sec: null, status: 'resolved', handled_by: 'Heather', booking_id: null, resolution: 'other',
  reached_step: 'resolution', quoted_total: null, inbound_call_id: null, ...o });
const started = (live, actor) => ({ call_id: live.id, event: 'started', actor, meta: {}, created_at: live.occurred_at });
const estimate = (o = {}) => {
  const created = o.created_at || ago(2 * H);
  return { id: uid(), business_id: 'b-ha', source: 'manual', status: 'contacted', customer_name: 'Jamie Holt', customer_phone: CUST, created_at: created,
    updated_at: created, texted_at: created, emailed_at: null, contacted_at: created, approved_at: null, approved_total: null,
    line_items: [{ description: 'TV mounting', qty: 1, unit_price: 200 }], tax_rate: 0.0825, text_opened_at: null, email_opened_at: null,
    followup_emailed_at: null, call_id: null, service_label: 'TV mounting', ...o };
};
const booking = (o = {}) => ({ id: uid(), business_id: 'b-ha', customer_id: 'cust-1', status: 'assigned', source: 'manual', scheduled_at: new Date(NOW + D).toISOString(),
  created_at: ago(2 * H), updated_at: ago(2 * H), completed_at: null, paid_at: null, cancelled_at: null, price: 289, amount_paid: null,
  payment_status: 'unpaid', notes: null, customer_notes: null, metadata: {}, customer: { name: 'Jamie Holt', phone: CUST }, technician: { name: 'Juan' }, ...o });
const attempt = (o = {}) => ({ id: uid(), phone: CUST, business_id: 'b-ha', our_phone: '2816388419', staff_name: 'Heather', source: 'call_claim', twilio_sid: null,
  started_at: ago(H), staff_status: 'completed', dial_status: 'no-answer', duration_sec: 0, talked: false, talked_set_by: 'auto', ended_at: ago(H), card_key: null, ...o });
const text = (o = {}) => ({ id: uid(), business_id: 'b-ha', customer_phone: CUST, our_phone: '2816388419', direction: 'in', body: 'Hi, do you mount TVs?',
  sent_by: null, status: 'received', created_at: ago(2 * H), ...o });

const OWNER = { isOwner: true, allowed: null, viewerName: 'Andrew', range: '30' };
const board = (r, opts = {}) => buildPipeline(r, NOW, { ...OWNER, ...opts });
function one(r, opts) {
  const b = board(r, opts);
  assert.equal(b.cards.length, 1, `expected 1 card, got ${b.cards.length}: ${JSON.stringify(b.cards.map((c) => [c.stage, c.opened_at]))}`);
  return b.cards[0];
}
const all = (r) => computeCards(r, NOW).cards.filter((c) => c.st.stage !== 'hidden').sort((a, b) => a.openedMs - b.openedMs);

let failed = 0, passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); }
}

// ── The spec's verification cases ───────────────────────────────────────────
await check('missed call -> 2 failed tries -> Lost "Never reached"', () => {
  const c = missed({ occurred_at: ago(5 * H) });
  const one1 = one(raw({ calls: [c], attempts: [attempt({ started_at: ago(4 * H) })] }));
  assert.equal(one1.stage, 'new'); assert.equal(one1.tries, 1);
  assert.deepEqual(one1.next, { text: 'Call back — 2nd try left', tone: 'warn' });
  const card = one(raw({ calls: [c], attempts: [attempt({ started_at: ago(4 * H) }), attempt({ started_at: ago(3 * H) })] }));
  assert.equal(card.stage, 'lost');
  assert.deepEqual({ reason: card.lost.reason, auto: card.lost.auto }, { reason: 'Never reached', auto: true });
  assert.equal(card.lost.at, ago(3 * H));
});

await check('missed call, no answer for 48 h -> Lost "Never reached"; fresh miss -> Call back', () => {
  assert.equal(one(raw({ calls: [missed({ occurred_at: ago(49 * H) })] })).lost.reason, 'Never reached');
  const fresh = one(raw({ calls: [missed({ occurred_at: ago(30 * M) })] }));
  assert.equal(fresh.stage, 'new');
  assert.deepEqual(fresh.next, { text: 'Call back — missed 30m ago', tone: 'ok' });
  assert.equal(fresh.source, 'Phone call · HA Greenway');
  assert.equal(fresh.secretary, 'Heather');
});

await check('missed -> callback talked -> Talked to, red leak after 1 h', () => {
  const r = raw({ calls: [missed({ occurred_at: ago(3 * H) })], attempts: [attempt({ started_at: ago(150 * M), talked: true, dial_status: 'completed', duration_sec: 140 })] });
  const b = board(r); const card = b.cards[0];
  assert.equal(card.stage, 'talked'); assert.equal(card.leak, true);
  assert.deepEqual(card.next, { text: 'No booking or estimate yet', tone: 'danger' });
  assert.deepEqual(b.metrics, { calls: 1, converted: 0, leaks: 1 });
  const early = one(raw({ calls: [missed({ occurred_at: ago(40 * M) })], attempts: [attempt({ started_at: ago(30 * M), ended_at: ago(28 * M), talked: true, dial_status: 'completed', duration_sec: 90 })] }));
  assert.equal(early.leak, false);
  assert.deepEqual(early.next, { text: 'Talking — send estimate or book', tone: 'warn' });
});

await check('talked -> estimate -> 7 days -> Lost "No reply after estimate"', () => {
  const sent = ago(8 * D);
  const card = one(raw({ calls: [inbound({ occurred_at: ago(8 * D + 5 * M) })], estimates: [estimate({ created_at: sent })] }));
  assert.equal(card.stage, 'lost');
  assert.deepEqual([card.lost.reason, card.lost.auto], ['No reply after estimate', true]);
  assert.equal(card.lost.at, ago(D));
  const q = one(raw({ calls: [inbound({ occurred_at: ago(6 * D + 5 * M) })], estimates: [estimate({ created_at: ago(6 * D), text_opened_at: ago(5 * D) })] }));
  assert.equal(q.stage, 'quoted');
  assert.deepEqual(q.next, { text: 'Estimate 6d old · opened', tone: 'danger' });
  assert.equal(q.estimate.total, 216.5);
  assert.equal(q.amount, 216.5);
});

await check('auto-Lost quote, approved on day 9 -> Booked (soft revive, same card)', () => {
  const est = estimate({ created_at: ago(10 * D), approved_at: ago(D), approved_total: 356.14, status: 'scheduled' });
  const r = raw({ calls: [inbound({ occurred_at: ago(10 * D + 5 * M) })], estimates: [est],
    bookings: [booking({ source: 'estimate', created_at: ago(D), price: 356.14, metadata: { source_estimate_id: est.id, booked_by: 'Estimate approval (auto-booked)' } })] });
  const card = one(r);
  assert.equal(card.stage, 'booked'); assert.equal(card.lost, null);
  assert.equal(card.booking.price, 356.14);
  // Office "Convert to job" approval with no booking yet.
  const conv = one(raw({ calls: [inbound({ occurred_at: ago(10 * D + 5 * M) })], estimates: [estimate({ created_at: ago(10 * D), approved_at: ago(D), status: 'scheduled' })] }));
  assert.deepEqual([conv.stage, conv.next.text], ['booked', 'Approved — put it on the schedule']);
});

await check('auto-Lost more than 14 days back: the next booking opens a NEW card', () => {
  const cards = all(raw({ calls: [inbound({ occurred_at: ago(25 * D + 5 * M) })], estimates: [estimate({ created_at: ago(25 * D) })],
    bookings: [booking({ created_at: ago(D) })] }));
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.st.stage), ['lost', 'booked']);
});

await check('Paid, then a new call -> new card (with history)', () => {
  const bk = booking({ created_at: ago(5 * D), status: 'completed', completed_at: ago(4 * D), paid_at: ago(4 * D + 3 * M), payment_status: 'paid', amount_paid: 289 });
  const call2 = inbound({ occurred_at: ago(D) });
  const r = raw({ calls: [inbound({ occurred_at: ago(5 * D + 10 * M) }), call2], bookings: [bk],
    messages: [text({ direction: 'out', sent_by: 'automated', our_phone: '8889159967', body: 'How did we do? Leave a review', created_at: ago(4 * D - H) })],
    history: [{ id: bk.id, business_id: 'b-ha', price: 289, amount_paid: 289, completed_at: bk.completed_at, customer: { phone: CUST } }] });
  const b = board(r);
  assert.equal(b.cards.length, 2);
  const paid = b.cards.find((c) => c.paid);
  const fresh = b.cards.find((c) => !c.paid);
  assert.equal(paid.next.text, 'Paid · $289');
  assert.ok(paid.timeline.some((t) => t.text === 'Review request texted'), 'the review ask after Paid stays on the paid card');
  assert.equal(fresh.key, 'c_' + call2.id);
  assert.deepEqual(fresh.history, { prior_cards: 1, prior_jobs: 1, spent: 289, returning: true });
  assert.equal(b.stages.booked, 1);   // Paid shows in Booked (owner 2026-09-26)
});

await check('online booking with no call -> Booked card', () => {
  const card = one(raw({ bookings: [booking({ source: 'widget', payment_status: 'card_on_file', customer: { name: 'Catie Orth', phone: CUST } })] }));
  assert.deepEqual([card.stage, card.source, card.next.text, card.name], ['booked', 'Booked online', 'Booked online', 'Catie Orth']);
  assert.equal(card.secretary, null);
  assert.equal(card.our_phone, null);
});

await check('text to the toll-free alone -> no card; to a tracking line -> New lead', () => {
  assert.equal(board(raw({ messages: [text({ our_phone: '8889159967', business_id: null })] })).cards.length, 0);
  const card = one(raw({ messages: [text({ created_at: ago(20 * M) })] }));
  assert.deepEqual([card.stage, card.source, card.next.text], ['new', 'Text · HA Greenway', 'Text back — texted 20m ago']);
  assert.equal(card.our_phone, '2816388419');
});

await check('Not a lead hides the card from the board and every count', () => {
  const c = inbound({ occurred_at: ago(3 * H) });
  const b = board(raw({ calls: [c], marks: [{ card_key: 'c_' + c.id, not_a_lead: true, not_a_lead_at: ago(2 * H), talk_call_ids: [], no_talk_call_ids: [] }] }));
  assert.equal(b.cards.length, 0);
  assert.deepEqual(b.metrics, { calls: 0, converted: 0, leaks: 0 });
  assert.equal(Object.values(b.stages).reduce((s, n) => s + n, 0), 0);
  // A touch after it opens a fresh card.
  const later = inbound({ occurred_at: ago(H) });
  const b2 = board(raw({ calls: [c, later], marks: [{ card_key: 'c_' + c.id, not_a_lead: true, not_a_lead_at: ago(2 * H) }] }));
  assert.deepEqual(b2.cards.map((x) => x.key), ['c_' + later.id]);
});

await check('manual Lost, then a new call -> new card', () => {
  const c = inbound({ occurred_at: ago(3 * D) });
  const cards = all(raw({ calls: [c, inbound({ occurred_at: ago(2 * H) })],
    marks: [{ card_key: 'c_' + c.id, lost_reason: 'Too expensive', lost_note: 'wanted $99', lost_at: ago(2 * D), lost_by: 'Heather' }] }));
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0].st.lost, { reason: 'Too expensive', auto: false, note: 'wanted $99', by: 'Heather', atMs: NOW - 2 * D });
  assert.equal(cards[1].st.stage, 'talked');
  // Reopen after the Lost puts the first card back where it was.
  const again = all(raw({ calls: [c], marks: [{ card_key: 'c_' + c.id, lost_reason: 'Too expensive', lost_at: ago(2 * D), reopened_at: ago(D) }] }));
  assert.equal(again[0].st.stage, 'talked');
});

// ── Amendments ──────────────────────────────────────────────────────────────
await check('answered under 20 s and nothing else = kept off the board (owner 2026-09-26)', () => {
  const b = board(raw({ calls: [inbound({ duration_sec: 12, occurred_at: ago(20 * M) })] }));
  assert.equal(b.cards.length, 0);
});

await check('answered 20-119 s with no script = unconfirmed talk (Talked / Voicemail)', () => {
  const card = one(raw({ calls: [inbound({ duration_sec: 45, occurred_at: ago(2 * H) })] }));
  assert.deepEqual([card.stage, card.leak], ['talked', true]);
  assert.deepEqual(card.next, { text: 'No booking or estimate — or was it voicemail?', tone: 'danger' });
  assert.equal(card.answered_call.state, 'unconfirmed');
  const b = board(raw({ calls: [inbound({ duration_sec: 45, occurred_at: ago(2 * H) })] }));
  assert.equal(b.metrics.calls, 1, 'still counts as a talk');
});

await check('answered 2 min or more = talked', () => {
  const card = one(raw({ calls: [inbound({ duration_sec: 125, occurred_at: ago(2 * H) })] }));
  assert.deepEqual([card.stage, card.next.text, card.answered_call.state], ['talked', 'No booking or estimate yet', 'talked']);
});

await check('Take a Call row linked by timing -> the short-ish call is a real talk, one card', () => {
  const c = inbound({ duration_sec: 45, occurred_at: ago(2 * H) });
  const live = liveRow({ occurred_at: ago(2 * H - 90000), handled_by: 'Someone else' });   // handled_by overwritten; started actor is Heather
  const b = board(raw({ calls: [c, live], callEvents: [started(live, 'Heather')] }));
  assert.equal(b.cards.length, 1);
  const card = b.cards[0];
  assert.equal(card.stage, 'talked');
  assert.equal(card.answered_call.state, 'talked'); assert.equal(card.answered_call.wizard, true);
  assert.equal(card.next.text, 'No booking or estimate yet');
  assert.equal(card.secretary, 'Heather');
  assert.ok(card.timeline.some((t) => t.icon === 'script' && t.who === 'Heather'));
});

await check('Take a Call row: explicit inbound_call_id, booking phone, no phone, misclick', () => {
  const c = inbound({ duration_sec: 60, occurred_at: ago(3 * H), forwarded_to: '+13032190118' });   // rang Joey, but the script names it
  const live = liveRow({ occurred_at: ago(2 * H), inbound_call_id: c.id, quoted_total: 199 });
  assert.equal(one(raw({ calls: [c, live], callEvents: [started(live, 'Heather')] })).answered_call.state, 'talked');
  // Phone from its booking.
  const bk = booking({ created_at: ago(2 * H - 5 * M), customer: { name: 'Brandon Schell', phone: CUST2 } });
  const live2 = liveRow({ occurred_at: ago(2 * H), booking_id: bk.id, resolution: 'booked' });
  const card2 = one(raw({ calls: [live2], bookings: [bk], callEvents: [started(live2, 'Heather')] }));
  assert.deepEqual([card2.phone, card2.stage, card2.source], [CUST2, 'booked', 'Phone call · Handy Andy']);
  // Phone from the estimate the script sent.
  const est = estimate({ customer_phone: '(832) 555-0303', created_at: ago(2 * H - 3 * M) });
  const live3 = liveRow({ occurred_at: ago(2 * H), resolution: 'estimate_sent' });
  const card3 = one(raw({ calls: [live3], estimates: [est], callEvents: [started(live3, 'Heather'), { call_id: live3.id, event: 'estimate_sent', actor: 'Heather', meta: { estimate_id: est.id } }] }));
  assert.deepEqual([card3.phone, card3.stage], ['8325550303', 'quoted']);
  // No phone anywhere: its own card.
  const lone = liveRow({ occurred_at: ago(3 * H), resolution: null, reached_step: 'recap', quoted_total: 150 });
  const card4 = one(raw({ calls: [lone] }));
  assert.deepEqual([card4.key, card4.name, card4.phone, card4.stage, card4.leak, card4.amount], ['c_' + lone.id, 'Caller (no phone saved)', null, 'talked', true, 150]);
  // Opened on the greet card and closed: ignored.
  assert.equal(board(raw({ calls: [liveRow({ reached_step: 'greet', resolution: null })] })).cards.length, 0);
});

await check("brand family split: a Dom's shopper who also calls HA gets two cards", () => {
  const r = raw({ calls: [
    inbound({ business_id: 'b-doms', grasshopper_number: '7208006095', forwarded_to: '+13032190118', occurred_at: ago(3 * H) }),
    inbound({ business_id: 'b-hm', grasshopper_number: '3466604850', occurred_at: ago(2 * H - 57 * M) }),
  ] });
  const b = board(r);
  assert.equal(b.cards.length, 2);
  assert.deepEqual(b.cards.map((c) => c.family).sort(), ['doms', 'handy-andy']);
  const heather = board(r, { isOwner: false, allowed: allowedSlugsFor({ scope: 'handy-andy' }), viewerName: 'Heather' });
  const joey = board(r, { isOwner: false, allowed: allowedSlugsFor({ scope: 'doms' }), viewerName: 'Joey' });
  assert.deepEqual(heather.cards.map((c) => c.family), ['handy-andy']);
  assert.deepEqual(joey.cards.map((c) => c.family), ['doms']);
  assert.equal(board(r, { business: 'family:doms' }).cards.length, 1);
  assert.equal(board(r, { business: 'houstonmounting' }).cards[0].business.slug, 'houstonmounting');
  // website_form estimates are filed under Dom's on purpose and stay there.
  assert.equal(familyOf('doms'), 'doms'); assert.equal(familyOf('tvmountingdenver'), 'doms'); assert.equal(familyOf('houstonmounting'), 'handy-andy');
  const wf = one(raw({ estimates: [estimate({ business_id: 'b-doms', source: 'website_form', status: 'new', texted_at: null, contacted_at: null, created_at: ago(3 * H) })] }));
  assert.deepEqual([wf.family, wf.stage, wf.source, wf.next.text, wf.next.tone], ['doms', 'new', 'Website estimate', 'Needs a response — over 30 min', 'warn']);
});

await check('$0 completed job = Paid; future $0 job is not; priced completed unpaid = Done', () => {
  assert.equal(one(raw({ bookings: [booking({ price: 0, status: 'completed', completed_at: ago(H), created_at: ago(3 * H) })] })).paid, true);
  assert.equal(one(raw({ bookings: [booking({ price: 0, status: 'assigned' })] })).stage, 'booked');
  const done = one(raw({ bookings: [booking({ status: 'completed', completed_at: ago(H), created_at: ago(3 * H) })] }));
  assert.deepEqual([done.stage, done.next.text], ['booked', 'Job done — payment not collected']);
});

await check('Talked / Voicemail marks and audit skips override the length rule', () => {
  const c = inbound({ duration_sec: 45, occurred_at: ago(2 * H) });
  const k = 'c_' + c.id;
  assert.equal(one(raw({ calls: [c], marks: [{ card_key: k, no_talk_call_ids: [c.id], talk_call_ids: [] }] })).stage, 'new');
  assert.equal(one(raw({ calls: [c], auditSkips: [{ call_id: c.id, reason: 'voicemail' }] })).answered_call.state, 'voicemail');
  const short = inbound({ duration_sec: 8, occurred_at: ago(2 * H) });
  const t = one(raw({ calls: [short], marks: [{ card_key: 'c_' + short.id, talk_call_ids: [short.id], no_talk_call_ids: [] }] }));
  assert.deepEqual([t.stage, t.next.text], ['talked', 'No booking or estimate yet']);
});

await check('excluded phones never open a card', () => {
  const r = raw({
    blocked: [{ phone: '3017852271' }],
    calls: [
      inbound({ caller_phone: '3017852271' }),                                           // blocked sitewide
      inbound({ caller_phone: '3017850000', status: 'ignored', handled_by: 'Blocked number' }),
      inbound({ caller_phone: '3374997817' }),                                           // silent (owner)
      inbound({ caller_phone: '7207223653' }),                                           // staff handset
      inbound({ caller_phone: '7203711561' }),                                           // Heather's old phone
      inbound({ caller_phone: 'unknown' }),
      inbound({ caller_phone: '521234567890' }),                                         // 12 digits
    ],
    estimates: [estimate({ customer_phone: '9999999999 ext 9999' }), estimate({ customer_name: 'Browser E2E Test (ignore)', customer_phone: '3035550199' })],
    bookings: [booking({ customer: { name: 'Andrew', phone: '(337) 499-7817' } })],
  });
  assert.equal(board(r).cards.length, 0);
});

await check('answered IS NULL after the floor = missed (voicemail line / bot); in progress = on the phone', () => {
  const old = one(raw({ calls: [inbound({ answered: null, duration_sec: 4, status: 'new', occurred_at: ago(3 * H) })] }));
  assert.deepEqual([old.stage, old.timeline[0].text], ['new', 'Call not answered by a person · HA Greenway']);
  const now = one(raw({ calls: [inbound({ answered: null, duration_sec: null, status: 'new', occurred_at: ago(2 * M) })] }));
  assert.deepEqual([now.stage, now.next.text], ['talked', 'On the phone now']);
});

// ── Other rules ─────────────────────────────────────────────────────────────
await check('cancelled job -> Lost "Job cancelled"; the customer calling back revives it', () => {
  const bk = booking({ status: 'cancelled', cancelled_at: ago(2 * D), created_at: ago(3 * D) });
  assert.deepEqual(one(raw({ bookings: [bk] })).lost, { reason: 'Job cancelled', auto: true, note: '', by: null, at: ago(2 * D) });
  const back = one(raw({ bookings: [bk], calls: [inbound({ occurred_at: ago(20 * M), duration_sec: 130 })] }));
  assert.deepEqual([back.stage, back.leak], ['talked', false]);
});

await check('office "Not a fit" -> Lost "We don\'t do that"', () => {
  const card = one(raw({ estimates: [estimate({ status: 'declined', updated_at: ago(H), created_at: ago(3 * H) })] }));
  assert.deepEqual([card.lost.reason, card.lost.auto], ["We don't do that", true]);
});

await check('a staff text is a talk only after the customer texted in', () => {
  const r1 = raw({ calls: [missed({ occurred_at: ago(3 * H) })], messages: [text({ direction: 'out', sent_by: 'Heather', created_at: ago(2 * H) })] });
  assert.equal(one(r1).stage, 'new');
  const r2 = raw({ messages: [text({ created_at: ago(3 * H) }), text({ direction: 'out', sent_by: 'Heather', body: 'Yes we do!', created_at: ago(170 * M) })] });
  const card = one(r2);
  assert.deepEqual([card.stage, card.leak, card.secretary], ['talked', true, 'Heather']);
});

await check('bridge call whose staff leg never connected is not a try', () => {
  const card = one(raw({ calls: [missed({ occurred_at: ago(5 * H) })], attempts: [
    attempt({ started_at: ago(4 * H), staff_status: 'no-answer', dial_status: null }),
    attempt({ started_at: ago(3 * H), staff_status: 'failed', dial_status: null }),
  ] }));
  assert.deepEqual([card.stage, card.tries], ['new', 0]);
  assert.ok(card.timeline.some((t) => /your phone no-answer/.test(t.text)));
  // Her own "No answer" tap after such a call still isn't a try: nobody rang the customer.
  const tapped = one(raw({ calls: [missed({ occurred_at: ago(5 * H) })], attempts: [
    attempt({ started_at: ago(4 * H), staff_status: 'no-answer', dial_status: null, talked: false, talked_set_by: 'Heather' }),
    attempt({ started_at: ago(3 * H), staff_status: 'busy', dial_status: null, talked: false, talked_set_by: 'Heather' }),
  ] }));
  assert.deepEqual([tapped.stage, tapped.tries], ['new', 0]);
  // ...but her "Yes" on one is a talk.
  const yes = one(raw({ calls: [missed({ occurred_at: ago(5 * H) })], attempts: [attempt({ started_at: ago(4 * H), staff_status: 'no-answer', dial_status: null, talked: true, talked_set_by: 'Heather' })] }));
  assert.equal(yes.stage, 'talked');
});

await check('a new missed call after "Never reached" restarts the callback clock', () => {
  const card = one(raw({ calls: [missed({ occurred_at: ago(5 * D) }), missed({ occurred_at: ago(H) })],
    attempts: [attempt({ started_at: ago(5 * D - H) }), attempt({ started_at: ago(5 * D - 2 * H) })] }));
  assert.deepEqual([card.stage, card.tries, card.next.text], ['new', 0, 'Call back — missed 1h ago']);
});

await check('Reopen cancels an automatic Lost and restarts its clock', () => {
  const c = missed({ occurred_at: ago(4 * D) });
  const card = one(raw({ calls: [c], marks: [{ card_key: 'c_' + c.id, reopened_at: ago(H), reopened_by: 'Heather' }] }));
  assert.equal(card.stage, 'new');
  assert.ok(card.timeline.some((t) => t.text === 'Reopened' && t.who === 'Heather'));
});

await check('a card quiet for 30 days: the next touch opens a new card', () => {
  const cards = all(raw({ calls: [inbound({ occurred_at: ago(40 * D) }), inbound({ occurred_at: ago(H) })], bookings: [booking({ created_at: ago(40 * D - H), scheduled_at: ago(39 * D) })] }));
  assert.equal(cards.length, 2);
});

await check('a try from the card\'s Call button joins that card; timeline carries the auto-text', () => {
  const c = missed({ occurred_at: ago(3 * H) });
  const card = one(raw({ calls: [c],
    messages: [text({ direction: 'out', sent_by: 'automated', body: 'Sorry we missed your call! We will call you back.', created_at: ago(3 * H - 20000) })],
    attempts: [attempt({ started_at: ago(2 * H), card_key: 'c_' + c.id, source: 'pipeline' })] }));
  assert.equal(card.tries, 1);
  assert.ok(card.timeline.some((t) => t.text === 'Auto-text sent (missed call)'));
});

await check('ranges, sort order, scoreboard and audits', () => {
  const leak = inbound({ occurred_at: ago(13 * H), duration_sec: 200 });        // 05:00Z = before today's Chicago midnight (06:00Z)
  const fresh = inbound({ caller_phone: CUST2, occurred_at: ago(20 * M), duration_sec: 200 });
  const joeyCall = inbound({ caller_phone: '7205550404', business_id: 'b-doms', grasshopper_number: '7208006095', forwarded_to: '+13032190118', occurred_at: ago(3 * H), duration_sec: 300 });
  const r = raw({ calls: [leak, fresh, joeyCall], bookings: [booking({ customer: { name: 'Pat', phone: '7205550404' }, business_id: 'b-doms', created_at: ago(170 * M) })],
    audits: [{ id: 'a1', call_id: leak.id, caller_phone: '(832) 555-0101', occurred_at: ago(14 * H), handled_by: 'Heather',
      answers: { greet_named_business: 'yes', paused_after_price: 'no', asked_scoping_questions: 'yes', said_price_matched: 'na', cust_agreed_date: 'no' },
      ratings: { script: 5 }, flagged: true, listen_reason: 'rushed the price', complaint: null }] });
  assert.equal(board(r, { range: 'today' }).cards.length, 2);
  const b = board(r, { range: '7' });
  assert.equal(b.cards.length, 3);
  assert.equal(b.cards[0].key, 'c_' + leak.id, 'leaks first');
  assert.deepEqual(b.scoreboard, [{ name: 'Heather', talked: 2, converted: 0, pct: 0 }, { name: 'Joey', talked: 1, converted: 1, pct: 100 }]);
  assert.deepEqual(b.metrics, { calls: 3, converted: 1, leaks: 1 });
  assert.deepEqual(b.cards[0].audit, { score: 67, yes: 2, n: 3, flagged: true, listen_reason: 'rushed the price', complaint: null, ratings: { script: 5 }, by: 'Heather', at: ago(14 * H), count: 1 });
  const sec = board(r, { isOwner: false, allowed: allowedSlugsFor({ scope: 'handy-andy' }), viewerName: 'Heather', range: '7' });
  assert.equal(sec.is_owner, false);
  assert.deepEqual(sec.scoreboard.map((x) => x.name), ['Heather'], 'a secretary sees only her own row');
  assert.ok(sec.cards.every((c) => c.audit === null && !c.timeline.some((t) => t.icon === 'audit')), 'audits are owner-only');
  assert.deepEqual(b.lost_reasons, LOST_REASONS);
  assert.equal(b.floor, PIPELINE_FLOOR);
  assert.ok(!('_talked' in b.cards[0]) && !JSON.stringify(b).includes('_converted'));
});

await check('phone normalising and audit score', () => {
  assert.equal(phone10('(303) 555-1234 ext 12'), '3035551234');
  assert.equal(phone10('+1 720-637-3707'), '7206373707');
  assert.equal(phone10('555-1234'), '');
  assert.deepEqual(auditSummary([{ answers: { a: 'yes', b: 'no', cust_accepted_price: 'no', c: 'na' }, flagged: false, listen_reason: 'x' }]).score, 50);
  assert.equal(auditSummary([{ answers: { cust_agreed_date: 'yes' } }]).score, null);
});

await check('nothing before the floor is shown', () => {
  const r = raw({ calls: [inbound({ occurred_at: '2026-09-22T14:00:00Z' })] });
  assert.equal(buildPipeline(r, Date.parse('2026-09-23T12:00:00Z'), { ...OWNER, range: '30' }).cards.length, 0);
});

// ── Review fixes (2026-09-24) ───────────────────────────────────────────────
await check('Lost, reopened, Lost again: a call from the first Lost span keeps its own card', () => {
  const a = inbound({ occurred_at: ago(6 * D) });
  const b = inbound({ occurred_at: ago(4 * D) });    // while A sat marked Lost
  const mk = { card_key: 'c_' + a.id, lost_reason: 'Just shopping', lost_at: ago(D), reopened_at: ago(3 * D), closed_windows: [{ from: ago(5 * D), to: ago(3 * D) }] };
  const cards = all(raw({ calls: [a, b], marks: [mk] }));
  assert.deepEqual(cards.map((c) => [c.key, c.st.stage]), [['c_' + a.id, 'lost'], ['c_' + b.id, 'talked']]);
  assert.equal(board(raw({ calls: [a, b], marks: [mk] })).metrics.leaks, 1, "B's leak stays on the board");
});

await check('owner-only brands are their own family: never on a Handy Andy card', () => {
  assert.deepEqual(['lainstall', 'latvpro', 'tvmountinglosangeles', 'houstonmounting', 'handy-andy', 'doms'].map(familyOf),
    ['owner', 'owner', 'owner', 'handy-andy', 'handy-andy', 'doms']);
  const r = raw({ calls: [missed({ occurred_at: ago(3 * H) })],
    estimates: [estimate({ business_id: 'b-la', customer_name: 'Pat LA', created_at: ago(2 * H) })] });
  const b = board(r);
  assert.deepEqual(b.cards.map((c) => c.family).sort(), ['handy-andy', 'owner']);
  const heather = board(r, { isOwner: false, allowed: allowedSlugsFor({ scope: 'handy-andy' }), viewerName: 'Heather' });
  assert.deepEqual(heather.cards.map((c) => [c.family, c.business.slug, c.estimate]), [['handy-andy', 'handy-andy', null]]);
  assert.ok(!JSON.stringify(heather).includes('Pat LA'));
  assert.deepEqual(board(r, { business: 'family:owner' }).cards.map((c) => c.business.slug), ['lainstall']);
});

await check('answered_call is the call the card asks about, not the latest pickup', () => {
  const c45 = inbound({ duration_sec: 45, occurred_at: ago(2 * H) });
  const c10 = inbound({ duration_sec: 10, occurred_at: ago(H) });
  const card = one(raw({ calls: [c45, c10] }));
  assert.equal(card.next.text, 'No booking or estimate — or was it voicemail?');
  assert.deepEqual([card.answered_call.id, card.answered_call.state], [c45.id, 'unconfirmed']);
  assert.equal(card.inbound_call_id, c10.id, 'inbound_call_id stays the latest call');
  // A confirmed talk followed by a short pickup: the talk is the one to undo.
  const c150 = inbound({ duration_sec: 150, occurred_at: ago(2 * H) });
  const talked = one(raw({ calls: [c150, inbound({ duration_sec: 8, occurred_at: ago(H) })] }));
  assert.deepEqual([talked.answered_call.id, talked.answered_call.state, talked.answered_call.wizard], [c150.id, 'talked', false]);
});

await check('a stored Talked mark never turns a missed or unanswered call into a talk', () => {
  const m = missed({ occurred_at: ago(30 * M) });
  const card = one(raw({ calls: [m], marks: [{ card_key: 'c_' + m.id, talk_call_ids: [m.id], no_talk_call_ids: [] }] }));
  assert.deepEqual([card.stage, card.timeline[0].text], ['new', 'Missed call · HA Greenway']);
  const n = inbound({ answered: null, duration_sec: 6, status: 'new', occurred_at: ago(3 * H) });
  assert.equal(one(raw({ calls: [n], marks: [{ card_key: 'c_' + n.id, talk_call_ids: [n.id] }] })).stage, 'new');
});

await check('a script linked to ANOTHER customer\'s call does not make that call a talk', () => {
  const other = inbound({ caller_phone: CUST2, duration_sec: 45, occurred_at: ago(2 * H) });
  const live = liveRow({ occurred_at: ago(2 * H - 60000), inbound_call_id: other.id, caller_phone: CUST });
  const cards = board(raw({ calls: [other, live], callEvents: [started(live, 'Heather')] })).cards;
  const theirs = cards.find((c) => c.phone === CUST2);
  assert.deepEqual([theirs.answered_call.state, theirs.answered_call.wizard], ['unconfirmed', false]);
  assert.equal(cards.find((c) => c.phone === CUST).stage, 'talked');
});

await check('a null call that ended or was never forwarded is not "On the phone now"', () => {
  const noFwd = one(raw({ calls: [inbound({ answered: null, duration_sec: null, status: 'new', forwarded_to: null, occurred_at: ago(10 * M) })] }));
  assert.deepEqual([noFwd.stage, noFwd.next.text], ['new', 'Call back — missed 10m ago']);
  const ended = board(raw({ calls: [inbound({ answered: null, duration_sec: 4, status: 'new', occurred_at: ago(10 * M) })] }));
  assert.deepEqual([ended.cards[0].stage, ended.metrics.calls], ['new', 0]);
});

await check('a toll-free "ok thanks" after a cancellation leaves it Lost "Job cancelled"', () => {
  const bk = booking({ status: 'cancelled', cancelled_at: ago(2 * D), created_at: ago(3 * D) });
  const card = one(raw({ bookings: [bk], messages: [text({ our_phone: '8889159967', business_id: null, body: 'ok thanks', created_at: ago(2 * D - M) })] }));
  assert.deepEqual([card.stage, card.lost.reason], ['lost', 'Job cancelled']);
});

await check('a late approval books its own quote card (booking row written just before approved_at)', () => {
  const est = estimate({ created_at: ago(25 * D), approved_at: ago(D), approved_total: 356.14, status: 'scheduled' });
  const r = raw({ calls: [inbound({ occurred_at: ago(25 * D + 5 * M) })], estimates: [est],
    bookings: [booking({ source: 'estimate', created_at: ago(D + 3000), price: 356.14, metadata: { source_estimate_id: est.id, booked_by: 'Estimate approval (auto-booked)' } })] });
  const b = board(r);
  assert.deepEqual(b.cards.map((c) => [c.stage, c.next.text]), [['booked', 'Booked']]);
  // A quote a person marked Lost stays Lost; the approval gets its own card.
  const k = 'c_' + r.calls[0].id;
  const lost = all({ ...r, marks: [{ card_key: k, lost_reason: 'Too expensive', lost_at: ago(20 * D) }] });
  assert.deepEqual(lost.map((c) => c.st.stage), ['lost', 'booked']);
});

await check('an unanswered web request auto-archived later keeps its card key and marks', () => {
  const est = estimate({ source: 'widget', status: 'new', texted_at: null, contacted_at: null, created_at: ago(9 * D) });
  const c = missed({ occurred_at: ago(9 * D - H) });
  const mk = [{ card_key: 'c_' + est.id, not_a_lead: true, not_a_lead_at: ago(9 * D - 2 * H) }];
  assert.equal(board(raw({ calls: [c], estimates: [est], marks: mk })).cards.length, 0);
  const archived = { ...est, status: 'archived' };
  const after = board(raw({ calls: [c], estimates: [archived], marks: mk }));
  assert.deepEqual([after.cards.length, after.stages.lost], [0, 0], 'still Not a lead after the archive');
  // Without the mark it is the same card, now judged by the missed call.
  const kept = one(raw({ calls: [c], estimates: [archived] }));
  assert.deepEqual([kept.key, kept.stage, kept.lost.reason], ['c_' + est.id, 'lost', 'Never reached']);
  assert.ok(kept.timeline.some((t) => /archived, never sent/.test(t.text)));
  // An archived request on its own is still no card.
  assert.equal(board(raw({ estimates: [archived] })).cards.length, 0);
});

await check('a call about a job booked weeks out joins that job, not a new leaking card', () => {
  const cards = all(raw({ bookings: [booking({ created_at: ago(35 * D), scheduled_at: new Date(NOW + 2 * D).toISOString() })],
    calls: [inbound({ occurred_at: ago(3 * H), duration_sec: 200 })] }));
  assert.deepEqual(cards.map((c) => c.st.stage), ['booked']);
});

// ── POST ops, GET through the handler, and the call helpers (in-memory db) ──
function cmp(a, b) {
  const x = Date.parse(a), y = Date.parse(b);
  if (typeof a === 'string' && typeof b === 'string' && Number.isFinite(x) && Number.isFinite(y) && /\d{4}-\d\d-\d\dT/.test(a)) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}
const DEFAULTS = { pipeline_marks: { not_a_lead: false, talk_call_ids: [], no_talk_call_ids: [] }, call_attempts: {} };
// missingCols: columns the fake database doesn't have yet (a migration not applied).
function fakeDb(seed, missingCols = []) {
  const t = {};
  for (const [k, v] of Object.entries(seed)) t[k] = v.map((r) => ({ ...r }));
  const embed = (cols, rows) => rows.map((r) => {
    const o = { ...r };
    if (/business:businesses/.test(cols)) { const b = (t.businesses || []).find((x) => x.id === r.business_id); o.business = b ? { slug: b.slug, name: b.name } : null; }
    return o;
  });
  class Q {
    constructor(name) { this.name = name; this.f = []; this.o = []; this.op = 'select'; this.cols = '*'; }
    select(cols = '*') { if (this.op === 'select') this.cols = cols; return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
    gte(c, v) { this.f.push((r) => r[c] != null && cmp(r[c], v) >= 0); return this; }
    order(c, opt = {}) { this.o.push([c, opt.ascending !== false]); return this; }
    range(a, b) { this.rg = [a, b]; return this; }
    limit(n) { this.lim = n; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'one'; return this; }
    insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    update(p) { this.op = 'update'; this.payload = p; return this; }
    upsert(rows, opt) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.key = (opt && opt.onConflict) || 'id'; return this; }
    then(ok, bad) { try { ok(this.run()); } catch (e) { bad(e); } }
    run() {
      const tbl = t[this.name] || (t[this.name] = []);
      if (this.op === 'insert') { const out = this.payload.map((r) => { const row = { ...(DEFAULTS[this.name] || {}), id: r.id || uid(), ...r }; tbl.push(row); return row; }); return this.shape(out); }
      if (this.op === 'update') { const hit = tbl.filter((r) => this.f.every((f) => f(r))); hit.forEach((r) => Object.assign(r, this.payload)); return this.shape(hit); }
      if (this.op === 'upsert') {
        const gone = missingCols.find((c) => this.payload.some((row) => c in row));
        if (gone) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${gone}' column of '${this.name}' in the schema cache` } };
        for (const row of this.payload) { const ex = tbl.find((r) => r[this.key] === row[this.key]); if (ex) Object.assign(ex, row); else tbl.push({ ...(DEFAULTS[this.name] || {}), ...row }); }
        return { data: null, error: null };
      }
      let rows = tbl.filter((r) => this.f.every((f) => f(r)));
      if (this.o.length) rows.sort((a, b) => { for (const [c, asc] of this.o) { const d = cmp(a[c], b[c]); if (d) return asc ? d : -d; } return 0; });
      if (this.rg) rows = rows.slice(this.rg[0], this.rg[1] + 1);
      if (this.lim != null) rows = rows.slice(0, this.lim);
      return this.shape(embed(this.cols, rows));
    }
    shape(rows) {
      if (!this.one) return { data: rows, error: null };
      if (rows.length > 1 && this.one === 'one') return { data: null, error: { message: 'multiple rows' } };
      return { data: rows[0] || null, error: rows.length || this.one === 'maybe' ? null : { message: 'no rows' } };
    }
  }
  return { tables: t, from: (name) => new Q(name) };
}
function res() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const HEATHER = { kind: 'admin', role: 'secretary', scope: 'handy-andy', name: 'Heather' };
const JOEY = { kind: 'admin', role: 'secretary', scope: 'doms', name: 'Joey' };
const OWNER_AUTH = { kind: 'admin', role: 'owner', scope: 'all', name: 'Andrew' };
const AUDITOR = { kind: 'admin', role: 'auditor', scope: 'all', name: 'Jiyah', auditor: true };
// Fixtures use relative-to-NOW times; the handler runs on the real clock, so
// shift them onto it.
const shift = Date.now() - NOW;
const real = (iso) => new Date(Date.parse(iso) + shift).toISOString();
const reclock = (row, keys) => { const o = { ...row }; for (const k of keys) if (o[k]) o[k] = real(o[k]); return o; };
function seedDb(missingCols = []) {
  const ha = reclock(inbound({ duration_sec: 45, occurred_at: ago(2 * H) }), ['occurred_at']);
  const dom = reclock(inbound({ caller_phone: CUST2, business_id: 'b-doms', grasshopper_number: '7208006095', forwarded_to: '+13032190118', occurred_at: ago(3 * H), duration_sec: 300 }), ['occurred_at']);
  const cust = { id: 'cust-9', business_id: 'b-ha', name: 'Web Only', phone: '(720) 555-0909' };
  const bk = reclock(booking({ customer_id: 'cust-9', source: 'widget', customer: { name: 'Web Only', phone: '(720) 555-0909' } }), ['created_at', 'updated_at', 'scheduled_at']);
  const db = fakeDb({ calls: [ha, dom], messages: [], estimates: [], bookings: [bk], call_attempts: [], pipeline_marks: [], audit_skips: [],
    staff_users: STAFF, silent_numbers: [{ id: 's1', phone: '3374997817' }], blocked_numbers: [], tracking_numbers: TRACKING, businesses: BIZ,
    call_audits: [], call_events: [], customers: [cust] }, missingCols);
  return { db, ha, dom, bk };
}
const post = async (db, auth, body) => { const r = res(); await pipelineHandler({ method: 'POST', query: {} }, r, db, auth, body); return r; };
const get = async (db, auth, query = {}) => { const r = res(); await pipelineHandler({ method: 'GET', query: { range: '7', ...query } }, r, db, auth, {}); return r; };

await check('GET through the handler: scoping by login', async () => {
  const { db, ha } = seedDb();
  const o = await get(db, OWNER_AUTH);
  assert.equal(o.code, 200); assert.equal(o.body.cards.length, 3);
  const h = await get(db, HEATHER);
  assert.deepEqual(h.body.cards.map((c) => c.family).sort(), ['handy-andy', 'handy-andy']);
  assert.ok(h.body.cards.some((c) => c.key === 'c_' + ha.id));
  assert.equal((await get(db, JOEY)).body.cards.length, 1);
  assert.equal((await get(db, AUDITOR)).code, 403);
  assert.equal((await post(db, AUDITOR, { op: 'reopen', card_key: 'c_' + ha.id })).code, 403);
});

await check('POST mark_lost / not_a_lead / reopen', async () => {
  const { db, ha, dom } = seedDb();
  const key = 'c_' + ha.id;
  assert.equal((await post(db, HEATHER, { op: 'mark_lost', card_key: key, reason: 'Cheap' })).code, 400);
  assert.equal((await post(db, HEATHER, { op: 'mark_lost', card_key: 'c_' + dom.id, reason: 'Spam' })).code, 403, "Heather can't touch a Dom's card");
  assert.equal((await post(db, HEATHER, { op: 'mark_lost', card_key: 'c_00000000-0000-4000-8000-999999999999', reason: 'Spam' })).code, 404);
  const r = await post(db, HEATHER, { op: 'mark_lost', card_key: key, reason: 'Too expensive', note: '  wanted   $99 ' });
  assert.deepEqual([r.code, r.body], [200, { ok: true }]);
  const m = db.tables.pipeline_marks[0];
  assert.deepEqual([m.card_key, m.business_id, m.phone, m.lost_reason, m.lost_note, m.lost_by], [key, 'b-ha', CUST, 'Too expensive', 'wanted $99', 'Heather']);
  let card = (await get(db, HEATHER)).body.cards.find((c) => c.key === key);
  assert.deepEqual([card.stage, card.lost.reason, card.lost.auto], ['lost', 'Too expensive', false]);
  await new Promise((ok) => setTimeout(ok, 5));
  await post(db, HEATHER, { op: 'reopen', card_key: key });
  card = (await get(db, HEATHER)).body.cards.find((c) => c.key === key);
  assert.equal(card.stage, 'talked');
  await post(db, OWNER_AUTH, { op: 'not_a_lead', card_key: key });
  assert.ok(!(await get(db, OWNER_AUTH)).body.cards.some((c) => c.key === key));
  assert.equal(db.tables.pipeline_marks.length, 1, 'one marks row per card');
});

await check('POST talk / no_talk flip the answered call', async () => {
  const { db, ha, dom } = seedDb();
  const key = 'c_' + ha.id;
  assert.equal((await post(db, HEATHER, { op: 'no_talk', card_key: key, call_id: dom.id })).code, 400, 'call must be on the card');
  await post(db, HEATHER, { op: 'no_talk', card_key: key, call_id: ha.id });
  let card = (await get(db, HEATHER)).body.cards.find((c) => c.key === key);
  assert.deepEqual([card.stage, card.answered_call.state], ['new', 'voicemail']);
  await post(db, HEATHER, { op: 'talk', card_key: key, call_id: ha.id });
  card = (await get(db, HEATHER)).body.cards.find((c) => c.key === key);
  assert.deepEqual([card.stage, card.answered_call.state, card.next.text], ['talked', 'talked', 'No booking or estimate yet']);
  assert.deepEqual([db.tables.pipeline_marks[0].talk_call_ids, db.tables.pipeline_marks[0].no_talk_call_ids], [[ha.id], []]);
});

await check('POST talk refuses a missed call (only an answered call can be a talk)', async () => {
  const { db, ha } = seedDb();
  const m = reclock(missed({ occurred_at: ago(90 * M) }), ['occurred_at']);
  db.tables.calls.push(m);
  const key = 'c_' + ha.id;
  const r = await post(db, HEATHER, { op: 'talk', card_key: key, call_id: m.id });
  assert.deepEqual([r.code, r.body.error], [400, 'Only an answered call can be marked as a talk']);
  assert.equal(db.tables.pipeline_marks.length, 0, 'nothing stored');
  assert.equal((await post(db, HEATHER, { op: 'no_talk', card_key: key, call_id: m.id })).code, 200, 'no_talk on it is harmless');
  const card = (await get(db, HEATHER)).body.cards.find((c) => c.key === key);
  assert.deepEqual([card.answered_call.id, card.answered_call.state], [ha.id, 'unconfirmed'], 'the question is still about the answered call');
});

await check('POST reopen / re-mark keeps the span the card sat closed', async () => {
  const { db, ha } = seedDb();
  const key = 'c_' + ha.id;
  const tick = () => new Promise((ok) => setTimeout(ok, 5));
  await post(db, HEATHER, { op: 'mark_lost', card_key: key, reason: 'Just shopping' });
  const m = db.tables.pipeline_marks[0];
  const lost1 = m.lost_at;
  await tick(); await post(db, HEATHER, { op: 'reopen', card_key: key });
  assert.deepEqual(m.closed_windows, [{ from: lost1, to: m.reopened_at }]);
  await tick(); await post(db, HEATHER, { op: 'mark_lost', card_key: key, reason: 'Too expensive' });
  assert.equal(m.closed_windows.length, 1, 'marking an open card Lost adds no span');
  const lost2 = m.lost_at;
  await tick(); await post(db, HEATHER, { op: 'mark_lost', card_key: key, reason: 'Spam' });
  assert.deepEqual(m.closed_windows[1], { from: lost2, to: m.lost_at }, 'a re-mark while Lost keeps the earlier Lost span');
  // Migration 0142 not applied yet: the decision still saves, without the span.
  const old = seedDb(['closed_windows']);
  const k2 = 'c_' + old.ha.id;
  await post(old.db, HEATHER, { op: 'mark_lost', card_key: k2, reason: 'Just shopping' });
  await tick();
  const r = await post(old.db, HEATHER, { op: 'reopen', card_key: k2 });
  assert.equal(r.code, 200);
  assert.ok(old.db.tables.pipeline_marks[0].reopened_at && !('closed_windows' in old.db.tables.pipeline_marks[0]));
});

await check('owner-only brand: its card is not Heather\'s to see or change', async () => {
  const { db, ha } = seedDb();
  const la = reclock(estimate({ business_id: 'b-la', customer_name: 'Pat LA', created_at: ago(H) }), ['created_at', 'updated_at', 'texted_at', 'contacted_at']);
  db.tables.estimates.push(la);
  const h = await get(db, HEATHER);
  assert.ok(!h.body.cards.some((c) => c.family === 'owner') && !JSON.stringify(h.body).includes('Pat LA'));
  assert.equal(h.body.cards.find((c) => c.key === 'c_' + ha.id).estimate, null);
  assert.equal((await post(db, HEATHER, { op: 'mark_lost', card_key: 'c_' + la.id, reason: 'Spam' })).code, 403);
  assert.ok((await get(db, OWNER_AUTH)).body.cards.some((c) => c.key === 'c_' + la.id && c.family === 'owner'));
});

await check('POST log_attempt / attempt_outcome', async () => {
  const { db, ha } = seedDb();
  const key = 'c_' + ha.id;
  assert.equal((await post(db, HEATHER, { op: 'log_attempt', card_key: key, phone: '8325559999', talked: false })).code, 400);
  assert.equal((await post(db, HEATHER, { op: 'log_attempt', card_key: key, phone: CUST })).code, 400, 'talked is required');
  assert.equal((await post(db, HEATHER, { op: 'log_attempt', card_key: key, phone: CUST, talked: false })).code, 200);
  const a = db.tables.call_attempts[0];
  assert.deepEqual([a.phone, a.business_id, a.source, a.talked, a.talked_set_by, a.card_key, a.our_phone], [CUST, 'b-ha', 'manual', false, 'Heather', key, '2816388419']);
  assert.equal((await post(db, JOEY, { op: 'attempt_outcome', attempt_id: a.id, talked: true })).code, 403);
  assert.equal((await post(db, HEATHER, { op: 'attempt_outcome', attempt_id: a.id, talked: 'yes' })).code, 400);
  assert.equal((await post(db, HEATHER, { op: 'attempt_outcome', attempt_id: a.id, talked: true })).code, 200);
  assert.deepEqual([a.talked, a.talked_set_by], [true, 'Heather']);
  assert.equal((await post(db, HEATHER, { op: 'bogus' })).code, 400);
});

await check('call_start source pipeline: line and business re-derived, scoped', async () => {
  const { db, bk } = seedDb();
  const t1 = await pipelineCallTarget(db, HEATHER, CUST, 'handy-andy');
  assert.deepEqual([t1.phone, t1.line, t1.businessId], [CUST, '2816388419', 'b-ha']);
  // Only a booking (widget): no call or text line -> the brand's first forwarded line.
  const t2 = await pipelineCallTarget(db, HEATHER, '7205550909', 'handy-andy');
  assert.deepEqual([t2.line, t2.businessId], ['2816388419', 'b-ha']);
  assert.ok(bk.id);
  await assert.rejects(pipelineCallTarget(db, HEATHER, CUST2, null), (e) => e.status === 404, "Joey's customer isn't Heather's to call");
  await assert.rejects(pipelineCallTarget(db, HEATHER, CUST2, 'doms'), (e) => e.status === 404, "a brand she can't use is ignored, and nothing of hers has the number");
  await assert.rejects(pipelineCallTarget(db, HEATHER, '3035550000', 'handy-andy'), (e) => e.status === 404, 'a made-up number');
  const t3 = await pipelineCallTarget(db, JOEY, CUST2, 'doms');
  assert.equal(t3.line, '7208006095');
  await assert.rejects(pipelineCallTarget(db, HEATHER, '999-999-9999', null), (e) => e.status === 400);
  // Owner, a phone that rang both families: the card's family picks the line.
  db.tables.calls.push(reclock(inbound({ caller_phone: CUST, business_id: 'b-doms', grasshopper_number: '7208006095', occurred_at: ago(30 * M) }), ['occurred_at']));
  assert.equal((await pipelineCallTarget(db, OWNER_AUTH, CUST, 'handy-andy')).line, '2816388419');
  assert.equal((await pipelineCallTarget(db, OWNER_AUTH, CUST, 'doms')).line, '7208006095');
  assert.equal((await pipelineCallTarget(db, OWNER_AUTH, CUST, null)).line, '7208006095', 'no brand: the latest call');
});

await check('call_start pipeline: a call row with no business_id counts by its line (as the board does)', async () => {
  const { db } = seedDb();
  db.tables.tracking_numbers.push({ phone: '3235701778', business_slug: 'handy-andy', display_name: 'HA Los Angeles 2', active: false, forward_to: null, created_at: '2026-08-04T00:00:00Z' });
  const orphan = reclock(missed({ caller_phone: '3233183361', business_id: null, grasshopper_number: '3235701778', forwarded_to: null, occurred_at: ago(3 * H) }), ['occurred_at']);
  db.tables.calls.push(orphan);
  const h = await get(db, HEATHER);
  assert.ok(h.body.cards.some((c) => c.phone === '3233183361'), 'Heather sees the card');
  const t = await pipelineCallTarget(db, HEATHER, '3233183361', 'handy-andy');
  assert.deepEqual([t.line, t.businessId], ['2816388419', 'b-ha'], 'inactive line -> the brand\'s first forwarded line');
  await assert.rejects(pipelineCallTarget(db, JOEY, '3233183361', null), (e) => e.status === 404, 'not a Dom\'s call');
  assert.deepEqual(await inboundForLiveStart(db, HEATHER, { inbound_call_id: orphan.id }), { inbound_call_id: orphan.id, caller_phone: '3233183361' });
  assert.deepEqual(await inboundForLiveStart(db, JOEY, { inbound_call_id: orphan.id }), {});
});

await check("a Call-button try follows its card across brand families", () => {
  const c = missed({ occurred_at: ago(3 * H) });
  const card = one(raw({ calls: [c], attempts: [attempt({ started_at: ago(2 * H), card_key: 'c_' + c.id, business_id: 'b-doms', our_phone: '7208006095', source: 'pipeline' })] }));
  assert.equal(card.tries, 1);
});

await check('call_live_start link: explicit call, else the call ringing her handset', async () => {
  const live = { ...inbound({ caller_phone: '7135550123', answered: null, duration_sec: null, status: 'new' }), occurred_at: new Date(Date.now() - 2 * M).toISOString() };
  const used = { ...inbound({ caller_phone: '7135550999', answered: true }), occurred_at: new Date(Date.now() - 60000).toISOString() };
  const db = fakeDb({ calls: [live, used, { id: uid(), kind: 'live', inbound_call_id: used.id }], staff_users: STAFF, businesses: BIZ });
  assert.deepEqual(await inboundForLiveStart(db, HEATHER, {}), { inbound_call_id: live.id, caller_phone: '7135550123' });
  // The script already knows its customer: another caller's ringing call is never linked...
  assert.deepEqual(await inboundForLiveStart(db, HEATHER, { caller_phone: '(832) 555-0101' }), { caller_phone: CUST });
  // ...that customer's own call is.
  assert.deepEqual(await inboundForLiveStart(db, HEATHER, { caller_phone: '(713) 555-0123' }), { inbound_call_id: live.id, caller_phone: '7135550123' });
  // A pickup under 20 s (voicemail / hang-up) is not the call being scripted.
  const short = { ...inbound({ caller_phone: '7135550777', answered: true, duration_sec: 9 }), occurred_at: new Date(Date.now() - 30000).toISOString() };
  const db2 = fakeDb({ calls: [short], staff_users: STAFF, businesses: BIZ });
  assert.deepEqual(await inboundForLiveStart(db2, HEATHER, {}), {});
  assert.deepEqual(await inboundForLiveStart(db, HEATHER, { inbound_call_id: used.id }), { inbound_call_id: used.id, caller_phone: '7135550999' });
  assert.deepEqual(await inboundForLiveStart(db, JOEY, { inbound_call_id: used.id }), {}, 'not a call Joey may use');
  assert.deepEqual(await inboundForLiveStart(db, JOEY, {}), {}, 'nothing rang Joey');
  assert.deepEqual(await inboundForLiveStart(db, HEATHER, { inbound_call_id: 'nope' }), {});
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
