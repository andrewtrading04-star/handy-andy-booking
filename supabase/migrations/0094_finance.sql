-- ============================================================================
-- Finances: Andrew's personal + business bank/card accounts, tracked entirely
-- separately from every customer-facing table in this schema. Nothing here is
-- ever read by api/tech.js, api/book.js, api/estimate.js, or the tech/customer
-- apps -- only api/finance.js touches these tables, and that file gate-checks
-- role==='owner' before dispatching to a single action (see api/finance.js).
--
-- Four accounts as of 2026-08: Business Savings (...2866, pays techs, takes in
-- both businesses' income), a personal account used as a tax reserve, a
-- personal savings account, and the main business credit card (...3844).
-- More can be added later (see finance_accounts) without a migration.
-- ============================================================================

create table if not exists app.finance_accounts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,                 -- "Business Savings", "Tax Reserve", "Personal Savings", "Business Card"
  -- Free text, not a CHECK: this only ever drives a UI icon/label, never a
  -- money calculation (those all work off amount sign + account identity),
  -- so it shouldn't be able to block a real account whose exact type we
  -- guessed wrong.
  account_type  text not null default 'bank',
  last4         text,
  display_order int not null default 0,
  archived      boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists app.finance_transactions (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references app.finance_accounts(id) on delete cascade,
  posted_date       date not null,
  description       text not null,
  -- Signed dollars: positive = money IN to this account, negative = money OUT.
  -- A credit card's own "payment received" and "purchase" rows use the same
  -- convention (payment = positive here, a purchase = negative) so the sign
  -- always means the same thing regardless of which of the 4 accounts a row
  -- belongs to.
  amount            numeric(12,2) not null,
  category          text not null default 'uncategorized' check (category in (
                      'income', 'tech_payroll', 'materials', 'marketing', 'software',
                      'insurance', 'fuel_vehicle', 'tax_set_aside', 'personal_draw',
                      'fees_interest', 'internal_transfer', 'other', 'uncategorized'
                    )),
  -- Set true the moment a human picks a category by hand, so a re-run of the
  -- auto-categorizer (e.g. after improving its rules) never overwrites a
  -- correction someone already made.
  category_locked   boolean not null default false,
  is_transfer       boolean not null default false,
  transfer_pair_id  uuid references app.finance_transactions(id),
  -- account_id + this row's own fingerprint (see financeImportHash in
  -- api/_lib/finance-parse.js) is what makes re-uploading the same statement
  -- a no-op instead of a duplicate.
  import_hash       text not null,
  source_label      text,                        -- e.g. "JUL_2026", the statement it was imported from
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (account_id, import_hash)
);

create index if not exists finance_tx_account_date_idx on app.finance_transactions (account_id, posted_date);
create index if not exists finance_tx_category_idx on app.finance_transactions (category) where is_transfer = false;
create index if not exists finance_tx_transfer_pair_idx on app.finance_transactions (transfer_pair_id) where transfer_pair_id is not null;

comment on table app.finance_accounts is 'Owner-only personal/business finance accounts. Read/written ONLY by api/finance.js.';
comment on table app.finance_transactions is 'Owner-only transaction ledger, one row per bank/card line item. Read/written ONLY by api/finance.js.';
