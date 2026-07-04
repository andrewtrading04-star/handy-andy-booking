// TEMPORARY diagnostic — DELETE after reading live Stripe payout data.
// Gated by a strong one-off token so the numbers aren't world-readable.
// Returns each business account's balance (available/pending) and recent
// payout objects so we can see exactly what Stripe reports and build the
// Revenue-box payout figure to match the dashboard's "Expected" number.
import { businessSecretKey } from './_lib/stripe.js';

const TOKEN = 'a9a9ac01bbde1977f47345ca67301f44e67125675a888c1e';
const STRIPE_API = 'https://api.stripe.com/v1';

export default async function handler(req, res) {
  if ((req.query.t || '') !== TOKEN) return res.status(401).json({ error: 'nope' });
  const out = {};
  for (const slug of ['handy-andy', 'doms']) {
    const key = businessSecretKey({ slug });
    if (!key) { out[slug] = { configured: false }; continue; }
    const call = async (path) => {
      const r = await fetch(STRIPE_API + path, { headers: { Authorization: `Bearer ${key}` } });
      return { http: r.status, body: await r.json().catch(() => ({})) };
    };
    try {
      const bal = await call('/balance');
      const pos = await call('/payouts?limit=6');
      out[slug] = {
        configured: true,
        balance: {
          http: bal.http,
          available: (bal.body.available || []).map(a => ({ currency: a.currency, amount: a.amount })),
          pending: (bal.body.pending || []).map(a => ({ currency: a.currency, amount: a.amount })),
        },
        payouts: {
          http: pos.http,
          list: (pos.body.data || []).map(p => ({
            id: p.id, status: p.status, amount: p.amount,
            arrival_date: p.arrival_date, created: p.created, automatic: p.automatic,
          })),
          error: pos.body.error ? pos.body.error.message : undefined,
        },
      };
    } catch (e) { out[slug] = { configured: true, error: e.message }; }
  }
  res.status(200).json(out);
}
