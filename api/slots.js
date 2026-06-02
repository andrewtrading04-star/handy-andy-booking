// /api/slots.js
// Returns available Zenbooker timeslots for a given zip + duration.
// Docs: https://developers.zenbooker.com/reference/retrieve-timeslots

const TERRITORY_BY_ZIP_PREFIX = {
  '80': '1685582903241x973573877706522600', // Denver
  '77': '1707514546803x280800015001583600', // Houston
  '78': '1724797832896x339501352491155460', // Austin
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://www.ihandyandy.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) {
    return res.status(500).json({ error: 'ZENBOOKER_API_KEY is not set' });
  }

  const { zip, duration, days, date } = req.body || {};
  if (!zip)      return res.status(400).json({ error: 'zip is required' });
  if (!duration) return res.status(400).json({ error: 'duration (minutes) is required' });

  const territory = TERRITORY_BY_ZIP_PREFIX[String(zip).substring(0, 2)];
  if (!territory) {
    return res.status(400).json({ error: `Service not available in zip ${zip}` });
  }

  const startDate = date || new Date().toISOString().slice(0, 10);
  const dayCount  = days || 14;

  const url = new URL('https://api.zenbooker.com/v1/scheduling/timeslots');
  url.searchParams.set('territory', territory);
  url.searchParams.set('date',      startDate);
  url.searchParams.set('duration',  String(duration));
  url.searchParams.set('days',      String(dayCount));

  try {
    const zbkRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${ZBK_KEY}` },
    });

    const data = await zbkRes.json().catch(() => ({}));

    if (!zbkRes.ok) {
      console.error('Zenbooker timeslots failed', zbkRes.status, data);
      return res.status(zbkRes.status).json({
        error: data?.message || data?.error || 'Zenbooker rejected the request',
        details: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('slots.js fetch threw', err);
    return res.status(500).json({ error: 'Failed to reach Zenbooker', message: err.message });
  }
}
