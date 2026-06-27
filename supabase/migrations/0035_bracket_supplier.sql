-- ============================================================================
-- Migration 0035: Who supplied the bracket on a job
-- ----------------------------------------------------------------------------
-- On a two-person job only ONE tech supplies the bracket. The tech app now makes
-- one of them record who supplied it before the job can be completed; that tech's
-- bracket_inventory is decremented for the bracket type(s) on the job.
--
--   bracket_supplied_by  -> the technician whose stock the bracket came from
--   bracket_supplied_at  -> when it was recorded
--
-- Additive + idempotent. Run after 0034.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists bracket_supplied_by uuid references technicians(id) on delete set null;
alter table bookings add column if not exists bracket_supplied_at timestamptz;

-- ============================================================================
-- DONE.
-- ============================================================================
