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
// ============================================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseWalmartEmails } from './lib/walmart-parse.mjs';
import { parseAmazonPlateEmail } from './lib/amazon-parse.mjs';
import { parseGoogleReviewEmail } from './lib/google-review-parse.mjs';

const CRON_SECRET = process.env.CRON_SECRET || '';
const VERCEL_URL  = (process.env.VERCEL_URL || 'https://handy-andy-booking.vercel.app').replace(/\/$/, '');
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS) || 45;

const STATUS_RANK = { in_route: 0, ordered: 0, delivered: 1, canceled: 2 };

// Mailboxes to scan: primary + optional secondary.
function mailboxes() {
  const list = [];
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
    list.push({ user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD });
  if (process.env.GMAIL_USER_2 && process.env.GMAIL_APP_PASSWORD_2)
    list.push({ user: process.env.GMAIL_USER_2, pass: process.env.GMAIL_APP_PASSWORD_2 });
  // Third mailbox (e.g. houstonhandyandy@gmail.com — where the Amazon wire-plate
  // orders arrive). Scanned for both Walmart and Amazon emails like the others.
  if (process.env.GMAIL_USER_3 && process.env.GMAIL_APP_PASSWORD_3)
    list.push({ user: process.env.GMAIL_USER_3, pass: process.env.GMAIL_APP_PASSWORD_3 });
  return list;
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
    if (p.order_date && (!cur.order_date || p.order_date < cur.order_date)) cur.order_date = p.order_date;
  }
  return [...byOrder.values()];
}

// POST one order to a sync endpoint (bracket_sync or wire_plate_sync).
async function syncTo(action, payload) {
  const res = await fetch(`${VERCEL_URL}/api/migrate?action=${action}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
    body:    JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
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
];

async function searchUids(client, since) {
  const all = new Set();
  for (const term of SEARCH_TERMS) {
    try {
      const uids = await client.search({ since, ...term }, { uid: true });
      if (Array.isArray(uids)) for (const u of uids) all.add(u);
    } catch (e) {
      console.warn(`[bracket-sync] search ${JSON.stringify(term)} failed: ${e.message}`);
    }
  }
  return [...all];
}

async function scanMailbox({ user, pass }, todayISO) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
    // Don't let one slow/bad mailbox hang the whole run.
    socketTimeout: 60000, greetingTimeout: 15000, connectionTimeout: 15000,
  });
  // A dropped/timed-out socket emits an 'error' event; without a listener Node
  // crashes the whole process. Swallow it — per-mailbox failures are handled below.
  client.on('error', (e) => console.warn(`[bracket-sync] ${user} imap error: ${e.message}`));
  const walmart = [], amazon = [], reviews = [];
  await client.connect();
  console.log(`[bracket-sync] Connected: ${user}`);
  try {
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
    let uids = await searchUids(client, since);
    if (!uids.length) { console.log(`[bracket-sync] ${user}: no candidate emails`); return { walmart, amazon, reviews }; }
    console.log(`[bracket-sync] ${user}: ${uids.length} candidate email(s)`);

    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      let parsed;
      try { parsed = await simpleParser(msg.source); }
      catch (e) { console.warn(`[bracket-sync] parse fail uid=${msg.uid}: ${e.message}`); continue; }
      const email = { subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', todayISO };

      // Google Business Profile review notification.
      const review = parseGoogleReviewEmail({ ...email, emailDateISO: parsed.date ? new Date(parsed.date).toISOString() : undefined });
      if (review) {
        console.log(`[bracket-sync] ${user}: google review ${review.business} ${review.rating}★ by ${review.reviewer_name}`);
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
      // Amazon: strict — only fires on a real plate order (order # + product match).
      const plate = parseAmazonPlateEmail(email);
      if (plate) {
        console.log(
          `[bracket-sync] ${user}: amazon order=${plate.amazon_order_num} status=${plate.status} ` +
          `units=${plate.units} plates=${plate.plates}`
        );
        amazon.push(plate);
      }
    }
  } finally {
    // Close cleanly; if logout hangs/fails (e.g. after a failed command), force
    // the socket shut so it can't linger and fire a fatal timeout later.
    await client.logout().catch(() => { try { client.close(); } catch (_) {} });
  }
  return { walmart, amazon, reviews };
}

async function main() {
  if (!CRON_SECRET) { console.error('[bracket-sync] Missing CRON_SECRET'); process.exit(1); }

  // One-off maintenance: delete specific Amazon plate orders (e.g. phantom rows
  // a bad scan created). Triggered by setting PURGE_ORDERS to a comma-separated
  // list of Amazon order numbers. Runs the purge and exits — no email scan.
  if (process.env.PURGE_ORDERS && process.env.PURGE_ORDERS.trim()) {
    const order_nums = process.env.PURGE_ORDERS.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`[bracket-sync] PURGE_ORDERS set — deleting ${order_nums.length} plate order(s): ${order_nums.join(', ')}`);
    try {
      const r = await syncTo('wire_plate_purge', { order_nums });
      console.log(`[bracket-sync] purge result: ${JSON.stringify(r)}`);
    } catch (e) {
      console.error(`[bracket-sync] purge failed — ${e.message}`);
      process.exit(1);
    }
    return;
  }

  const boxes = mailboxes();
  if (!boxes.length) { console.error('[bracket-sync] No mailbox configured (set GMAIL_USER + GMAIL_APP_PASSWORD)'); process.exit(1); }

  const todayISO = new Date().toISOString().slice(0, 10);

  // Gather from every configured mailbox.
  let allWalmart = [], allAmazon = [], allReviews = [];
  for (const box of boxes) {
    try {
      const { walmart, amazon, reviews } = await scanMailbox(box, todayISO);
      allWalmart = allWalmart.concat(walmart);
      allAmazon = allAmazon.concat(amazon);
      allReviews = allReviews.concat(reviews || []);
    } catch (e) {
      // Surface Gmail's actual reason so a connect/login failure is diagnosable
      // (auth vs IMAP-disabled vs something else) instead of a bare "Command failed".
      const detail = [
        e.authenticationFailed ? 'AUTH_FAILED' : null,
        e.serverResponseCode ? `code=${e.serverResponseCode}` : null,
        e.responseText || e.response || null,
      ].filter(Boolean).join(' | ');
      console.error(`[bracket-sync] mailbox ${box.user} failed: ${e.message}${detail ? ' | ' + detail : ''}`);
    }
  }

  // ── Walmart brackets ──
  const orders = mergeByOrder(allWalmart);
  if (!orders.length) { console.log('[bracket-sync] No Walmart orders found.'); }
  else console.log(`[bracket-sync] ${orders.length} distinct Walmart order(s) to sync`);
  let synced = 0;
  for (const order of orders) {
    // A brand-new order with no parsed quantities can't be created — skip it
    // (a later confirmation email with quantities will create it).
    const qty = order.flat_qty + order.tilting_qty + order.full_motion_qty;
    if (qty === 0 && order.status === 'in_route') {
      console.log(`[bracket-sync] ${order.walmart_order_num}: no quantities, skipping`);
      continue;
    }
    try {
      const r = await syncOrder(order);
      console.log(`[bracket-sync] ${order.walmart_order_num}: ${JSON.stringify(r.results)}`);
      synced++;
    } catch (e) {
      console.error(`[bracket-sync] ${order.walmart_order_num}: sync failed — ${e.message}`);
    }
  }

  // ── Amazon wire concealment plates ──
  const plateOrders = mergePlatesByOrder(allAmazon);
  if (!plateOrders.length) { console.log('[bracket-sync] No Amazon plate orders found.'); }
  else console.log(`[bracket-sync] ${plateOrders.length} distinct Amazon plate order(s) to sync`);
  let platesSynced = 0;
  for (const order of plateOrders) {
    if (order.plates <= 0 && order.status === 'in_route') {
      console.log(`[bracket-sync] ${order.amazon_order_num}: no plate qty, skipping`);
      continue;
    }
    try {
      const r = await syncTo('wire_plate_sync', order);
      console.log(`[bracket-sync] ${order.amazon_order_num}: ${JSON.stringify(r.results)}`);
      platesSynced++;
    } catch (e) {
      console.error(`[bracket-sync] ${order.amazon_order_num}: plate sync failed — ${e.message}`);
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
    }
  }

  console.log(`[bracket-sync] Done — ${synced}/${orders.length} bracket order(s), ${platesSynced}/${plateOrders.length} plate order(s), ${reviewsSynced}/${reviewList.length} review(s) synced`);
}

// Force exit once the work is done. A lingering IMAP socket (e.g. one left open
// by a mailbox whose command failed) would otherwise keep the process alive
// until its timeout fires an unhandled 'error' and crashes with exit 1 — after
// the sync already succeeded. Exiting explicitly makes the run's success final.
main()
  .then(() => process.exit(0))
  .catch(e => { console.error('[bracket-sync] Fatal:', e); process.exit(1); });
