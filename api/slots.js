// /api/slots.js
// Returns available Zenbooker timeslots for a territory.
// Supports both GET (query params) and POST (JSON body).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const src = req.method === 'GET' ? req.query : (req.body || {});
  const { territory_id, duration, date, days, lat, lng } = src;

  if (!territory_id) return res.status(400).json({ error: 'territory_id is required' });
  if (!duration)     return res.status(400).json({ error: 'duration (minutes) is required' });

  try {
    const url = new URL('https://api.zenbooker.com/v1/scheduling/timeslots');
    url.searchParams.set('territory', territory_id);
    url.searchParams.set('date',      date || new Date().toISOString().slice(0, 10));
    url.searchParams.set('duration',  String(duration));
    url.searchParams.set('days',      String(days || 14));
    if (lat) url.searchParams.set('lat', String(lat));
    if (lng) url.searchParams.set('lng', String(lng));

    const r = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ZBK_KEY}` },
    });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ error: data?.message || 'Zenbooker error', details: data });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Timeslot lookup failed', message: err.message });
  }
}
