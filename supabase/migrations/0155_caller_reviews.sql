-- Owner review of a caller shown on the Calls card (2026-09-28).
create table if not exists app.caller_reviews (phone text primary key, data jsonb not null, created_by text, created_at timestamptz not null default now());
alter table app.caller_reviews enable row level security;
