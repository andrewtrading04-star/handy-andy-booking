-- ============================================================================
-- Juan's Walmart bracket order DELIVERED — mark delivered + credit inventory
-- ----------------------------------------------------------------------------
-- Order 2000149-97869279 delivered Jul 6, 2026 (confirmed by Walmart email):
--   5 × Full Motion + 5 × Tilting + 5 × Fixed (Flat) = 15 brackets.
-- Run STEP 1 to confirm the order + Juan's current counts, then STEP 2 + 3.
-- ============================================================================

-- ── STEP 1 — INSPECT ─────────────────────────────────────────────────────────
select bp.id, bp.walmart_order_num, bp.status, bp.flat_qty, bp.tilting_qty,
       bp.full_motion_qty, bp.technician_id, bp.delivered_date
from app.bracket_purchases bp
where bp.walmart_order_num = '2000149-97869279';

select t.name, bi.flat_qty, bi.tilting_qty, bi.full_motion_qty
from app.bracket_inventory bi
join app.technicians t on t.id = bi.technician_id
where t.name ilike 'juan%';

-- ── STEP 2 — Mark the order DELIVERED (assign to Juan if unassigned) ──────────
update app.bracket_purchases bp
set status = 'delivered',
    delivered_date = '2026-07-06',
    flat_qty = 5, tilting_qty = 5, full_motion_qty = 5,
    technician_id = coalesce(
      bp.technician_id,
      (select id from app.technicians where name ilike 'juan%' and business_id = bp.business_id limit 1))
where bp.walmart_order_num = '2000149-97869279'
returning walmart_order_num, status, flat_qty, tilting_qty, full_motion_qty, delivered_date;

-- ── STEP 3 — Credit Juan's on-hand inventory (+5 / +5 / +5) ───────────────────
-- Creates his inventory row if missing. Since he was reset to 0 earlier, this
-- makes him 5 Flat / 5 Tilting / 5 Full Motion.
insert into app.bracket_inventory (business_id, technician_id, flat_qty, tilting_qty, full_motion_qty)
select t.business_id, t.id, 5, 5, 5
from app.technicians t
where t.name ilike 'juan%'
on conflict (business_id, technician_id) do update
  set flat_qty        = app.bracket_inventory.flat_qty + 5,
      tilting_qty     = app.bracket_inventory.tilting_qty + 5,
      full_motion_qty = app.bracket_inventory.full_motion_qty + 5;

-- Verify: Juan should now read 5 / 5 / 5, and the order should be 'delivered'.
--   (re-run STEP 1's two SELECTs)
-- ============================================================================
