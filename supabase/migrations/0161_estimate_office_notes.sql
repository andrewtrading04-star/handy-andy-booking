-- Staff-only office notes on an estimate (owner 2026-09-29).
create table if not exists app.estimate_office_notes (id uuid primary key default gen_random_uuid(), estimate_id uuid not null references app.estimates(id) on delete cascade, body text not null, created_by text, created_at timestamptz not null default now());
create index if not exists estimate_office_notes_est on app.estimate_office_notes(estimate_id);
alter table app.estimate_office_notes enable row level security;
