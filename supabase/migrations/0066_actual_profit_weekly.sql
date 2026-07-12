-- Owner-only, hand-entered "actual profit" per pay date (sum of the two
-- Stripe accounts' payout for that week, entered manually each Sun night/Mon
-- morning). Not tied to a business_id -- it's a combined, cross-business,
-- owner-eyes-only figure. Surfaced only through the payroll API, which is
-- already gated to auth.role === 'owner' (techs/secretary never hit it).
create table if not exists app.actual_profit_weekly (
  pay_date date primary key,
  amount numeric(10,2) not null,
  updated_at timestamptz not null default now()
);
