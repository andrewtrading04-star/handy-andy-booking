-- ============================================================================
-- Migration 0041: Credit wire-plate inventory on DELIVERY, not on assignment
-- ============================================================================
-- Plates should only count toward a technician's ON-HAND total once the Amazon
-- order is actually delivered. Assigning an en-route order now just RESERVES it
-- to a tech; the delivery sync credits the plates when it arrives. `credited`
-- tracks that the plates were counted, so it happens exactly once.
--
-- Also reconciles the launch state: earlier the assign added plates immediately
-- (before delivery), so any current on-hand plate count was credited too early.
-- Zero those out and mark every existing plate order uncredited + en route; the
-- tracker re-reads each order's real status from email, and the plates credit on
-- actual delivery. (Only wire-plate inventory is touched — brackets are untouched.)
-- Run after 0040. Additive + idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table wire_plate_purchases add column if not exists credited boolean not null default false;

-- One-time launch reconcile (safe to re-run): no plate order has been physically
-- delivered yet, so nothing should be counted on-hand.
update wire_plate_purchases set credited = false, status = 'in_route', delivered_date = null;
update bracket_inventory   set wire_plate_qty = 0 where wire_plate_qty > 0;

-- ============================================================================
-- DONE. Verify with:
--   select amazon_order_num, status, credited, technician_id, plates from wire_plate_purchases;
--   select technician_id, wire_plate_qty from bracket_inventory;
-- ============================================================================
