// TEMPORARY read-only diagnostic — pulls scheduling/provider info for one Zenbooker job
// to investigate a double-booking. Customer PII (name/email/phone/address/notes) is stripped.
// Token-gated. DELETE this file after use.
const TOKEN = 'ha-diag-7q2v9z4m8k3f6310x';

const PII = new Set([
  'name','first_name','last_name','full_name','display_name','email','phone','phone_number',
  'mobile','address','line1','line2','street','street_address','city','state','postal_code',
  'zip','lat','lng','latitude','longitude','notes','customer_notes','formatted_address',
]);
function redact(v, depth = 0) {
  if (depth > 8) return v;
  if (Array.isArray(v)) return v.map(x => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      o[k] = PII.has(k.toLowerCase()) ? '[redacted]' : redact(val, depth + 1);
    }
    return o;
  }
  return v;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = process.env.ZENBOOKER_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });
  if ((req.query.token || '') !== TOKEN) return res.status(403).json({ error: 'forbidden' });

  const jobNum = String(req.query.job || '662894');
  const H = { Authorization: `Bearer ${KEY}` };
  const get = async (u) => {
    try { const r = await fetch(u, { headers: H }); const j = await r.json().catch(() => ({})); return { status: r.status, ok: r.ok, j }; }
    catch (e) { return { status: 0, ok: false, j: { error: e.message } }; }
  };

  const out = { jobNum, scan: {} };

  // 1) Direct hit in case caller passed the long bubble id
  {
    const d = await get(`https://api.zenbooker.com/v1/jobs/${encodeURIComponent(jobNum)}`);
    out.direct = { status: d.status, keys: d.ok && d.j ? Object.keys(d.j) : null, body: d.ok ? null : d.j };
    if (d.ok && d.j && (String(d.j.job_number) === jobNum || String(d.j.id) === jobNum)) out._found = d.j;
  }

  // 2) Scan jobs by cursor for a matching job_number, within an optional date window
  const fromDate = req.query.from || null; // e.g. 2026-06-01
  const toDate   = req.query.to   || null; // e.g. 2026-08-01
  let found = out._found || null;
  if (!found) {
    let cursor = null, pages = 0, scanned = 0;
    let minDate = null, maxDate = null;
    while (pages < 40) {
      const u = new URL('https://api.zenbooker.com/v1/jobs');
      u.searchParams.set('limit', '100');
      if (fromDate) u.searchParams.set('start_date_min', String(fromDate));
      if (toDate)   u.searchParams.set('start_date_max', String(toDate));
      if (cursor != null) u.searchParams.set('cursor', String(cursor));
      const { ok, j } = await get(u.toString());
      if (!ok) { out.scan.error = j; break; }
      const results = j.results || [];
      for (const job of results) {
        scanned++;
        const sd = job.start_date || job.scheduled_at || null;
        if (sd) { if (!minDate || sd < minDate) minDate = sd; if (!maxDate || sd > maxDate) maxDate = sd; }
        if (String(job.job_number) === jobNum || String(job.id) === jobNum) { found = job; break; }
      }
      if (found) break;
      if (j.cursor == null || results.length === 0) break;
      cursor = j.cursor; pages++;
    }
    out.scan.scanned = scanned; out.scan.pages = pages; out.scan.dateRange = { min: minDate, max: maxDate };
  }
  delete out._found;

  if (!found) { out.note = 'job not found in scan window — widen with ?job= or it may be outside the scanned range'; return res.status(200).json(out); }

  // 3) Report schedule + provider for the found job, plus full key list/schema
  out.jobKeys = Object.keys(found);
  const provs = Array.isArray(found.assigned_providers) ? found.assigned_providers : [];
  // Technician identity is the owner's own staff (not customer PII) — surface it un-redacted.
  out.assignedProviders = provs.map(p => ({
    id: p.id || p.provider_id || p.provider?.id,
    name: p.display_name || p.name || p.provider?.display_name || p.provider?.name ||
          [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
    raw_keys: Object.keys(p),
  }));
  out.job = {
    job_number: found.job_number, id: found.id, status: found.status, canceled: found.canceled,
    rescheduled: found.rescheduled, recurring: found.recurring, recurring_instance: found.recurring_instance,
    start_date: found.start_date, end_date: found.end_date,
    estimated_duration_seconds: found.estimated_duration_seconds,
    time_slot: found.time_slot, timezone: found.timezone,
    territory: found.territory && (found.territory.name || found.territory.id),
    min_providers_required: found.min_providers_required,
    unable_to_auto_assign: found.unable_to_auto_assign,
    skill_tags_required: found.skill_tags_required,
    job_offer: found.job_offer,
    created: found.created, created_by: found.created_by,
    service_name: found.service_name,
  };

  // 4) All jobs in the same territory window — to see who is occupied at #662894's time
  const provIds = out.assignedProviders.map(p => p.id).filter(Boolean);
  out.providerIds = provIds;
  const sd = found.start_date;
  if (sd) {
    const day = String(sd).slice(0, 10);
    const nextDay = new Date(new Date(day + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
    const u = new URL('https://api.zenbooker.com/v1/jobs');
    u.searchParams.set('start_date_min', day);
    u.searchParams.set('start_date_max', nextDay); // max is exclusive of `day`, so bump to next day
    u.searchParams.set('limit', '100');
    const { j } = await get(u.toString());
    const tStart = new Date(found.start_date).getTime();
    const tEnd = new Date(found.end_date).getTime();
    const all = (j.results || []).map(jb => {
      const ap = Array.isArray(jb.assigned_providers) ? jb.assigned_providers : [];
      const s = new Date(jb.start_date).getTime(), e = new Date(jb.end_date).getTime();
      return {
        job_number: jb.job_number, id: jb.id, status: jb.status, canceled: jb.canceled,
        start_date: jb.start_date, end_date: jb.end_date, created: jb.created,
        territory: jb.territory && (jb.territory.name || jb.territory.id),
        time_slot: jb.time_slot && jb.time_slot.name,
        unable_to_auto_assign: jb.unable_to_auto_assign,
        providers: ap.map(p => ({ id: p.id || p.provider_id || p.provider?.id, name: p.display_name || p.name || p.provider?.display_name || p.provider?.name || [p.first_name, p.last_name].filter(Boolean).join(' ') })),
        overlapsTarget: (s < tEnd && e > tStart && !jb.canceled && jb.id !== found.id),
      };
    });
    out.sameDayCount = all.length;
    out.sameDayJobs = all;
    out.overlappingJobs = all.filter(x => x.overlapsTarget);
  }

  // 5) Providers in this territory (who *could* serve it) + their status/skills
  {
    const r = await get('https://api.zenbooker.com/v1/providers');
    const list = Array.isArray(r.j) ? r.j : (r.j.results || r.j.data || []);
    out.providers = (list || []).slice(0, 60).map(p => ({
      id: p.id, name: p.display_name || p.name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      status: p.status, active: p.active,
      territories: p.territories || p.territory_ids || (p.territory && [p.territory.name || p.territory.id]),
      skill_tags: p.skill_tags || p.skills,
    }));
  }

  return res.status(200).json(out);
}
