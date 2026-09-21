-- 0125: why a call that did not end in a booking or an estimate needed neither.
-- Owner rule: every real customer who calls gets an estimate (or a booking).
-- The Estimate Check (Analytics > Phone Desk, My Call Performance) flags calls
-- that ended with neither; the secretary can excuse one with a reason, and the
-- reason is stored here so the excuses can be audited.
--   calls.no_estimate_reason        call-wizard sessions (kind = 'live')
--   call_audits.no_estimate_reason  calls the outside auditor logged
-- Allowed values (enforced in api/_lib/estimate-check.js): not_a_customer,
-- existing_customer, outside_area, vendor, other. `other` also needs a note.
alter table app.calls
  add column if not exists no_estimate_reason text,
  add column if not exists no_estimate_note text,
  add column if not exists no_estimate_at timestamptz;
alter table app.call_audits
  add column if not exists no_estimate_reason text,
  add column if not exists no_estimate_note text,
  add column if not exists no_estimate_at timestamptz;
