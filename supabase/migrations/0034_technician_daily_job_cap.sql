-- ============================================================================
-- Migration 0034: Per-technician daily job cap
-- ----------------------------------------------------------------------------
-- Lets the OWNER limit how many jobs a technician can be booked for in a single
-- day (e.g. cap Gregory at 2/day). NULL = no limit (default). Enforced in the
-- public booking engine: a tech at their cap for a date stops being offered or
-- auto-assigned new slots that day.
--
-- Additive + idempotent. Run after 0033.
-- ============================================================================
set search_path = app, public, extensions;

alter table technicians add column if not exists max_jobs_per_day integer;

-- ============================================================================
-- DONE. (Set a cap from the dashboard → Technicians, owner only.)
--   e.g.  update technicians set max_jobs_per_day = 2 where name = 'Gregory';
-- ============================================================================
