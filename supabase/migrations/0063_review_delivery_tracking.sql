-- ============================================================================
-- Migration 0063: Review email/SMS delivery tracking + per-channel opens
-- ----------------------------------------------------------------------------
-- Two things this adds:
--
-- 1) DELIVERY confirmation (not just "we called the send API without an
--    error" — an actual delivered/bounced/failed signal from the provider):
--      review_email_id           — Resend's message id, so its delivery
--                                   webhook (POST /api/analytics?action=email_webhook)
--                                   can match the event back to this booking
--      review_email_delivered_at — when Resend confirmed inbox delivery
--      review_email_status       — 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed'
--      review_sms_delivered_at   — when Twilio confirmed the text was delivered
--      review_sms_status         — 'sent' | 'delivered' | 'failed' | 'undelivered'
--
-- 2) PER-CHANNEL click tracking. The 0062 columns (review_clicked_at,
--    review_click_channel) only ever recorded the FIRST channel a customer
--    clicked from — so a customer who opened both the email and the text link
--    could never show as having opened both, which breaks an honest email-vs-
--    SMS open-rate comparison. These replace that as the source of truth:
--      review_email_clicked_at
--      review_sms_clicked_at
-- The old shared columns are left in place (still updated, for anything still
-- reading them) but are no longer the source of truth for engagement stats.
--
-- Additive + idempotent. Run after 0062.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists review_email_id           text;
alter table bookings add column if not exists review_email_delivered_at timestamptz;
alter table bookings add column if not exists review_email_status      text;
alter table bookings add column if not exists review_sms_delivered_at   timestamptz;
alter table bookings add column if not exists review_sms_status        text;
alter table bookings add column if not exists review_email_clicked_at  timestamptz;
alter table bookings add column if not exists review_sms_clicked_at    timestamptz;

-- Backfill per-channel clicks from the existing shared column + channel flag.
update bookings
set review_email_clicked_at = review_clicked_at
where review_email_clicked_at is null
  and review_click_channel = 'email'
  and review_clicked_at is not null;

update bookings
set review_sms_clicked_at = review_clicked_at
where review_sms_clicked_at is null
  and review_click_channel = 'sms'
  and review_clicked_at is not null;

-- A job that already has a send timestamp but no status yet was sent before
-- this migration — mark it 'sent' (the best we know) rather than leaving it
-- null, which the dashboard would otherwise render as "never sent".
update bookings set review_email_status = 'sent'
  where review_email_status is null and review_email_sent_at is not null;
update bookings set review_sms_status = 'sent'
  where review_sms_status is null and review_sms_sent_at is not null;

create index if not exists bookings_review_email_id_idx on bookings(review_email_id) where review_email_id is not null;

-- ============================================================================
-- DONE. Verify with:
--   select review_email_status, count(*) from bookings group by 1;
--   select review_sms_status, count(*) from bookings group by 1;
--   select count(*) filter (where review_email_clicked_at is not null) as email_opened,
--          count(*) filter (where review_sms_clicked_at is not null)   as sms_opened
--     from bookings;
-- ============================================================================
