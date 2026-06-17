// TEMPORARY diagnostic endpoint — lists Zenbooker providers, territories, and
// SERVICES (with full pricing structure). Read-only. Remove after use.
//
//   /api/zdiag                 -> Handy Andy account (ZENBOOKER_API_KEY)
//   /api/zdiag?account=doms    -> Doms account (DOMS_ZENBOOKER_API_KEY)
//
// Use the Doms variant to capture Doms' services + prices, then they get seeded
// into the database (migration 0004).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const account = (req.query.account || 'handy').toLowerCase();
  const KEY = account === 'doms' ? process.env.DOMS_ZENBOOKER_API_KEY : process.env.ZENBOOKER_API_KEY;
  if (!KEY) return res.status(500).json({ error: `${account === 'doms' ? 'DOMS_ZENBOOKER_API_KEY' : 'ZENBOOKER_API_KEY'} missing` });

  const get = async (path) => {
    try {
      const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${KEY}` } });
      const j = await r.json().catch(() => ({}));
      const results = Array.isArray(j) ? j : (j.results || j.data || null);
      return { status: r.status, ok: r.ok, results, rawKeys: results ? null : Object.keys(j || {}) };
    } catch (e) { return { error: e.message }; }
  };

  const compact = (arr) => Array.isArray(arr) ? arr.slice(0, 50).map(o => ({
    id: o.id, name: o.name, first_name: o.first_name, last_name: o.last_name,
    email: o.email, display_name: o.display_name,
    territory_id: o.territory_id, territory: o.territory && (o.territory.name || o.territory.id),
    territories: o.territories, status: o.status, active: o.active,
  })) : null;

  const out = { account };

  // Providers + territories (compacted).
  for (const p of ['/v1/providers', '/v1/service_providers', '/v1/territories']) {
    const r = await get(p);
    out[p] = { status: r.status, ok: r.ok, count: Array.isArray(r.results) ? r.results.length : null, results: compact(r.results), rawKeys: r.rawKeys };
  }

  // Services — return FULL objects so the whole pricing/option structure is
  // visible (base price, durations, option groups, per-option prices, ids).
  for (const p of ['/v1/services', '/v1/service_types']) {
    const r = await get(p);
    out[p] = { status: r.status, ok: r.ok, count: Array.isArray(r.results) ? r.results.length : null, results: Array.isArray(r.results) ? r.results.slice(0, 25) : r.results, rawKeys: r.rawKeys };
  }

  res.status(200).json(out);
}
