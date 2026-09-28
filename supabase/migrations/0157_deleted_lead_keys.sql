-- Website leads the office deleted (owner 2026-09-28). website_lead_sync
-- re-scans the mailbox over 45 days on every run and re-files any email it
-- has no estimate for, so a deleted lead came straight back (and re-texted
-- Joey if it was under a day old). Deleting now leaves its key here instead.
create table if not exists app.deleted_lead_keys (external_key text primary key, deleted_by text, deleted_at timestamptz not null default now());
alter table app.deleted_lead_keys enable row level security;
