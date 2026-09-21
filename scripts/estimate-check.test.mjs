// node scripts/estimate-check.test.mjs -- estimateCheckFor and setExcuse against an in-memory db.
import assert from 'node:assert/strict';
import { estimateCheckFor, setExcuse, TRACKING_STARTS } from '../api/_lib/estimate-check.js';

// Noon in Denver on the day tracking starts (06:00Z is midnight Denver).
const NOW = new Date('2026-09-21T18:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const dateOf = (h) => ago(h).slice(0, 10);

const tables = {
  calls: [
    { id: 'c1', occurred_at: ago(2), resolution: 'booked', booking_id: 'b1', reached_step: 'customer' },
    { id: 'c2', occurred_at: ago(5), resolution: 'estimate_sent', reached_step: 'estimate' },
    { id: 'c3', occurred_at: ago(9), resolution: 'other', reached_step: 'resolution', quoted_total: 300, service: 'TV mounting' },   // no estimate
    { id: 'c5', occurred_at: ago(11), resolution: null, reached_step: 'greet' },                                                       // misclick, ignored
    { id: 'c6', occurred_at: ago(20), resolution: 'other', reached_step: 'resolution' },                                               // before the clean slate
  ],
  call_audits: [
    { id: 'a0', audit_date: dateOf(9), occurred_at: ago(9.2), time_local: '11:00', caller_phone: '(303) 555-0100', call_id: null },   // same call as c3
    { id: 'a1', audit_date: dateOf(3.5), occurred_at: ago(3.5), time_local: '10:00', caller_phone: '(303) 555-0111', call_id: null },  // an estimate exists
    { id: 'a2', audit_date: dateOf(4), occurred_at: ago(4), time_local: '10:00', caller_phone: '(303) 555-0122', call_id: null }, // nothing sent
    { id: 'a3', audit_date: dateOf(6), occurred_at: ago(6), time_local: null, caller_phone: '(303) 555-0133', call_id: null },        // no time: left out
    { id: 'a4', audit_date: dateOf(7), occurred_at: ago(7), time_local: '10:00', caller_phone: '(303) 555-0144', call_id: 'c9' },     // linked: skipped
    { id: 'a5', audit_date: dateOf(30), occurred_at: ago(30), time_local: '10:00', caller_phone: '(303) 555-0155', call_id: null },   // before the clean slate
  ],
  estimates: [{ customer_phone: '303-555-0111', created_at: ago(3), source: 'manual' }],
  bookings: [],
};
const db = { from(name) { const q = {}; for (const m of ['select','eq','gte','lt','lte','order','limit','in']) q[m] = () => q; q.then = (r) => r({ data: tables[name] || [], error: null }); return q; } };

assert.equal(TRACKING_STARTS, '2026-09-21');
const r = await estimateCheckFor(db, { bizId: 'b', tz: 'America/Denver', name: 'Heather', now: NOW });
assert.deepEqual(r.windows.map(x => x.label), ['Today', 'Yesterday', 'Last 7 days']);
const [today, yest, wk] = r.windows;
assert.equal(today.booked, 1);          // c1
assert.equal(today.estimate, 2);        // c2 + audited call a1
assert.equal(today.missed, 2);          // c3 + audited call a2
assert.equal(today.calls, 5);
assert.equal(today.rate, 60);
assert.equal(yest.calls, 0);            // nothing before the clean slate is counted
assert.equal(yest.rate, null);
assert.equal(wk.calls, today.calls);
assert.equal(r.unchecked_audits, 1);    // a3 has no time
assert.ok(!('missed_list' in r) && !r.missed);   // numbers only, no list of calls

// setExcuse guards (kept for the API; the screen no longer offers it)
const row = { id: 'c3', business_id: 'b', handled_by: 'Heather' };
const upd = { patch: null };
const wdb = { from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row }), update: (p) => { upd.patch = p; return { eq: async () => ({ error: null }) }; } }; return q; } };
await assert.rejects(setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'made_up', bizId: 'b', who: 'Heather' }), /Unknown reason/);
await assert.rejects(setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'vendor', bizId: 'b', who: 'Joey' }), /not yours/);
await setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'vendor', bizId: 'b', who: 'Heather' });
assert.equal(upd.patch.no_estimate_reason, 'vendor');
console.log('estimate-check tests ok');
