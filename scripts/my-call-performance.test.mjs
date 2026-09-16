import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function myCallPerformance('), source.indexOf('// Backs the click-a-day-to-see-the-calls drill-down'));

test('secretary performance returns only her business, audits, and audit notes', async () => {
  const calls = [{ handled_by: 'Heather', resolution: 'booked', booking_id: 'b1', quoted_total: 220, occurred_at: '2026-09-16T16:00:00Z', reached_step: 'booked' }];
  const audits = [
    { id: 'a1', audit_date: '2026-09-16', answers: { greeting: 'yes', price: 'no' }, flagged: true, notes: 'Explain the price before asking for payment.', audited_by: 'Jiyah' },
    { id: 'a2', audit_date: '2026-09-15', answers: { greeting: 'yes', price: 'yes' }, flagged: false, notes: '', audited_by: 'Jiyah' },
  ];
  const filters = [];
  const db = { from(table) {
    const q = {
      select: () => q, eq: (key, value) => (filters.push([table, key, value]), q),
      gte: () => q, lt: () => q, lte: () => q, order: () => q, limit: () => q,
      then: resolve => resolve({ data: table === 'businesses' ? [{ id: 'handy', timezone: 'America/Denver' }] : table === 'calls' ? calls : audits }),
    };
    return q;
  }};
  const ctx = vm.createContext({ Promise, Math, Object, Date, console,
    displayNameFor: () => 'Heather',
    localDayStartUTC: (_tz, offset) => new Date(Date.UTC(2026, 8, 16 + offset)),
  });
  vm.runInContext(fn, ctx);
  const res = { status() { return this; }, json(body) { this.body = body; return this; } };
  await ctx.myCallPerformance({ query: { days: '7', offset: '0' } }, res, db, { role: 'secretary', scope: 'handy-andy' });

  assert.equal(res.body.audit.audited, 2);
  assert.equal(res.body.audit.script_score, 75);
  assert.equal(res.body.audit.flagged, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body.audit.questions)), [{ key: 'price', asked: 2, no: 1, fail_rate: 50 }]);
  assert.equal(res.body.audit.notes.length, 1);
  assert.equal(res.body.audit.notes[0].notes, 'Explain the price before asking for payment.');
  assert.ok(filters.some(([table, key, value]) => table === 'call_audits' && key === 'business_id' && value === 'handy'));
  assert.ok(filters.some(([table, key, value]) => table === 'call_audits' && key === 'handled_by' && value === 'Heather'));
});
