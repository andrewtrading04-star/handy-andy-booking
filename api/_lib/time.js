// Timezone helpers — compute UTC bounds for a business's LOCAL day/week/month
// without pulling in a date library. Handy Andy spans Mountain + Central, so
// each business (and service area) carries its own tz.

// Offset (local - utc) in ms for a given tz at a given instant.
function tzOffsetMs(tz, atUTC) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(atUTC).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - atUTC.getTime();
}

// UTC Date for local midnight of (today + offsetDays) in tz.
export function localDayStartUTC(tz, offsetDays = 0, base = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [y, m, d] = dtf.format(base).split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d + offsetDays, 0, 0, 0);
  return new Date(ms - tzOffsetMs(tz, new Date(ms)));
}

// UTC Date for local midnight of an EXPLICIT calendar date 'YYYY-MM-DD' in tz.
// Unlike localDayStartUTC this is anchored to the given date, not "today", so it
// never drifts when the server's UTC day and the business's local day differ.
export function localDateStartUTC(tz, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(ms - tzOffsetMs(tz, new Date(ms)));
}

// Calendar date string 'YYYY-MM-DD' that is `days` after the given one (UTC math).
export function addDaysStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// Local day-of-week 0..6 (Sun..Sat) in tz.
function localDow(tz, base = new Date()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(base);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

// Start of the current week (Sunday 00:00 local) as UTC.
export function startOfWeekUTC(tz, base = new Date()) {
  return localDayStartUTC(tz, -localDow(tz, base), base);
}

// Start of the current month (1st 00:00 local) as UTC.
export function startOfMonthUTC(tz, base = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m] = dtf.format(base).split('-').map(Number);
  const ms = Date.UTC(y, m - 1, 1, 0, 0, 0);
  return new Date(ms - tzOffsetMs(tz, new Date(ms)));
}
