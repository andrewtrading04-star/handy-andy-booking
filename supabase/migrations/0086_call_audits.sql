-- ============================================================================
-- Manual call auditing.
--
-- An outside auditor listens to Grasshopper recordings once a day and grades
-- whether the secretaries followed the "Take a Call" phone script. Two tables,
-- because two genuinely different things are being recorded:
--
--   call_audit_days  one row per LINE per DAY. How many calls came in on that
--                    number, including zero. Zero is real data, not an absent
--                    row: a line that goes quiet for a week has to be visible
--                    rather than looking like the auditor skipped it. This is
--                    also the only per-line attribution that exists for
--                    answered calls, since app.calls rows with kind='live'
--                    record handled_by but leave grasshopper_number null.
--
--   call_audits      one row per audited call.
--
-- Answers are jsonb, not columns. The scorecard is derived from a script that
-- will keep changing, and adding or retiring a question must never mean a
-- migration plus a backfill of rows whose call was graded under the old set.
-- Reading it back is always "what did this call score on the questions it was
-- actually asked", never a fixed column list.
-- ============================================================================

create table if not exists app.call_audit_days (
  id                  uuid primary key default gen_random_uuid(),
  audit_date          date not null,
  grasshopper_number  text not null,
  business_id         uuid references app.businesses(id),
  calls_counted       smallint not null default 0 check (calls_counted >= 0),
  audited_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One count per line per day. Re-saving the day updates in place instead of
  -- stacking duplicate counts for the same line.
  unique (audit_date, grasshopper_number)
);

create index if not exists call_audit_days_date_idx
  on app.call_audit_days (audit_date desc);

create table if not exists app.call_audits (
  id                  uuid primary key default gen_random_uuid(),
  audit_date          date not null,
  grasshopper_number  text not null,
  business_id         uuid references app.businesses(id),
  -- The scripted call this audit belongs to, when the auditor could match one
  -- by time and who took it. NULL is the interesting case: a call that came in
  -- with no scripted row behind it means the secretary never opened the script
  -- at all, which is the first thing the owner wants to know.
  call_id             uuid references app.calls(id) on delete set null,
  occurred_at         timestamptz,
  direction           text not null default 'incoming'
                        check (direction in ('incoming', 'outgoing')),
  handled_by          text,
  -- { question_key: 'yes' | 'no' | 'na' }. Keys are stable slugs owned by the
  -- audit page, never positional indexes, so reordering or inserting a
  -- question cannot silently re-point old answers at a different question.
  answers             jsonb not null default '{}'::jsonb,
  -- Which scoping questions applied. Comes from the linked scripted call when
  -- there is one, and from the auditor otherwise, since a call with no script
  -- row behind it still has to be graded against the right branch. 'unknown'
  -- is for a call that ended before the service came up, and suppresses both
  -- scoping sections rather than guessing one.
  service             text check (service is null or service in ('TV Mounting', 'Handyman', 'unknown')),
  flagged             boolean not null default false,
  notes               text,
  audited_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists call_audits_date_idx
  on app.call_audits (audit_date desc);
create index if not exists call_audits_call_idx
  on app.call_audits (call_id) where call_id is not null;
create index if not exists call_audits_flagged_idx
  on app.call_audits (audit_date desc) where flagged;
