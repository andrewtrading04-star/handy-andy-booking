// Minimal Stripe REST helper (no SDK — keeps the serverless bundle tiny).
// Uses STRIPE_SECRET_KEY, the SAME account the live booking widget already uses
// to put cards on file, so charges taken here hit the right customer/card.
//
// Everything is form-encoded per Stripe's API. Nested params (e.g. metadata)
// are flattened to metadata[key]=value. Errors throw with a friendly .message
// and the HTTP .status so callers can surface them directly.

const STRIPE_API = 'https://api.stripe.com/v1';

export function stripeConfigured() { return !!process.env.STRIPE_SECRET_KEY; }

function secretKey() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) { const e = new Error('Payments are not configured (STRIPE_SECRET_KEY is missing on the server).'); e.status = 400; throw e; }
  return k;
}

function toForm(obj) {
  const p = new URLSearchParams();
  const add = (k, v) => { if (v !== undefined && v !== null) p.append(k, String(v)); };
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) add(`${k}[${k2}]`, v2);
    } else add(k, v);
  }
  return p;
}

// Low-level call. `path` may include a query string for GET requests.
export async function stripe(path, { method = 'POST', body = null } = {}) {
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? toForm(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error((data && data.error && data.error.message) || 'Stripe request failed');
    e.status = res.status; e.stripe = (data && data.error) || null;
    throw e;
  }
  return data;
}

// Resolve a usable { customerId, paymentMethodId } for an email — used when the
// card was put on file by the live widget (which keys the Stripe customer by
// email and sets the card as the default payment method).
export async function findCardOnFileByEmail(email) {
  if (!email) return { customerId: null, paymentMethodId: null };
  const found = await stripe(`/customers?email=${encodeURIComponent(email)}&limit=10`, { method: 'GET' });
  const list = found.data || [];
  const withPm = list.find(c => c.invoice_settings && c.invoice_settings.default_payment_method) || list[0];
  if (!withPm) return { customerId: null, paymentMethodId: null };
  return { customerId: withPm.id, paymentMethodId: withPm.invoice_settings?.default_payment_method || null };
}

// Given a Stripe customer, find its default (or first) card payment method.
export async function defaultPaymentMethod(customerId) {
  const c = await stripe(`/customers/${customerId}`, { method: 'GET' });
  if (c.invoice_settings?.default_payment_method) return c.invoice_settings.default_payment_method;
  const pms = await stripe(`/payment_methods?customer=${customerId}&type=card&limit=1`, { method: 'GET' });
  return (pms.data && pms.data[0] && pms.data[0].id) || null;
}
