-- ============================================================================
-- Migration 0054: Estimate approval — card on file + service address
-- ----------------------------------------------------------------------------
-- When a customer APPROVES an estimate they now must give us (a) a card to hold
-- on file and (b) their full service address, so the office has everything
-- needed to book the appointment. These columns store what the approve page
-- collects. The card itself lives in Stripe; we keep only the customer id +
-- brand/last4 for display (never the full number).
--   customer_address / customer_city / customer_state — service address
--     (customer_zip / customer_name / customer_phone / customer_email already
--      exist from 0016 / 0017).
--   stripe_customer_id — the Stripe customer holding the saved card.
--   card_brand / card_last4 — for showing "Visa ···· 4242" on the estimate.
-- Idempotent. Run after 0053.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates
  add column if not exists customer_address   text,
  add column if not exists customer_city      text,
  add column if not exists customer_state     text,
  add column if not exists stripe_customer_id text,
  add column if not exists card_brand         text,
  add column if not exists card_last4         text;

-- Verify:
--   select id, customer_name, customer_address, customer_city, customer_state,
--          customer_zip, stripe_customer_id, card_brand, card_last4, approved_at
--   from estimates where approved_at is not null order by approved_at desc;
-- ============================================================================
