-- Split the single combined "actual profit" figure into one column per
-- business, so the payroll page can show a Dom's section and a Handy Andy
-- section instead of one merged number.
alter table app.actual_profit_weekly
  add column if not exists doms_amount numeric(10,2),
  add column if not exists handy_andy_amount numeric(10,2);
