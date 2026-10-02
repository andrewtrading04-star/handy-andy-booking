-- Task list: Andrew gives Joey (assistant) tasks; red/yellow/green (owner 2026-10-02).
create table if not exists app.assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null, color text not null check (color in ('red','yellow','green')),
  notes text, booking_id uuid, job_slug text, job_label text,
  created_by text, created_at timestamptz not null default now(),
  done_at timestamptz, done_by text, deleted_at timestamptz);
create index if not exists assistant_tasks_open on app.assistant_tasks (done_at, created_at) where deleted_at is null;
