-- ============================================================================
-- Migration 0028: Estimate line items
-- ----------------------------------------------------------------------------
-- Adds a `line_items` column to app.estimates so the office can build a real
-- quote (priced line items) on top of a customer's request, then email/text it.
-- Each element: { description: text, qty: number, unit_price: number }.
-- The line total is qty * unit_price; the grand total is their sum (computed in
-- the app/email, never stored, so it can't drift from the items).
-- Idempotent. Run after 0027.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates
  add column if not exists line_items jsonb not null default '[]'::jsonb;

-- ============================================================================
-- DONE. Verify with:
--   select id, customer_name, jsonb_array_length(line_items) lines from estimates;
-- ============================================================================
