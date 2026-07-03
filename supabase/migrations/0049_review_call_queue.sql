-- ============================================================================
-- Migration 0049: Review-call queue (Joey's daily review outreach)
-- ----------------------------------------------------------------------------
-- Joey calls customers the day after their job to thank them, nudge a Google
-- review (via the email review filter), and promote handyman labor. These
-- columns record the outcome of each call so a customer isn't called twice and
-- resolved ones drop off the queue.
--
--   review_call_status  text  -- null = not called yet; else one of:
--                             --   'called'         reached them / spoke
--                             --   'voicemail'      left a message
--                             --   'callback'       call again later
--                             --   'reviewed'       confirmed they left a review (drops off)
--                             --   'declined'       not interested
--                             --   'do_not_contact' never call (drops off)
--   review_call_at      timestamptz  -- when the outcome was last logged
--   review_call_by      text         -- who logged it (owner / secretary name)
--   review_call_notes   text         -- optional free-text note from the call
--
-- "Did they leave a Google review?" is answered by review_rating (>= 4 means the
-- email filter routed them to Google) — those are excluded from the queue in the
-- app, so no extra column is needed here.
-- Idempotent. Run after 0048.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists review_call_status text;
alter table bookings add column if not exists review_call_at     timestamptz;
alter table bookings add column if not exists review_call_by      text;
alter table bookings add column if not exists review_call_notes   text;

-- Pull the day's queue fast (completed jobs, recent first).
create index if not exists idx_bookings_review_call
  on bookings (business_id, status, completed_at)
  where status = 'completed';

-- ============================================================================
-- DONE. Verify with:
--   select id, completed_at, review_rating, review_call_status, review_call_at
--   from bookings where status = 'completed' order by completed_at desc limit 20;
-- ============================================================================
