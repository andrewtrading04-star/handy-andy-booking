import { createHash } from 'node:crypto';
import { syncBracketOrder } from './bracket-moves.js';
import { matchBracketShippingAddress } from './bracket-shipping.js';

function invalid(message,status = 400) { throw Object.assign(new Error(message),{status}); }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
// No purchase/counter writes here. The RPC owns the atomic event, purchase and
// receipt movement. Legacy status-only workflow calls become review requests.
export async function ingestWalmartOrder(db,body = {}) {
  const orderNum = String(body.walmart_order_num || '').trim();
  if (!/^\d{7}-\d{8}$/.test(orderNum)) invalid('Valid walmart_order_num required');
  if (!['ordered','in_route','delivered','canceled'].includes(body.status || 'in_route')) invalid('Invalid order status');
  for (const field of ['ordered','received']) {
    if (body[field] == null) continue;
    if (typeof body[field] !== 'object' || Array.isArray(body[field]) || ['flat','tilting','full_motion'].some(k => !Number.isInteger(body[field][k]) || body[field][k] < 0 || body[field][k] > 1000)) invalid('Explicit non-negative integer quantities required');
  }
  const {data:rows,error:rowsErr} = await db.from('bracket_purchases').select('id,business_id,technician_id').eq('walmart_order_num',orderNum);
  if (rowsErr) throw rowsErr;
  const {data:businesses,error:bizErr} = await db.from('businesses').select('id,slug').eq('active',true);
  if (bizErr) throw bizErr;
  const verifiedSource = body.source === 'walmart_email' && body.provenance?.trusted === true
    && ['authenticated_supplier','authenticated_forwarder'].includes(body.provenance?.kind);
  const assigned = (rows || []).filter(r => r.technician_id), techIds = new Set(assigned.map(r => r.technician_id));
  const matched = verifiedSource && body.delivery_address ? await matchBracketShippingAddress(db,body.delivery_address) : null;
  const issues = [body.review_reason].filter(Boolean);
  if (!verifiedSource) issues.push('supplier_or_legacy_event_requires_review');
  if (techIds.size > 1) issues.push('ambiguous_order_assignment');
  if (matched && assigned.length && !techIds.has(matched.id)) issues.push('shipping_address_conflicts_with_assignment');
  const own = techIds.size === 1 ? assigned[0] : (rows || [])[0];
  const technicianId = techIds.size === 1 ? assigned[0].technician_id : matched?.id || null;
  const businessId = own?.business_id || matched?.business_id || (businesses || []).find(b => b.slug === 'handy-andy')?.id || (businesses?.length === 1 ? businesses[0].id : null);
  if (!businessId) invalid('No unambiguous business for this supplier order',422);
  if (!technicianId) issues.push('shipping_address_unassigned');
  const eventId = String(body.event_id || ('legacy-status:' + createHash('sha256').update(JSON.stringify({orderNum,status:body.status || 'in_route'})).digest('hex')));
  if (eventId.length > 250 || !eventId.trim()) invalid('Invalid event identifier');
  const result = await syncBracketOrder(db,{
    orderNum,event_id:eventId,business_id:businessId,technician_id:technicianId,
    // Assignment/review state may change between scans; the source message did
    // not. Database replay identity compares this immutable source fingerprint.
    source_fingerprint:createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'),
    facts_verified:verifiedSource && !body.review_reason,
    ordered:verifiedSource ? body.ordered || null : null,received:verifiedSource ? body.received || null : null,
    receipt_scope:verifiedSource && ['complete','cumulative'].includes(body.receipt_scope) ? body.receipt_scope : 'unknown',
    receipt_verified:verifiedSource && body.receipt_verified === true,status:body.status || 'in_route',occurred_at:body.occurred_at || null,
    order_date:body.order_date || null,delivered_date:body.delivered_date || null,estimated_delivery:body.estimated_delivery || null,
    order_url:body.order_url || null,order_total:body.order_total ?? null,source:verifiedSource ? 'walmart_email' : 'legacy_status_override',
    evidence:{...(body.evidence || {}),shipping_address_id:matched?.shipping_address_id || null,delivery_address:body.delivery_address || null},
    review_reason:issues.length ? [...new Set(issues)].join(', ') : null,actor:'system:bracket-sync',
  });
  if (!result || result.ok !== true || !['synced','review','duplicate'].includes(result.status)) throw new Error('Receipt operation did not confirm persistence');
  return {ok:true,order:orderNum,...result};
}
