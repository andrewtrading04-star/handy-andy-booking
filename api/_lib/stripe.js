// Minimal Stripe REST helper (no SDK — keeps the serverless bundle tiny).
// Uses STRIPE_SECRET_KEY, the SAME account the live booking widget already uses
// to put cards on file, so charges taken here hit the right customer/card.
//
// Everything is form-encoded per Stripe's API. Nested params (e.g. metadata)
// are flattened to metadata[key]=value. Errors throw with a friendly .message
// and the HTTP .status so callers can surface them directly.

const STRIPE_API = 'https://api.stripe.com/v1';

// Per-business Stripe accounts. Each business is its own Stripe account, so a
// card put on file for one business can ONLY be charged with that business's
// key. Selection is by business slug; Handy Andy (and any caller that passes no
// slug) keeps using the global STRIPE_SECRET_KEY exactly as before.
//
// IMPORTANT: there is NO fallback from a per-business key to the global key —
// charging a Doms card with Handy Andy's key would hit the wrong account (and
// fail, since the card lives in Doms' account). A missing per-business key is a
// hard, explicit error rather than a silent mis-charge.
const BUSINESS_KEY_ENV = {
  doms: 'DOMS_STRIPE_SECRET_KEY',
};

export function stripeConfigured(slug) {
  const envName = slug && BUSINESS_KEY_ENV[slug];
  if (envName) return !!process.env[envName];
  return !!process.env.STRIPE_SECRET_KEY;
}

// The raw secret key for a business (null if unconfigured). Exported for the few
// callers that talk to Stripe with their own fetch() instead of stripe().
export function businessSecretKey(slug) {
  const envName = slug && BUSINESS_KEY_ENV[slug];
  if (envName) return process.env[envName] || null;
  return process.env.STRIPE_SECRET_KEY || null;
}

function secretKey(slug) {
  const envName = slug && BUSINESS_KEY_ENV[slug];
  if (envName) {
    const k = process.env[envName];
    if (!k) { const e = new Error(`Payments are not configured for ${slug} (${envName} is missing on the server).`); e.status = 400; throw e; }
    return k;
  }
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
// `slug` selects the business's Stripe account (omit for the global account).
export async function stripe(path, { method = 'POST', body = null, slug = null } = {}) {
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: { Authorization: `Bearer ${secretKey(slug)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
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
export async function findCardOnFileByEmail(email, slug = null) {
  if (!email) return { customerId: null, paymentMethodId: null };
  const found = await stripe(`/customers?email=${encodeURIComponent(email)}&limit=10`, { method: 'GET', slug });
  const list = found.data || [];
  const withPm = list.find(c => c.invoice_settings && c.invoice_settings.default_payment_method) || list[0];
  if (!withPm) return { customerId: null, paymentMethodId: null };
  return { customerId: withPm.id, paymentMethodId: withPm.invoice_settings?.default_payment_method || null };
}

// Given a Stripe customer, find its default (or first) card payment method.
export async function defaultPaymentMethod(customerId, slug = null) {
  const c = await stripe(`/customers/${customerId}`, { method: 'GET', slug });
  if (c.invoice_settings?.default_payment_method) return c.invoice_settings.default_payment_method;
  const pms = await stripe(`/payment_methods?customer=${customerId}&type=card&limit=1`, { method: 'GET', slug });
  return (pms.data && pms.data[0] && pms.data[0].id) || null;
}

// Save a card on file in a business's Stripe account: find/create the customer
// by email, attach the payment method, and make it the default. Returns the
// Stripe customer id. Used by the public Doms booking flow (and reusable by any
// per-business flow). Throws with .status/.message on failure.
export async function saveCardOnFile({ email, name, phone, paymentMethodId, slug = null }) {
  if (!paymentMethodId) return { customerId: null };
  // 1) Reuse an existing customer for this email, else create one.
  let customerId = null;
  try {
    const found = await stripe(`/customers?email=${encodeURIComponent(email || '')}&limit=1`, { method: 'GET', slug });
    customerId = (found.data && found.data[0] && found.data[0].id) || null;
  } catch (e) { /* fall through to create */ }
  if (!customerId) {
    const c = await stripe('/customers', { method: 'POST', slug, body: {
      email: email || undefined, name: name || undefined, phone: phone || undefined,
      description: 'Booking widget customer',
    }});
    customerId = c.id;
  }
  // 2) Attach the payment method and make it the default.
  await stripe(`/payment_methods/${paymentMethodId}/attach`, { method: 'POST', slug, body: { customer: customerId } });
  await stripe(`/customers/${customerId}`, { method: 'POST', slug, body: {
    invoice_settings: { default_payment_method: paymentMethodId },
  }});
  return { customerId };
}
