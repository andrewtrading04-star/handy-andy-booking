// /api/service-area.js
// Looks up which Zenbooker territory serves a zip code.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const zip = (req.body && (req.body.zip || req.body.postal_code)) || '';
  if (!zip) return res.status(400).json({ error: 'zip is required' });

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
