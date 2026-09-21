// node scripts/phone-desk.test.mjs  -- phoneDesk against an in-memory db.
import assert from 'node:assert/strict';
import { phoneDesk } from '../api/_lib/phone-desk.js';
import { todayStr, dayOfWeekFor } from '../api/_lib/availability.js';
import { addDaysStr, localDateTimeUTC } from '../api/_lib/time.js';

const TZ = 'America/Denver';
const today = todayStr(TZ);
const sunday = addDaysStr(today, -dayOfWeekFor(today));
const lastTue = addDaysStr(sunday, -5);
const at = (d) => localDateTimeUTC(TZ, d, '09:00').toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const tables = {
  businesses: [{ id: 'h', slug: 'handy-andy' }, { id: 'd', slug: 'doms' }],
  bookings: [
    { id: 'p1', business_id: 'h', source: 'manual', price: 300, tip: 20, scheduled_at: at(lastTue) },
    { id: 'p2', business_id: 'h', source: 'manual', price: 200, tip: 0, scheduled_at: at(lastTue) },
    { id: 'w1', business_id: 'h', source: 'widget', price: 400, tip: 0, scheduled_at: at(lastTue) },
    { id: 'd1', business_id: 'd', source: 'manual', price: 500, tip: 0, scheduled_at: at(lastTue) },
  ],
  booking_line_items: [
    { booking_id: 'p1', name: '60"-69"', line_total: 130 },
    { booking_id: 'p1', name: 'Tilting (recommended)', line_total: 75 },
    { booking_id: 'p1', name: 'Yes, hide the wires BEHIND the wall', line_total: 82 },
    { booking_id: 'p2', name: '33"-59"', line_total: 110 },
    { booking_id: 'p2', name: 'I will be using the bracket that comes in the box (Samsung Frame TV)', line_total: 33 },
    { booking_id: 'w1', name: 'TV Size: 70"-85"', line_total: 150 },
    { booking_id: 'w1', name: 'Full Motion', line_total: 110 },
    { booking_id: 'w1', name: 'Soundbar Installation', line_total: 49 },
    { booking_id: 'd1', name: '60"-69"', line_total: 130 },
  ],
  estimates: [
    { business_id: 'h', status: 'contacted', created_at: daysAgo(2), customer_email: 'a@b.c', line_items: [{ qty: 1, unit_price: 135 }, { qty: 2, unit_price: 50 }] },
    { business_id: 'h', status: 'contacted', created_at: daysAgo(20), customer_email: '', line_items: [{ qty: 1, unit_price: 300 }] },
    { business_id: 'h', status: 'scheduled', created_at: daysAgo(10), customer_email: 'x@y.z', line_items: [] },
    { business_id: 'h', status: 'archived', created_at: daysAgo(40), contacted_at: null, line_items: [] },
  ],
};
const db = {
  from(name) {
    const q = {};
    for (const m of ['select', 'in', 'not', 'gt', 'gte', 'lt', 'order', 'limit']) q[m] = () => q;
    q.then = (res) => res({ data: tables[name] || [], error: null });
    return q;
  },
};

const r = await phoneDesk(db);
const ha = r.brands.find(b => b.slug === 'handy-andy');
const wk = ha.phone.weeks.find(w => w.start === addDaysStr(sunday, -7));
assert.equal(wk.jobs, 2);
assert.equal(wk.sales, 520);                      // 300+20 + 200
assert.equal(wk.avg_ticket, 260);
assert.equal(wk.tv_jobs, 2);
assert.equal(wk.bracket_pct, 50);                 // p1 yes, p2 own-bracket line does not count
assert.equal(wk.inwall_pct, 50);
const fw = ha.form.weeks.find(w => w.start === addDaysStr(sunday, -7));
assert.equal(fw.jobs, 1); assert.equal(fw.bracket_pct, 100);
assert.equal(ha.estimates.open, 2);
assert.equal(ha.estimates.open_quoted, 135 + 100 + 300);
assert.equal(ha.estimates.buckets[0].count, 1);
assert.equal(ha.estimates.buckets[2].count, 1);
assert.equal(ha.estimates.buckets[2].no_email, 1);
assert.equal(ha.estimates.close_pct, 25);         // 1 of 4
assert.equal(ha.estimates.archived_no_contact, 1);
const dd = r.brands.find(b => b.slug === 'doms');
assert.equal(dd.phone.last4.jobs, 1);
console.log('phone-desk tests ok');
