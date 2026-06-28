// ============================================================================
// api/bracket-sync.js  —  Bracket purchase sync endpoint
// ============================================================================
// Called by the bracket-tracker GitHub Action after parsing Walmart order
// emails. Upserts bracket_purchases for ALL businesses so every platform
// dashboard shows the same orders. Protected by CRON_SECRET (same as the
// appointment-reminders endpoint in migrate.js).
//
//   POST /api/bracket-sync
//   Authorization: Bearer <CRON_SECRET>
//   { walmart_order_num, flat_qty, tilting_qty, full_motion_qty,
//     status, order_date, delivered_date, order_url }
//
// Status machine: ordered → delivered (upgrades only, never downgrades).
// If all qty are zero the record must already exist (delivery-only update).
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { applyCors } from './_lib/auth.js';

const STATUS_RANK = { ordered: 0, delivered: 1, canceled: 2 };

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET not configured on server' });

  const auth   = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const qsecret = (req.query.secret || '').toString().trim();
  if (auth !== secret && qsecret !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const walmart_order_num = (body.walmart_order_num || '').toString().trim();
  if (!walmart_order_num) return res.status(400).json({ error: 'walmart_order_num required' });

  const flat_qty      = Math.max(0, parseInt(body.flat_qty)       || 0);
  const tilting_qty   = Math.max(0, parseInt(body.tilting_qty)    || 0);
  const full_motion_qty = Math.max(0, parseInt(body.full_motion_qty) || 0);
  const totalQty      = flat_qty + tilting_qty + full_motion_qty;
  const rawStatus     = (body.status || 'ordered').toString();
  const status        = Object.prototype.hasOwnProperty.call(STATUS_RANK, rawStatus) ? rawStatus : 'ordered';
  const order_date    = body.order_date    || null;
  const delivered_date = body.delivered_date || null;
  const order_url     = body.order_url     || null;

  const db = serviceClient();
  const { data: businesses, error: bizErr } = await db.from('businesses')
    .select('id, slug').eq('active', true);
  if (bizErr) return res.status(500).json({ error: bizErr.message });

  const results = [];

  for (const biz of (businesses || [])) {
    const { data: existing } = await db.from('bracket_purchases')
      .select('id, status, flat_qty, tilting_qty, full_motion_qty')
      .eq('business_id', biz.id)
      .eq('walmart_order_num', walmart_order_num)
      .maybeSingle();

    if (existing) {
      const currentRank = STATUS_RANK[existing.status] ?? 0;
      const newRank     = STATUS_RANK[status] ?? 0;
      const shouldUpgrade = newRank > currentRank;

      const patch = {};
      if (shouldUpgrade) {
        patch.status = status;
        if (status === 'delivered' && delivered_date) patch.delivered_date = delivered_date;
      }
      if (order_url && !existing.order_url) patch.order_url = order_url;
      // Refresh quantities if the existing row has zeroes (e.g. delivery-only insert)
      if (totalQty > 0 && (existing.flat_qty + existing.tilting_qty + existing.full_motion_qty) === 0) {
        patch.flat_qty = flat_qty;
        patch.tilting_qty = tilting_qty;
        patch.full_motion_qty = full_motion_qty;
      }

      if (Object.keys(patch).length === 0) {
        results.push({ business: biz.slug, action: 'unchanged', status: existing.status });
        continue;
      }

      const { error: upErr } = await db.from('bracket_purchases').update(patch).eq('id', existing.id);
      results.push({
        business: biz.slug,
        action:   upErr ? 'update_failed' : 'updated',
        patch,
        error:    upErr?.message,
      });
    } else {
      // New order — skip if no quantities (e.g. bare delivery email for unknown order)
      if (totalQty === 0) {
        results.push({ business: biz.slug, action: 'skipped', reason: 'no_qty_for_new_order' });
        continue;
      }

      const { error: insErr } = await db.from('bracket_purchases').insert({
        business_id:    biz.id,
        technician_id:  null,       // unassigned until admin assigns in the Brackets tab
        walmart_order_num,
        flat_qty,
        tilting_qty,
        full_motion_qty,
        status,
        order_date,
        delivered_date,
        order_url,
      });

      results.push({
        business: biz.slug,
        action:   insErr ? 'insert_failed' : 'created',
        error:    insErr?.message,
      });
    }
  }

  console.log('[bracket-sync]', walmart_order_num, results.map(r => `${r.business}:${r.action}`).join(', '));
  return res.status(200).json({ ok: true, order: walmart_order_num, results });
}
