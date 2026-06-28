-- ============================================================================
-- Migration 0038: Technician manual "expected pay" (transitional)
-- ============================================================================
-- HA/Dom's payroll totals still come from the external (Zenbooker) payroll tool,
-- so those jobs are NOT in this database and the app can't auto-compute them.
-- The owner sets each tech's expected pay for the upcoming deposit; the tech app
-- shows it as a banner on the Payroll screen. Columns are nullable (clearing them
-- hides the banner). This migration also loads the July 6, 2026 deposit totals
-- from the Combined Payroll — Per-Person Detail sheet. Idempotent; run after 0037.
-- ============================================================================
set search_path = app, public, extensions;

alter table technicians add column if not exists manual_pay_amount numeric(10,2);
alter table technicians add column if not exists manual_pay_date   date;

do $$
declare ha uuid; doms uuid;
begin
  select id into ha   from businesses where slug = 'handy-andy' limit 1;
  select id into doms from businesses where slug = 'doms'       limit 1;

  -- July 6, 2026 deposit totals (Combined Payroll — Per-Person Detail).
  -- Handy Andy techs:
  update technicians set manual_pay_amount = 2165, manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'juan%';
  update technicians set manual_pay_amount = 240,  manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'zach%';
  update technicians set manual_pay_amount = 2035, manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'kregg%';
  update technicians set manual_pay_amount = 1335, manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'steve%';
  -- Dom's techs:
  update technicians set manual_pay_amount = 2130, manual_pay_date = '2026-07-06' where business_id = doms and name ilike 'tk%';
  update technicians set manual_pay_amount = 1043, manual_pay_date = '2026-07-06' where business_id = doms and name ilike 'gregory%';
end $$;
