-- ============================================================================
-- Migration 0099: business-hours routing for tracking numbers
-- ----------------------------------------------------------------------------
-- A tracking number forwards to ONE handset today. The eight Austin/Houston
-- lead-gen lines are answered by Joey during the day, but outside her hours a
-- customer calling them would still ring her phone at 3am — so a line now
-- carries an optional second destination and the window that separates them.
--
-- Deliberately per-ROW rather than a global setting: the markets are in
-- different timezones (Denver lines are Mountain, Austin/Houston are Central),
-- and the day/night split is not something every brand wants. Nulls mean
-- "behave exactly as before", so every existing line is unaffected until it is
-- explicitly given a window.
--
-- Idempotent. Run after 0098.
-- ============================================================================
set search_path = app, public, extensions;

alter table app.tracking_numbers
  -- Where to send the call OUTSIDE the window below. NULL = no after-hours
  -- routing at all: forward_to is used around the clock, exactly as before.
  add column if not exists after_hours_forward_to text,
  -- Local hour the window opens (inclusive) and closes (exclusive), 0-23, so
  -- 8 and 20 means 8:00am through 7:59pm. Same-day only; a window that wraps
  -- past midnight is not expressible and is not needed by any line today.
  add column if not exists hours_start           smallint,
  add column if not exists hours_end             smallint,
  -- IANA zone the two hours above are read in. The market's own zone, not the
  -- server's and not the office's — a Houston customer dialing at 7pm their
  -- time is inside the window regardless of where anyone else is.
  add column if not exists hours_timezone        text;

-- Both bounds must be real hours, and the window must be a forward span. A
-- half-configured row (a start with no end, an after-hours number with no
-- window) would otherwise route unpredictably rather than fail loudly here.
alter table app.tracking_numbers
  drop constraint if exists tracking_numbers_hours_valid;
alter table app.tracking_numbers
  add constraint tracking_numbers_hours_valid check (
    (hours_start is null and hours_end is null and hours_timezone is null)
    or (
      hours_start between 0 and 23
      and hours_end between 1 and 24
      and hours_start < hours_end
      and hours_timezone is not null
    )
  );

comment on column app.tracking_numbers.after_hours_forward_to is
  'Destination outside [hours_start, hours_end) in hours_timezone. NULL = forward_to is used 24/7.';
