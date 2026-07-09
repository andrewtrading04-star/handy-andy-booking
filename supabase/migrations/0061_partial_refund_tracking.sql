-- ============================================================================
-- Migration 0061: Partial refund tracking
-- ----------------------------------------------------------------------------
-- The office can now refund LESS than the full ticket price. Deliberately NOT
-- adding a new payment_status value for this (e.g. 'partially_refunded') --
-- payroll's paymentState() and admin.js's revenue/profit filters (earned(),
-- paidDone) both key strictly on payment_status === 'paid', so a partially
-- refunded booking must keep reading as 'paid' or it would silently zero out
-- the technician's pay and drop the job out of revenue reporting. Only a FULLY
-- exhausted refund flips payment_status to 'refunded', exactly like today.
--
-- amount_refunded is purely a running total for display (how much has been
-- refunded so far) -- the refund action itself always re-derives the true
-- remaining balance from Stripe directly before charging, so this column
-- drifting or being briefly unset never risks an over-refund.
-- Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

alter table bookings add column if not exists amount_refunded numeric(10,2);
