-- One-time / one-shot flags the app can atomically "claim" (e.g. sending a
-- notification exactly once ever, no matter how many serverless cold-starts
-- run afterward). A row existing for a key means it has already fired.
set search_path = app, public, extensions;

create table if not exists system_flags (
  key text primary key,
  value jsonb,
  created_at timestamptz not null default now()
);

alter table system_flags enable row level security;
alter table system_flags force row level security;
grant all on system_flags to service_role;
