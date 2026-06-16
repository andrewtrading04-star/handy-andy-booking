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

    // Try multiple date windows to find the job
    const windows = [
      { start: '2026-06-15', end: '2026-06-17' },  // June 16 target
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-01-01', end: '2026-12-31' },
    ];
    let found = [], seen = 0;
    for (const w of windows) {
      let cursor = 0;
      for (let page = 0; page < 6; page++) {
        const url = `https://api.zenbooker.com/v1/jobs?limit=50&cursor=${cursor}&start_date_after=${w.start}&start_date_before=${w.end}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
        const j = await r.json();
        const results = j.results || [];
        seen += results.length;
        for (const job of results) {
          const numMatch  = targetNum  && (String(job.job_number) === String(targetNum) || String(job.job_number) === String(targetNum).replace(/^0+/, ''));
          const nameMatch = targetName && (job.customer?.name || '').toLowerCase().includes(targetName);
          if (numMatch || nameMatch) found.push({ ...job, _window: w });
        }
        if (!results.length || results.length < 50) break;
        cursor = (j.cursor || 0) + results.length;
      }
      if (found.length) break;
    }
    return res.status(200).json({ query: `jobnum=${targetNum} name=${name}`, scanned: seen, found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
