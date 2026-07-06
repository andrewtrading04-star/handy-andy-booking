-- ============================================================================
-- Migration 0052: Extra time slots on a booking (big jobs)
-- ----------------------------------------------------------------------------
-- A booking normally occupies ONE fixed daily slot (derived from scheduled_at).
-- For an occasional big job the office can reserve ADDITIONAL slots so the
-- technician isn't double-booked into them. extra_slots holds those extra slot
-- keys (e.g. '{s3}') — same day, same technician(s). Availability everywhere
-- (office, public widget, auto-assign, the schedule grid) treats a job's
-- extra_slots as busy, exactly like its main slot.
--
-- Idempotent. Run after 0051.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings
  add column if not exists extra_slots text[] not null default '{}';

-- ============================================================================
-- DONE.
-- ============================================================================
