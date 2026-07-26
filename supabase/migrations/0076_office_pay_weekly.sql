-- Hand-entered weekly pay for office staff who aren't technicians (Heather —
-- Handy Andy's secretary, Joey — Dom's) so they can show up as a real row on
-- the Weekly Payroll screen instead of only living in the owner's head. One
-- row per pay week; each staffer is their own nullable column, same pattern
-- as actual_profit_weekly (one row per pay_date with a few hand-entered
-- fields), just keyed on week_start since this is entered before the pay
-- date's other figures are known.
create table if not exists app.office_pay_weekly (
  week_start date primary key,
  heather_pay numeric,
  joey_pay numeric,
  updated_at timestamptz not null default now()
);
