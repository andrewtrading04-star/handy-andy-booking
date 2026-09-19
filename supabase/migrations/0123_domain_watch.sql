-- Migration 0123: domain watch list (applied 2026-09-19)
-- Owner pastes domains; a daily cron checks each one and texts the owner when
-- one becomes registrable (or enters pending-delete, i.e. is about to drop).
-- notified_status remembers the last state we texted about, so a domain only
-- alerts again when it changes to a different alert-worthy state.
set search_path = app, public;
create table if not exists domain_watch (
  id               uuid primary key default gen_random_uuid(),
  domain           text not null unique,
  status           text not null default 'unchecked'
                   check (status in ('unchecked','taken','available','pending_delete','redemption','likely_available','unsupported','error')),
  status_since     timestamptz,
  expires_at       timestamptz,
  registrar        text,
  last_checked_at  timestamptz,
  last_error       text,
  notified_status  text,
  notified_at      timestamptz,
  created_by       text,
  created_at       timestamptz not null default now()
);
alter table domain_watch enable row level security;
revoke all on domain_watch from anon, authenticated;
grant all on domain_watch to service_role;
notify pgrst, 'reload schema';
