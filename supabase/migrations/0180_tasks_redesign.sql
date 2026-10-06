-- ============================================================================
-- Migration 0180: Tasks redesign (owner 2026-10-07)
-- ----------------------------------------------------------------------------
-- Andrew + Joey only. Level stays in color: red Emergency, yellow ASAP,
-- green Normal, white Someday ('joey' kept one release; new writes use green).
-- Status is derived (Open / Check / Sent back / Done), never stored.
-- assistant_tasks:
--   due_on                       optional due date (labels in Denver time)
--   checklist                    [{id, text, done}]
--   sent_back_at                 Andrew sent Joey's tick back; clears on her next tick
--   seen_owner_at / seen_joey_at drawer opened (never stamped under View As)
--   updated_at / updated_by      last change and who
--   texted_at, text_sid, text_status, text_error, text_claim_at
--                                Notify Joey by text: last good send, Twilio sid,
--                                sent/delivered/undelivered/failed, last error,
--                                in-flight claim (atomic, 60s repeat guard)
--   emailed_at, email_error, email_claim_at   same for email
-- assistant_task_events: per-task Activity thread (replies + every notify try).
-- Additive + idempotent. Existing rows keep working.
-- ============================================================================
set search_path = app, public, extensions;

alter table app.assistant_tasks add column if not exists due_on date;
alter table app.assistant_tasks add column if not exists checklist jsonb not null default '[]'::jsonb;
alter table app.assistant_tasks add column if not exists sent_back_at timestamptz;
alter table app.assistant_tasks add column if not exists seen_owner_at timestamptz;
alter table app.assistant_tasks add column if not exists seen_joey_at timestamptz;
alter table app.assistant_tasks add column if not exists updated_at timestamptz default now();
alter table app.assistant_tasks add column if not exists updated_by text;
alter table app.assistant_tasks add column if not exists texted_at timestamptz;
alter table app.assistant_tasks add column if not exists text_error text;
alter table app.assistant_tasks add column if not exists text_sid text;
alter table app.assistant_tasks add column if not exists text_status text;
alter table app.assistant_tasks add column if not exists text_claim_at timestamptz;
alter table app.assistant_tasks add column if not exists emailed_at timestamptz;
alter table app.assistant_tasks add column if not exists email_error text;
alter table app.assistant_tasks add column if not exists email_claim_at timestamptz;
alter table app.assistant_tasks add column if not exists deleted_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'assistant_tasks_checklist_array') then
    alter table app.assistant_tasks add constraint assistant_tasks_checklist_array check (jsonb_typeof(checklist) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'assistant_tasks_text_status_check') then
    alter table app.assistant_tasks add constraint assistant_tasks_text_status_check
      check (text_status is null or text_status in ('sent', 'delivered', 'undelivered', 'failed'));
  end if;
end $$;

create index if not exists assistant_tasks_live on app.assistant_tasks (cleared_at, created_at) where deleted_at is null;
create index if not exists assistant_tasks_text_sid on app.assistant_tasks (text_sid) where text_sid is not null;

create table if not exists app.assistant_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references app.assistant_tasks(id) on delete cascade,
  kind text not null check (kind in ('comment', 'texted', 'text_failed', 'emailed', 'email_failed', 'sent_back', 'ok', 'reopened')),
  body text,
  by text,
  created_at timestamptz not null default now()
);
create index if not exists assistant_task_events_task on app.assistant_task_events (task_id, created_at);
alter table app.assistant_task_events enable row level security;
revoke all on app.assistant_task_events from anon, authenticated;
grant select, insert, update, delete on app.assistant_task_events to service_role;

notify pgrst, 'reload schema';
