-- Migration 0124 (applied 2026-09-19): owner can dismiss a domain alert banner for its current state.
set search_path = app, public;
alter table domain_watch add column if not exists alert_dismissed_status text;
notify pgrst, 'reload schema';
