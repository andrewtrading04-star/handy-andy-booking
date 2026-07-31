// /api/assurion-slots.js
// Returns Steve's appointment availability for the matched Denver territory.
// DISABLED 2026-07-31 — see the matching comment in api/assurion-area.js.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({ error: 'This booking channel is no longer available.' });
}
