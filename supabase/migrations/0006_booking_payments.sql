-- ============================================================================
-- Migration 0006: Booking payment tracking
-- ----------------------------------------------------------------------------
-- The booking already carries payment_status + stripe_customer_id +
-- stripe_payment_method_id. This adds the few fields needed to record an actual
-- charge taken from the dashboard (the business model is "card on file at
-- booking, charged at time of service"):
--   stripe_payment_intent_id  the Stripe PaymentIntent that captured the money
--   paid_at                   when it was marked paid (Stripe OR cash)
--   amount_paid               how much was captured (USD)
-- Run after 0005. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists stripe_payment_intent_id text;
alter table bookings add column if not exists paid_at    timestamptz;
alter table bookings add column if not exists amount_paid numeric(10,2);
