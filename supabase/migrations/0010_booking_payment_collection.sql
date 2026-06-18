-- ============================================================================
-- Migration 0010: Booking payment collection at booking time
-- ----------------------------------------------------------------------------
-- Adds fields to track whether payment should be collected and via what method:
--   payment_required      whether to collect payment at booking (boolean)
--   payment_method        method of collection (card, cash, quote, null)
-- Run after 0009. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists payment_required boolean not null default false;
alter table bookings add column if not exists payment_method text;
