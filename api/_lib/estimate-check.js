// Estimate check: every real customer who calls gets an estimate (or a booking).
//
// Two sources of calls, because neither sees everything:
//   1. Call-wizard sessions (app.calls kind='live'): the secretary opened the
//      script. Outcome is calls.resolution: booked / estimate_sent are fine.
//      Anything else (other, refused, never finished) is a MISS unless the
//      secretary excused it with a reason.
//   2. Calls the outside auditor logged (app.call_audits, direction 'incoming',
//      handled by a named secretary). The wizard was never opened for these
//      (or was not linked), so they are matched by phone number to an estimate
//      or a booking created for that number in the next few days. No match =
//      MISS unless excused. Audited rows already linked to a wizard session
//      (call_id) are skipped so one call is never counted twice.
//
// Read model + one write (excuse). A secretary only ever sees her own rows.
import { digitsOf, prettyPhone } from './grasshopper.js';
import { localDayStartUTC, localDateStartUTC } from './time.js';

export const EXCUSE_REASONS = {
  not_a_customer: 'Not a customer (wrong number, spam, hang-up)',
  existing_customer: 'Existing customer (schedule change or job question)',
  outside_area: 'Outside our service area',
  vendor: 'Vendor or solicitor',
  other: 'Other (write why)',
};

// Clean slate (owner, 2026-09-21): the secretaries were told that day to send an
// estimate to every caller, so nothing before this date is counted or shown.
export const TRACKING_STARTS = '2026-09-21';
const SPAN_DAYS = 7;            // the widest window shown is the last 7 days
const MATCH_DAYS = 3;           // an estimate/booking up to 3 days after an audited call counts

const rate = (ok, n) => (n > 0 ? Math.round((ok / n) * 100) : null);

// One person's numbers. `name` is the secretary's display name (calls.handled_by
// and call_audits.handled_by hold that name).
export async function estimateCheckFor(db, { bizId, tz, name, now = new Date() }) {
  const startOf = (off) => localDayStartUTC(tz, off, now);
  const trackFrom = localDateStartUTC(tz, TRACKING_STARTS).getTime();
  const since = new Date(Math.max(startOf(-(SPAN_DAYS - 1)).getTime(), trackFrom));
  const until = startOf(1);
  const sinceDay = since.toISOString().slice(0, 10);
  const untilDay = new Date(until.getTime() - 86400000).toISOString().slice(0, 10);

  const [{ data: calls, error: cErr }, { data: audits, error: aErr }] = await Promise.all([
    db.from('calls')
      .select('id, occurred_at, resolution, booking_id, reached_step, quoted_total, service, notes, no_estimate_reason, no_estimate_note')
      .eq('business_id', bizId).eq('kind', 'live').eq('handled_by', name)
      .gte('occurred_at', since.toISOString()).lt('occurred_at', until.toISOString())
      .order('occurred_at', { ascending: false }).limit(2000),
    db.from('call_audits')
      .select('id, audit_date, occurred_at, time_local, caller_name, caller_phone, service, call_id, direction, no_estimate_reason, no_estimate_note')
      .eq('business_id', bizId).eq('handled_by', name).eq('direction', 'incoming')
      .gte('audit_date', sinceDay).lte('audit_date', untilDay)
      .order('audit_date', { ascending: false }).limit(2000),
  ]);
  if (cErr) throw cErr;
  if (aErr) throw aErr;

  // Phones that received an estimate or a booking, with when.
  const lo = new Date(since.getTime() - 86400000).toISOString();
  const hi = new Date(until.getTime() + MATCH_DAYS * 86400000).toISOString();
  const [{ data: ests }, { data: bks }] = await Promise.all([
    // Only estimates the office wrote FOR a caller (source 'manual'). Website
    // estimate requests and contact-form messages are a different thing: the
    // customer started those, not a phone call the secretary handled.
    db.from('estimates').select('customer_phone, created_at').eq('business_id', bizId).eq('source', 'manual').gte('created_at', lo).lt('created_at', hi).limit(5000),
    db.from('bookings').select('created_at, customer:customers ( phone )').eq('business_id', bizId).gte('created_at', lo).lt('created_at', hi).limit(5000),
  ]);
  const sentTo = new Map();          // digits -> [ms]
  const note = (phone, iso) => {
    const d = digitsOf(phone); if (d.length !== 10) return;
    if (!sentTo.has(d)) sentTo.set(d, []);
    sentTo.get(d).push(Date.parse(iso));
  };
  for (const e of (ests || [])) note(e.customer_phone, e.created_at);
  for (const b of (bks || [])) note(b.customer?.phone, b.created_at);

  const items = [];
  // 1) wizard sessions that worked the script (same gate as My Call Performance)
  for (const r of (calls || [])) {
    if (!(r.booking_id || r.resolution || (r.reached_step && r.reached_step !== 'greet'))) continue;
    const booked = !!r.booking_id || r.resolution === 'booked';
    const est = r.resolution === 'estimate_sent';
    items.push({
      kind: 'wizard', id: r.id, at: r.occurred_at, service: r.service || null,
      quoted_total: r.quoted_total != null ? Number(r.quoted_total) : null, reached_step: r.reached_step || null,
      status: booked ? 'booked' : est ? 'estimate' : r.no_estimate_reason ? 'excused' : 'missed',
      reason: r.no_estimate_reason || null, reason_note: r.no_estimate_note || null,
      resolution: r.resolution || null,
    });
  }
  // 2) audited calls with no wizard session. The auditor logs EVERY call, so a
  //    call the secretary did work on the script shows up here too: skip an
  //    audited call when a wizard session by the same person sits within 30
  //    minutes of it (or is linked by call_id). Audits with no recorded time
  //    cannot be lined up with anything, so they are left out rather than
  //    risk a false accusation.
  const wizardTimes = items.filter(i => i.kind === 'wizard').map(i => Date.parse(i.at));
  let unchecked = 0;
  for (const a of (audits || [])) {
    if (a.call_id) continue;
    if (!a.time_local || !a.occurred_at) { unchecked++; continue; }
    const at = Date.parse(a.occurred_at);
    if (wizardTimes.some(t => Math.abs(t - at) <= 30 * 60000)) continue;
    const digits = digitsOf(a.caller_phone);
    const dayStart = Date.parse(a.audit_date + 'T00:00:00Z') - 86400000;   // audit_date is a plain date; pad a day for time zones
    const dayEnd = dayStart + (MATCH_DAYS + 2) * 86400000;
    const hit = digits.length === 10 && (sentTo.get(digits) || []).some(t => t >= dayStart && t <= dayEnd);
    items.push({
      kind: 'audit', id: a.id, at: a.occurred_at || (a.audit_date + 'T12:00:00Z'), service: a.service && a.service !== 'unknown' ? a.service : null,
      phone: digits.length === 10 ? prettyPhone(digits) : null, caller_name: (a.caller_name || '').trim() || null,
      quoted_total: null, reached_step: null,
      status: hit ? 'estimate' : a.no_estimate_reason ? 'excused' : 'missed',
      reason: a.no_estimate_reason || null, reason_note: a.no_estimate_note || null,
    });
  }

  // Three windows: today, yesterday, the last 7 days. Numbers only, no list of
  // individual calls. Nothing before TRACKING_STARTS is counted.
  const WIN = [['Today', 0, 0], ['Yesterday', -1, -1], ['Last 7 days', -(SPAN_DAYS - 1), 0]];
  const windows = WIN.map(([label, a, b]) => {
    const from = Math.max(startOf(a).getTime(), trackFrom), to = startOf(b + 1).getTime();
    const inWin = items.filter(i => { const t = Date.parse(i.at); return t >= from && t < to; });
    const c = (s) => inWin.filter(i => i.status === s).length;
    const n = inWin.length, ok = c('booked') + c('estimate');
    return { label, calls: n, booked: c('booked'), estimate: c('estimate'), missed: c('missed') + c('excused'), rate: rate(ok, n) };
  });
  return { name, windows, started_on: TRACKING_STARTS, unchecked_audits: unchecked };
}

// Excuse (or un-excuse) one call. `who` is the caller's own display name for a
// secretary (rows must be hers) or null for the owner (any row in the business).
export async function setExcuse(db, { kind, id, reason, note, bizId, who }) {
  const table = kind === 'audit' ? 'call_audits' : kind === 'wizard' ? 'calls' : null;
  if (!table) { const e = new Error('kind must be wizard or audit'); e.status = 400; throw e; }
  const clear = !reason;
  if (!clear && !Object.prototype.hasOwnProperty.call(EXCUSE_REASONS, reason)) { const e = new Error('Unknown reason'); e.status = 400; throw e; }
  const cleanNote = String(note || '').trim().slice(0, 300);
  if (!clear && reason === 'other' && cleanNote.length < 3) { const e = new Error('Say why for "Other"'); e.status = 400; throw e; }
  const { data: row, error } = await db.from(table).select('id, business_id, handled_by').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row || row.business_id !== bizId) { const e = new Error('Call not found'); e.status = 404; throw e; }
  if (who && row.handled_by !== who) { const e = new Error('That call is not yours'); e.status = 403; throw e; }
  const patch = clear
    ? { no_estimate_reason: null, no_estimate_note: null, no_estimate_at: null }
    : { no_estimate_reason: reason, no_estimate_note: cleanNote || null, no_estimate_at: new Date().toISOString() };
  const { error: uErr } = await db.from(table).update(patch).eq('id', id);
  if (uErr) throw uErr;
  return { ok: true };
}
