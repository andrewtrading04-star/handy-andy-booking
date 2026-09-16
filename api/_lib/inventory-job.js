import { createHash } from 'node:crypto';
import { saveJobInventory } from './bracket-moves.js';
import { classifyBracketMaterials } from './bracket-materials.js';

const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export function inventoryRequestId(body, action, revision = 0) {
  if (body.operation_id != null) {
    if (typeof body.operation_id !== 'string' || !body.operation_id.trim() || body.operation_id.length > 180) throw new Error('Invalid inventory operation ID.');
    return `${action}:${body.operation_id}`;
  }
  return `${action}:${createHash('sha256').update(JSON.stringify(canonical({ body, revision }))).digest('hex')}`;
}
export function inventoryError(res, error) {
  const message = String(error?.message || error);
  const conflict = /conflict|stale|refresh|revision|li_rev|version|changed|request.*reus|idempotenc/i.test(message);
  const unavailable = /does not exist|schema cache|function .*not found/i.test(message);
  const invalid = /required|invalid|insufficient|pick|assigned|quantity|count|supplier|reason|whole number|already belongs|not found|use a physical|use.*receipt|confirm actual/i.test(message);
  let userMessage=message;
  if (/^inventory_/.test(message)) {
    if (/idempotency/.test(message)) userMessage='This attempt was already recorded with different details. Close and reopen the form before submitting a different change.';
    else if (conflict) userMessage='This record changed after it was opened. Refresh it, review the latest values, then try again.';
    else if (/insufficient/.test(message)) userMessage='There is not enough recorded stock for this transfer. Verify the physical count first.';
    else if (/reason/.test(message)) userMessage='Explain why this stock change is needed (at least 8 characters for transfers and recipient corrections).';
    else if (/quantity|quantities|count/.test(message)) userMessage='Enter valid whole bracket quantities. If you are correcting an old receipt, review its history first.';
    else if (/recipient|technician|assigned/.test(message)) userMessage='Choose a valid technician. A job supplier must be assigned to that job.';
    else userMessage='This inventory change could not be saved. Refresh the record and check the inventory review queue.';
  }
  return res.status(unavailable ? 503 : conflict ? 409 : invalid ? 400 : 500)
    .json({ error: unavailable ? 'Inventory update is not ready. Refresh shortly; no inventory change was saved.' : userMessage,
      code: conflict ? 'li_conflict' : unavailable ? 'inventory_unavailable' : 'inventory_error' });
}
export async function writeInventoryJob(db, { booking, businessId, body, action, actor, actorTechnicianId = null,
  patch = {}, lineItems = null, confirmUse = false }) {
  let lines = lineItems;
  if (lines == null) {
    const r = await db.from('booking_line_items').select('name,quantity,material_type,material_owner').eq('booking_id', booking.id).eq('business_id', businessId);
    if (r.error) throw r.error;
    lines = r.data || [];
  }
  if (patch.metadata) {
    const before = booking.metadata || {}, after = patch.metadata;
    patch = { ...patch, metadata: Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map(k => [k, Object.hasOwn(after, k) ? after[k] : null])) };
  }
  const rev = body.li_rev == null ? Number(booking.metadata?.li_rev) || 0 : Number(body.li_rev);
  return saveJobInventory(db, { bookingId: booking.id, businessId, expectedLiRev: rev,
    expectedUpdatedAt: lineItems == null ? booking.updated_at || null : null, patch, lineItems,
    materials: classifyBracketMaterials(lines), requestId: inventoryRequestId(body, action, rev),
    requestFingerprint: createHash('sha256').update(JSON.stringify(canonical({action,body}))).digest('hex'),
    actor, actorTechnicianId, confirmUse });
}
