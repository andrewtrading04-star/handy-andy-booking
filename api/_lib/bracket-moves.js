import { requireBracketQuantities } from './bracket-materials.js';

export function bracketTotal(q = {}) { return Object.values(requireBracketQuantities(q, { signed: true })).reduce((a, n) => a + Math.abs(n), 0); }
async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (row == null) throw new Error(`${name} did not confirm the inventory operation.`);
  return row;
}
function eventId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error('A stable inventory request ID is required.');
  return value;
}
export async function saveJobInventory(db, { bookingId, businessId, expectedLiRev, expectedUpdatedAt = null, patch = {}, lineItems = null,
  materials, requestId, actor, actorTechnicianId = null, confirmUse = false, requestFingerprint = null }) {
  if (!bookingId || !businessId || !Number.isInteger(expectedLiRev) || expectedLiRev < 0 || !materials?.source_lines) throw new Error('The job must be refreshed before updating inventory.');
  requireBracketQuantities(materials.qtys);
  return rpc(db, 'inventory_job_write', { p_booking_id: bookingId, p_business_id: businessId, p_expected_li_rev: expectedLiRev,
    p_expected_updated_at: expectedUpdatedAt, p_patch: patch, p_line_items: lineItems, p_materials: materials,
    p_request_id: eventId(requestId), p_actor: actor || 'office', p_actor_technician_id: actorTechnicianId, p_confirm_use: confirmUse, p_request_fingerprint: requestFingerprint });
}
export async function syncBracketOrder(db, { orderNum, ...payload }) {
  eventId(payload.event_id);
  if (!orderNum || typeof orderNum !== 'string') throw new Error('An order number is required.');
  if (payload.ordered) payload.ordered = requireBracketQuantities(payload.ordered);
  if (payload.received) payload.received = requireBracketQuantities(payload.received);
  return rpc(db, 'ingest_bracket_order', { p_order_num: orderNum.trim(), p_payload: payload });
}
export async function recount(db, { technicianId, flat, tilting, fullMotion, reason, actor, expectedUpdatedAt, requestId, at }) {
  if (!technicianId || !reason?.trim() || !expectedUpdatedAt) throw new Error('A recount requires the technician, reason, and current inventory version.');
  const counts = requireBracketQuantities({ flat, tilting, full_motion: fullMotion }, { partial: true });
  if (!Object.keys(counts).length) throw new Error('Enter at least one physical count.');
  return rpc(db, 'inventory_recount', { p_technician_id: technicianId, p_counts: counts, p_expected_updated_at: expectedUpdatedAt === 'uninitialized' ? null : expectedUpdatedAt,
    p_request_id: eventId(requestId || at), p_reason: reason, p_actor: actor || 'office' });
}
export async function adjust(db, { businessId, technicianId, deltaQtys, bookingId, reason, actor, idempotencyKey, requestId }) {
  if (!technicianId || !reason?.trim()) throw new Error('An adjustment requires a technician and reason.');
  const q = requireBracketQuantities(deltaQtys, { signed: true });
  return rpc(db, 'bracket_move', { p_business_id: businessId || null, p_technician_id: technicianId, p_kind: 'adjust',
    p_flat: q.flat, p_tilting: q.tilting, p_full_motion: q.full_motion, p_idempotency_key: eventId(idempotencyKey || requestId),
    p_booking_id: bookingId || null, p_purchase_id: null, p_order_num: null, p_reason: reason, p_actor: actor || 'office' });
}
// Legacy mutation APIs fail closed; deploy migration and all callers together.
export async function debitForJob() { throw new Error('Job inventory requires inventory_job_write (migration 0112).'); }
export async function reverseJobDebit() { throw new Error('Record a reviewed material correction through inventory_job_write.'); }
export async function reconcileJobEdit() { throw new Error('Job edits require inventory_job_write (migration 0112).'); }
export async function creditDelivery() { throw new Error('Receipts require ingest_bracket_order and verified delivered quantities.'); }
export async function adjustDelivery() { throw new Error('Receipt corrections require ingest_bracket_order and verified cumulative quantities.'); }
