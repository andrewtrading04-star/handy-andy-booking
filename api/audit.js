// ============================================================================
// Call audit API (separate app, separate token kind).
//
//   POST login      { password }                   -> { token, name }
//   GET  day        ?date=YYYY-MM-DD               -> lines, counts, scripted calls, saved audits
//   GET  week       ?date=YYYY-MM-DD               -> Mon-Sun dashboard data for the week containing that date
//   POST day_save   { date, counts:{number:n} }    -> per-line call counts for the day
//   POST audit_save { ...one call audit... }       -> upsert one graded call
//
// This is deliberately NOT part of api/admin.js. The auditor is an outside
// contractor who must never reach CRM data, and admin.js has ~65 actions that
// never check a role. Living in a different file behind a different token kind
// means there is no action she could reach even by hand-crafting a request:
// admin.js rejects anything whose token kind is not 'admin', and the only
// actions defined here are the four above. Same separation api/tech.js uses.
//
// Nothing here returns revenue, profit, payroll, customer lists, or bookings.
// The call context it does return is limited to the fields the auditor has to
// grade against, and it is read-only.
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { signToken, verifyToken, getBearer, applyCors, safeEqual } from './_lib/auth.js';
import { GRASSHOPPER_LINES, prettyPhone } from './_lib/grasshopper.js';
import { localDateStartUTC, localDateTimeUTC, addDaysStr } from './_lib/time.js';

// Grasshopper always displays call times in Central, regardless of which
// market the line serves (Denver, Austin and Houston lines all show Central
// in the Grasshopper UI). The auditor's typed time is matched against that
// screen, so it has to be interpreted as Central no matter what timezone her
// own browser is in.
const AUDITOR_TZ = 'America/Chicago';

// The lines the auditor works through each day, in the order she sees them.
// Derived from the same GRASSHOPPER_LINES map the voicemail parser routes on,
// so a number can never be audited under one brand and filed under another.
// AUDIT_LINES is the subset she is actually asked to check: (713) 876-9032 is
// still in the routing map so its historical voicemails stay attributed, but
// the owner does not want it in the daily worklist.
const AUDIT_SKIP = new Set(['7138769032']);
export function auditLines() {
  return Object.entries(GRASSHOPPER_LINES)
    .filter(([digits]) => !AUDIT_SKIP.has(digits))
    .map(([digits, l]) => ({
      number: digits,
      pretty: prettyPhone(digits),
      market: l.market,
      business: l.business,
    }))
    // Group by brand then market so the two Dom's/Handy Andy sets do not
    // interleave, which is how she reads down the list in Grasshopper.
    .sort((a, b) => a.business.localeCompare(b.business)
      || a.market.localeCompare(b.market)
      || a.number.localeCompare(b.number));
}

function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    if (action === 'login') return await login(req, res, body);

    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'auditor') return res.status(401).json({ error: 'Unauthorized' });

    const db = serviceClient();
    switch (action) {
      case 'day':          return await day(req, res, db, auth);
      case 'week':         return await week(req, res, db, auth);
      case 'day_save':     return await daySave(req, res, db, auth, body);
      case 'audit_save':   return await auditSave(req, res, db, auth, body);
      case 'audit_delete': return await auditDelete(req, res, db, auth, body);
      default:             return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error('[audit]', action, e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}

async function login(req, res, body) {
  const password = (body.password || '').toString();
  const expected = process.env.AUDITOR_PASSWORD || '';
  // No dev bypass here on purpose. admin.js grants full owner access when no
  // password is configured, which is convenient for local work and completely
  // wrong for an outside contractor's login: an unset env var must lock the
  // door, not open it.
  if (!expected) return res.status(503).json({ error: 'Auditor login is not set up yet' });
  if (!password || !safeEqual(password, expected)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const name = (process.env.AUDITOR_NAME || 'Auditor').toString();
  return res.status(200).json({ token: signToken({ kind: 'auditor', name }), name });
}

// Everything the auditor needs for one day, in one round trip: the lines to
// work, whatever counts she already saved, the scripted calls the secretaries
// logged that day (for reconciliation and for grading context), and any audits
// already written so a half-finished day picks back up.
async function day(req, res, db, auth) {
  const date = (req.query.date || '').toString();
  if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const lines = auditLines();

  const { data: dayRows } = await db.from('call_audit_days')
    .select('grasshopper_number, calls_counted')
    .eq('audit_date', date);
  const counts = {};
  for (const r of (dayRows || [])) counts[r.grasshopper_number] = r.calls_counted;

  // Scripted calls are bounded by the business's own local day. Both brands run
  // America/Denver today, but reading it off the row rather than assuming keeps
  // this correct if a Houston or Austin business ever gets its own timezone.
  const { data: bizRows } = await db.from('businesses').select('id, slug, name, timezone').eq('active', true);
  const bizBySlug = {};
  for (const b of (bizRows || [])) bizBySlug[b.slug] = b;

  const tz = (bizRows && bizRows[0] && bizRows[0].timezone) || 'America/Denver';
  const start = localDateStartUTC(tz, date);
  const end = localDateStartUTC(tz, addDaysStr(date, 1));

  const { data: callRows } = await db.from('calls')
    .select('id, business_id, occurred_at, handled_by, service, market, resolution, quoted_total, discount_amount, discount_detail, tv_count, reached_step, ended_at, caller_phone')
    .eq('kind', 'live')
    .gte('occurred_at', start.toISOString())
    .lt('occurred_at', end.toISOString())
    .order('occurred_at', { ascending: true });

  const slugById = {};
  for (const b of (bizRows || [])) slugById[b.id] = b.slug;
  const calls = (callRows || []).map(c => ({
    id: c.id,
    business: slugById[c.business_id] || null,
    occurred_at: c.occurred_at,
    caller_phone: c.caller_phone || null,
    handled_by: c.handled_by,
    service: c.service,
    market: c.market,
    resolution: c.resolution,
    quoted_total: c.quoted_total,
    discount_amount: c.discount_amount,
    discount_detail: c.discount_detail,
    tv_count: c.tv_count,
    reached_step: c.reached_step,
  }));

  const { data: audits } = await db.from('call_audits')
    .select('id, grasshopper_number, call_id, occurred_at, time_local, direction, handled_by, service, caller_name, caller_phone, caller_zip, answers, flagged, notes')
    .eq('audit_date', date)
    .order('occurred_at', { ascending: true });

  return res.status(200).json({
    date,
    lines,
    counts,
    calls,
    audits: audits || [],
    auditor: auth.name || 'Auditor',
  });
}

// Dashboard data for the Monday-Sunday week containing the given date: per-day
// counted/graded/flagged tallies for the volume chart and stat tiles, plus
// every graded call in the week for the log table, the secretary split, and
// client-side search. Same read-only scope as day(): nothing here reaches
// revenue, customers, or bookings.
async function week(req, res, db, auth) {
  const date = (req.query.date || '').toString();
  if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  // Monday of the week the date falls in. Parsed at noon UTC so the weekday
  // math cannot be nudged across midnight by any server timezone.
  const d = new Date(date + 'T12:00:00Z');
  const monday = addDaysStr(date, -((d.getUTCDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => addDaysStr(monday, i));
  const sunday = days[6];

  const { data: dayRows } = await db.from('call_audit_days')
    .select('audit_date, calls_counted')
    .gte('audit_date', monday).lte('audit_date', sunday);

  const { data: auditRows } = await db.from('call_audits')
    .select('id, audit_date, grasshopper_number, call_id, occurred_at, time_local, direction, handled_by, service, caller_name, caller_phone, caller_zip, answers, flagged, notes')
    .gte('audit_date', monday).lte('audit_date', sunday)
    .order('occurred_at', { ascending: false });

  const byDay = {};
  for (const day of days) byDay[day] = { date: day, counted: 0, graded: 0, flagged: 0 };
  for (const r of (dayRows || [])) { if (byDay[r.audit_date]) byDay[r.audit_date].counted += r.calls_counted || 0; }
  for (const a of (auditRows || [])) {
    const b = byDay[a.audit_date];
    if (b) { b.graded += 1; if (a.flagged) b.flagged += 1; }
  }

  return res.status(200).json({
    week_start: monday,
    days: days.map(day => byDay[day]),
    audits: auditRows || [],
  });
}

async function daySave(req, res, db, auth, body) {
  const date = (body.date || '').toString();
  if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const counts = body.counts && typeof body.counts === 'object' ? body.counts : null;
  if (!counts) return res.status(400).json({ error: 'counts is required' });

  const known = new Map(auditLines().map(l => [l.number, l]));
  const { data: bizRows } = await db.from('businesses').select('id, slug');
  const idBySlug = {};
  for (const b of (bizRows || [])) idBySlug[b.slug] = b.id;

  const rows = [];
  for (const [number, raw] of Object.entries(counts)) {
    const line = known.get(number);
    // Silently dropping an unknown line would let a typo look like a saved
    // zero, which is indistinguishable from a real quiet day on the report.
    if (!line) return res.status(400).json({ error: `Unknown line ${number}` });
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 500) {
      return res.status(400).json({ error: `Call count for ${line.pretty} must be a whole number from 0 to 500` });
    }
    rows.push({
      audit_date: date,
      grasshopper_number: number,
      business_id: idBySlug[line.business] || null,
      calls_counted: n,
      audited_by: auth.name || 'Auditor',
      updated_at: new Date().toISOString(),
    });
  }
  if (!rows.length) return res.status(400).json({ error: 'No counts supplied' });

  const { error } = await db.from('call_audit_days')
    .upsert(rows, { onConflict: 'audit_date,grasshopper_number' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, saved: rows.length });
}

async function auditSave(req, res, db, auth, body) {
  const date = (body.date || '').toString();
  if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const number = (body.grasshopper_number || '').toString();
  const line = auditLines().find(l => l.number === number);
  if (!line) return res.status(400).json({ error: 'Pick which line the call came in on' });

  const direction = (body.direction || 'incoming').toString();
  if (!['incoming', 'outgoing'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be incoming or outgoing' });
  }

  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers : {};
  for (const [k, v] of Object.entries(answers)) {
    if (!['yes', 'no', 'na'].includes(String(v))) {
      return res.status(400).json({ error: `Answer for ${k} must be yes, no, or na` });
    }
  }

  const { data: bizRows } = await db.from('businesses').select('id, slug');
  const idBySlug = {};
  for (const b of (bizRows || [])) idBySlug[b.slug] = b.id;

  const service = (body.service || '').toString();
  if (service && !['TV Mounting', 'Handyman', 'unknown'].includes(service)) {
    return res.status(400).json({ error: 'service must be TV Mounting, Handyman, or unknown' });
  }

  const flagged = !!body.flagged;
  const callerPhone = (body.caller_phone || '').toString().trim() || null;
  // A flagged call is a request for the owner to go listen to it in
  // Grasshopper. Without the caller's number he has nothing to search on --
  // the whole point of flagging is lost -- so it's required at exactly the
  // moment it's needed, not on every call.
  if (flagged && !callerPhone) {
    return res.status(400).json({ error: "Flagging a call needs the caller's phone number, so it can be found in Grasshopper later." });
  }

  const timeLocal = (body.time_local || '').toString().trim() || null;
  // Shape AND range. Date.UTC() does not reject an out-of-range hour/minute --
  // it silently rolls over into a different day -- so '99:99' would pass a
  // shape-only check and land occurred_at on the wrong date entirely, exactly
  // the class of bug this server-side computation exists to prevent.
  if (timeLocal) {
    const m = /^(\d{2}):(\d{2})$/.exec(timeLocal);
    const hh = m && Number(m[1]), mm = m && Number(m[2]);
    if (!m || hh > 23 || mm > 59) {
      return res.status(400).json({ error: 'time_local must be a valid HH:MM (00:00-23:59)' });
    }
  }
  // occurred_at is computed here, server-side, from the auditor's own typed
  // date + time -- never trusted as a client-built ISO string. Grasshopper
  // always shows Central, so anchoring to AUDITOR_TZ keeps this correct no
  // matter what timezone the auditor's browser is actually in. See
  // api/_lib/time.js localDateTimeUTC and the 0091 migration note on
  // time_local for the bug this replaced.
  const occurredAt = timeLocal ? localDateTimeUTC(AUDITOR_TZ, date, timeLocal) : null;

  const row = {
    audit_date: date,
    grasshopper_number: number,
    business_id: idBySlug[line.business] || null,
    call_id: body.call_id || null,
    occurred_at: occurredAt ? occurredAt.toISOString() : null,
    time_local: timeLocal,
    direction,
    service: service || null,
    handled_by: (body.handled_by || '').toString().trim() || null,
    caller_phone: callerPhone,
    caller_name: (body.caller_name || '').toString().trim() || null,
    caller_zip: (body.caller_zip || '').toString().trim().slice(0, 10) || null,
    answers,
    flagged,
    notes: (body.notes || '').toString().trim() || null,
    audited_by: auth.name || 'Auditor',
    updated_at: new Date().toISOString(),
  };

  // Editing a saved audit updates it; a new one inserts. The id comes from the
  // client only as a row it already received from 'day', never as a way to
  // address an arbitrary row, since every row in this table belongs to the
  // auditor anyway and the table holds nothing else.
  if (body.id) {
    const { error } = await db.from('call_audits').update(row).eq('id', body.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, id: body.id });
  }
  const { data, error } = await db.from('call_audits').insert(row).select('id').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, id: data.id });
}

// Removes one graded call, for the duplicate-entry case: the same call saved
// twice (a double-tap on Save, or logged again by accident). The confirm
// dialog lives client-side; this endpoint deletes on request with no
// secondary check, same trust level as auditSave's update-by-id above -- every
// row in this table belongs to the auditor and the table holds nothing else.
async function auditDelete(req, res, db, auth, body) {
  const id = (body.id || '').toString();
  if (!id) return res.status(400).json({ error: 'id required' });
  const { error } = await db.from('call_audits').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
