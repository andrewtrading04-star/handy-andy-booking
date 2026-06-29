-- ============================================================================
-- Migration 0039: Wire concealment plate inventory (per technician)
-- ============================================================================
-- Adds a per-tech count of "Wire Concealment plates" alongside brackets. Plates
-- are sourced from Amazon. The count decrements by one (per unit) when a
-- technician completes a job that includes the "Hide wires BEHIND the wall"
-- service. Additive + idempotent. Run after 0038.
-- ============================================================================
set search_path = app, public, extensions;

alter table bracket_inventory add column if not exists wire_plate_qty  integer not null default 0;
alter table bracket_usage_logs add column if not exists wire_plate_used integer not null default 0;

-- ============================================================================
-- DONE. Verify with:
--   select technician_id, wire_plate_qty from bracket_inventory;
-- ============================================================================
