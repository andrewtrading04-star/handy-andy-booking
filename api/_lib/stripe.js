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
  'mile-high':  'MILE_HIGH_STRIPE_SECRET_KEY',
  austin:       'AUSTIN_STRIPE_SECRET_KEY',
  precision:    'PRECISION_STRIPE_SECRET_KEY',
  tvmountingdenver: 'TVMOUNTINGDENVER_STRIPE_SECRET_KEY',
  // Houston lead-gen quad (houstonmounting, houstontvinstallation,
  // tvhanginghouston, htvmounting) deliberately share ONE Stripe account —
  // houstonmounting.com's — instead of each getting its own. Only one account
  // entry exists; all four slugs resolve to it via LEGACY_SLUG_ACCOUNT below.
  houstonmounting: 'HOUSTONMOUNTING_STRIPE_SECRET_KEY',
};

// Legacy slug -> account for bookings made BEFORE per-booking stamping: Handy
// Andy charged on the GLOBAL account, Doms on its own. Used only when no explicit
// account is given, so existing bookings keep charging exactly as before.
const LEGACY_SLUG_ACCOUNT = {
  'handy-andy': 'global',
  doms:         'doms',
  'mile-high':  'mile-high',
  austin:       'austin',   // always its own account, never global -- born after the split
  precision:    'precision',// same
  tvmountingdenver: 'tvmountingdenver', // same
  // All four Houston lead-gen brands charge on the shared houstonmounting
  // account, never their own — there is no per-slug account for them.
  houstonmounting:         'houstonmounting',
  houstontvinstallation:   'houstonmounting',
  tvhanginghouston:        'houstonmounting',
  htvmounting:             'houstonmounting',
};

// A "selector" passed to these helpers is EITHER a string slug (legacy callers)
// OR an object { account, slug }. Resolve it to a concrete account name:
// explicit account wins; else map the slug; else the global account.
function selToAccount(sel) {
  const s = typeof sel === 'string' ? { slug: sel } : (sel || {});
  if (s.account && ACCOUNT_KEY_ENV[s.account]) return s.account;
  if (s.slug && LEGACY_SLUG_ACCOUNT[s.slug]) return LEGACY_SLUG_ACCOUNT[s.slug];
  // A slug we don't recognize must NEVER silently fall through to 'global' —
  // that is Handy Andy's live Stripe account, so a new business added without a
  // mapping here would quietly save and charge real cards in the wrong
  // company's account. Fail loudly instead. (No slug at all still means the
  // legacy Zenbooker path, which has always used the global account.)
  if (s.slug) throw new Error(`No Stripe account mapped for business "${s.slug}" — add it to ACCOUNT_KEY_ENV/LEGACY_SLUG_ACCOUNT in api/_lib/stripe.js`);
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
  // `customer` is null on a PaymentMethod that was tokenized but never
  // attached (e.g. the attach was declined) — only an attached pm is
  // actually chargeable, so callers deciding "is a card on file" must
  // check it, not just that the pm object exists.
  return { brand: c.brand || null, last4: c.last4 || null, customer: (typeof pm?.customer === 'string' ? pm.customer : pm?.customer?.id) || null };
}

// Verify a resolved payment method is actually chargeable before creating a
// PaymentIntent with it. A pm id can linger on a booking even though it was
// never attached (tokenized but the attach was declined — the Caplan booking,
// 2026-08-20) or was later detached in the Stripe dashboard; Stripe rejects a
// charge on an unattached pm with a raw error the office/tech UIs don't
// recognize as "no card". Returns { pmId, card }: the original pm when it's
// attached (or when the lookup merely errored — transient Stripe trouble must
// not block a charge on a good card), the customer's attached default as a
// swap when the stored pm is CONFIRMED unattached, or pmId:null when the
// customer genuinely has no attached card. This is the same swap the office
// UI's card chip (bookingCard in api/admin.js) applies, so the card shown is
// the card charged.
export async function resolveChargeablePm({ customerId, paymentMethodId, account = null, slug = null }) {
  const acct = { account, slug };
  let card = { brand: null, last4: null, customer: null };
  let lookupOk = false;
  try { card = await retrieveCard(paymentMethodId, acct); lookupOk = true; } catch (_) { /* transient — pass through */ }
  if (!lookupOk || card.customer) return { pmId: paymentMethodId, card };
  let fallback = null;
  try { if (customerId) fallback = await defaultPaymentMethod(customerId, acct); } catch (_) { /* none */ }
  if (!fallback || fallback === paymentMethodId) return { pmId: null, card: { brand: null, last4: null, customer: null } };
  card = { brand: null, last4: null, customer: null };
  lookupOk = false;
  try { card = await retrieveCard(fallback, acct); lookupOk = true; } catch (_) { /* transient */ }
  if (lookupOk && !card.customer) return { pmId: null, card: { brand: null, last4: null, customer: null } };
  return { pmId: fallback, card };
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

// Actual historical payouts (real amount + arrival date, not a projection) for
// one business's Stripe account, in a date range. Used by the Finances
// reconciliation to compare against what actually deposited into Business
// Savings -- unlike upcomingPayoutBySlug() above (a forward-looking estimate
// off the current balance), this reads Stripe's own payout OBJECTS, which
// only exist once Stripe has actually initiated the transfer. Amounts are
// cents in Stripe; returned in whole dollars. Best-effort: a missing key or a
// Stripe error yields an empty list rather than throwing, same convention as
// upcomingPayoutBySlug.
export async function listPayouts(slug, { sinceUnix, untilUnix } = {}) {
  const key = businessSecretKey({ slug });
  if (!key) return [];
  const out = [];
  let startingAfter = null;
  try {
    for (let page = 0; page < 20; page++) {   // hard cap: never loop forever on a Stripe paging bug
      const params = new URLSearchParams({ limit: '100' });
      if (sinceUnix) params.set('arrival_date[gte]', String(sinceUnix));
      if (untilUnix) params.set('arrival_date[lte]', String(untilUnix));
      if (startingAfter) params.set('starting_after', startingAfter);
      const res = await stripe(`/payouts?${params.toString()}`, { method: 'GET', slug });
      for (const p of (res.data || [])) {
        out.push({
          id: p.id,
          amount: Math.round(Number(p.amount)) / 100,
          arrival_date: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
          status: p.status,
        });
      }
      if (!res.has_more || !res.data || !res.data.length) break;
      startingAfter = res.data[res.data.length - 1].id;
    }
  } catch (e) {
    console.warn('[stripe payouts] listPayouts failed:', slug, e.message);
  }
  return out;
}

// Reconciliation guard — find a charge for this booking that ALREADY LANDED on
// Stripe but was never recorded in the CRM. The one way that happens: a charge
// request times out CLIENT-side (the 15s abort above) while Stripe completes
// the PaymentIntent server-side — the catch path restores the booking to
// unpaid and the intent id is never written. A later retry at the SAME
// amount+card is safely replayed by the idempotency key, but a retry with a
// DIFFERENT amount or card gets a different key and would create a second
// real charge (the exact residual behind the Jul 15 double-charge class).
// So before charging (or cash-marking) a booking with no recorded intent,
// search Stripe for a succeeded, un-refunded PaymentIntent tagged with this
// booking's id (both charge paths stamp metadata.job_id / metadata.booking_id).
// Best-effort by design: any search failure returns null and the caller
// proceeds exactly as before — this guard must never block a legitimate
// charge over a Stripe search hiccup. Note Stripe search is eventually
// consistent (up to ~1 min); the idempotency key covers that early window.
export async function findLandedCharge(bookingId, sel = null) {
  if (demoMode()) return null;
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  try {
    for (const metaKey of ['job_id', 'booking_id']) {
      const q = encodeURIComponent(`metadata['${metaKey}']:'${bookingId}'`);
      const out = await stripe(`/payment_intents/search?query=${q}&limit=10&expand[]=data.latest_charge`, { method: 'GET', slug, account });
      const hit = (out.data || []).find(pi => pi.status === 'succeeded'
        && pi.latest_charge && !pi.latest_charge.refunded && !(Number(pi.latest_charge.amount_refunded) > 0));
      if (hit) {
        return {
          id: hit.id,
          amount: Math.round(Number(hit.amount)) / 100,
          tip: Number(hit.metadata && hit.metadata.tip) || 0,
          customerId: (typeof hit.customer === 'string' ? hit.customer : hit.customer?.id) || null,
          paymentMethodId: (typeof hit.payment_method === 'string' ? hit.payment_method : hit.payment_method?.id) || null,
        };
      }
    }
  } catch (e) {
    console.warn('[stripe reconcile] landed-charge search failed (proceeding without):', e.message);
  }
  return null;
}

// Find a business's Stripe customer by email, else create one. Shared by
// saveCardOnFile (tokenize-then-attach fallback) and createCardSetupIntent
// (verified in-checkout save).
export async function findOrCreateCustomer({ email, name, phone, slug = null, account = null }) {
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
  return customerId;
}

// Best-effort: make a pm the customer's default for future off-session charges.
// Never load-bearing — defaultPaymentMethod() falls back to the first attached
// card when no default is set — so callers may fire-and-await without failing
// their flow on an error here.
export async function setDefaultPaymentMethod(customerId, paymentMethodId, sel = null) {
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  try {
    await stripe(`/customers/${customerId}`, { method: 'POST', slug, account, body: {
      invoice_settings: { default_payment_method: paymentMethodId },
    }});
    return true;
  } catch (e) {
    console.warn('[stripe setDefaultPaymentMethod] failed (non-fatal):', e.message);
    return false;
  }
}

// Create a SetupIntent tied to the (found-or-created) customer so the WIDGET
// can confirm the card in-page: the bank actually validates the card while
// the customer is still at checkout and can fix a typo'd CVC on the spot —
// instead of the attach failing server-side after the booking already went
// through (the Caplan/Alleman incidents). Returns what the client needs.
export async function createCardSetupIntent({ email, name, phone, slug = null, account = null }) {
  const customerId = await findOrCreateCustomer({ email, name, phone, slug, account });
  const si = await stripe('/setup_intents', { method: 'POST', slug, account, body: {
    customer: customerId, usage: 'off_session', 'payment_method_types[0]': 'card',
  }});
  return { clientSecret: si.client_secret, customerId };
}

// Save a card on file in a business's Stripe account: find/create the customer
// by email, attach the payment method, and make it the default. Returns the
// Stripe customer id. Used by the public Doms booking flow (and reusable by any
// per-business flow). Throws with .status/.message on failure.
export async function saveCardOnFile({ email, name, phone, paymentMethodId, slug = null, account = null }) {
  if (!paymentMethodId) return { customerId: null };
  const customerId = await findOrCreateCustomer({ email, name, phone, slug, account });
  // Attach the payment method and make it the default. Only the ATTACH is
  // load-bearing: once it succeeds the card is saved and chargeable, so a
  // failure setting invoice_settings must not make the whole save read as
  // failed (callers would then discard a working pm id and alert the office
  // that no card was saved). defaultPaymentMethod() already falls back to
  // listing the customer's attached cards when no default is set.
  await stripe(`/payment_methods/${paymentMethodId}/attach`, { method: 'POST', slug, account, body: { customer: customerId } });
  try {
    await stripe(`/customers/${customerId}`, { method: 'POST', slug, account, body: {
      invoice_settings: { default_payment_method: paymentMethodId },
    }});
  } catch (e) {
    console.warn('[stripe saveCardOnFile] card attached but set-default failed (card IS on file):', e.message);
  }
  return { customerId };
}
