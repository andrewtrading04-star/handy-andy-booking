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
async function scanMailbox({ user, pass }, todayISO) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
  });
  const walmart = [], amazon = [];
  await client.connect();
  console.log(`[bracket-sync] Connected: ${user}`);
  try {
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    // Walmart OR Amazon order emails, direct OR forwarded. Direct ones are from
    // the vendor; forwarded ones quote the vendor name in the body. Each parser
    // then requires a real order number (and, for Amazon, a product match) so
    // unrelated emails are filtered out.
    let uids = await client.search(
      { since, or: [ { from: 'walmart.com' }, { body: 'walmart' }, { from: 'amazon.com' }, { body: 'amazon' } ] },
      { uid: true }
    );
    if (!Array.isArray(uids)) uids = [];
    if (!uids.length) { console.log(`[bracket-sync] ${user}: no candidate emails`); return { walmart, amazon }; }
    console.log(`[bracket-sync] ${user}: ${uids.length} candidate email(s)`);

    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      let parsed;
      try { parsed = await simpleParser(msg.source); }
      catch (e) { console.warn(`[bracket-sync] parse fail uid=${msg.uid}: ${e.message}`); continue; }
      const email = { subject: parsed.subject || '', text: parsed.text || '', html: parsed.html || '', todayISO };

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
    await client.logout().catch(() => {});
  }
  return { walmart, amazon };
}

async function main() {
  if (!CRON_SECRET) { console.error('[bracket-sync] Missing CRON_SECRET'); process.exit(1); }
  const boxes = mailboxes();
  if (!boxes.length) { console.error('[bracket-sync] No mailbox configured (set GMAIL_USER + GMAIL_APP_PASSWORD)'); process.exit(1); }

  const todayISO = new Date().toISOString().slice(0, 10);

  // Gather from every configured mailbox.
  let allWalmart = [], allAmazon = [];
  for (const box of boxes) {
    try {
      const { walmart, amazon } = await scanMailbox(box, todayISO);
      allWalmart = allWalmart.concat(walmart);
      allAmazon = allAmazon.concat(amazon);
    } catch (e) { console.error(`[bracket-sync] mailbox ${box.user} failed: ${e.message}`); }
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

  console.log(`[bracket-sync] Done — ${synced}/${orders.length} bracket order(s), ${platesSynced}/${plateOrders.length} plate order(s) synced`);
}

main().catch(e => { console.error('[bracket-sync] Fatal:', e); process.exit(1); });
