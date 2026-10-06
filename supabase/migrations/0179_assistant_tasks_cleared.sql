-- Joey's done tasks stay crossed out until Andrew taps them (owner 2026-10-07).
alter table app.assistant_tasks add column if not exists cleared_at timestamptz;
update app.assistant_tasks set cleared_at = done_at where done_at is not null and cleared_at is null;
