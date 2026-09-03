// Single JS entry point onto the bracket_moves ledger (migration 0088).
//
// Every place in this codebase that used to hand-roll "read the count, add a
// delta, write it back" now calls one of the functions below instead. They all
// go through the bracket_move() Postgres function, which is the ONLY thing
// allowed to change bracket_inventory.flat_qty/tilting_qty/full_motion_qty:
// it writes the signed delta to an append-only ledger AND updates the counter
// in one transaction, keyed by an idempotency_key so calling the same event
// twice (a re-run backfill, a double-click, a re-parsed email) is a no-op.
//
// This does NOT cover wire_plate_qty or appletv_bracket_qty yet -- those still
// go through the old direct-write helpers. Same bug class, follow-up work.

export function bracketTotal(q) { return Math.abs(q.flat || 0) + Math.abs(q.tilting || 0) + Math.abs(q.full_motion || 0); }

async function callBracketMove(db, { businessId, technicianId, kind, flat, tilting, fullMotion, idempotencyKey, bookingId, purchaseId, orderNum, reason, actor }) {
  const { data, error } = await db.rpc('bracket_move', {
    p_business_id: businessId,
    p_technician_id: technicianId,
    p_kind: kind,
    p_flat: flat || 0,
    p_tilting: tilting || 0,
    p_full_motion: fullMotion || 0,
    p_idempotency_key: idempotencyKey,
    p_booking_id: bookingId || null,
    p_purchase_id: purchaseId || null,
    p_order_num: orderNum || null,
    p_reason: reason || null,
    p_actor: actor || null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

// A job consumed brackets. idempotencyKey defaults to job:<bookingId> so a
// backfill, a retry, or a re-completion of the same job can never double-debit
// -- calling this twice for the same booking just returns the first result.
export async function debitForJob(db, { businessId, technicianId, qtys, bookingId, reason, actor }) {
  if (!technicianId || !bookingId || bracketTotal(qtys) <= 0) return null;
  return callBracketMove(db, {
    businessId, technicianId, kind: 'job_use',
    flat: -(qtys.flat || 0), tilting: -(qtys.tilting || 0), fullMotion: -(qtys.full_motion || 0),
    idempotencyKey: `job:${bookingId}`, bookingId, reason: reason || 'job completion', actor,
  });
}

// Reverse a job's debit (reopened/cancelled/reassigned). Keyed off the ORIGINAL
// job move so it can only ever reverse that one event once.
export async function reverseJobDebit(db, { businessId, technicianId, qtys, bookingId, reason, actor }) {
  if (!technicianId || !bookingId || bracketTotal(qtys) <= 0) return null;
  return callBracketMove(db, {
    businessId, technicianId, kind: 'job_reversal',
    flat: qtys.flat || 0, tilting: qtys.tilting || 0, fullMotion: qtys.full_motion || 0,
    idempotencyKey: `job-rev:${bookingId}`, bookingId, reason: reason || 'job reopened/reassigned', actor,
  });
}

// A job's bracket quantities changed after completion (line-item edit). Keyed
// per li_rev so each distinct edit reconciles exactly once, in either direction.
export async function reconcileJobEdit(db, { businessId, technicianId, oldQtys, newQtys, bookingId, liRev, reason, actor }) {
  const flat = (oldQtys.flat || 0) - (newQtys.flat || 0);
  const tilting = (oldQtys.tilting || 0) - (newQtys.tilting || 0);
  const fullMotion = (oldQtys.full_motion || 0) - (newQtys.full_motion || 0);
  if (!technicianId || !bookingId || (!flat && !tilting && !fullMotion)) return null;
  return callBracketMove(db, {
    businessId, technicianId, kind: 'adjust',
    flat, tilting, fullMotion,
    idempotencyKey: `job-edit:${bookingId}:${liRev != null ? liRev : Date.now()}`,
    bookingId, reason: reason || 'line items edited after completion', actor,
  });
}

// A Walmart delivery credited a tech's stock. Keyed on the order number so the
// same delivery (re-parsed email, re-run sync, double-click Assign) can only
// ever credit once.
export async function creditDelivery(db, { businessId, technicianId, qtys, purchaseId, orderNum, actor }) {
  if (!technicianId || !orderNum || bracketTotal(qtys) <= 0) return null;
  return callBracketMove(db, {
    businessId, technicianId, kind: 'delivery',
    flat: qtys.flat || 0, tilting: qtys.tilting || 0, fullMotion: qtys.full_motion || 0,
    idempotencyKey: `delivery:${orderNum}`, purchaseId, orderNum, reason: 'Walmart delivery', actor,
  });
}

// A delivery's quantities were corrected by a follow-up email, or the order
// was cancelled after being credited. Keyed so each distinct correction only
// ever applies once.
export async function adjustDelivery(db, { businessId, technicianId, deltaQtys, purchaseId, orderNum, tag, reason, actor }) {
  if (!technicianId || !orderNum || bracketTotal(deltaQtys) <= 0) return null;
  return callBracketMove(db, {
    businessId, technicianId, kind: 'delivery_reversal',
    flat: deltaQtys.flat || 0, tilting: deltaQtys.tilting || 0, fullMotion: deltaQtys.full_motion || 0,
    idempotencyKey: `delivery-adj:${orderNum}:${tag}`, purchaseId, orderNum, reason: reason || 'delivery correction', actor,
  });
}

// A physical recount ("I counted the truck"). Pass the ABSOLUTE counts
// observed for each field you're recounting (omit a field to leave it
// untouched) -- the database computes the signed delta itself, so the ledger
// always records what actually moved. reason is REQUIRED. Idempotency key
// includes the timestamp so it never collides across recounts, but each call
// is still one atomic, logged event.
export async function recount(db, { businessId, technicianId, flat, tilting, fullMotion, reason, actor, at }) {
  if (!technicianId || !reason) throw new Error('recount requires technicianId and reason');
  const ts = at || new Date().toISOString();
  return callBracketMove(db, {
    businessId, technicianId, kind: 'recount',
    flat: flat == null ? null : flat, tilting: tilting == null ? null : tilting, fullMotion: fullMotion == null ? null : fullMotion,
    idempotencyKey: `recount:${technicianId}:${ts}`, reason, actor,
  });
}

// A free-form correction with a signed delta and a mandatory reason (replaces
// the old "manual adjust" action). Pass idempotencyKey explicitly for an event
// that can be retried (e.g. keyed on a booking id) so a retry can't double-
// apply; otherwise a timestamp-based key is generated (fine for one-off admin
// clicks, where "retry = a new correction" is the right behavior).
export async function adjust(db, { businessId, technicianId, deltaQtys, bookingId, reason, actor, at, idempotencyKey }) {
  if (!technicianId || !reason || bracketTotal(deltaQtys) <= 0) return null;
  const ts = at || new Date().toISOString();
  return callBracketMove(db, {
    businessId, technicianId, kind: 'adjust',
    flat: deltaQtys.flat || 0, tilting: deltaQtys.tilting || 0, fullMotion: deltaQtys.full_motion || 0,
    idempotencyKey: idempotencyKey || `adjust:${technicianId}:${ts}`, bookingId, reason, actor,
  });
}
