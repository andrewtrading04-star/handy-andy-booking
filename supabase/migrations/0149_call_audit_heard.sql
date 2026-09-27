-- Owner audit redesign (2026-09-27): a flagged call leaves the owner's
-- "Listen to these" list once he marks it heard. Old flags saved with no
-- listen_reason are hidden from that list by the app (not deleted).
alter table app.call_audits add column if not exists heard_at timestamptz;
