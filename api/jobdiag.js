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
      // direct fetch by Zenbooker UUID
      const r = await fetch(`https://api.zenbooker.com/v1/jobs/${jobId}`, { headers: { Authorization: `Bearer ${KEY}` } });
      const j = await r.json();
      return res.status(r.status).json(j);
    }

    // Paginate backwards from most-recent jobs, collect up to 300, filter client-side
    const targetNum  = req.query.jobnum || '';
    const targetName = (name || '').toLowerCase();
    if (!targetNum && !targetName) return res.status(400).json({ error: 'id, jobnum, or name required' });

    let cursor = 0, found = [], seen = 0;
    for (let page = 0; page < 6; page++) {
      const r = await fetch(`https://api.zenbooker.com/v1/jobs?limit=50&cursor=${cursor}&sort=-created`, { headers: { Authorization: `Bearer ${KEY}` } });
      const j = await r.json();
      const results = j.results || [];
      if (!results.length) break;
      seen += results.length;
      for (const job of results) {
        const numMatch  = targetNum  && String(job.job_number) === String(targetNum).replace(/^0+/, '');
        const nameMatch = targetName && (job.customer?.name || '').toLowerCase().includes(targetName);
        if (numMatch || nameMatch) found.push(job);
      }
      if (found.length) break; // stop as soon as we find a match
      cursor = j.cursor + results.length;
    }
    return res.status(200).json({ query: `jobnum=${targetNum} name=${name}`, scanned: seen, found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
