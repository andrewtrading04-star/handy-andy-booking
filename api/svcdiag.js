// TEMPORARY read-only diagnostic — dumps Zenbooker service option pricing so we can
// sync the booking widget's hardcoded prices. Token-gated. Remove after use.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if ((req.query.token || '') !== 'svc-7q3z9k') return res.status(403).json({ error: 'forbidden' });
  const KEY = process.env.ZENBOOKER_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const get = async (path) => {
    try {
      const r = await fetch('https://api.zenbooker.com' + path, { headers: { Authorization: `Bearer ${KEY}` } });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 400); }
      return { status: r.status, j };
    } catch (e) { return { error: e.message }; }
  };

  const GROUP_KEYS = ['service_modifiers', 'modifiers', 'questions', 'option_groups', 'fields', 'custom_fields', 'sections'];
  const OPT_KEYS = ['options', 'modifier_options', 'choices', 'values', 'items'];
  function dig(svc) {
    if (!svc || typeof svc !== 'object') return { note: 'not an object', value: svc };
    const topKeys = Object.keys(svc);
    let groups = null, gk = null;
    for (const k of GROUP_KEYS) { if (Array.isArray(svc[k])) { groups = svc[k]; gk = k; break; } }
    const parsed = groups ? groups.map(g => {
      let opts = null, ok = null;
      for (const k of OPT_KEYS) { if (Array.isArray(g[k])) { opts = g[k]; ok = k; break; } }
      return {
        group_id: g.id, group_name: g.name || g.title || g.label, opt_key: ok,
        options: (opts || []).map(o => {
          const f = {};
          for (const k in o) { const v = o[k]; if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') f[k] = v; }
          return f;
        }),
      };
    }) : null;
    const scalars = {};
    for (const k of ['base_price', 'min_price', 'base_duration', 'pricing_method', 'price_prefix', 'name']) scalars[k] = svc[k];
    return { topKeys, groupKey: gk, scalars, groups: parsed };
  }

  const ids = (req.query.ids || '').split(',').filter(Boolean);
  const out = { list: await get('/v1/services') };
  for (const id of ids) {
    const r = await get('/v1/services/' + id);
    out[id] = (r.status === 200 && r.j && typeof r.j === 'object') ? { status: r.status, dig: dig(r.j.service || r.j) } : r;
  }
  res.status(200).json(out);
}
