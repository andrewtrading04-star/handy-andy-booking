-- "Ask why" notes go to the named secretary on the card (Joey and Joe are different people), 2026-09-29.
alter table app.pipeline_ask_why add column if not exists for_name text;
