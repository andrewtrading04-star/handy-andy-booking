-- The old single-figure "amount" column (from the first Actual Profit
-- design) still had a NOT NULL constraint, which broke every save under the
-- current three-field design since amount is no longer set on insert.
-- Relax it and drop the short-lived per-business columns from the design
-- that came between (doms_amount / handy_andy_amount), now unused.
alter table app.actual_profit_weekly
  alter column amount drop not null,
  drop column if exists doms_amount,
  drop column if exists handy_andy_amount;
