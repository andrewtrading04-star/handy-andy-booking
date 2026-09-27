-- Pipeline "Ask why" (owner 2026-09-27): Opus 5.5 explains what's holding a
-- card back. One cached answer per card; redone when the card changes.
create table if not exists app.pipeline_ask_why (card_key text primary key, fingerprint text not null, answer jsonb not null, asked_by text, created_at timestamptz not null default now());
alter table app.pipeline_ask_why enable row level security;
