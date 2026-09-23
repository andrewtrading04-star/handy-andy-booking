alter table app.call_audits add column if not exists ratings jsonb not null default '{}'::jsonb, add column if not exists complaint text, add column if not exists listen_reason text;
