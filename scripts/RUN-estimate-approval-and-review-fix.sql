-- ============================================================================
-- Paste-and-run: estimate-approval card/address columns + review-open backfill
-- ----------------------------------------------------------------------------
-- Two independent updates in one file. Schema-qualified (app.) so it runs as-is
-- in the Supabase SQL editor. Both are idempotent — safe to run more than once.
-- ============================================================================

-- ── 1) Estimate approval: card on file + service address (migration 0054) ─────
-- Lets the "Approve" page store the customer's card-on-file + address so the
-- office can book. (customer_zip/name/phone/email already exist.)
alter table app.estimates
  add column if not exists customer_address   text,
  add column if not exists customer_city      text,
  add column if not exists customer_state     text,
  add column if not exists stripe_customer_id text,
  add column if not exists card_brand         text,
  add column if not exists card_last4         text;

-- ── 2) Review "email opened" backfill (Noah Ciminski + anyone like him) ───────
-- The open flag was set only by an email tracking pixel, which Gmail/Outlook
-- routinely block — so a customer who clearly opened the email (they left a
-- review!) still showed "not opened". A submitted review is proof they opened
-- it, so backfill the open time from the review time wherever it's missing.
-- (Going forward the app records this automatically on link-click / review.)
update app.bookings
set review_email_opened_at = reviewed_at
where reviewed_at is not null
  and review_email_opened_at is null
returning id, reviewed_at;

-- Verify #2 (should return 0 rows once fixed):
--   select count(*) from app.bookings
--   where reviewed_at is not null and review_email_opened_at is null;
-- ============================================================================
