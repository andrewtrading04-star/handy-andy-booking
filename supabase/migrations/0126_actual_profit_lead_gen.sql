-- Lead-gen brands (Mile High, Precision, Austin/Houston microsites ...) earn a
-- little each but don't deserve a payroll-page field apiece. One jsonb map per
-- pay date, { "<business slug>": amount }, edited from a single collapsed
-- "Lead-gen brands" dropdown. Blank/missing = 0; it is added into
-- "Total I made" (doms + handy_andy + lead-gen - tech_pay).
alter table app.actual_profit_weekly
  add column if not exists lead_gen_payouts jsonb not null default '{}'::jsonb;
