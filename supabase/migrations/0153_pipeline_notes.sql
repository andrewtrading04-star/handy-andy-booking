-- Pipeline card notes (owner 2026-09-28).
create table if not exists app.pipeline_notes (id uuid primary key default gen_random_uuid(), card_key text not null, body text not null, created_by text, created_at timestamptz not null default now());
create index if not exists pipeline_notes_card_idx on app.pipeline_notes(card_key, created_at);
alter table app.pipeline_notes enable row level security;
