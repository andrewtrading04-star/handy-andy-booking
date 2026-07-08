-- ============================================================================
-- Migration 0056: track the PRICE we paid per Walmart bracket order.
-- ----------------------------------------------------------------------------
-- The order total ("Includes all fees, taxes and discounts $XX.XX") is parsed
-- from the Walmart order email and stored here, so the Bracket Inventory page can
-- show what each order cost and a running total spent. Additive + idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table bracket_purchases
  add column if not exists order_total numeric(10,2);

-- Verify:
--   select walmart_order_num, order_total, status from bracket_purchases order by created_at desc limit 10;
-- ============================================================================
