// TEMPORARY read-only diagnostic — fetch Zenbooker job details. Token-gated. Remove after use.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if ((req.query.token || '') !== 'job-x8k2p9m') return res.status(403).json({ error: 'forbidden' });
  const KEY = process.env.ZENBOOKER_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ZENBOOKER_API_KEY missing' });

  const jobId = req.query.id;
  if (!jobId) return res.status(400).json({ error: 'id param required' });

  try {
    const r = await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${KEY}` }
    });
    const j = await r.json();
    res.status(r.status).json(j);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
