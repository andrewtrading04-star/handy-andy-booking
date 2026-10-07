-- Personal loans (owner 2026-10-07): Andrew lends to Catie on agreed terms.
-- Both can see the payment history; the borrower opens a private link
-- (share_key) and can log her own payments. Owner edits terms in the CRM.
set search_path = app, public;
create table if not exists loans (
  id               uuid primary key default gen_random_uuid(),
  borrower_name    text not null,
  principal        numeric(12,2) not null check (principal > 0),
  apr              numeric(6,3) not null default 0,       -- annual %, 0 = no interest
  monthly_payment  numeric(12,2) not null default 200,    -- mandatory minimum
  start_date       date not null default current_date,
  first_due_date   date not null,
  terms            text,
  share_key        text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_at       timestamptz not null default now()
);
create table if not exists loan_payments (
  id          uuid primary key default gen_random_uuid(),
  loan_id     uuid not null references loans(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  paid_on     date not null default current_date,
  method      text,
  note        text,
  logged_by   text not null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists loan_payments_loan on loan_payments (loan_id, paid_on);
alter table loans enable row level security;
alter table loan_payments enable row level security;
revoke all on loans, loan_payments from anon, authenticated;
grant all on loans, loan_payments to service_role;
notify pgrst, 'reload schema';

-- Seed: Catie's credit card loan (from her "Credit Card Loan" plan + running total).
do $$
declare lid uuid;
begin
  if not exists (select 1 from loans) then
    insert into loans (borrower_name, principal, apr, monthly_payment, start_date, first_due_date, terms)
    values ('Catie', 4900, 0, 200, '2026-01-15', '2026-02-15',
E'• Andrew pays off Catie''s full credit card balance of $4,900.\n• Catie pays $200 on the 15th of each month (Zelle). No interest.\n• Extra payments are welcome any time to pay it off sooner (tips, gigs, favors).\n• At $200/month the payoff is about 25 months.\n• Once paid in full, Catie sends a $400 thank-you bonus.\n• If a payment will be late, Catie will say so in advance.')
    returning id into lid;
    insert into loan_payments (loan_id, amount, paid_on, method, logged_by) values
      (lid,200,'2026-02-15','Zelle','Catie'),(lid,200,'2026-03-14','Zelle','Catie'),
      (lid,200,'2026-04-15','Zelle','Catie'),(lid,200,'2026-05-15','Zelle','Catie'),
      (lid,200,'2026-06-15','Zelle','Catie'),(lid,200,'2026-07-13','Zelle','Catie'),
      (lid,200,'2026-08-15','Zelle','Catie'),(lid,200,'2026-09-15','Zelle','Catie');
  end if;
end $$;
