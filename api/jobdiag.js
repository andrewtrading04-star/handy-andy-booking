// TEMPORARY read-only diagnostic — fetch Zenbooker job details. Token-gated. Remove after use.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if ((req.query.token || '') !== 'job-x8k2p9m') return res.status(403).json({ error: 'forbidden' });
  const KEY = process.env.ZENBOOKER_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const jobId = req.query.id;
  const name = req.query.name;

  try {
    let url, label;
    if (jobId) {
      url = `https://api.zenbooker.com/v1/jobs/${jobId}`;
      label = `job ${jobId}`;
    } else if (name) {
      url = `https://api.zenbooker.com/v1/jobs?customer_name=${encodeURIComponent(name)}&limit=10`;
      label = `jobs for ${name}`;
    } else {
      return res.status(400).json({ error: 'id or name param required' });
    }
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` }
    });
    const j = await r.json();
    res.status(r.status).json({ query: label, ...j });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
