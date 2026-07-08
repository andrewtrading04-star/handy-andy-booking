-- ============================================================================
-- ONE-TIME payroll override — pay Steve $60 for the Christopher Klein job.
-- ----------------------------------------------------------------------------
-- This is NOT a rule. The Christopher Klein job (Tue Jul 7, 2026) is a $0
-- cross-company ticket assigned to Steve, so the normal line-item math pays $0.
-- The owner wants Steve paid a flat $60 for it, this once.
--
-- The payroll engine reads a "Payroll override: $<amount>" line from a booking's
-- notes and pays exactly that (never deferred). Storing it on the booking keeps
-- it a one-time DATA edit — nothing about this customer is hard-coded anywhere.
-- It shows up automatically in BOTH the office payroll and Steve's tech portal.
--
-- Idempotent: the WHERE guard skips the row if the override note is already set.
-- Run once in the Supabase SQL editor.
-- ============================================================================
set search_path = app, public, extensions;

update bookings b
set notes = coalesce(nullif(b.notes, '') || E'\n', '') || 'Payroll override: $60'
from customers c, technicians t
where b.customer_id = c.id
  and b.technician_id = t.id
  and c.name ilike 'christopher klein%'
  and t.name ilike 'steve%'
  and b.scheduled_at >= '2026-07-06T00:00:00Z'
  and b.scheduled_at <  '2026-07-09T00:00:00Z'
  and coalesce(b.notes, '') not ilike '%payroll override%';

-- Verify (should show the note now ending in "Payroll override: $60"):
--   select b.id, c.name, t.name as tech, b.scheduled_at, b.notes
--   from bookings b
--   join customers c on c.id = b.customer_id
--   join technicians t on t.id = b.technician_id
--   where c.name ilike 'christopher klein%';
-- ============================================================================
