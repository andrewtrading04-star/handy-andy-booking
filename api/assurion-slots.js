// /api/assurion-slots.js
// Returns appointment availability for STEVE ONLY (Assurion widget).
// Steve's provider id + territory are fixed server-side so the widget can only
// ever surface Steve's open slots.
const STEVE_PROVIDER_ID = '1688834379840x866068852960133100'; // Steve B.
const ASSURION_TERRITORY_ID = '1685582903241x973573877706522600'; // Denver #1

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  try {
    const url = new URL('https://api.zenbooker.com/v1/scheduling/timeslots');
    url.searchParams.set('territory', ASSURION_TERRITORY_ID);
    url.searchParams.set('date', new Date().toISOString().slice(0, 10));
    url.searchParams.set('duration', '120');
    url.searchParams.set('days', '30');
    url.searchParams.set('min_providers_needed', '1');
    url.searchParams.set('service_providers', STEVE_PROVIDER_ID); // Steve only

    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${ZBK_KEY}` } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: data?.message || 'Zenbooker error', details: data });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Timeslot lookup failed', message: err.message });
  }
}
