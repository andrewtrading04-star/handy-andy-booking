-- Owner's note back to the auditor on a flagged call (2026-09-27).
alter table app.call_audits add column if not exists owner_note text, add column if not exists owner_note_at timestamptz;
