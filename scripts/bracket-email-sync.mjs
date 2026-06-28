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
  return list;
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

// POST one order to the bracket-sync endpoint.
async function syncOrder(payload) {
  const res = await fetch(`${VERCEL_URL}/api/migrate?action=bracket_sync`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
    body:    JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

// Scan one mailbox, returning every parsed Walmart order payload found.
async function scanMailbox({ user, pass }, todayISO) {
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
  });
  const found = [];
  await client.connect();
  console.log(`[bracket-sync] Connected: ${user}`);
  try {
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    // Walmart order emails, direct OR forwarded. Direct ones are from
    // walmart.com; forwarded ones quote "...walmart.com" in the body. The
    // parser then requires a real Walmart order number, filtering any noise.
    let uids = await client.search(
      { since, or: [ { from: 'walmart.com' }, { body: 'walmart' } ] },
      { uid: true }
    );
    if (!Array.isArray(uids)) uids = [];
    if (!uids.length) { console.log(`[bracket-sync] ${user}: no candidate emails`); return found; }
    console.log(`[bracket-sync] ${user}: ${uids.length} candidate email(s)`);

    for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
      let parsed;
      try { parsed = await simpleParser(msg.source); }
      catch (e) { console.warn(`[bracket-sync] parse fail uid=${msg.uid}: ${e.message}`); continue; }
      // One email can bundle several orders (a forwarded "conversation").
      const orders = parseWalmartEmails({
        subject: parsed.subject || '',
        text:    parsed.text || '',
        html:    parsed.html || '',
        todayISO,
      });
      for (const payload of orders) {
        console.log(
          `[bracket-sync] ${user}: order=${payload.walmart_order_num} status=${payload.status} ` +
          `flat=${payload.flat_qty} tilt=${payload.tilting_qty} fm=${payload.full_motion_qty}`
        );
        found.push(payload);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return found;
}

async function main() {
  if (!CRON_SECRET) { console.error('[bracket-sync] Missing CRON_SECRET'); process.exit(1); }
  const boxes = mailboxes();
  if (!boxes.length) { console.error('[bracket-sync] No mailbox configured (set GMAIL_USER + GMAIL_APP_PASSWORD)'); process.exit(1); }

  const todayISO = new Date().toISOString().slice(0, 10);

  // Gather from every configured mailbox.
  let all = [];
  for (const box of boxes) {
    try { all = all.concat(await scanMailbox(box, todayISO)); }
    catch (e) { console.error(`[bracket-sync] mailbox ${box.user} failed: ${e.message}`); }
  }

  const orders = mergeByOrder(all);
  if (!orders.length) { console.log('[bracket-sync] No Walmart orders found — nothing to sync.'); return; }
  console.log(`[bracket-sync] ${orders.length} distinct order(s) to sync`);

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
  console.log(`[bracket-sync] Done — ${synced}/${orders.length} order(s) synced`);
}

main().catch(e => { console.error('[bracket-sync] Fatal:', e); process.exit(1); });
