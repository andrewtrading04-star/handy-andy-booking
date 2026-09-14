#!/usr/bin/env node
// ============================================================================
// scripts/bracket-email-sync.mjs  —  Walmart order email → bracket inventory
// ============================================================================
// Reads Walmart order emails from one or more Gmail mailboxes (via IMAP + App
// Password), parses bracket type/quantity/status/tracking-URL, and pushes each
// order to the HAD CRM via POST /api/migrate?action=bracket_sync.
//
// IMPORTANT — why it reads by content, not sender:
//   Walmart orders are placed under one account (e.g. domstvmounting@gmail.com)
//   and may be FORWARDED to another (andrewtrading04@gmail.com). A forwarded
//   email's From: is the forwarder, NOT walmart.com — so we match Walmart
//   emails by body content + a recent-date window, never by sender alone.
//
//   The sync endpoint is idempotent (keyed on the Walmart order number, per
//   business) so we do NOT rely on read/unread state and we do NOT mutate the
//   mailbox — every run re-scans the window and upserts safely.
//
// Accounts (set as GitHub Actions secrets). At least the primary is required:
//   GMAIL_USER          / GMAIL_APP_PASSWORD          (primary mailbox)
//   GMAIL_USER_2        / GMAIL_APP_PASSWORD_2         (optional 2nd mailbox)
// Plus:
//   CRON_SECRET         same value as the Vercel CRON_SECRET env var
//   VERCEL_URL          optional (default https://handy-andy-booking.vercel.app)
//   LOOKBACK_DAYS       optional (default 45)
//
// HEALTH REPORT: every run ends by POSTing one report (per-inbox ok/failed with
// a classified reason, counts, sync errors, crash) to
// /api/migrate?action=bracket_sync_health. The CRM texts the owner and shows a
// dashboard card — see api/_lib/bracket-sync-health.js. The process exits 1
// ONLY when that report could not be delivered; a failed inbox never fails the
// run (the 2026-09-12 revoked-App-Password outage hid behind green runs for
// ten days precisely because nobody watches per-run GitHub e-mails).
// Classifier: kind 'auth' = Gmail's hard AUTHENTICATIONFAILED / "Invalid
// credentials" family only; any other NO to AUTHENTICATE (Gmail's transient
// [UNAVAILABLE], too-many-connections) is 'auth_soft' and needs a streak.
// App Passwords go into the GitHub secret WITHOUT spaces. Slots 1..7 are
// expected to be set; a blank or half-set one is reported, not skipped.
// ============================================================================

import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseWalmartEmails } from './lib/walmart-parse.mjs';
import { parseAmazonPlateEmail, PLATE_MATCH } from './lib/amazon-parse.mjs';
import { parseGoogleReviewEmail } from './lib/google-review-parse.mjs';
import { parseWebsiteLeadEmail } from './lib/website-lead-parse.mjs';

const CRON_SECRET = process.env.CRON_SECRET || '';
const VERCEL_URL  = (process.env.VERCEL_URL || 'https://handy-andy-booking.vercel.app').replace(/\/$/, '');
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS) || 45;

const STATUS_RANK = { in_route: 0, ordered: 0, delivered: 1, canceled: 2 };

// Mailboxes to scan: the primary (GMAIL_USER) plus every numbered mailbox
// (GMAIL_USER_2, _3, _4, …) that has both a user and an app password set.
// Numbered slots are discovered dynamically so adding another Gmail account is
// just a matter of setting two more secrets — no code change here.
//
// Current layout (see scripts/lib/gmb-locations.mjs for the review inboxes):
//   GMAIL_USER    primary forwarder
//   GMAIL_USER_2  domstvmounting@gmail.com   (Dom's reviews + Walmart orders)
//   GMAIL_USER_3  houstonhandyandy@gmail.com (Amazon wire-plate orders)
//   GMAIL_USER_4  houstonmainbusiness@gmail.com   (HA Houston #1 + #2 reviews)
//   GMAIL_USER_5  denvermainbusiness@gmail.com    (HA Denver #1 reviews)
//   GMAIL_USER_6  denverinstallpros@gmail.com     (HA Denver #2 reviews)
//   GMAIL_USER_7  austinmainbusiness@gmail.com    (HA Austin reviews)
// Every mailbox is scanned for Walmart, Amazon AND Google-review emails alike,
// so a review inbox that never sees an order simply yields reviews only.
// This mailbox exists ONLY to buy the wire concealment plate product — see
// scripts/lib/amazon-parse.mjs's trustSender doc comment. Amazon's "Ordered:"
// email doesn't always include the product title (sometimes just the generic
// category, e.g. "2 Electrical & Heating items"), so PLATE_MATCH can miss a
// real order. Since nothing else is ever bought through this account, any
// real Amazon order-flow email seen here is trusted as a plate order.
const PLATE_DEDICATED_MAILBOX_IDX = 3;
const EXPECTED_MAILBOX_COUNT = 7;
const MAILBOX_ROLE = {
  1: 'Walmart orders forwarder', 2: "Dom's reviews + Walmart", 3: 'Amazon wire plates',
  4: 'Houston reviews', 5: 'Denver #1 reviews', 6: 'Denver #2 reviews', 7: 'Austin reviews',
};
const CRM_FETCH_TIMEOUT_MS = 30000;

// Returns { boxes, misconfigured }. A slot with exactly one of the pair set is
// reported by the real secret name (a typo'd secret silently skipping an inbox
// is how an outage hides for weeks); a blank slot within 1..EXPECTED_MAILBOX_COUNT
// is reported as 'both' (amber on the dashboard — retiring an inbox is fine).
function mailboxes() {
  const boxes = [], misconfigured = [];
  for (let i = 1; i <= 12; i++) {
    const userName = i === 1 ? 'GMAIL_USER' : `GMAIL_USER_${i}`;
    const passName = i === 1 ? 'GMAIL_APP_PASSWORD' : `GMAIL_APP_PASSWORD_${i}`;
    const user = process.env[userName], pass = process.env[passName];
    if (user && pass) boxes.push({ user, pass, idx: i });
    else if (user || pass) misconfigured.push({ idx: i, missing: user ? passName : userName });
    else if (i <= EXPECTED_MAILBOX_COUNT) misconfigured.push({ idx: i, missing: 'both' });
  }
  return { boxes, misconfigured };
}

// ── Per-run health report (see header) ──────────────────────────────────────
// Built at the top of main(); finish() falls back to a bare one so a crash
// before main() is still reported.
let report = null;
function runInfo() {
  const env = process.env;
  const event = env.GITHUB_EVENT_NAME || null;
  return {
    source: env.GITHUB_ACTIONS === 'true' ? 'github' : 'local',
    id: env.GITHUB_RUN_ID || null, attempt: env.GITHUB_RUN_ATTEMPT || null, event,
    trigger: event === 'workflow_dispatch' ? 'dispatch' : event === 'schedule' ? 'github-schedule' : 'local',
    sha: env.GITHUB_SHA || null, node: process.version, lookback_days: LOOKBACK_DAYS,
    started_at: new Date().toISOString(),
  };
}
function newReport() {
  return { run: runInfo(), mailboxes: [], misconfigured: [], totals: null, sync_errors: [], sync_errors_dropped: 0, fatal: null, skipped: null };
}
// What the CRM stores about a failure. Whitelist only — never the password,
// the executed command or a stack (this lands in a DB row and on a card).
const HARD_AUTH_RE = /invalid credentials|username and password not accepted|application-specific password|log in via your web browser|not enabled for IMAP|IMAP access is disabled/i;
function errorSummary(e) {
  if (!e) return { kind: 'other', message: 'unknown error', code: null, serverResponseCode: null, responseText: null, authenticationFailed: false };
  const responseText = String(e.responseText || (typeof e.response === 'string' ? e.response : '') || '').slice(0, 300);
  let kind = 'other';
  if (e.serverResponseCode === 'AUTHENTICATIONFAILED' || HARD_AUTH_RE.test(responseText)) kind = 'auth';
  else if (e.authenticationFailed) kind = 'auth_soft';   // imapflow flags ANY NO/BAD to AUTHENTICATE, incl. Gmail's transient ones
  else if (e.code === 'ETIMEOUT' || e.code === 'GREETING_TIMEOUT' || (e.details && e.details.connectionTimeout)) kind = 'timeout';
  else if (e.code === 'NoConnection' || /^ClosedAfterConnect/.test(e.code || '')) kind = 'disconnect';
  else if (e.code === 'SEARCH_FAILED') kind = 'search';
  return {
    kind, message: String(e.message || e).slice(0, 300), code: e.code || null,
    serverResponseCode: e.serverResponseCode || null, responseText: responseText || null,
    authenticationFailed: !!e.authenticationFailed,
  };
}
function pushSyncError(action, key, e) {
  if (!report) return;
  if (report.sync_errors.length >= 20) { report.sync_errors_dropped++; return; }
  const status = Number.isFinite(e && e.status) ? e.status : 0;
  report.sync_errors.push({ action, key: String(key || ''), status, message: String((e && e.message) || e).slice(0, 200) });
  if (status >= 400 && status < 500) console.log(`::warning title=CRM rejected ${action} ${key}::HTTP ${status}`);
}

// Merge multiple parsed Amazon plate emails for the SAME order (confirmation +
// delivery, or the same order seen in two mailboxes). Keep the highest status
// and the largest unit count.
function mergePlatesByOrder(payloads) {
  const byOrder = new Map();
  for (const p of payloads) {
    const cur = byOrder.get(p.amazon_order_num);
    if (!cur) { byOrder.set(p.amazon_order_num, { ...p }); continue; }
    cur.units  = Math.max(cur.units, p.units);
    cur.plates = Math.max(cur.plates, p.plates);
    if ((STATUS_RANK[p.status] ?? 0) > (STATUS_RANK[cur.status] ?? 0)) cur.status = p.status;
    cur.order_url      = cur.order_url || p.order_url;
    cur.delivered_date = cur.delivered_date || p.delivered_date;
    if (p.order_date && (!cur.order_date || p.order_date < cur.order_date)) cur.order_date = p.order_date;
  }
  return [...byOrder.values()];
}

// Merge multiple parsed emails for the SAME order (e.g. a confirmation plus a
// later delivery email, or the same order forwarded twice). Keep the highest
// status, the largest seen quantities, and the first non-null url/date.
function mergeByOrder(payloads) {
  const byOrder = new Map();
  for (const p of payloads) {
    const cur = byOrder.get(p.walmart_order_num);
    if (!cur) { byOrder.set(p.walmart_order_num, { ...p }); continue; }
    cur.flat_qty        = Math.max(cur.flat_qty, p.flat_qty);
    cur.tilting_qty     = Math.max(cur.tilting_qty, p.tilting_qty);
    cur.full_motion_qty = Math.max(cur.full_motion_qty, p.full_motion_qty);
    if ((STATUS_RANK[p.status] ?? 0) > (STATUS_RANK[cur.status] ?? 0)) cur.status = p.status;
    cur.order_url      = cur.order_url || p.order_url;
    cur.delivered_date = cur.delivered_date || p.delivered_date;
    cur.estimated_delivery = cur.estimated_delivery || p.estimated_delivery;
    if (p.order_date && (!cur.order_date || p.order_date < cur.order_date)) cur.order_date = p.order_date;
  }
  return [...byOrder.values()];
}

// POST one order to a sync endpoint (bracket_sync or wire_plate_sync).
// Throws with `.status` on a non-2xx (0 / undefined for a network failure or
// the 30-s timeout) so the health report can tell a CRM rejection from an outage.
async function syncTo(action, payload) {
  const res = await fetch(`${VERCEL_URL}/api/migrate?action=${action}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(CRM_FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json)}`), { status: res.status });
  return json;
}
const syncOrder = (payload) => syncTo('bracket_sync', payload);

// Scan one mailbox, returning every parsed Walmart order AND Amazon plate order
// payload found: { walmart: [...], amazon: [...] }.
// Each criterion is run as its OWN small IMAP SEARCH and the UIDs are unioned.
// A single 8-way nested-OR search fails ("Command failed"/BAD) on some large
// mailboxes; per-term searches are simple and far more reliable, and a failure
// of one term still lets the others through.
const SEARCH_TERMS = [
  { from: 'walmart.com' }, { body: 'walmart' },
  { from: 'auto-confirm@amazon.com' }, { from: 'ship-confirm@amazon.com' }, { from: 'order-update@amazon.com' },
  { body: 'ANONION' }, { body: 'brush wall plate' }, { body: 'cable pass through' },
  // Google Business Profile review notifications.
  { from: 'businessprofile-noreply@google.com' }, { body: 'left a review for' },
  // Website contact-form leads (LandingSite).
  { from: 'landingsite.ai' }, { body: 'New customer message from' },
];

async function searchUids(client, since) {
  const all = new Set();
  let failed = 0, lastMsg = '';
  for (const term of SEARCH_TERMS) {
    try {
      const uids = await client.search({ since, ...term }, { uid: true });
      if (Array.isArray(uids)) for (const u of uids) all.add(u);
    } catch (e) {
      failed++; lastMsg = e.message;
      console.warn(`[bracket-sync] search ${JSON.stringify(term)} failed: ${e.message}`);
    }
  }
  // One failed term is noise; every term failing means the mailbox was not
  // really scanned and must be reported as such, not as "no candidates".
  if (failed === SEARCH_TERMS.length) throw Object.assign(new Error(`every IMAP SEARCH failed: ${lastMsg}`), { code: 'SEARCH_FAILED' });
  return { uids: [...all], failed_terms: failed };
}

// A real Amazon order-flow email, as opposed to a promo/marketing message.
const AMAZON_ORDER_SENDER_RE = /^(auto-confirm|ship-confirm|order-update)@amazon\.com$/i;

async function scanMailbox({ user, pass, idx }, todayISO) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
    // Don't let one slow/bad mailbox hang the whole run.
    socketTimeout: 60000, greetingTimeout: 15000, connectionTimeout: 15000,
  });
  // A dropped/timed-out socket emits an 'error' event; without a listener Node
  // crashes the whole process. Swallow it — per-mailbox failures are handled below.
  client.on('error', (e) => console.warn(`[bracket-sync] ${user} imap error: ${e.message}`));
  const walmart = [], amazon = [], reviews = [], leads = [];
  const t0 = Date.now();
  let stage = 'connect', candidates = 0, failedTerms = 0;
  const meta = () => ({ ms: Date.now() - t0, candidates, search_terms_failed: failedTerms });
  // connect() sits outside the try/finally below: shut the socket a failed
  // login leaves open, and tag the error with the stage it died in.
  try { await client.connect(); }
  catch (e) { try { client.close(); } catch (_) {} e.stage = 'connect'; throw e; }
  console.log(`[bracket-sync] Connected: ${user}`);
  try {
    stage = 'open';
    // Scan the INBOX only. (Scanning Gmail "All Mail" was tried to catch archived
    // order confirmations, but it surfaced unrelated Amazon emails — recommendation
    // / "buy it again" sections that mention the plate product — and the parser
    // false-matched them into phantom orders. INBOX + a reliable, frequent schedule
    // is the safe combination: a real order email is in the inbox long enough to be
    // caught before it's archived.)
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    // Targeted candidate search — keep the set SMALL so a busy business inbox
    // doesn't pull hundreds of messages every run:
    //   • Walmart: vendor sender OR "walmart" in the body (forwarded copies).
    //   • Amazon:  only the order-flow senders (auto-confirm / ship-confirm /
    //     order-update), NOT every email that mentions "amazon" (promos, etc.).
    //     Plus the distinctive plate product phrases, so a FORWARDED order whose
    //     From: isn't amazon.com is still caught. Each parser then requires a
    //     real order number (and, for Amazon, a product match) to qualify.
    stage = 'search';
    const found = await searchUids(client, since);
    const uids = found.uids;
    candidates = uids.length; failedTerms = found.failed_terms;
    if (!uids.length) { console.log(`[bracket-sync] ${user}: no candidate emails`); return { walmart, amazon, reviews, leads, meta: meta() }; }
    console.log(`[bracket-sync] ${user}: ${uids.length} candidate email(s)`);

    stage = 'fetch';
    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      let parsed;
      try { parsed = await simpleParser(msg.source); }
      catch (e) { console.warn(`[bracket-sync] parse fail uid=${msg.uid}: ${e.message}`); continue; }
      const email = { subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', todayISO };
      const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address || '').toLowerCase();

      // Google Business Profile review notification. `mailbox` matters: for
      // every listing but the two Houston ones it is what identifies WHICH
      // listing the review was left on (migration 0108).
      const review = parseGoogleReviewEmail({ ...email, emailDateISO: parsed.date ? new Date(parsed.date).toISOString() : undefined, mailbox: user });
      if (review) {
        console.log(`[bracket-sync] ${user}: google review ${review.business} ${review.rating}★ by ${review.reviewer_name} → ${review.location_key || 'UNATTRIBUTED'}`);
        reviews.push(review);
      }

      // Walmart: one email can bundle several orders (a forwarded "conversation").
      for (const payload of parseWalmartEmails(email)) {
        console.log(
          `[bracket-sync] ${user}: walmart order=${payload.walmart_order_num} status=${payload.status} ` +
          `flat=${payload.flat_qty} tilt=${payload.tilting_qty} fm=${payload.full_motion_qty}`
        );
        walmart.push(payload);
      }
      // Amazon: strict everywhere — order # + product-phrase match — EXCEPT in
      // the dedicated plate-ordering mailbox, where a real Amazon order-flow
      // sender is trusted even if the email only shows the generic category
      // (Amazon doesn't always print the product title in "Ordered:" emails).
      const trustSender = idx === PLATE_DEDICATED_MAILBOX_IDX && AMAZON_ORDER_SENDER_RE.test(fromAddr);
      const plate = parseAmazonPlateEmail({ ...email, trustSender });
      if (plate) {
        console.log(
          `[bracket-sync] ${user}: amazon order=${plate.amazon_order_num} status=${plate.status} ` +
          `units=${plate.units} plates=${plate.plates}${trustSender && !PLATE_MATCH.test(email.subject + '\n' + email.text) ? ' (trusted sender — no product phrase in email)' : ''}`
        );
        amazon.push(plate);
      }
      // Website contact-form lead. Keyed on the email's Message-ID so a re-scan
      // of the same message never creates a second estimate.
      const lead = parseWebsiteLeadEmail({
        from: fromAddr, subject: email.subject, text: email.text, html: email.html,
        messageId: parsed.messageId || '',
        receivedISO: parsed.date ? new Date(parsed.date).toISOString() : '',
      });
      if (lead) {
        console.log(`[bracket-sync] ${user}: website lead from ${lead.name} <${lead.email || lead.phone}>`);
        leads.push(lead);
      }
    }
    stage = 'done';
  } catch (e) {
    e.stage = e.stage || stage;
    throw e;
  } finally {
    // Close cleanly; if logout hangs/fails (e.g. after a failed command), force
    // the socket shut so it can't linger and fire a fatal timeout later.
    await client.logout().catch(() => { try { client.close(); } catch (_) {} });
  }
  return { walmart, amazon, reviews, leads, meta: meta() };
}

async function main() {
  report = newReport();
  if (!CRON_SECRET) { console.error('[bracket-sync] Missing CRON_SECRET'); process.exit(1); }

  // One-off maintenance: delete specific Amazon plate orders (e.g. phantom rows
  // a bad scan created). Triggered by setting PURGE_ORDERS to a comma-separated
  // list of Amazon order numbers. Runs the purge and exits — no email scan, and
  // no health report (a maintenance dispatch must not count as a completed scan).
  if (process.env.PURGE_ORDERS && process.env.PURGE_ORDERS.trim()) {
    report.skipped = 'maintenance';
    const order_nums = process.env.PURGE_ORDERS.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[bracket-sync] PURGE_ORDERS set — deleting ${order_nums.length} plate order(s): ${order_nums.join(', ')}`);
    try {
      const r = await syncTo('wire_plate_purge', { order_nums });
      console.log(`[bracket-sync] purge result: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error(`[bracket-sync] purge failed — ${e.message}`);
      throw e;
    }
    return;
  }

  // One-off maintenance: add/re-tier a service-area zip. Triggered by setting
  // ADD_ZIP to "zip,area,surcharge,payout" (e.g. "80027,Denver,65,50"). Runs the
  // seed and exits — no email scan.
  if (process.env.ADD_ZIP && process.env.ADD_ZIP.trim()) {
    report.skipped = 'maintenance';
    const [zip, area, surcharge, payout] = process.env.ADD_ZIP.split(',').map(s => s.trim());
    console.log(`[bracket-sync] ADD_ZIP set — seeding ${zip} into ${area} (${surcharge}/${payout})`);
    try {
      const r = await syncTo('seed_zip', { zip, area, surcharge: Number(surcharge) || 0, payout: Number(payout) || 0 });
      console.log(`[bracket-sync] seed_zip result: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error(`[bracket-sync] seed_zip failed — ${e.message}`);
      throw e;
    }
    return;
  }

  const { boxes, misconfigured } = mailboxes();
  report.misconfigured = misconfigured;
  if (misconfigured.length) console.log(`[bracket-sync] misconfigured mailbox slot(s): ${misconfigured.map(x => `${x.idx} (${x.missing})`).join(', ')}`);
  if (!boxes.length) {
    console.error('[bracket-sync] No mailbox configured (set GMAIL_USER + GMAIL_APP_PASSWORD)');
    report.totals = { mailboxes_configured: 0, mailboxes_ok: 0 };
    return;
  }

  const todayISO = new Date().toISOString().slice(0, 10);

  // Gather from every configured mailbox. A failed inbox goes into the health
  // report (finish() posts it; the CRM texts the owner) and the scan carries on
  // with the rest — it does NOT fail the run. See the workflow header for why.
  let allWalmart = [], allAmazon = [], allReviews = [], allLeads = [];
  for (const box of boxes) {
    const role = MAILBOX_ROLE[box.idx] || '';
    const t0 = Date.now();
    try {
      const { walmart, amazon, reviews, leads, meta } = await scanMailbox(box, todayISO);
      allWalmart = allWalmart.concat(walmart);
      allAmazon = allAmazon.concat(amazon);
      allReviews = allReviews.concat(reviews || []);
      allLeads = allLeads.concat(leads || []);
      report.mailboxes.push({
        idx: box.idx, user: box.user, role, ok: true, stage: 'done',
        ms: meta.ms, candidates: meta.candidates, search_terms_failed: meta.search_terms_failed,
        parsed: { walmart: walmart.length, amazon: amazon.length, reviews: reviews.length, leads: leads.length },
      });
    } catch (e) {
      // Surface Gmail's actual reason so a connect/login failure is diagnosable
      // (auth vs IMAP-disabled vs something else) instead of a bare "Command failed".
      const err = errorSummary(e);
      const detail = [
        e.authenticationFailed ? 'AUTH_FAILED' : null,
        e.serverResponseCode ? `code=${e.serverResponseCode}` : null,
        e.responseText || e.response || null,
      ].filter(Boolean).join(' | ');
      console.error(`[bracket-sync] mailbox ${box.user} failed: ${e.message}${detail ? ' | ' + detail : ''}`);
      console.log(`::warning title=Bracket sync mailbox ${box.idx}::${box.user} failed at ${e.stage || 'connect'}: ${err.kind} ${err.message}`);
      report.mailboxes.push({ idx: box.idx, user: box.user, role, ok: false, stage: e.stage || 'connect', ms: Date.now() - t0, error: err });
    }
  }

  // ── Walmart brackets ──
  const orders = mergeByOrder(allWalmart);
  if (!orders.length) { console.log('[bracket-sync] No Walmart orders found.'); }
  else console.log(`[bracket-sync] ${orders.length} distinct Walmart order(s) to sync`);
  let synced = 0, skippedNoQty = 0;
  for (const order of orders) {
    // A brand-new order with no parsed quantities can't be created — skip it
    // (a later confirmation email with quantities will create it).
    const qty = order.flat_qty + order.tilting_qty + order.full_motion_qty;
    if (qty === 0 && order.status === 'in_route') {
      console.log(`[bracket-sync] ${order.walmart_order_num}: no quantities, skipping`);
      skippedNoQty++;
      continue;
    }
    try {
      const r = await syncOrder(order);
      console.log(`[bracket-sync] ${order.walmart_order_num}: ${JSON.stringify(r.results)}`);
      synced++;
    } catch (e) {
      console.error(`[bracket-sync] ${order.walmart_order_num}: sync failed — ${e.message}`);
      pushSyncError('bracket_sync', order.walmart_order_num, e);
    }
  }

  // ── Amazon wire concealment plates ──
  const plateOrders = mergePlatesByOrder(allAmazon);
  if (!plateOrders.length) { console.log('[bracket-sync] No Amazon plate orders found.'); }
  else console.log(`[bracket-sync] ${plateOrders.length} distinct Amazon plate order(s) to sync`);
  let platesSynced = 0, platesSkipped = 0;
  for (const order of plateOrders) {
    if (order.plates <= 0 && order.status === 'in_route') {
      console.log(`[bracket-sync] ${order.amazon_order_num}: no plate qty, skipping`);
      platesSkipped++;
      continue;
    }
    try {
      const r = await syncTo('wire_plate_sync', order);
      console.log(`[bracket-sync] ${order.amazon_order_num}: ${JSON.stringify(r.results)}`);
      platesSynced++;
    } catch (e) {
      console.error(`[bracket-sync] ${order.amazon_order_num}: plate sync failed — ${e.message}`);
      pushSyncError('wire_plate_sync', order.amazon_order_num, e);
    }
  }

  // ── Website contact-form leads ── dedupe by Message-ID (one email can match
  // more than one search term, and mailboxes can overlap).
  const leadByKey = new Map();
  for (const l of allLeads) {
    const k = l.external_key || `${l.email || ''}|${l.phone || ''}|${l.message.slice(0, 60)}`;
    if (!leadByKey.has(k)) leadByKey.set(k, l);
  }
  const leadList = [...leadByKey.values()];
  if (!leadList.length) { console.log('[bracket-sync] No website leads found.'); }
  else console.log(`[bracket-sync] ${leadList.length} website lead(s) to sync`);
  let leadsSynced = 0;
  for (const lead of leadList) {
    try {
      const r = await syncTo('website_lead_sync', lead);
      console.log(`[bracket-sync] website lead ${lead.name}: ${r.action || 'ok'}`);
      if (r.action === 'created') leadsSynced++;
    } catch (e) {
      console.error(`[bracket-sync] website lead sync failed — ${e.message}`);
      pushSyncError('website_lead_sync', lead.external_key || lead.email || lead.phone, e);
    }
  }

  // ── Google reviews ── dedupe by key (the same email can match two search terms).
  const reviewByKey = new Map();
  for (const r of allReviews) if (r && r.google_key && !reviewByKey.has(r.google_key)) reviewByKey.set(r.google_key, r);
  const reviewList = [...reviewByKey.values()];
  if (!reviewList.length) { console.log('[bracket-sync] No Google reviews found.'); }
  else console.log(`[bracket-sync] ${reviewList.length} Google review(s) to sync`);
  let reviewsSynced = 0;
  for (const rev of reviewList) {
    try {
      const r = await syncTo('google_review_sync', rev);
      console.log(`[bracket-sync] google review ${rev.reviewer_name} (${rev.rating}★): ${r.action || 'ok'}`);
      reviewsSynced++;
    } catch (e) {
      console.error(`[bracket-sync] google review sync failed — ${e.message}`);
      pushSyncError('google_review_sync', rev.google_key, e);
    }
  }

  report.totals = {
    mailboxes_configured: boxes.length,
    mailboxes_ok: report.mailboxes.filter(m => m.ok).length,
    walmart: { distinct: orders.length, synced, failed: orders.length - synced - skippedNoQty, skipped_no_qty: skippedNoQty },
    plates: { distinct: plateOrders.length, synced: platesSynced, failed: plateOrders.length - platesSynced - platesSkipped, skipped_no_qty: platesSkipped },
    leads: { distinct: leadList.length, created: leadsSynced },
    reviews: { distinct: reviewList.length, synced: reviewsSynced, failed: reviewList.length - reviewsSynced },
  };
  console.log(`[bracket-sync] Done — ${synced}/${orders.length} bracket order(s), ${platesSynced}/${plateOrders.length} plate order(s), ${reviewsSynced}/${reviewList.length} review(s), ${leadsSynced}/${leadList.length} website lead(s) synced`);
}

// ── Health report + exit policy ─────────────────────────────────────────────
// Every run — success, partial, or crash — posts ONE report to the CRM, which
// stamps it with its own clock, tracks per-inbox failure streaks, texts the
// owner and drives the dashboard card (api/_lib/bracket-sync-health.js).
// Exit 1 ONLY when that report could not be delivered after a retry: the single
// case where nobody can have been alerted. A dead mailbox is exit 0 on purpose.
async function postHealth(payload) {
  try { return await syncTo('bracket_sync_health', payload); }
  catch (e1) {   // a stalled TLS handshake is not "the CRM could not alert"
    await new Promise(r => setTimeout(r, 5000));
    return syncTo('bracket_sync_health', payload);
  }
}

function writeStepSummary(r) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const rows = r.mailboxes.map(m => `| ${m.idx} | ${esc(m.user)} | ${m.ok ? 'ok' : 'FAILED'} | ${esc(m.stage)} | ${m.ok ? '' : esc(m.error && m.error.kind)} | ${m.ok ? '' : esc(m.error && (m.error.responseText || m.error.message))} | ${m.ok ? m.candidates : ''} | ${m.ok ? (m.parsed && m.parsed.walmart) : ''} |`);
  const mis = r.misconfigured.length ? `\nMisconfigured slots: ${r.misconfigured.map(x => `${x.idx} (${x.missing})`).join(', ')}\n` : '';
  const errs = r.sync_errors.length
    ? `\nSync errors (${r.sync_errors.length}${r.sync_errors_dropped ? ` +${r.sync_errors_dropped} more` : ''}):\n${r.sync_errors.map(e => `- ${e.action} ${e.key}: HTTP ${e.status} ${esc(e.message)}`).join('\n')}\n`
    : '';
  const md = `## Email sync — ${r.run.trigger}\n\n| # | mailbox | status | stage | kind | message | candidates | walmart |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n${mis}${errs}\nTotals: \`${JSON.stringify(r.totals)}\`${r.fatal ? `\n\n**Fatal:** ${esc(r.fatal.message)}` : ''}\n`;
  try { fs.appendFileSync(file, md); } catch (_) {}
}

async function finish(fatalErr) {
  report ||= newReport();
  if (fatalErr) { report.fatal = errorSummary(fatalErr); console.error('[bracket-sync] Fatal:', fatalErr); }
  if (report.skipped) process.exit(fatalErr ? 1 : 0);   // maintenance dispatch: nothing to report
  report.run.finished_at = new Date().toISOString();
  report.run.duration_ms = Date.parse(report.run.finished_at) - Date.parse(report.run.started_at);
  let healthOk = false;
  try {
    const r = await postHealth(report);
    healthOk = true;
    console.log('[bracket-sync] health report accepted:', JSON.stringify({ problems: r.problems, alerted: r.alerted, recovered: r.recovered, sms: r.sms }));
  } catch (e) {
    console.log(`::error title=Bracket sync health report::POST failed (${e.status || 'network'}) - the CRM could NOT alert the owner for this run: ${e.message}`);
  }
  if (report.mailboxes.length && report.mailboxes.every(m => !m.ok)) console.log('::error title=Bracket sync::ALL mailboxes failed this run');
  writeStepSummary(report);
  // Exit explicitly: a lingering IMAP socket would otherwise keep the process
  // alive until its timeout fires an unhandled 'error' after the work is done.
  process.exit(healthOk ? 0 : 1);
}

main().then(() => finish(null)).catch(e => finish(e));
