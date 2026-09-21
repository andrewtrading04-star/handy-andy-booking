// node scripts/estimate-check.test.mjs -- estimateCheckFor and setExcuse against an in-memory db.
import assert from 'node:assert/strict';
import { estimateCheckFor, setExcuse } from '../api/_lib/estimate-check.js';

const NOW = new Date('2026-09-21T18:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const dateOf = (h) => ago(h).slice(0, 10);

const tables = {
  calls: [
    { id: 'c1', occurred_at: ago(2), resolution: 'booked', booking_id: 'b1', reached_step: 'customer' },
    { id: 'c2', occurred_at: ago(5), resolution: 'estimate_sent', reached_step: 'estimate' },
    { id: 'c3', occurred_at: ago(9), resolution: 'other', reached_step: 'resolution', quoted_total: 300, service: 'TV mounting' },   // miss
    { id: 'c4', occurred_at: ago(12), resolution: 'refused', reached_step: 'resolution', no_estimate_reason: 'vendor' },              // excused
    { id: 'c5', occurred_at: ago(15), resolution: null, reached_step: 'greet' },                                                       // misclick, ignored
  ],
  call_audits: [
    // same call as c3 (within 30 min): must not count twice
    { id: 'a0', audit_date: dateOf(9), occurred_at: ago(9.2), time_local: '11:00', caller_phone: '(303) 555-0100', call_id: null },
    // no wizard session, an estimate exists for this phone: ok
    { id: 'a1', audit_date: dateOf(30), occurred_at: ago(30), time_local: '10:00', caller_phone: '(303) 555-0111', call_id: null },
    // no wizard session, nothing sent: miss
    { id: 'a2', audit_date: dateOf(40), occurred_at: ago(40), time_local: '10:00', caller_phone: '(303) 555-0122', caller_name: 'Pat', service: 'TV mounting', call_id: null },
    // no time recorded: left out
    { id: 'a3', audit_date: dateOf(50), occurred_at: ago(50), time_local: null, caller_phone: '(303) 555-0133', call_id: null },
    // already linked to a wizard call: skipped
    { id: 'a4', audit_date: dateOf(60), occurred_at: ago(60), time_local: '10:00', caller_phone: '(303) 555-0144', call_id: 'c9' },
  ],
  estimates: [{ customer_phone: '303-555-0111', created_at: ago(29), source: 'manual' }],
  bookings: [],
};
const db = { from(name) { const q = {}; for (const m of ['select','eq','gte','lt','lte','order','limit','in']) q[m] = () => q; q.then = (r) => r({ data: tables[name] || [], error: null }); return q; } };

const r = await estimateCheckFor(db, { bizId: 'b', tz: 'America/Denver', name: 'Heather', now: NOW });
const w = r.windows[0];
assert.equal(w.booked, 1);
assert.equal(w.estimate, 2);            // c2 + audit a1
assert.equal(w.excused, 1);             // c4
assert.equal(w.missed, 2);              // c3 + audit a2
assert.equal(w.calls, 6);
assert.equal(w.rate, Math.round(3 / 5 * 100));      // excused calls do not count
assert.equal(r.missed.length, 2);
assert.ok(r.missed.some(m => m.kind === 'wizard' && m.quoted_total === 300));
assert.ok(r.missed.some(m => m.kind === 'audit' && m.phone === '(303) 555-0122' && m.caller_name === 'Pat'));
assert.equal(r.excused.length, 1);
assert.equal(r.unchecked_audits, 1);
assert.equal(r.reason_counts.vendor, 1);

// setExcuse guards
const row = { id: 'c3', business_id: 'b', handled_by: 'Heather' };
const upd = { patch: null };
const wdb = { from() { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row }), update: (p) => { upd.patch = p; return { eq: async () => ({ error: null }) }; } }; return q; } };
await assert.rejects(setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'made_up', bizId: 'b', who: 'Heather' }), /Unknown reason/);
await assert.rejects(setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'other', note: '', bizId: 'b', who: 'Heather' }), /Say why/);
await assert.rejects(setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'vendor', bizId: 'b', who: 'Joey' }), /not yours/);
await assert.rejects(setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'vendor', bizId: 'other', who: 'Heather' }), /not found/);
await setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: 'vendor', bizId: 'b', who: 'Heather' });
assert.equal(upd.patch.no_estimate_reason, 'vendor');
await setExcuse(wdb, { kind: 'wizard', id: 'c3', reason: '', bizId: 'b', who: null });
assert.equal(upd.patch.no_estimate_reason, null);
console.log('estimate-check tests ok');
