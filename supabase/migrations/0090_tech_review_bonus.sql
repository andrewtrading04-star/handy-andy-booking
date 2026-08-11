-- ============================================================================
-- $100 review-program bonus (tech app, Reviews tab). When a technician checks
-- off all 5 Handy Andy Google listings in tech_review_checkins (migration
-- 0089), the server writes ONE row here. The primary key on technician_id is
-- the entire double-pay defense: the award insert uses on-conflict-do-nothing
-- semantics, so re-checking boxes, unchecking and re-checking, or racing two
-- taps can never create a second $100. Payroll (api/admin.js payroll(),
-- api/tech.js techPayroll()) surfaces the row as its own labeled line in the
-- Sun-Sat week containing completed_at; nothing here is ever updated or
-- deleted by the app.
-- ============================================================================

create table if not exists app.tech_review_bonus (
  technician_id uuid primary key references app.technicians(id),
  completed_at  timestamptz not null default now(),
  amount        numeric not null default 100
);

-- "Invite sent Aug 11" stamp for the owner's per-tech "Send $100 review
-- invite" button on the Technicians screen. Cosmetic bookkeeping only; the
-- program itself never reads it.
alter table app.technicians
  add column if not exists review_invite_sent_at timestamptz;
