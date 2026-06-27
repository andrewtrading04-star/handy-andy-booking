-- ============================================================================
-- Migration 0033: Review-request tracking
-- ----------------------------------------------------------------------------
-- Lets the Reviews tab track each completed job's "How did we do?" email:
--   • review_email_sent_at   — when the request email last went out
--   • review_email_opened_at — first time the customer opened it (tracking pixel)
--   • review_email_count     — how many times we've sent it (resends)
-- "Did they submit a review?" is already answered by review_rating / reviewed_at.
--
-- Additive + idempotent. Run after 0032.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists review_email_sent_at   timestamptz;
alter table bookings add column if not exists review_email_opened_at timestamptz;
alter table bookings add column if not exists review_email_count      integer not null default 0;

-- Backfill sent_at from the metadata we already stamped on completion, so jobs
-- completed before this migration still show as "sent".
update bookings
set review_email_sent_at = (metadata->>'review_email_sent_at')::timestamptz
where review_email_sent_at is null
  and metadata ? 'review_email_sent_at'
  and (metadata->>'review_email_sent_at') is not null;

-- ============================================================================
-- DONE. Verify with:
--   select count(*) filter (where review_email_sent_at is not null)   as sent,
--          count(*) filter (where review_email_opened_at is not null) as opened,
--          count(*) filter (where review_rating is not null)          as reviewed
--     from bookings;
-- ============================================================================
