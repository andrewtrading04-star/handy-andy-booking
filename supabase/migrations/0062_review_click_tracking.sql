-- ============================================================================
-- Migration 0062: Unified review click tracking (email + SMS)
-- ----------------------------------------------------------------------------
-- Replaces the email open-pixel with click tracking that works identically for
-- both channels. The review link in the email AND the SMS now routes through
-- /api/book?action=review_click&ch=email|sms, which stamps:
--   • review_clicked_at     — first time the customer clicked the review link
--   • review_click_channel  — 'email' or 'sms' (which channel that first click came from)
--   • review_sms_sent_at    — when the review-request SMS went out (parallels review_email_sent_at)
-- The old review_email_opened_at column stays for historical data but is no
-- longer written.
--
-- The code also stamps the same keys in bookings.metadata as a fallback, so it
-- works before AND after this migration — the columns just make it queryable.
--
-- Additive + idempotent. Run after 0061.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists review_clicked_at    timestamptz;
alter table bookings add column if not exists review_click_channel text;
alter table bookings add column if not exists review_sms_sent_at   timestamptz;

-- Backfill from the metadata stamps written while this migration wasn't applied.
update bookings
set review_clicked_at = (metadata->>'review_clicked_at')::timestamptz
where review_clicked_at is null
  and metadata ? 'review_clicked_at'
  and (metadata->>'review_clicked_at') is not null;

update bookings
set review_click_channel = metadata->>'review_click_channel'
where review_click_channel is null
  and metadata ? 'review_click_channel';

update bookings
set review_sms_sent_at = (metadata->>'review_sms_sent_at')::timestamptz
where review_sms_sent_at is null
  and metadata ? 'review_sms_sent_at'
  and (metadata->>'review_sms_sent_at') is not null;

-- A click is at least as strong a signal as the old pixel "open" — carry
-- historical pixel opens into clicked_at so old rows don't read as never-engaged.
update bookings
set review_clicked_at = review_email_opened_at,
    review_click_channel = coalesce(review_click_channel, 'email')
where review_clicked_at is null
  and review_email_opened_at is not null;

-- ============================================================================
-- DONE. Verify with:
--   select count(*) filter (where review_clicked_at is not null)  as clicked,
--          count(*) filter (where review_sms_sent_at is not null) as sms_sent,
--          count(*) filter (where review_rating is not null)      as reviewed
--     from bookings;
-- ============================================================================
