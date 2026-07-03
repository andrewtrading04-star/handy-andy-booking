-- ============================================================================
-- Migration 0048: Interactive estimate upsells (recommended add-ons)
-- ----------------------------------------------------------------------------
-- Adds three columns to app.estimates so an estimate can carry a menu of
-- optional add-ons the office recommends, and record exactly which ones the
-- customer accepted on the interactive approve page.
--
--   upsells           jsonb  -- the menu the office offered. Each element:
--                            --   { id, description, qty, unit_price,
--                            --     tech_pay, badge, blurb, default_on }
--                            -- tech_pay is OFFICE-ONLY and is never returned
--                            -- to the public approve page.
--   accepted_upsells  jsonb  -- snapshot of the add-ons the customer accepted,
--                            -- priced from the server's stored `upsells` at
--                            -- approval time (client prices are never trusted).
--                            --   { id, description, qty, unit_price, tech_pay }
--   approved_total    numeric-- base line-items + accepted upsells + tax, frozen
--                            -- at the moment of approval so the office knows the
--                            -- exact amount the customer agreed to.
--
-- The office menu and the customer's selection are both stored so a re-send or a
-- reopened approve link always reads the same authoritative list, and so
-- convert-to-job can fold the accepted add-ons (with their tech_pay) into the
-- booking's line items for scheduling, payroll, and the invoice.
--
-- Idempotent. Run after 0047.
-- ============================================================================
set search_path = app, public, extensions;

alter table estimates
  add column if not exists upsells jsonb not null default '[]'::jsonb;

alter table estimates
  add column if not exists accepted_upsells jsonb;

alter table estimates
  add column if not exists approved_total numeric;

-- ============================================================================
-- DONE. Verify with:
--   select id, customer_name,
--          jsonb_array_length(upsells) offered,
--          jsonb_array_length(coalesce(accepted_upsells,'[]'::jsonb)) accepted,
--          approved_total, approved_at
--   from estimates order by created_at desc limit 20;
-- ============================================================================
