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

  // 2) Scan recent jobs by cursor for a matching job_number
  let found = out._found || null;
  if (!found) {
    let cursor = null, pages = 0, scanned = 0;
    let minDate = null, maxDate = null;
    while (pages < 25) {
      const u = new URL('https://api.zenbooker.com/v1/jobs');
      u.searchParams.set('limit', '100');
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

  // 3) Report schedule + provider for the found job (PII stripped), plus the full key list/schema
  out.jobKeys = Object.keys(found);
  const providerRaw = found.provider || found.team_member || found.assigned_provider || found.providers || found.team || null;
  out.job = redact({
    job_number: found.job_number, id: found.id, status: found.status, canceled: found.canceled,
    start_date: found.start_date, end_date: found.end_date, scheduled_at: found.scheduled_at,
    duration: found.duration, duration_minutes: found.duration_minutes, total_duration: found.total_duration,
    arrival_window: found.arrival_window, arrival_window_minutes: found.arrival_window_minutes,
    territory: found.territory && (found.territory.name || found.territory.id),
    provider: providerRaw,
    services: (found.services || []).map(s => ({ name: s.name || s.service_name, duration: s.duration, pricing_summary: s.pricing_summary })),
    service_fields: found.service_fields,
  });

  // 4) Same-day jobs for the assigned provider — to locate the actual overlap
  const provId = (providerRaw && (providerRaw.id || (Array.isArray(providerRaw) && providerRaw[0] && providerRaw[0].id))) || null;
  out.providerId = provId;
  const sd = found.start_date || found.scheduled_at;
  if (sd) {
    const day = String(sd).slice(0, 10);
    const u = new URL('https://api.zenbooker.com/v1/jobs');
    u.searchParams.set('start_date_min', day);
    u.searchParams.set('start_date_max', day);
    u.searchParams.set('limit', '100');
    const { j } = await get(u.toString());
    const all = (j.results || []).map(jb => {
      const p = jb.provider || jb.team_member || jb.assigned_provider || (jb.providers && jb.providers[0]) || null;
      return {
        job_number: jb.job_number, id: jb.id, status: jb.status, canceled: jb.canceled,
        start_date: jb.start_date, end_date: jb.end_date, scheduled_at: jb.scheduled_at,
        duration: jb.duration || jb.duration_minutes || jb.total_duration,
        arrival_window: jb.arrival_window, arrival_window_minutes: jb.arrival_window_minutes,
        providerId: p && p.id, providerName: p && (p.display_name || p.name),
      };
    });
    out.sameDayCount = all.length;
    out.sameDayForProvider = provId ? all.filter(x => x.providerId === provId) : all;
    out.sameDayAll = all; // provider may live under a key we didn't guess; keep raw-ish (no PII fields included)
  }

  return res.status(200).json(out);
}
