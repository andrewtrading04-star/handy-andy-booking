// node scripts/capacity.test.mjs  -- exercises capacityOverview against an in-memory db.
import assert from 'node:assert/strict';
import { capacityOverview } from '../api/_lib/capacity.js';
import { todayStr, dayOfWeekFor } from '../api/_lib/availability.js';
import { addDaysStr, localDateTimeUTC } from '../api/_lib/time.js';

const TZ = 'America/Denver';
const today = todayStr(TZ);
const sunday = addDaysStr(today, -dayOfWeekFor(today));
const lastMon = addDaysStr(sunday, -6);           // a Monday last week
const dow = dayOfWeekFor(lastMon);

const tables = {
  technicians: [
    { id: 't1', name: 'Alpha', status: 'available', max_jobs_per_day: null, business_id: 'b1', service_area: { name: 'Denver', timezone: TZ } },
    { id: 't2', name: 'Beta',  status: 'available', max_jobs_per_day: 2,    business_id: 'b2', service_area: { name: 'Denver', timezone: TZ } },
    { id: 't3', name: 'Gamma', status: 'off',       max_jobs_per_day: null, business_id: 'b1', service_area: { name: 'Denver', timezone: TZ } },
  ],
  businesses: [{ id: 'b1', slug: 'handy-andy' }, { id: 'b2', slug: 'doms' }],
  service_areas: [{ id: 'a1', timezone: TZ }],
  // t1: s1,s2,s3 every day. t2: s1..s4 every day but capped at 2. t3 (off): s1 every day.
  technician_availability: [0, 1, 2, 3, 4, 5, 6].flatMap(d => [
    ...['s1', 's2', 's3'].map(k => ({ technician_id: 't1', day_of_week: d, slot_key: k })),
    ...['s1', 's2', 's3', 's4'].map(k => ({ technician_id: 't2', day_of_week: d, slot_key: k })),
    { technician_id: 't3', day_of_week: d, slot_key: 's1' },
  ]),
  technician_availability_exceptions: [
    // t1 turns s3 off on lastMon.
    { technician_id: 't1', exception_date: lastMon, slot_key: 's3', is_available: false },
  ],
  bookings: [
    // t1 job in s1 on lastMon (8am Denver), big job holding s2 too via extra_slots
    { technician_id: 't1', secondary_technician_id: null, scheduled_at: localDateTimeUTC(TZ, lastMon, '08:00').toISOString(), service_area_id: 'a1', extra_slots: ['s2'] },
    // t2 second tech on that same job (helper), s1 + s2
    { technician_id: 't9', secondary_technician_id: 't2', scheduled_at: localDateTimeUTC(TZ, lastMon, '08:00').toISOString(), service_area_id: 'a1', extra_slots: ['s2'] },
  ],
};

// Minimal query-builder stub: filtering is ignored (the module filters by ids/dates itself
// where it matters); every builder method returns itself and awaits to {data}.
const db = {
  from(name) {
    const q = { _n: name };
    for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'not', 'or', 'order', 'limit']) q[m] = () => q;
    q.then = (res) => res({ data: tables[name] || [], error: null });
    return q;
  },
};

const r = await capacityOverview(db);
assert.equal(r.cities.length, 1);
const c = r.cities[0];
assert.equal(c.name, 'Denver');
assert.equal(c.weeks.length, 11);                               // 8 back + current + 2 ahead

// One ordinary past day offers: t1 3 + t2 min(4, cap 2)=2 + t3 (off but past) 1 = 6.
// The exception day removes t1's s3: 5. Sum the week that contains lastMon.
const wk = c.weeks.find(w => w.start === addDaysStr(sunday, -7));
assert.equal(wk.state, 'past');
assert.equal(wk.offered, 6 * 7 - 1);                            // 41
// Used on lastMon: t1 s1+s2 (2), t2 helper s1+s2 (2, cap keeps s1,s2 offered) = 4.
assert.equal(wk.used, 4);
assert.equal(wk.idle, wk.offered - 4);

// Future days: the 'off' tech offers nothing from today on.
const nextDay = c.next[1];
assert.equal(nextDay.offered, 3 + 2);                           // t1 + capped t2, t3 off
assert.equal(nextDay.open, 5);
assert.ok(c.first_open && c.first_open.days_out <= 1);
assert.ok(c.per_tech.find(t => t.name === 'Alpha').offered > 0);
console.log('capacity tests ok');
