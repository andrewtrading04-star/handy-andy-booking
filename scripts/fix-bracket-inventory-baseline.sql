-- ============================================================================
-- Bracket inventory — one-time baseline correction to physical counts
-- ----------------------------------------------------------------------------
-- Brackets were only ever decremented on TWO-tech jobs (via the supplier picker),
-- so solo-job techs' counts drifted high. The app now auto-decrements on EVERY
-- job completion (fixed in code). This resets the current on-hand counts to what
-- the techs physically have, so tracking is correct from here forward.
--   TK:   1 Full Motion  (owner-reported; flat/tilting left untouched)
--   Greg: 3 Full Motion, 2 Flat, 2 Tilting
-- Add more techs below as you count them.
-- ============================================================================

-- TK — set Full Motion to the physical count (1).
update app.bracket_inventory bi
set full_motion_qty = 1, updated_at = now()
from app.technicians t
where t.id = bi.technician_id and t.name ilike 'tk%'
returning t.name, bi.flat_qty, bi.tilting_qty, bi.full_motion_qty;

-- Greg — set all three to the physical counts.
update app.bracket_inventory bi
set full_motion_qty = 3, flat_qty = 2, tilting_qty = 2, updated_at = now()
from app.technicians t
where t.id = bi.technician_id and t.name ilike 'greg%'
returning t.name, bi.flat_qty, bi.tilting_qty, bi.full_motion_qty;

-- Template for any other tech (fill in the physical counts):
--   update app.bracket_inventory bi
--   set full_motion_qty = <N>, flat_qty = <N>, tilting_qty = <N>, updated_at = now()
--   from app.technicians t
--   where t.id = bi.technician_id and t.name ilike '<name>%';
-- ============================================================================
