-- ============================================================================
-- Migration 0057: store the ESTIMATED delivery date per Walmart bracket order.
-- ----------------------------------------------------------------------------
-- Parsed from the "Arrives <Mon DD>" line in the Walmart order/shipping email.
-- The tech app shows this on the "In Route" card so a tech knows what's coming
-- and roughly when. Additive + idempotent; safe to run more than once.
-- ============================================================================
set search_path = app, public, extensions;

alter table bracket_purchases
  add column if not exists estimated_delivery date;

-- Verify:
--   select walmart_order_num, status, estimated_delivery from bracket_purchases
--   where status = 'in_route' order by created_at desc limit 10;
-- ============================================================================
