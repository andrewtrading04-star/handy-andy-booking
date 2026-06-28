#!/usr/bin/env node
// ============================================================================
// scripts/bracket-email-sync.mjs  —  Walmart order email → bracket inventory
// ============================================================================
// Reads unread Walmart order emails from Gmail (via IMAP + App Password),
// parses bracket type/quantity/status, and pushes each order to the HAD CRM
// via POST /api/migrate?action=bracket_sync.
//
// After processing, each email is marked SEEN so it won't be re-processed.
//
// Env vars (set as GitHub Actions secrets):
//   GMAIL_USER          andrewtrading04@gmail.com
//   GMAIL_APP_PASSWORD  16-character Google App Password (not your real password)
//   CRON_SECRET         same value as the Vercel CRON_SECRET env var
//   VERCEL_URL          optional override (default: https://handy-andy-booking.vercel.app)
// ============================================================================

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const GMAIL_USER     = process.env.GMAIL_USER        || '';
const GMAIL_PASS     = process.env.GMAIL_APP_PASSWORD || '';
const CRON_SECRET    = process.env.CRON_SECRET        || '';
const VERCEL_URL     = (process.env.VERCEL_URL || 'https://handy-andy-booking.vercel.app').replace(/\/$/, '');

if (!GMAIL_USER || !GMAIL_PASS || !CRON_SECRET) {
  console.error('[bracket-sync] Missing required env: GMAIL_USER, GMAIL_APP_PASSWORD, CRON_SECRET');
  process.exit(1);
}

// ── HTML → plain text ──────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Status from subject line ───────────────────────────────────────────────
function detectStatus(subject, bodyText) {
  const s = (subject + ' ' + bodyText).toLowerCase();
  if (/cancel/i.test(subject))                                  return 'canceled';
  if (/delivered|has been delivered|was delivered/i.test(s))    return 'delivered';
  return 'ordered';   // placed / confirmed / shipped all stay 'ordered' until delivered
}

// ── Extract Walmart order number ───────────────────────────────────────────
// Walmart format: 7 digits, dash, 8 digits  (e.g. 2000147-84714253)
function extractOrderNum(text) {
  const m = text.match(/\b(\d{7}-\d{8})\b/);
  return m ? m[1] : null;
}

// ── Extract bracket quantities from email text ─────────────────────────────
// Strategy:
//   1. Try paragraph blocks (blank-line separated) — look for bracket type +
//      quantity in the same block.
//   2. Scan line-by-line with a lookahead for a "Qty: N" on the next line.
// Both passes accumulate and their results are merged.
function extractBrackets(text) {
  let flat = 0, tilting = 0, fullMotion = 0;

  function qtySuffix(block) {
    const m = block.match(/(?:qty|quantity)[:\s]*(\d+)/i)
           || block.match(/[×x]\s*(\d+)/i)
           || block.match(/(\d+)\s*(?:unit|pack|piece|pcs)/i);
    return m ? parseInt(m[1], 10) : 1;
  }

  // Pass 1 — paragraph blocks
  for (const block of text.split(/\n{2,}/)) {
    const lower = block.toLowerCase();
    const qty   = qtySuffix(block);
    if (/full[\s\-]?motion/i.test(block))                              fullMotion += qty;
    else if (/tilting/i.test(block))                                   tilting    += qty;
    else if (/\bflat\b/i.test(block) && /mount|bracket|tv/i.test(block)) flat     += qty;
  }

  // Pass 2 — line by line (catches "Item\nQty: 2" layout)
  if (flat + tilting + fullMotion === 0) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line  = lines[i];
      const ahead = (lines[i + 1] || '') + ' ' + (lines[i + 2] || '');
      const qty   = qtySuffix(ahead) || 1;
      if (/full[\s\-]?motion/i.test(line))                               fullMotion += qty;
      else if (/tilting/i.test(line))                                    tilting    += qty;
      else if (/\bflat\b/i.test(line) && /mount|bracket|tv/i.test(line)) flat       += qty;
    }
  }

  return { flat, tilting, fullMotion };
}

// ── Extract order/tracking URL from HTML ───────────────────────────────────
function extractOrderUrl(html) {
  if (!html) return null;
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]);
  return (
    hrefs.find(u => /walmart\.com\/orders/i.test(u))  ||
    hrefs.find(u => /w-mt\.co/i.test(u))              ||
    hrefs.find(u => /track/i.test(u) && /walmart/i.test(u)) ||
    null
  );
}

// ── Parse a mailparser message into a bracket order payload ───────────────
function parseEmail(msg) {
  const subject  = msg.subject || '';
  const html     = msg.html    || '';
  const text     = msg.text    || stripHtml(html);
  const fullText = subject + '\n' + text;

  const walmart_order_num = extractOrderNum(fullText);
  if (!walmart_order_num) return null;   // not an order email we can identify

  const status   = detectStatus(subject, text);
  const { flat, tilting, fullMotion } = extractBrackets(text);
  const order_url = extractOrderUrl(html);

  // Try to parse an order date from the email body
  let order_date = new Date().toISOString().slice(0, 10);
  const dm = text.match(/(?:order(?:ed)?|placed)[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (dm) {
    try {
      const d = new Date(dm[1]);
      if (!isNaN(d.getTime())) order_date = d.toISOString().slice(0, 10);
    } catch { /* keep today */ }
  }

  const delivered_date = (status === 'delivered') ? new Date().toISOString().slice(0, 10) : null;

  return {
    walmart_order_num,
    flat_qty:       flat,
    tilting_qty:    tilting,
    full_motion_qty: fullMotion,
    status,
    order_date,
    delivered_date,
    order_url,
  };
}

// ── POST to Vercel bracket-sync endpoint ───────────────────────────────────
async function syncOrder(payload) {
  const url = `${VERCEL_URL}/api/migrate?action=bracket_sync`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const client = new ImapFlow({
    host:   'imap.gmail.com',
    port:   993,
    secure: true,
    auth:   { user: GMAIL_USER, pass: GMAIL_PASS },
    logger: false,   // silence verbose IMAP logs
  });

  await client.connect();
  console.log('[bracket-sync] Connected to Gmail IMAP');

  await client.mailboxOpen('INBOX');

  // Search for UNSEEN emails FROM walmart.com (any subdomain — substring match).
  // The 30-day window catches anything that arrived while the action was paused.
  // { uid: true } makes search + fetch + flag all operate on stable UIDs.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  let uids = await client.search({ from: 'walmart.com', seen: false, since }, { uid: true });
  if (!Array.isArray(uids)) uids = [];

  if (!uids.length) {
    console.log('[bracket-sync] No new Walmart emails — nothing to do.');
    await client.logout();
    return;
  }

  console.log(`[bracket-sync] Found ${uids.length} unread Walmart email(s)`);

  let synced = 0;
  const toMark = [];

  for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
    let parsed;
    try {
      parsed = await simpleParser(msg.source);
    } catch (e) {
      console.warn(`[bracket-sync] Could not parse email uid=${msg.uid}:`, e.message);
      toMark.push(msg.uid);
      continue;
    }

    const payload = parseEmail(parsed);

    if (!payload) {
      console.log(`[bracket-sync] uid=${msg.uid} — no order number found, skipping`);
      toMark.push(msg.uid);
      continue;
    }

    const totalQty = payload.flat_qty + payload.tilting_qty + payload.full_motion_qty;
    console.log(
      `[bracket-sync] uid=${msg.uid} order=${payload.walmart_order_num}` +
      ` status=${payload.status}` +
      ` flat=${payload.flat_qty} tilt=${payload.tilting_qty} fm=${payload.full_motion_qty}`
    );

    // Skip if no quantities AND status isn't a status-upgrade (delivery email
    // for an order we don't know about yet — can't create without quantities).
    if (totalQty === 0 && payload.status === 'ordered') {
      console.log(`[bracket-sync] Skipping — no bracket quantities detected`);
      toMark.push(msg.uid);
      continue;
    }

    try {
      const result = await syncOrder(payload);
      console.log(`[bracket-sync] Synced — ${JSON.stringify(result.results)}`);
      synced++;
    } catch (e) {
      console.error(`[bracket-sync] Sync failed for ${payload.walmart_order_num}:`, e.message);
      // Don't mark as read — retry next run
      continue;
    }

    toMark.push(msg.uid);
  }

  // Mark all processed emails as SEEN so they aren't re-processed next run.
  if (toMark.length) {
    await client.messageFlagsAdd(toMark, ['\\Seen'], { uid: true });
    console.log(`[bracket-sync] Marked ${toMark.length} email(s) as read`);
  }

  await client.logout();
  console.log(`[bracket-sync] Done — synced ${synced} order(s)`);
}

main().catch(e => {
  console.error('[bracket-sync] Fatal:', e);
  process.exit(1);
});
