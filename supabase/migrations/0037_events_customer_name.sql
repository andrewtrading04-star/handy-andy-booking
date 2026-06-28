-- ============================================================================
-- Migration 0037: Capture the customer's name on booking-analytics sessions
-- ----------------------------------------------------------------------------
-- The booking-funnel "events" table (public schema, written by the widget via
-- the anon key) gains a customer_name column. Once a visitor types their name on
-- the booking form, the widget stamps it on their events, and the Booking
-- Analytics sessions table shows it (the "Customer" column, replacing "Source").
--
-- Additive + idempotent. Run after 0036.
-- ============================================================================
alter table public.events add column if not exists customer_name text;

-- ============================================================================
-- DONE.
-- ============================================================================
