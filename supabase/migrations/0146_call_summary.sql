-- Short AI summary shown above a call transcript (owner, 2026-09-25).
alter table app.calls add column if not exists transcript_summary jsonb;
