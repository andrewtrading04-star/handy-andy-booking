-- Migration 0122: choose the technician on an estimate (applied 2026-09-19)
-- estimates.technician_id: when set, the customer's approve page offers only
-- that tech's open times and the auto-booked job is assigned to them.
-- NULL = any tech (the default, unchanged behaviour).
set search_path = app, public;
alter table estimates add column if not exists technician_id uuid references technicians(id) on delete set null;
notify pgrst, 'reload schema';
