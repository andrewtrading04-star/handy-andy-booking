// Shared definition of the FIVE fixed availability time slots and the weekly
// model. These are the ONLY slots a technician may be marked available for.
// Both the tech app and the admin dashboard read this (so there is a single
// source of truth) and every write is validated against it server-side, which
// is what enforces "no other time slots are allowed".

export const SLOTS = [
  { key: 's1', label: '8:00 AM – 10:00 AM', start: '08:00', end: '10:00' },
  { key: 's2', label: '11:00 AM – 1:00 PM', start: '11:00', end: '13:00' },
  { key: 's3', label: '2:00 PM – 4:00 PM',  start: '14:00', end: '16:00' },
  { key: 's4', label: '5:00 PM – 8:00 PM',  start: '17:00', end: '20:00' },
  { key: 's5', label: '8:00 PM – 10:30 PM', start: '20:00', end: '22:30' },
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
