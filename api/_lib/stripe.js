// Minimal Stripe REST helper (no SDK — keeps the serverless bundle tiny).
// Uses STRIPE_SECRET_KEY, the SAME account the live booking widget already uses
// to put cards on file, so charges taken here hit the right customer/card.
//
// Everything is form-encoded per Stripe's API. Nested params (e.g. metadata)
// are flattened to metadata[key]=value. Errors throw with a friendly .message
// and the HTTP .status so callers can surface them directly.

import { demoMode, demoStripeResponse } from './demo.js';
import { createHash, randomUUID } from 'node:crypto';

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
  // TV Mounting Denver now charges on Mile High's Stripe account, not its own.
  tvmountingdenver: 'mile-high',
  // All four Houston lead-gen brands charge on the shared houstonmounting
  // account, never their own — there is no per-slug account for them.
  houstonmounting:         'houstonmounting',
  houstontvinstallation:   'houstonmounting',
  tvhanginghouston:        'houstonmounting',
  htvmounting:             'houstonmounting',
  houstontvmountingpros:   'houstonmounting',
  houstonperfectviewtvmounting: 'houstonmounting',
  // Austin lead-gen quad, same arrangement as Houston's: all five Austin
  // brands (austin + these four) charge on austinmounting.com's existing
  // 'austin' Stripe account — no per-slug account exists or should be added.
  atxmountpros:            'austin',
  atxtvmount:              'austin',
  austinmountingpros:      'austin',
  austintvinstall:         'austin',
};

// A "selector" passed to these helpers is EITHER a string slug (legacy callers)
// OR an object { account, slug }. Resolve it to a concrete account name:
// explicit account wins; else map the slug; else the global account.
function selToAccount(sel) {
  const s = typeof sel === 'string' ? { slug: sel } : (sel || {});
  if (s.account && ACCOUNT_KEY_ENV[s.account]) return s.account;
  // Many callers pass a business SLUG as `account` (e.g. cardSetupPublic's
  // `{ account: business }`, and bookings stamped stripe_account=<slug>). A
  // slug that shares another business's account (the Houston lead-gen quad)
  // only exists in LEGACY_SLUG_ACCOUNT, so map it here too — before this,
  // `{ account: 'houstontvinstallation' }` fell through to 'global' (Handy
  // Andy's live account) and checkout card-verify died with "No such
  // setupintent": the SetupIntent landed on HA's account while the widget
  // held houstonmounting's publishable key.
  if (s.account && LEGACY_SLUG_ACCOUNT[s.account]) return LEGACY_SLUG_ACCOUNT[s.account];
  // A slug or account we don't recognize must NEVER silently fall through to
  // 'global' — that is Handy Andy's live Stripe account, so a new business
  // added without a mapping here would quietly save and charge real cards in
  // the wrong company's account. Fail loudly instead. (No selector at all
  // still means the legacy Zenbooker path, which has always used the global
  // account.)
  if (s.account) throw new Error(`No Stripe account mapped for "${s.account}" — add it to ACCOUNT_KEY_ENV/LEGACY_SLUG_ACCOUNT in api/_lib/stripe.js`);
  if (s.slug && LEGACY_SLUG_ACCOUNT[s.slug]) return LEGACY_SLUG_ACCOUNT[s.slug];
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
        // Idempotency-Key. The charge path (chargeCardOnFile below) puts a key
        // only on PaymentIntent CREATION, so a retry from either app converges on
        // the same intent object; each confirm carries a one-off key. Stripe
        // scopes keys per API key.
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
// amount+card converges on the same PaymentIntent (chargeCardOnFile reads the
// live intent under the shared create key and adopts it if it succeeded), but
// a retry with a DIFFERENT amount or card gets a different key and would
// create a second real charge (the exact residual behind the Jul 15
// double-charge class).
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

// ── Card-on-file charge, shared by api/admin.js and api/tech.js ─────────────
// Both apps charge the SAME booking under the SAME idempotency key so a retry
// from either replays the other's attempt. That only works if the request
// under the key is byte-identical: on 2026-09-11 (booking 9ff4ca11) the two
// paths built different bodies (description/metadata), the tech's cached 402
// poisoned the key, and every office attempt got Stripe's 400
// idempotency_error ("Keys for idempotent requests can only be used with the
// same parameters they were first used with") for the rest of the day.
// Everything under the key is now built here, once.
//
// Shape (Stripe's create-then-confirm split): the key covers only
// PaymentIntent CREATION (no money moves), so a replay always yields the same
// intent object; each CONFIRM is a fresh bank attempt under a one-off key, so
// a decline is never replayed for 24h and a PaymentIntent can only capture
// once — a double-tap / timeout / office-and-tech race can never charge twice.

function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// The CREATE body. Nothing attempt-specific may live here: anything that can
// differ between the office and the tech app for the same booking, or between
// two attempts (receipt_email changes when the customer's email is edited),
// would make the two requests disagree under the shared key. No confirm /
// off_session / receipt_email (confirm-time params). Both metadata keys are
// stamped so findLandedCharge's search keeps matching.
export function chargeIntentBody({ bookingId, cents, tip, customerId, paymentMethodId, businessSlug }) {
  return {
    amount: cents, currency: 'usd',
    customer: customerId, payment_method: paymentMethodId,
    description: `Booking ${bookingId}`,
    metadata: { booking_id: bookingId, job_id: bookingId, business: businessSlug || '', tip: String(tip) },
  };
}

// The CREATE key, derived from the body itself so the two can never disagree.
// 'charge2-' (not 'charge-'): keys cached under the old scheme carry old-shape
// bodies for up to 24h after deploy and would 400. The body hash gives any
// future change to chargeIntentBody() a new key automatically. `priorPiId`
// (the booking's recorded stripe_payment_intent_id — a refunded charge being
// re-charged) keeps this key off the refunded intent's key.
export function chargeIntentKey(body, { priorPiId = null } = {}) {
  // The tip rides in metadata for reconciliation, but the key must not care
  // how the same total splits into ticket + tip (the office can type a
  // different split than the tech), so it is hashed OUT: same booking + cents
  // + card => same key from either app. A differing split then trips Stripe's
  // parameter check, and chargeCardOnFile's safety net reconciles it.
  const { tip, ...metaNoTip } = body.metadata || {};
  const h = createHash('sha256').update(stableStringify({ ...body, metadata: metaNoTip })).digest('hex').slice(0, 8);
  return `charge2-${body.metadata.booking_id}-${body.amount}-${String(body.payment_method).slice(-8)}-${h}`
    + (priorPiId ? `-after-${String(priorPiId).slice(-8)}` : '');
}

// Turn a raw Stripe error into what the office / tech should read and do next.
// Decorates in place and returns e: .message (human), .code, .decline_code,
// .needs_new_card (offer "take cash / change card"), .retryable. Never
// touches .status. Hard declines never clear on retry (Stripe decline codes).
const HARD_DECLINES = new Set(['lost_card', 'stolen_card', 'pickup_card', 'fraudulent', 'do_not_try_again', 'restricted_card', 'security_violation', 'revocation_of_all_authorizations', 'revocation_of_authorization', 'merchant_blacklist', 'stop_payment_order', 'no_action_taken']);
const SOFT_DECLINES = new Set(['try_again_later', 'issuer_not_available', 'processing_error', 'reenter_transaction', 'card_velocity_exceeded', 'withdrawal_count_limit_exceeded', 'approve_with_id', 'call_issuer']);
const BAD_DETAILS   = new Set(['incorrect_cvc', 'invalid_cvc', 'incorrect_number', 'invalid_number', 'incorrect_zip', 'invalid_account', 'new_account_information_available', 'expired_card', 'invalid_expiry_month', 'invalid_expiry_year']);
export function friendlyChargeError(e) {
  const s = (e && e.stripe) || {};
  e.code = s.code || e.code || null;
  e.decline_code = s.decline_code || null;
  e.needs_new_card = false; e.retryable = false;
  const dc = e.decline_code || '';
  if (s.type === 'idempotency_error') {
    e.message = 'Stripe rejected this as a mismatched repeat of an earlier attempt. Try once more; if it persists, tell the office.'; e.retryable = true;
  } else if (s.type === 'card_error' || e.code === 'card_declined') {
    if (e.code === 'authentication_required' || dc === 'authentication_required') { e.message = 'This card requires the customer to verify with their bank, which cannot be done from the app. Ask for a different card or take cash.'; e.needs_new_card = true; }
    else if (dc === 'insufficient_funds') { e.message = 'Card declined: insufficient funds. Ask the customer for another card, or take cash.'; e.needs_new_card = true; }
    else if (HARD_DECLINES.has(dc)) { e.message = 'The bank blocked this card. Do not retry it — ask for a different card or take cash.'; e.needs_new_card = true; }
    else if (BAD_DETAILS.has(dc) || BAD_DETAILS.has(e.code)) { e.message = 'The card on file is expired or its details are out of date. Enter a different card, or take cash.'; e.needs_new_card = true; }
    else if (SOFT_DECLINES.has(dc)) { e.message = 'The bank could not process this right now. Wait a minute and try again — no charge was made.'; e.retryable = true; }
    else { e.message = `The bank declined this card${s.message ? ` (${String(s.message).replace(/\.$/, '')})` : ''}. The customer can call their bank, try another card, or pay cash.`; e.needs_new_card = true; }
  } else if (e.status === 504 || e.status >= 500 || e.code === 'lock_timeout' || s.type === 'api_error') {
    e.message = 'Stripe could not process this right now. Wait a minute and try again — no charge was made.'; e.retryable = true;
  }
  // invalid_request_error etc.: keep Stripe's message (it names the bad parameter — a code bug, not a card problem).
  return e;
}

// Shape helpers for a PaymentIntent fetched with expand[]=latest_charge.
// Stripe flips latest_charge.refunded only when the WHOLE charge went back; a
// partial refund means the customer still paid something, so it is neither
// adoptable as "paid in full" nor spent enough to charge the full amount again.
const piCharge = (p) => (p && p.latest_charge && typeof p.latest_charge === 'object') ? p.latest_charge : null;
const piChargeId = (p) => { const c = piCharge(p); return c ? (c.id || null) : ((p && p.latest_charge) || null); };
const piFullyRefunded = (p) => { const c = piCharge(p); return !!(c && (c.refunded === true || (Number(c.amount_refunded) > 0 && Number(c.amount_refunded) >= Number(c.amount || p.amount)))); };
const piPartlyRefunded = (p) => { const c = piCharge(p); return !!(c && Number(c.amount_refunded) > 0 && !piFullyRefunded(p)); };

// What became of an intent a booking row still carries while NOT paid — the
// callers keep the id after a charge attempt whose outcome chargeCardOnFile
// could not settle (our abort fired mid-confirm). Used by "Mark paid (cash)"
// so cash is never taken on top of a card charge that did land. Returns
// { state: 'succeeded' | 'refunded' | 'processing' | 'open' | 'unknown', landed }
// where `landed` (state 'succeeded' only) has findLandedCharge's shape.
export async function pendingIntentState(paymentIntentId, sel = null) {
  if (!paymentIntentId || demoMode()) return { state: 'unknown', landed: null };
  const { account = null, slug = null } = typeof sel === 'string' ? { slug: sel } : (sel || {});
  let pi = null;
  try { pi = await stripe(`/payment_intents/${paymentIntentId}?expand[]=latest_charge`, { method: 'GET', slug, account }); }
  catch (e) { console.warn('[stripe pending] lookup failed (proceeding without):', e.message); return { state: 'unknown', landed: null }; }
  if (pi.status === 'succeeded') {
    if (piFullyRefunded(pi) || piPartlyRefunded(pi)) return { state: 'refunded', landed: null };
    return { state: 'succeeded', landed: {
      id: pi.id,
      amount: Math.round(Number(pi.amount)) / 100,
      tip: Number(pi.metadata && pi.metadata.tip) || 0,
      customerId: (typeof pi.customer === 'string' ? pi.customer : pi.customer?.id) || null,
      paymentMethodId: (typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id) || null,
    } };
  }
  if (pi.status === 'processing') return { state: 'processing', landed: null };
  return { state: 'open', landed: null };   // requires_* or canceled: nothing was collected
}

// Charge a card on file. Returns { pi, recovered }: pi.status === 'succeeded',
// pi.latest_charge normalized to a charge ID string (callers store it).
// recovered:true means an EARLIER attempt had already landed this exact
// charge and was adopted — no new charge was made. Throws Error with .status
// (400/402/409/504), .stripe, .code, .decline_code, .needs_new_card, .retryable.
export async function chargeCardOnFile({ bookingId, cents, tip, customerId, paymentMethodId, receiptEmail = null, businessSlug = null, priorPiId = null, account = null, slug = null, log = '[charge]' }) {
  const acct = { account, slug };
  const body = chargeIntentBody({ bookingId, cents, tip, customerId, paymentMethodId, businessSlug });

  // Demo mode: the stub (api/_lib/demo.js) answers every POST /payment_intents
  // with 'succeeded' and every GET with a fixed 9999.99 intent, so the split
  // flow below would "adopt" a fake mismatched charge. Keep the one-shot call.
  if (demoMode()) {
    const pi = await stripe('/payment_intents', { ...acct, body: { ...body, off_session: true, confirm: true, receipt_email: receiptEmail || undefined } });
    return { pi, recovered: false };
  }

  const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
  const getPi = (id) => stripe(`/payment_intents/${id}?expand[]=latest_charge`, { method: 'GET', ...acct });
  const create = (key) => stripe('/payment_intents', { ...acct, idempotencyKey: key, body });
  const chargeIdOf = piChargeId, fullyRefunded = piFullyRefunded, partlyRefunded = piPartlyRefunded;
  const normalize = (p) => ({ ...p, latest_charge: chargeIdOf(p) });
  const STILL_PROCESSING = 'A charge for this booking is still processing at the bank — wait a minute and check the booking before charging again.';
  const IN_PROGRESS = 'This charge is already in progress from another device (office or tech app) — wait a moment and check whether it went through before trying again.';
  const decide = (p) => {
    if (p.status === 'succeeded') {
      if (Number(p.amount) !== cents) throw fail(409, `Stripe holds a succeeded payment for this booking at a different amount ($${(Number(p.amount) / 100).toFixed(2)}, ${p.id}) — check Stripe before charging again.`);
      if (partlyRefunded(p)) throw fail(409, `Stripe holds a partly refunded payment for this booking (${p.id}) — check Stripe before charging again.`);
      return fullyRefunded(p) ? 'successor' : 'adopt';
    }
    if (p.status === 'canceled') return 'successor';
    if (p.status === 'processing') throw fail(409, STILL_PROCESSING, { payment_intent_id: p.id });
    if (p.status === 'requires_capture') throw fail(409, `Stripe holds an uncaptured authorization for this booking (${p.id}) — check Stripe before charging again.`);
    return 'confirm';   // requires_confirmation | requires_payment_method | requires_action
  };

  // 0. A booking that already records an intent (stripe_payment_intent_id set)
  //    is one of: a refunded charge being re-charged; an attempt whose outcome
  //    was unknown when it ended (our abort fired mid-confirm — the callers
  //    keep the intent id on the row for exactly this moment); or a row someone
  //    flipped back to unpaid by hand. Read THAT intent first — a direct read,
  //    not the eventually-consistent search findLandedCharge relies on.
  //    Best-effort: a lookup failure (an older intent that lives on another
  //    Stripe account) does not block the charge.
  let pi = null;
  if (priorPiId) {
    let prior = null;
    try { prior = await getPi(priorPiId); } catch (_) { /* unknown — proceed */ }
    if (prior && prior.status === 'succeeded') {
      if (partlyRefunded(prior)) throw fail(409, `The charge recorded on this booking (${prior.id}) was only partly refunded — check Stripe before charging again.`);
      if (!fullyRefunded(prior)) {
        // The money is already there. Record it, never charge again.
        console.warn(`${log} booking=${bookingId} recorded intent ${prior.id} already succeeded — adopting, no new charge`);
        return { pi: normalize(prior), recovered: true };
      }
      // fully refunded: a fresh intent goes under the -after- key below
    } else if (prior && (prior.status === 'processing' || prior.status === 'requires_capture')) {
      decide(prior);   // throws the matching 409
    } else if (prior && prior.status !== 'canceled') {
      // requires_confirmation / requires_payment_method / requires_action: an
      // attempt that never settled (our abort fired) or a plain decline. RE-USE
      // this intent instead of minting another: Stripe's per-object lock is
      // what makes a confirm still executing at Stripe impossible to double —
      // the update / confirm below hit 429 lock_timeout until it settles.
      const patch = {};
      if (Number(prior.amount) !== cents) patch.amount = cents;
      const pmNow = (typeof prior.payment_method === 'string' ? prior.payment_method : (prior.payment_method && prior.payment_method.id)) || null;
      if (pmNow !== paymentMethodId) patch.payment_method = paymentMethodId;
      if (String((prior.metadata && prior.metadata.tip) ?? '') !== String(tip)) patch.metadata = { tip: String(tip) };
      pi = prior;
      if (Object.keys(patch).length) {
        try { await stripe(`/payment_intents/${prior.id}`, { ...acct, body: patch }); pi = await getPi(prior.id); }
        catch (e) {
          const s = e.stripe || {};
          if (e.status === 429 || s.code === 'lock_timeout') throw fail(409, IN_PROGRESS, { code: s.code || null, payment_intent_id: prior.id });
          // e.g. the new card belongs to a different Stripe customer: this
          // intent can't take it — leave it and start a fresh one below.
          console.warn(`${log} booking=${bookingId} could not re-use intent ${prior.id} (${e.message}); creating a fresh one`);
          pi = null;
        }
      }
      if (pi) console.warn(`${log} booking=${bookingId} re-using recorded intent ${pi.id} (${pi.status})`);
    }
  }

  // 1. CREATE under the shared key (unless an earlier attempt's intent is being
  //    re-used). No money moves here; a replay from either app (or a
  //    double-tap) yields the same intent object.
  let key = chargeIntentKey(body, { priorPiId });
  if (!pi) {
    let created;
    try {
      created = await create(key);
    } catch (e) {
      const t = e.stripe && e.stripe.type, c = e.stripe && e.stripe.code;
      if (e.status === 400 && t === 'idempotency_error') {
        // Parameters drifted under this key — the class of bug behind the
        // 2026-09-11 incident. Adopt a landed charge if there is one; otherwise
        // retry the CREATE (still no money) under a derived key both apps share.
        console.warn(`${log} booking=${bookingId} idempotency_error under ${key} — reconciling`);
        const landed = await findLandedCharge(bookingId, acct);
        if (landed) { console.warn(`${log} booking=${bookingId} adopting landed intent ${landed.id}`); return { pi: normalize(await getPi(landed.id)), recovered: true }; }
        key = `${key}-r1`;
        created = await create(key);
      } else if (e.status === 409 && c === 'idempotency_key_in_use') {
        throw fail(409, IN_PROGRESS, { code: c });
      } else {
        throw friendlyChargeError(e);
      }
    }
    // 2. Read the LIVE intent. A replayed create returns the ORIGINAL response
    //    body (status requires_confirmation) even when the intent has since
    //    been confirmed — only a GET says what actually happened.
    pi = await getPi(created.id);
  }
  let next = decide(pi);
  if (next === 'successor') {
    // The intent under this key is spent (a refunded charge being re-charged,
    // or Stripe canceled it after too many failed confirms). Mint ONE successor
    // under a key derived from the spent id, so both apps still converge.
    const spent = pi.id;
    key = `${key}-after-${String(spent).slice(-8)}`;
    console.warn(`${log} booking=${bookingId} intent ${spent} is spent (${pi.status}); creating successor under ${key}`);
    const successor = await create(key);
    pi = await getPi(successor.id);
    next = decide(pi);
    if (next === 'successor') throw fail(409, `Stripe already holds a used payment for this booking at this amount (${pi.id}) — check Stripe before charging again.`);
  }
  if (next === 'adopt') {
    console.warn(`${log} booking=${bookingId} intent ${pi.id} already succeeded (idempotent replay) — adopting, no new charge`);
    return { pi: normalize(pi), recovered: true };
  }

  // 3. CONFIRM — the money-moving call — under a ONE-OFF key, so a decline is
  //    a real new bank attempt every time (never a 24h replay). off_session and
  //    receipt_email are confirm-time params (Stripe rejects off_session on a
  //    create without confirm=true).
  console.info(`${log} booking=${bookingId} confirming intent ${pi.id} (${pi.status}) key=${key}`);
  // Every confirm attempt (approved or declined) hangs a NEW charge object on
  // the intent, so "did latest_charge change" is how the read-back below tells
  // THIS attempt's outcome from a decline an earlier attempt left behind.
  const chargeBefore = chargeIdOf(pi);
  try {
    pi = await stripe(`/payment_intents/${pi.id}/confirm`, { ...acct, idempotencyKey: `confirm-${pi.id}-${randomUUID()}`, body: {
      // error_on_requires_action: a saved card that suddenly demands 3-D Secure
      // fails the attempt as a card_error (authentication_required) instead of
      // parking the intent in requires_action, which nobody in the app can finish.
      payment_method: paymentMethodId, off_session: true, error_on_requires_action: true, receipt_email: receiptEmail || undefined,
    }});
  } catch (e) {
    const s = e.stripe || {};
    console.warn(`${log} booking=${bookingId} intent=${pi.id} confirm failed: http=${e.status} type=${s.type} code=${s.code} decline=${s.decline_code} ${s.request_log_url || ''} — ${e.message}`);
    if (s.type === 'card_error') { e.status = 402; throw friendlyChargeError(e); }
    // Not a decline: our 15s abort, a Stripe 5xx, 429 lock_timeout, a 400
    // payment_intent_unexpected_state from a racing confirm, a network drop.
    // The money MAY have moved — read the intent we hold the id of first.
    let live = null;
    for (let i = 0; i < 2 && !live; i++) { try { live = await getPi(pi.id); } catch (_) { /* one retry */ } }
    if (!live) throw fail(504, `Stripe did not answer while confirming this charge (${e.message}). It MAY have gone through — refresh the booking before trying again; a retry at the same amount and card resumes this exact payment (${pi.id}) instead of charging twice.`, { code: s.code || null, stripe: e.stripe || null, payment_intent_id: pi.id });
    if (live.status === 'succeeded') {
      if (!fullyRefunded(live) && !partlyRefunded(live) && Number(live.amount) === cents) return { pi: normalize(live), recovered: false };
      throw fail(409, `Stripe holds a succeeded payment for this booking (${live.id}) that does not match this charge — check Stripe before charging again.`);
    }
    if (live.status === 'processing') throw fail(409, STILL_PROCESSING, { payment_intent_id: live.id });
    if (live.status === 'canceled') throw fail(409, `Stripe canceled this payment attempt (${live.id}) — check Stripe, then charge again (the next attempt starts a fresh payment).`);
    const liveCharge = chargeIdOf(live);
    if (liveCharge && liveCharge !== chargeBefore && live.last_payment_error && live.last_payment_error.type === 'card_error') {
      // A new charge object carrying a card error: THIS attempt did reach the
      // bank and was declined (not a stale decline from an earlier attempt).
      throw friendlyChargeError(fail(402, live.last_payment_error.message || 'Your card was declined.', { stripe: live.last_payment_error }));
    }
    if (e.status === 429 || s.code === 'lock_timeout') {
      // Stripe's per-object lock is held: ANOTHER confirm of this very intent
      // is executing right now (the other app, or our own earlier attempt that
      // timed out on our side). Not "no charge was made" — it may be landing.
      throw fail(409, IN_PROGRESS, { code: s.code || null, stripe: e.stripe || null, payment_intent_id: pi.id });
    }
    if (e.status !== 400) {
      // Our abort / a Stripe 5xx / a network drop with no new charge visible
      // yet: the confirm may STILL be executing at Stripe. Never say "no charge
      // was made"; the callers keep this intent id on the row so the next
      // attempt reads this exact intent instead of searching for it.
      throw fail(504, `Stripe did not answer while confirming this charge and it MAY still be going through at the bank (${pi.id}). Refresh the booking before taking cash or charging again; a retry at the same amount and card resumes this exact payment instead of charging twice.`, { code: s.code || null, stripe: e.stripe || null, payment_intent_id: pi.id });
    }
    // A 400 with the intent still unconfirmed: the confirm never executed.
    e.status = e.status || 402;
    throw friendlyChargeError(e);
  }
  if (pi.status !== 'succeeded') {
    // A 200 that is not 'succeeded': 'processing' (money may still land — the
    // next attempt re-reads and adopts) or requires_action despite off_session
    // (the card wants the customer at a keyboard, which the app cannot do).
    if (pi.status === 'processing') throw fail(409, STILL_PROCESSING, { payment_intent_id: pi.id });
    const lpe = pi.last_payment_error || null;
    throw friendlyChargeError(fail(402, `Charge not completed (status: ${pi.status}). ${(lpe && lpe.message) || 'The card may need the customer to re-authenticate.'}`,
      { stripe: lpe || { type: 'card_error', code: 'authentication_required', message: 'This card needs the customer to authenticate with their bank.' } }));
  }
  return { pi: normalize(pi), recovered: false };
}
