// api/_lib/walmart-watcher.js
// Automated Walmart bracket-inventory watcher. Driven by a scheduled trigger
// (Vercel Cron / external scheduler) that hits
//   GET /api/migrate?action=watch_walmart_email&secret=CRON_SECRET
//
// What it does, hands-off:
//   1. Logs into the owner's AOL inbox over IMAP (read-only; never modifies the
//      inbox — no messages are marked read or moved).
//   2. Finds recent emails from Walmart that say a package was DELIVERED.
//   3. Parses the order number, date, and each line item's quantity + bracket
//      type (flat / tilting / full_motion) from the product name.
//   4. Records the delivery in bracket_purchases and adds the brackets to the
//      shared "Shop" inventory pile — exactly mirroring the manual
//      bracketParseEmail write path in api/admin.js.
//
// Design goals:
//   * Idempotent — a delivery is counted at most once. Dedupe is by
//     walmart_order_num (the purchase row), so the same email can be re-scanned
//     every run with no double-counting and WITHOUT touching the inbox's
//     read/unseen state (it's the owner's personal mailbox).
//   * Shared pile — delivery emails never name a technician, so every delivery
//     lands on a sentinel "Shop" technician (active:false so it never appears in
//     job-assignment pickers, but its inventory row still shows on the
//     dashboard). No schema change required.
//   * Bounded — only scans Walmart mail from the last LOOKBACK_DAYS so the run
//     stays small and fast.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { serviceClient } from './supabase.js';

const LOOKBACK_DAYS = 30;      // only scan Walmart mail this recent
const MAX_MESSAGES   = 40;     // hard cap per run (newest first)
const SENTINEL_NAME  = 'Shop'; // shared-pile technician for unassigned deliveries

// Which business the brackets belong to. Override with WALMART_BUSINESS_SLUG.
function businessSlug() {
  return (process.env.WALMART_BUSINESS_SLUG || 'handy-andy').toString();
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// Collapse an email body (prefer plaintext; fall back to HTML stripped of tags)
// into a single normalized line so the regexes below are layout-insensitive.
function normalizeBody(parsed) {
  let text = (parsed.text || '').toString();
  if (!text.trim() && parsed.html) {
    text = parsed.html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Map a product name to a bracket type. The product TITLE leads with the
// category ("onn Full Motion TV Wall Mount ..."); trailing words like "swivel"
// or "Tilting" are feature descriptors, so we test full-motion FIRST.
export function classifyBracketType(desc) {
  const d = (desc || '').toLowerCase();
  if (/full.?motion/.test(d)) return 'full_motion';
  if (/tilt/.test(d))         return 'tilting';
  if (/(flat|fixed|low.?profile)/.test(d)) return 'flat';
  return null; // unknown — caller logs it rather than silently dropping
}

// Detect "this package was delivered" from subject/body.
function isDelivered(subject, body) {
  const s = `${subject || ''} ${body || ''}`;
  return /\bdelivered\b/i.test(s) || /your package arrived|has been delivered|was delivered/i.test(s);
}

// Parse a normalized Walmart email body into structured fields. Returns null if
// it isn't a recognizable Walmart order email.
export function parseWalmartEmail(subject, body) {
  const orderMatch = body.match(/Order\s*#\s*([0-9][0-9-]+)/i);
  if (!orderMatch) return null;
  const orderNum = orderMatch[1].replace(/-+$/, '');

  // Order date: "Order date: Thu, Jun 25, 2026"
  let orderDate = null;
  const dateMatch = body.match(/Order\s*date[:\s]+([A-Za-z]{3,},?\s+[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4})/i);
  if (dateMatch) {
    const t = Date.parse(dateMatch[1]);
    if (!Number.isNaN(t)) orderDate = new Date(t).toISOString().slice(0, 10);
  }

  // Line items: "quantity 4 item onn Full Motion TV Wall Mount ..." — capture
  // each qty + description up to the next item or an end-of-list marker.
  const items = [];
  const unknown = [];
  const re = /quantity\s+(\d+)\s+item\s+(.+?)(?=\bquantity\s+\d+\s+item\b|\bhow was your delivery\b|\bpayment method\b|\bwalmart\+\b|$)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const qty = parseInt(m[1], 10) || 0;
    const desc = m[2].trim();
    if (qty <= 0) continue;
    const type = classifyBracketType(desc);
    if (type) items.push({ qty, type, desc });
    else unknown.push({ qty, desc });
  }

  // Fallback: a single qty with no "item" structure but a recognizable type.
  if (!items.length && !unknown.length) {
    const qm = body.match(/quantity\s+(\d+)/i);
    const type = classifyBracketType(body);
    if (qm && type) items.push({ qty: parseInt(qm[1], 10) || 0, type, desc: '(whole-email match)' });
  }

  const totals = { flat: 0, tilting: 0, full_motion: 0 };
  for (const it of items) totals[it.type] += it.qty;

  return { orderNum, orderDate, items, unknown, totals };
}

// ── Inventory write (mirrors api/admin.js bracketParseEmail) ──────────────────

// Find-or-create the shared "Shop" sentinel technician for this business.
async function getShopTechId(db, bizId) {
  const { data: existing } = await db.from('technicians')
    .select('id').eq('business_id', bizId).ilike('name', SENTINEL_NAME).maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await db.from('technicians')
    .insert({ business_id: bizId, name: SENTINEL_NAME, active: false })
    .select('id').single();
  if (error) throw new Error(`could not create "${SENTINEL_NAME}" technician: ${error.message}`);
  return created.id;
}

// Record one delivered order and bump inventory. Idempotent on walmart_order_num.
async function recordDelivery(db, bizId, techId, parsed, today) {
  // Already counted? (dedupe by order number) — skip without touching inventory.
  const { data: prior } = await db.from('bracket_purchases')
    .select('id').eq('walmart_order_num', parsed.orderNum).eq('business_id', bizId).maybeSingle();
  if (prior) return { status: 'skipped', reason: 'already recorded' };

  const { flat, tilting, full_motion } = parsed.totals;

  const { error: insErr } = await db.from('bracket_purchases').insert({
    business_id: bizId,
    technician_id: techId,
    walmart_order_num: parsed.orderNum,
    flat_qty: flat,
    tilting_qty: tilting,
    full_motion_qty: full_motion,
    status: 'delivered',
    order_date: parsed.orderDate || today,
    delivered_date: today,
  });
  if (insErr) throw new Error(`bracket_purchases insert failed: ${insErr.message}`);

  // Read-then-write inventory increment (no atomic increment in supabase-js).
  const { data: inv } = await db.from('bracket_inventory')
    .select('id, flat_qty, tilting_qty, full_motion_qty')
    .eq('technician_id', techId).eq('business_id', bizId).maybeSingle();
  if (inv) {
    await db.from('bracket_inventory').update({
      flat_qty: (inv.flat_qty || 0) + flat,
      tilting_qty: (inv.tilting_qty || 0) + tilting,
      full_motion_qty: (inv.full_motion_qty || 0) + full_motion,
    }).eq('id', inv.id);
  } else {
    await db.from('bracket_inventory').insert({
      business_id: bizId,
      technician_id: techId,
      flat_qty: flat,
      tilting_qty: tilting,
      full_motion_qty: full_motion,
    });
  }

  return { status: 'recorded', flat, tilting, full_motion };
}

// ── Main entry ────────────────────────────────────────────────────────────────
//   opts.dryRun — parse + report what WOULD be recorded; touch nothing.
export async function watchWalmartEmails(opts = {}) {
  const dryRun = !!opts.dryRun;
  const user = process.env.AOL_USER;
  const pass = process.env.AOL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('AOL_USER and AOL_APP_PASSWORD env vars must be set in Vercel.');
  }

  const db = serviceClient();
  const slug = businessSlug();
  const { data: biz, error: bizErr } = await db.from('businesses')
    .select('id, slug').eq('slug', slug).single();
  if (bizErr || !biz) throw new Error(`business "${slug}" not found (set WALMART_BUSINESS_SLUG?)`);
  const bizId = biz.id;

  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const summary = { checked: 0, recorded: 0, skipped: 0, errors: 0, dryRun, details: [] };

  const client = new ImapFlow({
    host: process.env.AOL_IMAP_HOST || 'imap.aol.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let shopTechId = null;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Walmart order mail from the last LOOKBACK_DAYS. We do NOT filter on
      // \Seen — dedupe is by order number, so the inbox is left untouched.
      let uids = await client.search({ from: 'walmart', since }, { uid: true });
      if (!uids || !uids.length) return summary;
      if (uids.length > MAX_MESSAGES) uids = uids.slice(-MAX_MESSAGES); // newest

      for (const uid of uids) {
        let msg;
        try {
          msg = await client.fetchOne(uid, { source: true }, { uid: true });
        } catch (e) {
          summary.errors++; summary.details.push({ uid, error: `fetch failed: ${e.message}` });
          continue;
        }
        if (!msg || !msg.source) continue;

        let parsedMail;
        try {
          parsedMail = await simpleParser(msg.source);
        } catch (e) {
          summary.errors++; summary.details.push({ uid, error: `parse failed: ${e.message}` });
          continue;
        }

        const subject = parsedMail.subject || '';
        const from = (parsedMail.from?.text || '').toLowerCase();
        if (!from.includes('walmart')) continue;

        const body = normalizeBody(parsedMail);
        if (!isDelivered(subject, body)) continue; // only count on delivery

        const parsed = parseWalmartEmail(subject, body);
        if (!parsed) continue;
        summary.checked++;

        const totalQty = parsed.totals.flat + parsed.totals.tilting + parsed.totals.full_motion;
        if (totalQty <= 0) {
          summary.skipped++;
          summary.details.push({
            order: parsed.orderNum, status: 'skipped',
            reason: parsed.unknown.length ? 'unrecognized bracket type' : 'no brackets found',
            subject, unknown: parsed.unknown,
          });
          continue;
        }

        if (dryRun) {
          summary.recorded++;
          summary.details.push({ order: parsed.orderNum, status: 'would record', ...parsed.totals, unknown: parsed.unknown });
          continue;
        }

        try {
          if (!shopTechId) shopTechId = await getShopTechId(db, bizId);
          const r = await recordDelivery(db, bizId, shopTechId, parsed, today);
          if (r.status === 'recorded') {
            summary.recorded++;
            summary.details.push({ order: parsed.orderNum, status: 'recorded', flat: r.flat, tilting: r.tilting, full_motion: r.full_motion, unknown: parsed.unknown });
          } else {
            summary.skipped++;
            summary.details.push({ order: parsed.orderNum, status: 'skipped', reason: r.reason });
          }
        } catch (e) {
          summary.errors++;
          summary.details.push({ order: parsed.orderNum, error: e.message });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    try { await client.logout(); } catch { /* best-effort */ }
    throw e;
  }

  return summary;
}
