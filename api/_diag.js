// TEMPORARY diagnostic endpoint — lists Zenbooker providers & territories so we
// can find Steve's provider_id for the Assurion widget. Read-only. Remove after use.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const KEY = process.env.ZENBOOKER_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const tryGet = async (path) => {
    try {
      const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${KEY}` } });
      const j = await r.json().catch(() => ({}));
      let results = Array.isArray(j) ? j : (j.results || j.data || null);
      // compact each result to id + likely name/territory fields
      const compact = Array.isArray(results)
        ? results.slice(0, 50).map(o => ({
            id: o.id, name: o.name, first_name: o.first_name, last_name: o.last_name,
            email: o.email, display_name: o.display_name,
            territory_id: o.territory_id, territory: o.territory && (o.territory.name || o.territory.id),
            territories: o.territories, status: o.status, active: o.active,
          }))
        : null;
      return { status: r.status, ok: r.ok, count: Array.isArray(results) ? results.length : null, results: compact, rawKeys: results ? null : Object.keys(j || {}) };
    } catch (e) { return { error: e.message }; }
  };

  const out = {};
  for (const p of ['/v1/providers', '/v1/service_providers', '/v1/team', '/v1/team_members', '/v1/workers', '/v1/territories']) {
    out[p] = await tryGet(p);
  }
  res.status(200).json(out);
}
