// Daily call counts per tracking line (owner 2026-09-27: "Jiyah's call count
// should be automatic"). Every line moved onto Twilio on 2026-09-22, so from
// that day on the count comes straight from our own inbound call log. Days
// before that keep the auditor's hand counts (call_audit_days).
import { localDateStartUTC, addDaysStr } from './time.js';

export const AUTO_COUNT_FROM = '2026-09-22';
const TZ = 'America/Chicago';

// Rows shaped like call_audit_days: { audit_date, grasshopper_number, calls_counted }.
export async function callDayRows(db, from, to) {
  const out = [];
  if (from < AUTO_COUNT_FROM) {
    const upto = to < AUTO_COUNT_FROM ? to : addDaysStr(AUTO_COUNT_FROM, -1);
    const { data } = await db.from('call_audit_days')
      .select('audit_date, grasshopper_number, calls_counted')
      .gte('audit_date', from).lte('audit_date', upto);
    out.push(...(data || []));
  }
  if (to >= AUTO_COUNT_FROM) {
    const start = from > AUTO_COUNT_FROM ? from : AUTO_COUNT_FROM;
    const { data } = await db.from('calls')
      .select('occurred_at, grasshopper_number')
      .eq('kind', 'inbound')
      .gte('occurred_at', localDateStartUTC(TZ, start).toISOString())
      .lt('occurred_at', localDateStartUTC(TZ, addDaysStr(to, 1)).toISOString())
      .limit(20000);
    const agg = {};
    for (const c of (data || [])) {
      if (!c.grasshopper_number) continue;
      const d = new Date(c.occurred_at).toLocaleDateString('en-CA', { timeZone: TZ });
      const k = d + '|' + c.grasshopper_number;
      agg[k] = (agg[k] || 0) + 1;
    }
    for (const [k, n] of Object.entries(agg)) {
      const [audit_date, grasshopper_number] = k.split('|');
      out.push({ audit_date, grasshopper_number, calls_counted: n });
    }
    // Every day from the cutoff counts as "counted" even with zero calls.
    for (let d = start; d <= to; d = addDaysStr(d, 1)) {
      if (!out.some((r) => r.audit_date === d)) out.push({ audit_date: d, grasshopper_number: null, calls_counted: 0 });
    }
  }
  return out;
}
