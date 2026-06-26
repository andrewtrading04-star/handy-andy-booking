// /api/service-area.js
// Looks up which Zenbooker territory serves a zip code.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // TEMPORARY read-only diagnostic — inspect actual pricing on recent Denver-outer
  // jobs to confirm whether Zenbooker applies the territory surcharge. Remove after use.
  if (req.method === 'GET' && req.query.debug === 'terradj') {
    if (req.query.token !== 'terr-7q2x') return res.status(403).json({ error: 'forbidden' });
    const KEY = process.env.ZENBOOKER_API_KEY;
    const ADJ = {
      '1707513178246x806633139915194400': 25,  // Denver #2
      '1687393551618x123774611115737090': 35,  // Denver #3
      '1723559782141x609094402068185100': 100, // Denver #4 Boulder/CS
    };
    const out = [];
    try {
      for (let page = 0; page < 8 && out.length < 10; page++) {
        const u = `https://api.zenbooker.com/v1/jobs?limit=50&cursor=${page * 50}&start_date_after=2026-05-01&start_date_before=2026-12-31`;
        const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
        const j = await r.json().catch(() => ({}));
        const results = j.results || [];
        for (const job of results) {
          const tid = job.territory && job.territory.id;
          if (ADJ[tid]) {
            const ps = (job.services || []).flatMap(s => (s.pricing_summary || []).map(p => `${p.description}=${p.amount}`));
            out.push({
              job_number: job.job_number,
              territory: job.territory && job.territory.name,
              expected_surcharge: ADJ[tid],
              invoice_subtotal: job.invoice && job.invoice.subtotal,
              invoice_total: job.invoice && (job.invoice.amount_due != null ? job.invoice.amount_due : job.invoice.total),
              pricing_lines: ps,
            });
            if (out.length >= 10) break;
          }
        }
        if (results.length < 50) break;
      }
      return res.status(200).json({ note: 'Denver-outer jobs — does any pricing line reflect the territory surcharge?', count: out.length, jobs: out });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const zip = (req.body && (req.body.zip || req.body.postal_code)) || '';
  if (!zip) return res.status(400).json({ error: 'zip is required' });

  // Hard-code overrides for zips that should always be accepted in specific territories
  const ZIP_OVERRIDES = {
    '80223': { territory_id: '1685582903241x973573877706522600', territory_name: 'Denver #1', timezone: 'America/Denver', city: 'Denver', state: 'CO' },
  };

  if (ZIP_OVERRIDES[zip]) {
    const ov = ZIP_OVERRIDES[zip];
    return res.status(200).json({
      in_service_area: true,
      territory_id:    ov.territory_id,
      territory_name:  ov.territory_name,
      timezone:        ov.timezone,
      service_ids:     [], // Service IDs not needed for override
      city:            ov.city,
      state:           ov.state,
      lat:             null,
      lng:             null,
    });
  }

  try {
    const url = new URL('https://api.zenbooker.com/v1/scheduling/service_area_check');
    url.searchParams.set('postal_code', String(zip));

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ZBK_KEY}` },
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || 'Zenbooker error', details: data });
    }

    return res.status(200).json({
      in_service_area: !!data.in_service_area,
      territory_id:    data.service_territory?.id || null,
      territory_name:  data.service_territory?.name || null,
      timezone:        data.service_territory?.timezone || null,
      service_ids:     data.service_territory?.service_ids || [],
      city:            data.customer_location?.components?.city || null,
      state:           data.customer_location?.components?.state || null,
      lat:             data.customer_location?.coordinates?.lat || null,
      lng:             data.customer_location?.coordinates?.lng || null,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Service area check failed', message: err.message });
  }
}
