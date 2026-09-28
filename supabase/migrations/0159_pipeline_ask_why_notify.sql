-- Owner's "Ask why" notes go to that company's secretary until opened (2026-09-29).
alter table app.pipeline_ask_why add column if not exists for_slug text, add column if not exists seen_at timestamptz;
