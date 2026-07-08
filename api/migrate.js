// ============================================================================
// Database migration helper for applying pending migrations
// Call with: GET /api/migrate?action=status
//            GET /api/migrate?action=apply&migration=0014_sms_consent
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { verifyToken, getBearer, applyCors } from './_lib/auth.js';
import { runDomsImport, runDomsImportChunk, domsDiag } from './_lib/doms-import.js';
import { sendAppointmentReminders } from './_lib/reminders.js';
import { sendDailyBookingDigest } from './_lib/daily-digest.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Allow the long-running Doms import to use the full Hobby-plan budget.
export const config = { maxDuration: 60 };

const __dir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dir, '../supabase/migrations');

// List of critical migrations that must be applied
const REQUIRED_MIGRATIONS = [
  '0014_sms_consent.sql',
];

async function checkSmsConsentColumn() {
  const db = serviceClient();
  try {
    // Try to query the bookings table and check if sms_consent column exists
    const { data, error } = await db.from('bookings')
      .select('id, sms_consent')
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.message?.includes('sms_consent')) {
        return { exists: false, error: error.message };
      }
      // Some other error, but column might exist
      return { exists: 'unknown', error: error.message };
    }

    return { exists: true };
  } catch (e) {
    return { exists: 'unknown', error: e.message };
  }
}

async function applyMigration(filename) {
  const filePath = path.join(migrationsDir, filename);

  if (!fs.existsSync(filePath)) {
    return { error: `Migration file not found: ${filename}` };
  }

  const sql = fs.readFileSync(filePath, 'utf-8');
  const db = serviceClient();

  try {
    // Use rpc with a custom function if available, or directly query
    // Note: This is a workaround. The Supabase JS client doesn't have direct SQL execution.
    // In production, these should be applied via the Supabase dashboard or CLI.
    const result = await db.rpc('exec_sql', { sql_text: sql });
    return { success: true, result };
  } catch (e) {
    // If rpc doesn't work, we'll need to use the dashboard or CLI
    return {
      error: `Could not apply migration via RPC: ${e.message}. Please apply migrations manually via Supabase dashboard or CLI.`,
      helpText: `To apply ${filename}, run: supabase db push`
    };
  }
}

// Status ladder for bracket purchases — sync only ever upgrades a row's status
// (in_route → delivered), never moves it backwards. 'ordered' is the legacy
// alias of 'in_route' (rank 0) so old rows compare correctly.
const BRACKET_STATUS_RANK = { in_route: 0, ordered: 0, delivered: 1, canceled: 2 };

// Adjust a tech's bracket_inventory by a (possibly negative) delta, clamped at
// zero. Used to self-heal inventory when an already-assigned order's quantities
// are corrected from the email.
async function adjustBracketInventory(db, businessId, technicianId, delta) {
  const clamp = (n) => Math.max(0, n || 0);
  const { data: inv } = await db.from('bracket_inventory')
    .select('id, flat_qty, tilting_qty, full_motion_qty')
    .eq('business_id', businessId).eq('technician_id', technicianId).maybeSingle();
  if (!inv) {
    await db.from('bracket_inventory').insert({
      business_id: businessId, technician_id: technicianId,
      flat_qty: clamp(delta.flat), tilting_qty: clamp(delta.tilting), full_motion_qty: clamp(delta.full_motion),
    });
    return;
  }
  await db.from('bracket_inventory').update({
    flat_qty:        clamp((inv.flat_qty || 0)        + delta.flat),
    tilting_qty:     clamp((inv.tilting_qty || 0)     + delta.tilting),
    full_motion_qty: clamp((inv.full_motion_qty || 0) + delta.full_motion),
  }).eq('id', inv.id);
}

// Sync one Walmart order into bracket_purchases. Auth/method checked by caller.
//   • Unassigned everywhere → mirror the order to every active business as an
//     unassigned delivery (so it can be assigned from either platform).
//   • Already assigned to a tech in some business → that business OWNS it:
//     update only that row, self-heal its quantities from the email (moving the
//     tech's inventory by the difference), and drop leftover unassigned twins in
//     other businesses so the same delivery isn't shown or counted twice.
// Tech home addresses — bracket orders ship to a tech's house, so the delivery
// address in the Walmart email tells us which tech the order is for. Keyed by
// street number + ZIP (unique per tech). Add a line when a tech moves or joins.
const TECH_HOME_ADDRESSES = [
  { num: '5809',  zip: '80128', name: 'steve', slug: 'handy-andy' },  // Steve Burns — Littleton, CO
  { num: '10507', zip: '80022', name: 'tk',    slug: 'doms' },        // Tk Adeshewo — Commerce City, CO
  { num: '7350',  zip: '77011', name: 'juan',  slug: 'handy-andy' },  // Juan Beltran — Houston, TX
  { num: '3749',  zip: '80205', name: 'kregg', slug: 'handy-andy' },  // Kregg G — Denver, CO
  { num: '16113', zip: '78728', name: 'zach',  slug: 'handy-andy' },  // Zach Benaya — Austin, TX
  { num: '9600',  zip: '80231', name: 'greg',  slug: 'doms' },        // Gregory Gadlin — Denver, CO
];

// Match a delivery address to the tech it ships to. STRICT: the street number
// AND the ZIP must both equal a known tech's home. Returns {id, business_id,
// name} or null — an unknown address leaves the order unassigned, never guessed.
async function matchTechByAddress(db, businesses, address) {
  if (!address) return null;
  const num = (String(address).match(/\b(\d{1,6})\b/) || [])[1];
  const zips = [...String(address).matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].map(m => m[1]);
  const zip = zips.length ? zips[zips.length - 1] : null;
  if (!num || !zip) return null;
  const entry = TECH_HOME_ADDRESSES.find(e => e.num === num && e.zip === zip);
  if (!entry) return null;
  const biz = (businesses || []).find(b => b.slug === entry.slug);
  if (!biz) return null;
  const { data: techs } = await db.from('technicians')
    .select('id, name, business_id').eq('business_id', biz.id).ilike('name', entry.name + '%').limit(1);
  const tech = (techs || [])[0];
  return tech ? { id: tech.id, business_id: tech.business_id, name: tech.name } : null;
}

// Status only ever upgrades (in_route → delivered), never downgrades.
async function bracketSync(req, res) {
  const body = req.body || {};
  const walmart_order_num = (body.walmart_order_num || '').toString().trim();
  if (!walmart_order_num) return res.status(400).json({ error: 'walmart_order_num required' });

  const flat_qty        = Math.max(0, parseInt(body.flat_qty)        || 0);
  const tilting_qty     = Math.max(0, parseInt(body.tilting_qty)     || 0);
  const full_motion_qty = Math.max(0, parseInt(body.full_motion_qty) || 0);
  const totalQty        = flat_qty + tilting_qty + full_motion_qty;
  const rawStatus       = (body.status || 'in_route').toString();
  const status          = Object.prototype.hasOwnProperty.call(BRACKET_STATUS_RANK, rawStatus) ? rawStatus : 'in_route';
  const order_date      = body.order_date     || null;
  const delivered_date  = body.delivered_date || null;
  const order_url       = body.order_url      || null;

  const db = serviceClient();
  const { data: businesses, error: bizErr } = await db.from('businesses').select('id, slug').eq('active', true);
  if (bizErr) return res.status(500).json({ error: bizErr.message });
  const slugOf = (id) => (businesses || []).find(b => b.id === id)?.slug || id;

  // Every row for this order across all businesses.
  const { data: rows, error: rowsErr } = await db.from('bracket_purchases')
    .select('id, business_id, status, flat_qty, tilting_qty, full_motion_qty, order_url, technician_id')
    .eq('walmart_order_num', walmart_order_num);
  if (rowsErr) return res.status(500).json({ error: rowsErr.message });

  const results = [];
  const upgrades = (fromStatus) => (BRACKET_STATUS_RANK[status] ?? 0) > (BRACKET_STATUS_RANK[fromStatus] ?? 0);
  const statusPatch = () => {
    const p = {};
    if (status === 'delivered' && delivered_date) p.delivered_date = delivered_date;
    p.status = status;
    return p;
  };

  const assignedRow = (rows || []).find(r => r.technician_id);
  // No tech on it yet? Auto-assign by the delivery address in the email.
  const matched = assignedRow ? null : await matchTechByAddress(db, businesses, body.delivery_address);
  if (assignedRow) {
    // The assigned tech's business owns this order.
    const patch = {};
    const wasDelivered = assignedRow.status === 'delivered';
    const nowDelivered = status === 'delivered';
    if (upgrades(assignedRow.status)) Object.assign(patch, statusPatch());
    if (order_url && !assignedRow.order_url) patch.order_url = order_url;
    const qtyChanged = totalQty > 0 && (assignedRow.flat_qty !== flat_qty || assignedRow.tilting_qty !== tilting_qty || assignedRow.full_motion_qty !== full_motion_qty);
    if (qtyChanged) { patch.flat_qty = flat_qty; patch.tilting_qty = tilting_qty; patch.full_motion_qty = full_motion_qty; }
    // Inventory moves ONLY on delivery — never while an order is in route.
    // Credit the full order the first time it flips to delivered; after that,
    // self-heal by any later quantity correction from a follow-up email.
    if (!wasDelivered && nowDelivered && totalQty > 0) {
      await adjustBracketInventory(db, assignedRow.business_id, assignedRow.technician_id,
        { flat: flat_qty, tilting: tilting_qty, full_motion: full_motion_qty });
    } else if (wasDelivered && qtyChanged) {
      await adjustBracketInventory(db, assignedRow.business_id, assignedRow.technician_id, {
        flat:        flat_qty        - (assignedRow.flat_qty || 0),
        tilting:     tilting_qty     - (assignedRow.tilting_qty || 0),
        full_motion: full_motion_qty - (assignedRow.full_motion_qty || 0),
      });
    }
    if (Object.keys(patch).length) {
      const { error } = await db.from('bracket_purchases').update(patch).eq('id', assignedRow.id);
      results.push({ business: slugOf(assignedRow.business_id), action: error ? 'update_failed' : 'updated_assigned', patch, error: error?.message });
    } else {
      results.push({ business: slugOf(assignedRow.business_id), action: 'unchanged' });
    }
    // Drop leftover unassigned twins of the same order anywhere else.
    for (const r of (rows || [])) {
      if (r.id === assignedRow.id || r.technician_id) continue;
      await db.from('bracket_purchases').delete().eq('id', r.id);
      results.push({ business: slugOf(r.business_id), action: 'twin_removed' });
    }
  } else if (matched) {
    // Auto-assign to the tech the order ships to. This only RESERVES the order to
    // the tech — it does NOT touch on-hand inventory. Brackets are added to the
    // count only when the order is delivered (below). Own the row for the tech's
    // business (update the existing unassigned twin there, or insert), drop twins.
    const own = (rows || []).find(r => r.business_id === matched.business_id) || null;
    const patch = { technician_id: matched.id };
    if (order_url) patch.order_url = order_url;
    if (own) {
      if (upgrades(own.status)) Object.assign(patch, statusPatch());
      if (totalQty > 0) { patch.flat_qty = flat_qty; patch.tilting_qty = tilting_qty; patch.full_motion_qty = full_motion_qty; }
      const { error } = await db.from('bracket_purchases').update(patch).eq('id', own.id);
      results.push({ business: slugOf(matched.business_id), action: error ? 'assign_failed' : 'auto_assigned', tech: matched.name, error: error?.message });
    } else if (totalQty === 0) {
      results.push({ business: slugOf(matched.business_id), action: 'skipped', reason: 'no_qty_for_new_order' });
    } else {
      const { error } = await db.from('bracket_purchases').insert({
        business_id: matched.business_id, technician_id: matched.id, walmart_order_num,
        flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url,
      });
      results.push({ business: slugOf(matched.business_id), action: error ? 'assign_insert_failed' : 'auto_assigned_new', tech: matched.name, error: error?.message });
    }
    // Credit inventory ONLY if this order is already delivered at the moment we
    // auto-assign it (e.g. the first email we saw was the delivery notice). An
    // in-route order adds nothing until its delivery email arrives.
    if (status === 'delivered' && totalQty > 0) {
      await adjustBracketInventory(db, matched.business_id, matched.id, { flat: flat_qty, tilting: tilting_qty, full_motion: full_motion_qty });
    }
    // Remove the still-unassigned twin(s) of this order in other businesses.
    for (const r of (rows || [])) {
      if (r.business_id === matched.business_id || r.technician_id) continue;
      await db.from('bracket_purchases').delete().eq('id', r.id);
      results.push({ business: slugOf(r.business_id), action: 'twin_removed' });
    }
  } else {
    // Unassigned everywhere — mirror to every active business.
    const byBiz = new Map((rows || []).map(r => [r.business_id, r]));
    for (const biz of (businesses || [])) {
      const existing = byBiz.get(biz.id);
      if (existing) {
        const patch = {};
        if (upgrades(existing.status)) Object.assign(patch, statusPatch());
        if (order_url && !existing.order_url) patch.order_url = order_url;
        if (totalQty > 0) {
          if (existing.flat_qty        !== flat_qty)        patch.flat_qty        = flat_qty;
          if (existing.tilting_qty     !== tilting_qty)     patch.tilting_qty     = tilting_qty;
          if (existing.full_motion_qty !== full_motion_qty) patch.full_motion_qty = full_motion_qty;
        }
        if (Object.keys(patch).length === 0) { results.push({ business: biz.slug, action: 'unchanged' }); continue; }
        const { error } = await db.from('bracket_purchases').update(patch).eq('id', existing.id);
        results.push({ business: biz.slug, action: error ? 'update_failed' : 'updated', patch, error: error?.message });
      } else {
        if (totalQty === 0) { results.push({ business: biz.slug, action: 'skipped', reason: 'no_qty_for_new_order' }); continue; }
        const { error } = await db.from('bracket_purchases').insert({
          business_id: biz.id, technician_id: null, walmart_order_num,
          flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url,
        });
        results.push({ business: biz.slug, action: error ? 'insert_failed' : 'created', error: error?.message });
      }
    }
  }

  // Record what we PAID (the order total from the email) on the order's row(s),
  // once. Best-effort: silently skipped if the order_total column isn't applied
  // yet, and only fills a null so a corrected total is never clobbered.
  if (body.order_total != null && isFinite(Number(body.order_total))) {
    try {
      await db.from('bracket_purchases')
        .update({ order_total: Math.round(Number(body.order_total) * 100) / 100 })
        .eq('walmart_order_num', walmart_order_num).is('order_total', null);
    } catch (e) { /* order_total column not present yet — ignore */ }
  }

  // Record the parsed "Arrives …" date so the tech app can show an estimated
  // delivery for in-route orders. Best-effort + fills only a null, same as
  // order_total: silently skipped if the column isn't applied yet.
  if (body.estimated_delivery && /^\d{4}-\d{2}-\d{2}$/.test(String(body.estimated_delivery))) {
    try {
      await db.from('bracket_purchases')
        .update({ estimated_delivery: body.estimated_delivery })
        .eq('walmart_order_num', walmart_order_num).is('estimated_delivery', null);
    } catch (e) { /* estimated_delivery column not present yet — ignore */ }
  }

  console.log('[bracket_sync]', walmart_order_num, results.map(r => `${r.business}:${r.action}`).join(', '));
  return res.status(200).json({ ok: true, order: walmart_order_num, results });
}

// One Amazon unit yields this many wire concealment plates (owner: "each 1
// purchased supplies 5"). Authoritative server-side, so a stale client can't
// inflate the count.
const PLATES_PER_UNIT = parseInt(process.env.PLATES_PER_UNIT) || 5;

// Adjust a tech's wire_plate_qty by a (possibly negative) delta, clamped at zero.
// Used to self-heal when an already-assigned order's quantity is corrected from
// a later email. Silently no-ops if migration 0039 isn't applied yet.
async function adjustWirePlateInv(db, businessId, technicianId, delta) {
  if (!delta) return;
  const { data: inv, error } = await db.from('bracket_inventory')
    .select('id, wire_plate_qty')
    .eq('business_id', businessId).eq('technician_id', technicianId).maybeSingle();
  if (error) { if (/wire_plate_qty/.test(error.message || '')) return; throw error; }
  if (!inv) {
    await db.from('bracket_inventory').insert({
      business_id: businessId, technician_id: technicianId, wire_plate_qty: Math.max(0, delta),
    });
    return;
  }
  await db.from('bracket_inventory')
    .update({ wire_plate_qty: Math.max(0, (inv.wire_plate_qty || 0) + delta) })
    .eq('id', inv.id);
}

// Sync one Amazon plate order into wire_plate_purchases. Unassigned orders mirror
// to every active business (assignable from either dashboard); once a tech is
// assigned, that business owns the row and unassigned twins are dropped.
//
// CREDITING (the key rule): plates are added to a tech's ON-HAND count only when
// the order is actually DELIVERED — not when it's assigned. An en-route order can
// be reserved to a tech, but their on-hand count doesn't move until delivery.
// `credited` tracks that the plates were counted, so it happens exactly once.
// While uncredited, status follows the email (in_route <-> delivered); once
// credited it's locked. Auth/method checked by the caller.
async function wirePlateSync(req, res) {
  const body = req.body || {};
  const amazon_order_num = (body.amazon_order_num || '').toString().trim();
  if (!amazon_order_num) return res.status(400).json({ error: 'amazon_order_num required' });

  const units          = Math.max(0, parseInt(body.units) || 0);
  const plates         = units > 0 ? units * PLATES_PER_UNIT : Math.max(0, parseInt(body.plates) || 0);
  const rawStatus      = (body.status || 'in_route').toString();
  const status         = Object.prototype.hasOwnProperty.call(BRACKET_STATUS_RANK, rawStatus) ? rawStatus : 'in_route';
  const order_date     = body.order_date     || null;
  const delivered_date = body.delivered_date || null;
  const order_url      = body.order_url      || null;

  const db = serviceClient();
  const { data: businesses, error: bizErr } = await db.from('businesses').select('id, slug').eq('active', true);
  if (bizErr) return res.status(500).json({ error: bizErr.message });
  const slugOf = (id) => (businesses || []).find(b => b.id === id)?.slug || id;

  // `credited` arrives with migration 0041; degrade gracefully (skip auto-credit)
  // if it isn't applied yet, so the sync never crashes.
  let hasCredited = true;
  let { data: rows, error: rowsErr } = await db.from('wire_plate_purchases')
    .select('id, business_id, status, units, plates, order_url, technician_id, credited')
    .eq('amazon_order_num', amazon_order_num);
  if (rowsErr && /credited/.test(rowsErr.message || '')) {
    hasCredited = false;
    ({ data: rows, error: rowsErr } = await db.from('wire_plate_purchases')
      .select('id, business_id, status, units, plates, order_url, technician_id')
      .eq('amazon_order_num', amazon_order_num));
  }
  if (rowsErr) return res.status(500).json({ error: rowsErr.message });

  const results = [];

  const assignedRow = (rows || []).find(r => r.technician_id);
  if (assignedRow) {
    const patch = {};
    const wasCredited = !!assignedRow.credited;
    // Status follows the email while uncredited; locked once counted.
    if (!wasCredited && assignedRow.status !== status) {
      patch.status = status;
      patch.delivered_date = status === 'delivered' ? (delivered_date || null) : null;
    }
    if (order_url && !assignedRow.order_url) patch.order_url = order_url;
    if (plates > 0 && assignedRow.plates !== plates) { patch.units = units; patch.plates = plates; }

    const effStatus = patch.status || assignedRow.status;
    const effPlates = (patch.plates != null) ? patch.plates : (assignedRow.plates || 0);

    if (hasCredited && !wasCredited && effStatus === 'delivered') {
      // DELIVERED + assigned for the first time → add plates to the tech's on-hand.
      await adjustWirePlateInv(db, assignedRow.business_id, assignedRow.technician_id, effPlates);
      patch.credited = true;
    } else if (hasCredited && wasCredited && effStatus === 'canceled') {
      // A counted order was canceled/returned → take the plates back.
      await adjustWirePlateInv(db, assignedRow.business_id, assignedRow.technician_id, -(assignedRow.plates || 0));
      patch.credited = false;
    } else if (hasCredited && wasCredited && patch.plates != null) {
      // Quantity corrected after counting → move the tech's count by the delta.
      await adjustWirePlateInv(db, assignedRow.business_id, assignedRow.technician_id, effPlates - (assignedRow.plates || 0));
    }

    if (Object.keys(patch).length) {
      const { error } = await db.from('wire_plate_purchases').update(patch).eq('id', assignedRow.id);
      results.push({ business: slugOf(assignedRow.business_id), action: error ? 'update_failed' : 'updated_assigned', error: error?.message });
    } else {
      results.push({ business: slugOf(assignedRow.business_id), action: 'unchanged' });
    }
    for (const r of (rows || [])) {
      if (r.id === assignedRow.id || r.technician_id) continue;
      await db.from('wire_plate_purchases').delete().eq('id', r.id);
      results.push({ business: slugOf(r.business_id), action: 'twin_removed' });
    }
  } else {
    const byBiz = new Map((rows || []).map(r => [r.business_id, r]));
    for (const biz of (businesses || [])) {
      const existing = byBiz.get(biz.id);
      if (existing) {
        const patch = {};
        if (existing.status !== status) {
          patch.status = status;
          patch.delivered_date = status === 'delivered' ? (delivered_date || null) : null;
        }
        if (order_url && !existing.order_url) patch.order_url = order_url;
        if (plates > 0) { if (existing.units !== units) patch.units = units; if (existing.plates !== plates) patch.plates = plates; }
        if (Object.keys(patch).length === 0) { results.push({ business: biz.slug, action: 'unchanged' }); continue; }
        const { error } = await db.from('wire_plate_purchases').update(patch).eq('id', existing.id);
        results.push({ business: biz.slug, action: error ? 'update_failed' : 'updated', error: error?.message });
      } else {
        if (plates === 0) { results.push({ business: biz.slug, action: 'skipped', reason: 'no_qty_for_new_order' }); continue; }
        const { error } = await db.from('wire_plate_purchases').insert({
          business_id: biz.id, technician_id: null, amazon_order_num,
          units, plates, status, order_date, delivered_date, order_url,
        });
        results.push({ business: biz.slug, action: error ? 'insert_failed' : 'created', error: error?.message });
      }
    }
  }

  console.log('[wire_plate_sync]', amazon_order_num, results.map(r => `${r.business}:${r.action}`).join(', '));
  return res.status(200).json({ ok: true, order: amazon_order_num, results });
}

// One-off maintenance: delete specific Amazon plate orders by order number(s).
// Used to scrub phantom rows a bad email scan created. If a row was already
// credited to a tech's on-hand count, the plates are subtracted back out before
// the row is deleted, so inventory stays correct. Auth/method checked by caller.
async function wirePlatePurge(req, res) {
  const body = req.body || {};
  let nums = body.order_nums;
  if (typeof nums === 'string') nums = nums.split(',');
  nums = (Array.isArray(nums) ? nums : []).map(s => String(s || '').trim()).filter(Boolean);
  if (!nums.length) return res.status(400).json({ error: 'order_nums required (array or comma-separated string)' });

  const db = serviceClient();

  // `credited` arrives with migration 0041; degrade gracefully if not applied.
  let hasCredited = true;
  const sel = (withC) => db.from('wire_plate_purchases')
    .select(`id, business_id, technician_id, plates, amazon_order_num${withC ? ', credited' : ''}`)
    .in('amazon_order_num', nums);
  let { data: rows, error } = await sel(true);
  if (error && /credited/.test(error.message || '')) { hasCredited = false; ({ data: rows, error } = await sel(false)); }
  if (error) return res.status(500).json({ error: String(error.message || error) });
  rows = rows || [];

  const results = [];
  for (const r of rows) {
    if (hasCredited && r.credited && r.technician_id && (r.plates || 0) > 0) {
      await adjustWirePlateInv(db, r.business_id, r.technician_id, -(r.plates || 0));
    }
    const { error: delErr } = await db.from('wire_plate_purchases').delete().eq('id', r.id);
    results.push({ order: r.amazon_order_num, action: delErr ? 'delete_failed' : 'deleted', error: delErr?.message });
  }

  console.log('[wire_plate_purge]', nums.join(','), `removed ${results.filter(r => r.action === 'deleted').length}/${rows.length}`);
  return res.status(200).json({ ok: true, requested: nums, found: rows.length, removed: results.filter(r => r.action === 'deleted').length, results });
}

// Add (or re-tier) one service-area zip across every business that serves the
// named metro. Upserts on (business_id, postal_code) so a re-run just re-asserts
// the surcharge/payout tier. POST { zip, area, surcharge, payout }. Auth/method
// checked by the caller. Mirrors migration 0042's seed for live application.
async function seedZip(req, res) {
  const body = req.body || {};
  const zip = String(body.zip || '').trim();
  const area = String(body.area || '').trim();
  const surcharge = Number(body.surcharge) || 0;
  const payout = Number(body.payout) || 0;
  if (!/^\d{5}$/.test(zip)) return res.status(400).json({ error: 'zip must be exactly 5 digits' });
  if (!area) return res.status(400).json({ error: 'area (metro name, e.g. "Denver") required' });

  const db = serviceClient();
  const { data: areas, error: aErr } = await db.from('service_areas')
    .select('id, business_id, name, business:businesses ( slug, active )')
    .eq('name', area);
  if (aErr) return res.status(500).json({ error: aErr.message });
  const targets = (areas || []).filter(a => a.business && a.business.active !== false);
  if (!targets.length) return res.status(404).json({ error: `No active business has a service area named "${area}"` });

  const results = [];
  for (const a of targets) {
    const { error } = await db.from('service_area_zips').upsert(
      { business_id: a.business_id, service_area_id: a.id, postal_code: zip, surcharge, tech_payout: payout },
      { onConflict: 'business_id,postal_code' }
    );
    results.push({ slug: a.business.slug, area, action: error ? 'failed' : 'upserted', error: error && error.message });
  }
  console.log('[seed_zip]', zip, area, `${surcharge}/${payout}`, results.map(r => `${r.slug}:${r.action}`).join(', '));
  return res.status(200).json({ ok: true, zip, area, surcharge, payout, results });
}

// Best-effort: credit a Google review to the tech who did a recent completed job
// for a customer whose surname matches the reviewer. Conservative — only matches
// on a (≥3 char) last name among the last 60 days of completed jobs, newest
// first. Returns nulls when there's no confident match (the review still saves;
// the owner can re-attribute in the dashboard).
async function matchTechByReviewer(db, bizId, reviewerName) {
  const out = { technician_id: null, booking_id: null };
  const tokens = String(reviewerName || '').toLowerCase().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (!last || last.length < 3) return out;
  const sinceISO = new Date(Date.now() - 60 * 86400000).toISOString();
  const { data: rows } = await db.from('bookings')
    .select('id, technician_id, scheduled_at, customer:customers ( name )')
    .eq('business_id', bizId).eq('status', 'completed')
    .not('technician_id', 'is', null)
    .gte('scheduled_at', sinceISO)
    .order('scheduled_at', { ascending: false }).limit(200);
  for (const b of (rows || [])) {
    const ct = String(b.customer?.name || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (ct.length && ct[ct.length - 1] === last) {
      return { technician_id: b.technician_id, booking_id: b.id };
    }
  }
  return out;
}

// Store one Google Business Profile review. Idempotent on (business_id,
// google_key): a re-scan of the same email is a no-op and never resurfaces a
// dismissed banner. Auth checked by the caller.
async function googleReviewSync(req, res) {
  const body = req.body || {};
  const slug = (body.business || '').toString().trim();
  const google_key = (body.google_key || '').toString().trim();
  const reviewer_name = (body.reviewer_name || '').toString().trim() || null;
  const rating = Math.max(1, Math.min(5, parseInt(body.rating) || 0)) || null;
  const review_text = (body.review_text || '').toString().trim() || null;
  const review_date = body.review_date || null;
  if (!slug || !google_key || !rating) return res.status(400).json({ error: 'business, google_key, rating required' });

  const db = serviceClient();
  const { data: biz } = await db.from('businesses').select('id, slug').eq('slug', slug).eq('active', true).maybeSingle();
  if (!biz) return res.status(404).json({ error: `Unknown business "${slug}"` });

  // Already stored? Keep it (preserves the seen flag + any manual re-attribution).
  const { data: existing } = await db.from('google_reviews')
    .select('id').eq('business_id', biz.id).eq('google_key', google_key).maybeSingle();
  if (existing) return res.status(200).json({ ok: true, action: 'exists', id: existing.id });

  const { technician_id, booking_id } = await matchTechByReviewer(db, biz.id, reviewer_name);

  const { data: ins, error } = await db.from('google_reviews').insert({
    business_id: biz.id, reviewer_name, rating, review_text, review_date,
    google_key, technician_id, booking_id, seen: false,
  }).select('id').maybeSingle();
  if (error) {
    // Unique race (another run inserted it) is fine.
    if (/duplicate key|unique/i.test(error.message || '')) return res.status(200).json({ ok: true, action: 'exists' });
    return res.status(500).json({ error: error.message });
  }
  console.log('[google_review_sync]', slug, reviewer_name, `${rating}★`, technician_id ? 'matched-tech' : 'no-match');
  return res.status(200).json({ ok: true, action: 'created', id: ins?.id, matched: !!technician_id });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || '').toString();

  // One-time Doms Zenbooker import. Secured by IMPORT_SECRET (so it can be
  // triggered from a browser URL), NOT the admin bearer token.
  //
  // RESUMABLE by default: each call processes a few pages of one phase and
  // returns { done, nextCursor }. The driver page (/import-doms.html) loops
  // until done so the work never exceeds the 60s serverless budget. Params:
  //   &phase=customers|jobs   which list to page through (default customers)
  //   &cursor=<token>         continue from a previous call's nextCursor
  //   &maxPages=N             pages per request (default 3)
  //   &mode=all               legacy single-shot run (may time out on big data)
  if (action === 'import_doms') {
    const debug = req.query.debug === '1';
    try {
      const secret = process.env.IMPORT_SECRET;
      if (!secret) return res.status(400).json({ error: 'IMPORT_SECRET env var not set. Add it in Vercel first.' });
      if (req.query.secret !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=YOUR_IMPORT_SECRET' });

      const step = (req.query.step || '').toString();

      // Diagnostic ladder — each rung adds one dependency so we can see exactly
      // which layer fails. ping touches nothing; db touches Supabase; zbk touches
      // Zenbooker. All return readable JSON (domsDiag never throws).
      if (step === 'ping') {
        return res.status(200).json({
          ok: true, step: 'ping', node: process.version,
          env: {
            SUPABASE_URL: !!process.env.SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
            ZENBOOKER_API_KEY: !!process.env.ZENBOOKER_API_KEY,
            IMPORT_SECRET: !!process.env.IMPORT_SECRET,
          },
        });
      }

      const zbk = process.env.ZENBOOKER_API_KEY;
      if (!zbk) return res.status(400).json({ error: 'ZENBOOKER_API_KEY env var not set' });

      if (step === 'db' || step === 'zbk') {
        return res.status(200).json(await domsDiag(serviceClient(), zbk, step));
      }

      if ((req.query.mode || '').toString() === 'all') {
        const phase = (req.query.phase || 'all').toString();
        const out = await runDomsImport(serviceClient(), zbk, { phase });
        return res.status(200).json(out);
      }
      const phase = (req.query.phase || 'customers').toString();
      const cursor = req.query.cursor ? req.query.cursor.toString() : null;
      const maxPages = req.query.maxPages ? Number(req.query.maxPages) : undefined;
      const out = await runDomsImportChunk(serviceClient(), zbk, { phase, cursor, maxPages });
      return res.status(200).json(out);
    } catch (e) {
      console.error('[import_doms]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e), stack: debug ? String((e && e.stack) || '') : undefined });
    }
  }

  // 24-hour appointment reminders. Secured by CRON_SECRET (NOT the admin bearer)
  // so a scheduled trigger (Vercel Cron / GitHub Actions hourly) can call it.
  // Vercel Cron auto-sends "Authorization: Bearer <CRON_SECRET>"; GitHub Actions
  // and manual tests can pass it as ?secret=... or the same Bearer header.
  //   &dry=1   find + report eligible bookings without sending anything
  if (action === 'send_reminders') {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      const summary = await sendAppointmentReminders({ dryRun });
      return res.status(200).json({ ok: true, ...summary });
    } catch (e) {
      console.error('[send_reminders]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // Daily booking digest — ONE 8 PM Denver email summarizing every appointment
  // booked today (replaces the per-booking alerts). Secured by CRON_SECRET.
  // Triggered by a Vercel Cron at 03:00 UTC (reliable; = 8–9 PM Denver year-round)
  // PLUS the hourly GitHub Action as a backup. The handler only sends inside the
  // 8 PM–midnight Denver window (with an overnight catch-up) and dedupes with a
  // Resend idempotency key, so exactly one email goes out per day regardless of
  // how many triggers fire.  &force=1 bypass the clock, &offset=N backfill a
  // specific day, &dry=1 count without sending.
  if (action === 'daily_digest') {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      // Optional &offset=N (0=today, -1=yesterday…) to backfill a specific missed
      // day, bypassing the 8 PM clock.
      const offset = (req.query.offset != null && req.query.offset !== '')
        ? parseInt(req.query.offset, 10) : null;
      const out = await sendDailyBookingDigest({ force, dryRun, offset });
      return res.status(200).json({ ok: true, ...out });
    } catch (e) {
      console.error('[daily_digest]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // Walmart bracket order sync. Called by the bracket-tracker GitHub Action
  // after it parses order emails from Gmail. Upserts bracket_purchases for
  // EVERY active business so both dashboards show the same orders. Secured by
  // CRON_SECRET (same as send_reminders, NOT the admin bearer). Status only
  // ever upgrades (ordered → delivered), never downgrades. POST JSON body:
  //   { walmart_order_num, flat_qty, tilting_qty, full_motion_qty,
  //     status, order_date, delivered_date, order_url }
  if (action === 'bracket_sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      return await bracketSync(req, res);
    } catch (e) {
      console.error('[bracket_sync]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // Amazon wire-concealment-plate order sync. Called by the bracket-tracker
  // GitHub Action after it parses Amazon order emails. Mirrors bracket_sync.
  // Secured by CRON_SECRET. POST JSON body:
  //   { amazon_order_num, units, status, order_date, delivered_date, order_url }
  if (action === 'wire_plate_sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      return await wirePlateSync(req, res);
    } catch (e) {
      console.error('[wire_plate_sync]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // One-off maintenance: delete specific Amazon plate orders (e.g. phantom rows a
  // bad email scan created). Secured by CRON_SECRET. POST { order_nums: [...] }.
  if (action === 'wire_plate_purge') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      return await wirePlatePurge(req, res);
    } catch (e) {
      console.error('[wire_plate_purge]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // Add/re-tier a service-area zip live (mirror of migration 0042). Secured by
  // CRON_SECRET. POST { zip, area, surcharge, payout }.
  if (action === 'seed_zip') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      return await seedZip(req, res);
    } catch (e) {
      console.error('[seed_zip]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // Google Business Profile review ingest. Called by the bracket-tracker Action
  // after it parses review-notification emails. Secured by CRON_SECRET.
  if (action === 'google_review_sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      return await googleReviewSync(req, res);
    } catch (e) {
      console.error('[google_review_sync]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  const auth = verifyToken(getBearer(req));

  // Require admin auth for any migration action
  if (!auth || auth.kind !== 'admin') {
    return res.status(401).json({ error: 'Admin authorization required' });
  }

  try {
    if (action === 'status') {
      const smsColumn = await checkSmsConsentColumn();
      return res.json({
        sms_consent_column: smsColumn,
        migrations: REQUIRED_MIGRATIONS,
      });
    }

    if (action === 'apply') {
      const migration = (req.query.migration || '').toString();
      if (!migration) {
        return res.status(400).json({ error: 'migration parameter required' });
      }
      const result = await applyMigration(migration);
      return res.json(result);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[migrate]', e);
    return res.status(500).json({ error: e.message });
  }
}
