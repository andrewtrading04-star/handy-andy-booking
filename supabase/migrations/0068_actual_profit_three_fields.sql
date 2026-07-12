-- Replace the two-business-figure design with three hand-entered fields per
-- pay date: each business's own Stripe payout, plus total tech pay across
-- both businesses. "Total I made" is computed client/server-side as
-- doms_stripe_payout + handy_andy_stripe_payout - tech_pay, not stored.
alter table app.actual_profit_weekly
  add column if not exists doms_stripe_payout numeric(10,2),
  add column if not exists handy_andy_stripe_payout numeric(10,2),
  add column if not exists tech_pay numeric(10,2);
