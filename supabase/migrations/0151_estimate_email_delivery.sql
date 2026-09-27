-- Estimate email delivery (owner 2026-09-27: a typo'd address went unnoticed).
-- email_id = Resend message id; the Resend webhook sets email_status/bounced_at.
alter table app.estimates add column if not exists email_id text, add column if not exists email_status text, add column if not exists email_bounced_at timestamptz;
create index if not exists estimates_email_id_idx on app.estimates(email_id);
