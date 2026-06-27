// Shared definition of the FIVE fixed availability time slots and the weekly
// model. These are the ONLY slots a technician may be marked available for.
// Both the tech app and the admin dashboard read this (so there is a single
// source of truth) and every write is validated against it server-side, which
// is what enforces "no other time slots are allowed".
import { localDateStartUTC, addDaysStr } from './time.js';

export const SLOTS = [
  { key: 's1', label: '8:00 AM – 10:00 AM', start: '08:00', end: '10:00' },
  { key: 's2', label: '11:00 AM – 1:00 PM', start: '11:00', end: '13:00' },
  { key: 's3', label: '2:00 PM – 4:00 PM',  start: '14:00', end: '16:00' },
  { key: 's4', label: '5:00 PM – 8:00 PM',  start: '17:00', end: '20:00' },
  { key: 's5', label: '8:00 PM – 10:30 PM', start: '20:00', end: '22:30', bonus: 75 },
];

export const SLOT_KEYS = new Set(SLOTS.map(s => s.key));

// Sunday-first to match JS Date.getDay().
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Validate & normalize an incoming availability set: an array of
// { day_of_week, slot_key }. Throws (with .status = 400) on any value outside
// the allowed days (0–6) or the five fixed slot keys. Returns a de-duplicated
// array of clean { day_of_week, slot_key } rows.
export function normalizeSlots(input) {
  if (!Array.isArray(input)) {
    const e = new Error('slots must be an array'); e.status = 400; throw e;
  }
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const day = Number(raw && raw.day_of_week);
    const key = String((raw && raw.slot_key) || '');
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      const e = new Error(`Invalid day_of_week: ${raw && raw.day_of_week}`); e.status = 400; throw e;
    }
    if (!SLOT_KEYS.has(key)) {
      const e = new Error(`Invalid time slot: ${key}`); e.status = 400; throw e;
    }
    const dedupe = `${day}:${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ day_of_week: day, slot_key: key });
  }
  return out;
}

// A calendar date string must be exactly YYYY-MM-DD and a real date.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function assertDate(s) {
  const str = String(s || '');
  if (!DATE_RE.test(str)) { const e = new Error(`Invalid date: ${s}`); e.status = 400; throw e; }
  const d = new Date(str + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) { const e = new Error(`Invalid date: ${s}`); e.status = 400; throw e; }
  return str;
}

// Day of week (0=Sun..6=Sat) for a YYYY-MM-DD calendar date, timezone-agnostic.
export function dayOfWeekFor(dateStr) {
  return new Date(assertDate(dateStr) + 'T00:00:00Z').getUTCDay();
}

// Given the recurring slot keys for a weekday and the slot keys a tech selected
// for one specific date, return the exception rows that capture ONLY the
// differences: a recurring slot that's been turned off, or an extra slot turned
// on. A date that matches the recurring schedule yields zero rows (= "normal").
// `selected` is validated against the five fixed slot keys.
export function computeExceptionRows(recurringKeys, selected) {
  if (!Array.isArray(selected)) {
    const e = new Error('selected must be an array'); e.status = 400; throw e;
  }
  const sel = new Set();
  for (const raw of selected) {
    const key = String(raw || '');
    if (!SLOT_KEYS.has(key)) { const e = new Error(`Invalid time slot: ${key}`); e.status = 400; throw e; }
    sel.add(key);
  }
  const recur = new Set(recurringKeys || []);
  const rows = [];
  for (const key of SLOT_KEYS) {
    const inRecur = recur.has(key);
    const inSel = sel.has(key);
    if (inSel && !inRecur) rows.push({ slot_key: key, is_available: true });
    else if (!inSel && inRecur) rows.push({ slot_key: key, is_available: false });
  }
  return rows;
}

// ── Public, customer-facing open-slot computation (no Zenbooker) ─────────────
// Mirrors the admin dashboard's availability math (recurring weekly availability
// + one-time exceptions − existing bookings) but packaged for a PUBLIC booking
// widget so a business with no Zenbooker territory (e.g. Doms) can show real
// open times. Kept self-contained so the public path never imports the large
// admin handler; the occupancy logic intentionally matches
// api/admin.js (bookedSlotKeysForTech / singleTechSlotKeys).

const SLOT_BY_KEY = Object.fromEntries(SLOTS.map(s => [s.key, s]));

// 'YYYY-MM-DD' for "today" in a timezone.
export function todayStr(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Local wall-clock 'HH:MM' (tz) for an instant ISO string.
function localHHMM(tz, instantISO) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(instantISO)).reduce((a, x) => (a[x.type] = x.value, a), {});
  const hh = p.hour === '24' ? '00' : p.hour;   // some envs emit 24 for midnight
  return `${hh}:${p.minute}`;
}
// Local calendar date 'YYYY-MM-DD' (tz) for an instant.
function localDateStr(tz, instantISO) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instantISO));
}
function toMin(s) { const [h, m] = s.split(':').map(Number); return h * 60 + m; }
// Which fixed slot (if any) a local wall-clock time falls inside: [start,end).
function slotKeyForLocalTime(hhmm) {
  const t = toMin(hhmm);
  for (const s of SLOTS) if (t >= toMin(s.start) && t < toMin(s.end)) return s.key;
  for (const s of SLOTS) if (toMin(s.start) === t) return s.key;   // exact-start fallback
  return null;
}

// Interpret a LOCAL wall time ('HH:MM' on YYYY-MM-DD in tz) and return its UTC
// Date. Used to anchor scheduled_at/scheduled_end for a booked slot.
function localTimeToUTC(tz, dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const ms = Date.UTC(y, m - 1, d, hh, mm, 0);
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return new Date(ms - (asUTC - ms));   // ms - offset(local-utc)
}

// UTC Date for the START / END of a fixed slot on a local calendar date.
export function slotStartUTC(tz, dateStr, slotKey) {
  const s = SLOT_BY_KEY[slotKey]; return s ? localTimeToUTC(tz, dateStr, s.start) : null;
}
export function slotEndUTC(tz, dateStr, slotKey) {
  const s = SLOT_BY_KEY[slotKey]; return s ? localTimeToUTC(tz, dateStr, s.end) : null;
}

// Parse a public slot id '<slug>_<YYYY-MM-DD>_<slotKey>' back to its parts.
export function parseSlotId(id) {
  const m = /^(.+)_(\d{4}-\d{2}-\d{2})_(s[1-5])$/.exec(String(id || ''));
  return m ? { businessSlug: m[1], dateStr: m[2], slotKey: m[3] } : null;
}

// Compute open slots for the next `days` days for a business, from its
// technicians' availability minus existing bookings. Returns
//   { days: [{ date, day_of_week, timeslots: [{ id, slot_key, formatted, start, end, bonus }] }], timezone }
// using the same { days:[{date,timeslots:[{id,formatted}]}] } shape the widget
// already consumes from the Zenbooker proxy. Four batched queries total.
// `serviceAreaId` (optional) restricts availability to the technicians assigned
// to ONE metro and computes slot times in that area's timezone — required for a
// multi-metro business (e.g. Handy Andy: Denver techs in Mountain, Houston/Austin
// techs in Central, and only the metro's own techs may take its jobs). `timezone`
// (optional) overrides the zone explicitly; otherwise the area's, then the
// business's, then Denver. Omit both for a single-area business (e.g. Doms).
export async function publicOpenSlots(db, { businessSlug, days = 30, serviceAreaId = null, timezone = null }) {
  const horizon = Math.max(1, Math.min(Number(days) || 30, 60));
  const { data: biz } = await db.from('businesses').select('id, timezone').eq('slug', businessSlug).single();
  if (!biz) return { days: [], timezone: 'America/Denver' };

  // Timezone precedence: explicit arg > the service area's tz > business tz > Denver.
  let areaTz = null;
  if (serviceAreaId && !timezone) {
    const { data: area } = await db.from('service_areas').select('timezone').eq('id', serviceAreaId).maybeSingle();
    areaTz = area?.timezone || null;
  }
  const tz = timezone || areaTz || biz.timezone || 'America/Denver';

  // Technicians for this business, optionally narrowed to one metro's roster.
  let techQ = db.from('technicians').select('id').eq('business_id', biz.id).eq('active', true);
  if (serviceAreaId) techQ = techQ.eq('service_area_id', serviceAreaId);
  const { data: techs } = await techQ;
  const techIds = (techs || []).map(t => t.id);
  if (!techIds.length) return { days: [], timezone: tz };

  const start = todayStr(tz);
  const endExclusive = addDaysStr(start, horizon);

  // Recurring weekly availability: `${techId}:${dow}` -> Set(slot_key)
  const { data: av } = await db.from('technician_availability')
    .select('technician_id, day_of_week, slot_key').in('technician_id', techIds);
  const recur = new Map();
  for (const r of (av || [])) {
    const k = `${r.technician_id}:${r.day_of_week}`;
    if (!recur.has(k)) recur.set(k, new Set());
    recur.get(k).add(r.slot_key);
  }

  // One-time exceptions in the window: `${techId}:${date}` -> Map(slot_key -> is_available)
  const { data: exc } = await db.from('technician_availability_exceptions')
    .select('technician_id, exception_date, slot_key, is_available')
    .in('technician_id', techIds)
    .gte('exception_date', start).lt('exception_date', endExclusive);
  const excMap = new Map();
  for (const e of (exc || [])) {
    const k = `${e.technician_id}:${e.exception_date}`;
    if (!excMap.has(k)) excMap.set(k, new Map());
    excMap.get(k).set(e.slot_key, e.is_available);
  }

  // Existing bookings in the window. NO business filter: a tech booked on ANY
  // company's job is busy everywhere (technician_id is globally unique), which
  // is what stops a cross-company double-booking. `${techId}:${date}:${slot}`.
  const winStart = localDateStartUTC(tz, start).toISOString();
  const winEnd = localDateStartUTC(tz, endExclusive).toISOString();
  const idList = techIds.join(',');
  const runB = (withSecond) => {
    // The SELECT (not just the filter) must drop secondary_technician_id on the
    // fallback, or a pre-0019 DB errors on BOTH attempts and no slot ever reads
    // as booked (→ overbooking). Matches admin.js's conditional-select pattern.
    let q = db.from('bookings')
      .select(withSecond ? 'technician_id, secondary_technician_id, scheduled_at' : 'technician_id, scheduled_at')
      .neq('status', 'cancelled').not('scheduled_at', 'is', null)
      .gte('scheduled_at', winStart).lt('scheduled_at', winEnd);
    return withSecond
      ? q.or(`technician_id.in.(${idList}),secondary_technician_id.in.(${idList})`)
      : q.in('technician_id', techIds);
  };
  let { data: bk, error: bkErr } = await runB(true);
  if (bkErr && /secondary_technician_id/.test(bkErr.message || '')) ({ data: bk } = await runB(false));
  const techIdSet = new Set(techIds);
  const booked = new Set();
  for (const b of (bk || [])) {
    const slotKey = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at));
    if (!slotKey) continue;
    const dateStr = localDateStr(tz, b.scheduled_at);
    for (const tid of [b.technician_id, b.secondary_technician_id]) {
      if (tid && techIdSet.has(tid)) booked.add(`${tid}:${dateStr}:${slotKey}`);
    }
  }

  const out = [];
  for (let i = 0; i < horizon; i++) {
    const dateStr = addDaysStr(start, i);
    const dow = dayOfWeekFor(dateStr);
    const open = new Set();
    for (const tid of techIds) {
      const set = new Set(recur.get(`${tid}:${dow}`) || []);
      const ex = excMap.get(`${tid}:${dateStr}`);
      if (ex) for (const [sk, avail] of ex) { if (avail) set.add(sk); else set.delete(sk); }
      for (const sk of set) if (!booked.has(`${tid}:${dateStr}:${sk}`)) open.add(sk);
    }
    if (!open.size) continue;
    const timeslots = SLOTS.filter(s => open.has(s.key)).map(s => ({
      id: `${businessSlug}_${dateStr}_${s.key}`,
      slot_key: s.key,
      formatted: s.label,
      start: slotStartUTC(tz, dateStr, s.key).toISOString(),
      end: slotEndUTC(tz, dateStr, s.key).toISOString(),
      bonus: s.bonus || 0,
    }));
    out.push({ date: dateStr, day_of_week: dow, timeslots });
  }
  return { days: out, timezone: tz };
}

// Recurring weekly availability ± one-time exceptions for ONE tech on a date.
async function recurringPlusExceptions(db, techId, dateStr, dow) {
  const { data: av } = await db.from('technician_availability')
    .select('slot_key').eq('technician_id', techId).eq('day_of_week', dow);
  const set = new Set((av || []).map(x => x.slot_key));
  const { data: exc } = await db.from('technician_availability_exceptions')
    .select('slot_key, is_available').eq('technician_id', techId).eq('exception_date', dateStr);
  for (const e of (exc || [])) { if (e.is_available) set.add(e.slot_key); else set.delete(e.slot_key); }
  return set;
}
let _liftOne = true;
// Slot keys already occupied by a non-cancelled booking for ONE tech on a date
// (across ANY business — a tech booked anywhere is busy everywhere).
async function bookedSlotKeysOneTech(db, techId, dateStr, tz) {
  const dayStart = localDateStartUTC(tz, dateStr).toISOString();
  const dayEnd = localDateStartUTC(tz, addDaysStr(dateStr, 1)).toISOString();
  const run = (withSecond) => {
    let q = db.from('bookings').select('scheduled_at')
      .neq('status', 'cancelled').not('scheduled_at', 'is', null)
      .gte('scheduled_at', dayStart).lt('scheduled_at', dayEnd);
    return withSecond
      ? q.or(`technician_id.eq.${techId},secondary_technician_id.eq.${techId}`)
      : q.eq('technician_id', techId);
  };
  let { data, error } = await run(_liftOne);
  if (error && /secondary_technician_id/.test(error.message || '')) { _liftOne = false; ({ data } = await run(false)); }
  const taken = new Set();
  for (const b of (data || [])) { const k = slotKeyForLocalTime(localHHMM(tz, b.scheduled_at)); if (k) taken.add(k); }
  return taken;
}

// Pick the first active tech who is available (recurring/exception) AND free for
// an exact date+slot, so a public booking actually OCCUPIES the slot (prevents
// two customers grabbing the same window). Falls back to any tech free that slot,
// else null (the office will assign). Returns a CRM technician id.
export async function pickOpenTech(db, { businessSlug, dateStr, slotKey, serviceAreaId = null, timezone = null }) {
  const { data: biz } = await db.from('businesses').select('id, timezone').eq('slug', businessSlug).single();
  if (!biz) return null;
  let areaTz = null;
  if (serviceAreaId && !timezone) {
    const { data: area } = await db.from('service_areas').select('timezone').eq('id', serviceAreaId).maybeSingle();
    areaTz = area?.timezone || null;
  }
  const tz = timezone || areaTz || biz.timezone || 'America/Denver';
  const dow = dayOfWeekFor(dateStr);
  // Only this metro's technicians may be assigned its jobs (Houston -> Juan,
  // Austin -> Zach, …), so a booking never lands on a tech from another city.
  let techQ = db.from('technicians')
    .select('id').eq('business_id', biz.id).eq('active', true);
  if (serviceAreaId) techQ = techQ.eq('service_area_id', serviceAreaId);
  const { data: techs } = await techQ.order('created_at', { ascending: true });
  const list = techs || [];
  // First choice: on the normal schedule AND free in this slot.
  for (const t of list) {
    const keys = await recurringPlusExceptions(db, t.id, dateStr, dow);
    if (!keys.has(slotKey)) continue;
    const booked = await bookedSlotKeysOneTech(db, t.id, dateStr, tz);
    if (!booked.has(slotKey)) return t.id;
  }
  // Fallback: any active tech who is at least free in this slot.
  for (const t of list) {
    const booked = await bookedSlotKeysOneTech(db, t.id, dateStr, tz);
    if (!booked.has(slotKey)) return t.id;
  }
  return null;
}

// Validate & normalize an incoming exception set for ONE date: an array of
// { slot_key, is_available }. Throws (.status = 400) on any unknown slot key.
// Returns a de-duplicated array of clean { slot_key, is_available } rows.
export function normalizeExceptionSlots(input) {
  if (!Array.isArray(input)) {
    const e = new Error('slots must be an array'); e.status = 400; throw e;
  }
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    const key = String((raw && raw.slot_key) || '');
    if (!SLOT_KEYS.has(key)) {
      const e = new Error(`Invalid time slot: ${key}`); e.status = 400; throw e;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slot_key: key, is_available: !!(raw && raw.is_available) });
  }
  return out;
}
