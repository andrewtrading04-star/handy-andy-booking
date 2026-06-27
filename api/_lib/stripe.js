// Minimal Stripe REST helper (no SDK — keeps the serverless bundle tiny).
// Uses STRIPE_SECRET_KEY, the SAME account the live booking widget already uses
// to put cards on file, so charges taken here hit the right customer/card.
//
// Everything is form-encoded per Stripe's API. Nested params (e.g. metadata)
// are flattened to metadata[key]=value. Errors throw with a friendly .message
// and the HTTP .status so callers can surface them directly.

const STRIPE_API = 'https://api.stripe.com/v1';

// Stripe accounts, by explicit account name. Each business with its own Stripe
// account adds one entry; 'global' is the original STRIPE_SECRET_KEY that Handy
// Andy has always used. A card put on file in one account can ONLY be charged
// with that account's key, so the account a booking's card lives in is recorded
// per booking (bookings.stripe_account) and passed back in when charging.
const ACCOUNT_KEY_ENV = {
  global:       'STRIPE_SECRET_KEY',
  'handy-andy': 'HANDY_ANDY_STRIPE_SECRET_KEY',
  doms:         'DOMS_STRIPE_SECRET_KEY',
};

// Legacy slug -> account for bookings made BEFORE per-booking stamping: Handy
// Andy charged on the GLOBAL account, Doms on its own. Used only when no explicit
// account is given, so existing bookings keep charging exactly as before.
const LEGACY_SLUG_ACCOUNT = {
  'handy-andy': 'global',
  doms:         'doms',
};

// A "selector" passed to these helpers is EITHER a string slug (legacy callers)
// OR an object { account, slug }. Resolve it to a concrete account name:
// explicit account wins; else map the slug; else the global account.
function selToAccount(sel) {
  const s = typeof sel === 'string' ? { slug: sel } : (sel || {});
  if (s.account && ACCOUNT_KEY_ENV[s.account]) return s.account;
  if (s.slug && LEGACY_SLUG_ACCOUNT[s.slug]) return LEGACY_SLUG_ACCOUNT[s.slug];
  return 'global';
}
function envNameFor(sel) { return ACCOUNT_KEY_ENV[selToAccount(sel)]; }

export function stripeConfigured(sel) {
  return !!process.env[envNameFor(sel)];
}

// The raw secret key for a selector (null if unconfigured). Exported for the few
// callers that talk to Stripe with their own fetch() instead of stripe().
export function businessSecretKey(sel) {
  return process.env[envNameFor(sel)] || null;
}

function secretKey(sel) {
  const env = envNameFor(sel);
  const k = process.env[env];
  if (!k) {
    const acct = selToAccount(sel);
    const e = new Error(acct === 'global'
      ? 'Payments are not configured (STRIPE_SECRET_KEY is missing on the server).'
      : `Payments are not configured for ${acct} (${env} is missing on the server).`);
    e.status = 400; throw e;
  }
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
// `account` (explicit) or `slug` (legacy) selects the Stripe account; omit both
// for the global account.
export async function stripe(path, { method = 'POST', body = null, slug = null, account = null } = {}) {
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: { Authorization: `Bearer ${secretKey({ account, slug })}`, 'Content-Type': 'application/x-www-form-urlencoded' },
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
export async function findCardOnFileByEmail(email, sel = null) {
  if (!email) return { customerId: null, paymentMethodId: null };
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  const found = await stripe(`/customers?email=${encodeURIComponent(email)}&limit=10`, { method: 'GET', slug, account });
  const list = found.data || [];
  const withPm = list.find(c => c.invoice_settings && c.invoice_settings.default_payment_method) || list[0];
  if (!withPm) return { customerId: null, paymentMethodId: null };
  return { customerId: withPm.id, paymentMethodId: withPm.invoice_settings?.default_payment_method || null };
}

// Given a Stripe customer, find its default (or first) card payment method.
export async function defaultPaymentMethod(customerId, sel = null) {
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  const c = await stripe(`/customers/${customerId}`, { method: 'GET', slug, account });
  if (c.invoice_settings?.default_payment_method) return c.invoice_settings.default_payment_method;
  const pms = await stripe(`/payment_methods?customer=${customerId}&type=card&limit=1`, { method: 'GET', slug, account });
  return (pms.data && pms.data[0] && pms.data[0].id) || null;
}

// Save a card on file in a business's Stripe account: find/create the customer
// by email, attach the payment method, and make it the default. Returns the
// Stripe customer id. Used by the public Doms booking flow (and reusable by any
// per-business flow). Throws with .status/.message on failure.
export async function saveCardOnFile({ email, name, phone, paymentMethodId, slug = null, account = null }) {
  if (!paymentMethodId) return { customerId: null };
  // 1) Reuse an existing customer for this email, else create one.
  let customerId = null;
  try {
    const found = await stripe(`/customers?email=${encodeURIComponent(email || '')}&limit=1`, { method: 'GET', slug, account });
    customerId = (found.data && found.data[0] && found.data[0].id) || null;
  } catch (e) { /* fall through to create */ }
  if (!customerId) {
    const c = await stripe('/customers', { method: 'POST', slug, account, body: {
      email: email || undefined, name: name || undefined, phone: phone || undefined,
      description: 'Booking widget customer',
    }});
    customerId = c.id;
  }
  // 2) Attach the payment method and make it the default.
  await stripe(`/payment_methods/${paymentMethodId}/attach`, { method: 'POST', slug, account, body: { customer: customerId } });
  await stripe(`/customers/${customerId}`, { method: 'POST', slug, account, body: {
    invoice_settings: { default_payment_method: paymentMethodId },
  }});
  return { customerId };
}
