// api/_lib/demo.js
// Demo / sandbox mode. When DEMO_MODE=1 (set only on the demo Vercel project),
// the paid integrations — Stripe, SMS, email — are FAKED so a prospective buyer
// can click every button without any real account, charge, text, or email going
// out. Env-gated: production (no DEMO_MODE) is completely unaffected by this file.
export function demoMode() {
  const v = (process.env.DEMO_MODE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// Canned, path-appropriate fake Stripe responses so every payment flow (save
// card, charge, refund, disputes, balance) returns a believable success shape
// without touching Stripe. Mirrors just the fields our code reads.
export function demoStripeResponse(path, method = 'POST', body = null) {
  const p = String(path || '');
  const card = { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 };
  if (p.startsWith('/balance')) {
    // Fake "money in the account" for the Revenue-box payout figure.
    return { available: [{ currency: 'usd', amount: 812300 }], pending: [{ currency: 'usd', amount: 154200 }] };
  }
  if (p.startsWith('/payment_intents')) return { id: 'pi_demo', status: 'succeeded', amount: (body && body.amount) || 0, charges: { data: [{ id: 'ch_demo', payment_method_details: { card } }] } };
  if (p.startsWith('/charges'))         return { id: 'ch_demo', status: 'succeeded', amount: (body && body.amount) || 0, paid: true };
  if (p.startsWith('/refunds'))         return { id: 're_demo', status: 'succeeded', amount: (body && body.amount) || 0 };
  if (p.startsWith('/disputes'))        return { data: [] };
  if (p.startsWith('/payment_methods')) {
    if (/\/payment_methods\/[^/]+$/.test(p)) return { id: 'pm_demo', card };
    return { data: [{ id: 'pm_demo', card }] };
  }
  if (p.startsWith('/customers')) {
    if (method === 'GET' && /\/customers\?/.test(p)) return { data: [{ id: 'cus_demo', invoice_settings: { default_payment_method: 'pm_demo' } }] };
    if (/\/customers\/[^/?]+/.test(p))              return { id: 'cus_demo', invoice_settings: { default_payment_method: 'pm_demo' } };
    return { id: 'cus_demo', invoice_settings: { default_payment_method: 'pm_demo' } };
  }
  return { id: 'demo', object: 'demo' };
}
