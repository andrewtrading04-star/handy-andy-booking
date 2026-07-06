-- ============================================================================
-- Migration 0053: Technician expected pay — June 28 – July 4, 2026 work week
-- ----------------------------------------------------------------------------
-- Updates each tech's owner-set "expected pay" banner (manual_pay_amount /
-- manual_pay_date, from migration 0038) with the FINAL per-person totals for the
-- June 28 – July 4, 2026 payroll week (deposited July 6, 2026). Supersedes the
-- preliminary numbers loaded in 0038.
--   Handy Andy:  Juan 3135 · Kregg 1580 · Zach 705 · Steve 650
--   Dom's:       TK 1925 · Greg 1135
-- Idempotent (plain updates). Run after 0052.
-- ============================================================================
set search_path = app, public, extensions;

do $$
declare ha uuid; doms uuid;
begin
  select id into ha   from businesses where slug = 'handy-andy' limit 1;
  select id into doms from businesses where slug = 'doms'       limit 1;

  -- Handy Andy
  update technicians set manual_pay_amount = 3135, manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'juan%';
  update technicians set manual_pay_amount = 1580, manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'kregg%';
  update technicians set manual_pay_amount = 705,  manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'zach%';
  update technicians set manual_pay_amount = 650,  manual_pay_date = '2026-07-06' where business_id = ha   and name ilike 'steve%';
  -- Dom's
  update technicians set manual_pay_amount = 1925, manual_pay_date = '2026-07-06' where business_id = doms and name ilike 'tk%';
  update technicians set manual_pay_amount = 1135, manual_pay_date = '2026-07-06' where business_id = doms and name ilike 'greg%';
end $$;

-- Verify:
--   select t.name, b.slug, t.manual_pay_amount, t.manual_pay_date
--   from technicians t join businesses b on b.id = t.business_id
--   where t.manual_pay_amount is not null order by b.slug, t.name;
-- ============================================================================
