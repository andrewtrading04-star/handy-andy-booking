// /api/assurion-area.js
// ZIP-code service-area check for the Asurion/Techs To You widget.
// Checks all 4 Denver territories; returns the first match.
const DENVER_TERRITORIES = [
  { id: '1685582903241x973573877706522600', name: 'Denver #1' },
  { id: '1653587269382x418859206954016450', name: 'Denver #2' },
  { id: '1687393551618x123774611115737090', name: 'Denver #3' },
  { id: '1685582226994x757356560998465500', name: 'Denver #4' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ZBK_KEY = process.env.ZENBOOKER_API_KEY;
  if (!ZBK_KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const zip = String((req.body && (req.body.zip || req.body.postal_code)) || '').trim();
  if (!zip) return res.status(400).json({ error: 'zip is required' });

  // Check each Denver territory in parallel
  const checks = await Promise.all(
    DENVER_TERRITORIES.map(async (t) => {
      try {
        const url = new URL('https://api.zenbooker.com/v1/scheduling/service_area_check');
        url.searchParams.set('postal_code', zip);
        url.searchParams.set('territory', t.id);
        const r = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${ZBK_KEY}` },
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.in_service_area) {
          return {
            matched: true,
            territory_id:   data.service_territory?.id   || t.id,
            territory_name: data.service_territory?.name || t.name,
            city:  data.customer_location?.components?.city  || null,
            state: data.customer_location?.components?.state || null,
          };
        }
        return { matched: false };
      } catch {
        return { matched: false };
      }
    })
  );

  const match = checks.find(c => c.matched);
  if (match) {
    return res.status(200).json({
      in_service_area: true,
      territory_id:   match.territory_id,
      territory_name: match.territory_name,
      city:  match.city,
      state: match.state,
    });
  }
  return res.status(200).json({ in_service_area: false, territory_id: null });
}
