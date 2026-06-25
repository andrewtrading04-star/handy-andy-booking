-- ============================================================================
-- Migration 0028: Estimate line items + tax
-- ----------------------------------------------------------------------------
-- Adds a `line_items` column to app.estimates so the office can build a real
-- quote (priced line items) on top of a customer's request, then email/text it.
-- Each element: { description: text, qty: number, unit_price: number }.
-- The line subtotal is the sum of qty * unit_price.
--
-- Adds a `tax_rate` column (default 8.75%) so quotes carry sales tax by
-- default, with a toggle in the dashboard to turn it off (sets the rate to 0).
-- The tax amount and grand total are computed in the app/email, never stored,
-- so they can't drift from the items.
-- Idempotent. Run after 0027.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates
  add column if not exists line_items jsonb not null default '[]'::jsonb;

alter table estimates
  add column if not exists tax_rate numeric not null default 0.0875;

-- ============================================================================
-- DONE. Verify with:
--   select id, customer_name, jsonb_array_length(line_items) lines, tax_rate
--   from estimates;
-- ============================================================================
