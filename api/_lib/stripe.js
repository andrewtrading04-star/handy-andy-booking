// Minimal Stripe REST helper (no SDK — keeps the serverless bundle tiny).
// Uses STRIPE_SECRET_KEY, the SAME account the live booking widget already uses
// to put cards on file, so charges taken here hit the right customer/card.
//
// Everything is form-encoded per Stripe's API. Nested params (e.g. metadata)
// are flattened to metadata[key]=value. Errors throw with a friendly .message
// and the HTTP .status so callers can surface them directly.

import { demoMode, demoStripeResponse } from './demo.js';

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
  return demoMode() || !!process.env[envNameFor(sel)];
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
export async function stripe(path, { method = 'POST', body = null, slug = null, account = null, idempotencyKey = null } = {}) {
  // Demo mode: return a believable fake instead of calling Stripe.
  if (demoMode()) return demoStripeResponse(path, method, body);
  // 15s cap per Stripe call. These run inside booking/charge request handlers;
  // an unbounded stall would hang the office UI on "Processing…" until the
  // serverless platform kills the function. Stripe's own p99 is well under this.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(STRIPE_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey({ account, slug })}`, 'Content-Type': 'application/x-www-form-urlencoded',
        // A caller passes this on a charge-creating call so a client-side retry
        // (timeout, double-tap) with the SAME amount replays the original
        // PaymentIntent instead of creating a second real charge. Stripe scopes
        // idempotency keys per API key, so this is safe to reuse the same string
        // across accounts/customers.
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? toForm(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    const err = e.name === 'AbortError' ? new Error('Stripe request timed out') : e;
    if (err !== e) err.status = 504;
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

// Retrieve a payment method's card brand + last4 (for receipts + dispute
// evidence). Best-effort — callers treat a throw as "unknown card".
export async function retrieveCard(paymentMethodId, sel = null) {
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  const pm = await stripe(`/payment_methods/${paymentMethodId}`, { method: 'GET', slug, account });
  const c = pm && pm.card ? pm.card : {};
  return { brand: c.brand || null, last4: c.last4 || null };
}

// Upload a file to Stripe (files.stripe.com, multipart) for dispute evidence.
// `dataBase64` is raw base64 (no data: prefix). Returns the Stripe file id.
export async function stripeUploadFile({ dataBase64, contentType = 'image/png', filename = 'evidence.png', purpose = 'dispute_evidence', account = null, slug = null }) {
  if (demoMode()) return 'file_demo';
  const key = businessSecretKey({ account, slug });
  if (!key) { const e = new Error('Payments are not configured on the server.'); e.status = 400; throw e; }
  const bytes = Buffer.from(dataBase64, 'base64');
  const fd = new FormData();
  fd.append('purpose', purpose);
  fd.append('file', new Blob([bytes], { type: contentType }), filename);
  const res = await fetch('https://files.stripe.com/v1/files', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error((data.error && data.error.message) || 'File upload failed'); e.status = res.status; throw e; }
  return data.id;
}

// List disputes on an account that still need a response, newest first. Expands
// the charge so we can recover the PaymentIntent id (older disputes only carry
// the charge). Returns the raw Stripe dispute objects.
export async function listOpenDisputes(sel = null, limit = 100) {
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  const out = await stripe(`/disputes?limit=${Math.min(100, limit)}&expand[]=data.charge`, { method: 'GET', slug, account });
  return (out.data || []).filter(d => d.status === 'needs_response' || d.status === 'warning_needs_response');
}

// Submit assembled evidence for a dispute. `evidence` is a flat object of the
// Stripe evidence fields (customer_signature is a file id, etc.). Setting
// submit=true finalizes it — after that Stripe won't accept further changes.
export async function submitDisputeEvidence(disputeId, evidence, sel = null, submit = true) {
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  // Drop empty fields so we never overwrite a good value with "".
  const clean = {};
  for (const [k, v] of Object.entries(evidence || {})) if (v !== undefined && v !== null && v !== '') clean[k] = v;
  return stripe(`/disputes/${disputeId}`, { method: 'POST', slug, account, body: { evidence: clean, submit } });
}

// Upcoming Stripe payout per business — the "Expected <date>" figure shown in the
// Stripe dashboard's Payouts box (e.g. Dom's "$6,866.25 Expected Jul 7").
//
// On automatic payouts Stripe hasn't created the payout OBJECT yet — it's a
// projection of the account BALANCE that will sweep to the bank on the next
// payout date. That projection is exactly balance.available + balance.pending:
// verified live against Dom's dashboard, where available $5,277.03 + pending
// $1,689.22 = $6,866.25, matching the shown "Expected" figure to the cent. So we
// read /v1/balance and sum the USD available + pending. Amounts are cents in
// Stripe; we return whole dollars. Best-effort: a Stripe hiccup or missing key
// yields null for that business (the caller hides the line) rather than throwing,
// so the dashboard never breaks over a payout read.
export async function upcomingPayoutBySlug(slugs) {
  // Demo mode: fixed fake "next payout" per business so the Revenue box populates.
  if (demoMode()) {
    const fake = { 'handy-andy': 8214.50, doms: 5390.75 };
    const out = {};
    for (const slug of slugs || []) out[slug] = fake[slug] != null ? fake[slug] : 4250.00;
    return out;
  }
  const out = {};
  for (const slug of slugs || []) {
    const key = businessSecretKey({ slug });
    if (!key) { out[slug] = null; continue; }
    try {
      const res = await fetch(`${STRIPE_API}/balance`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { console.warn('[stripe payouts]', slug, (data && data.error && data.error.message) || res.status); out[slug] = null; continue; }
      const sumUsd = (arr) => (arr || []).filter(x => x.currency === 'usd').reduce((n, x) => n + Number(x.amount || 0), 0);
      const cents = sumUsd(data.available) + sumUsd(data.pending);
      out[slug] = Math.round(cents) / 100;
    } catch (e) {
      console.warn('[stripe payouts]', slug, e.message);
      out[slug] = null;
    }
  }
  return out;
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
