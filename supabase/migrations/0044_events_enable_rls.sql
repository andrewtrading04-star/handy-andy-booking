-- ============================================================================
-- Migration 0044: Enable Row-Level Security on public.events
-- ----------------------------------------------------------------------------
-- Supabase flagged public.events as "publicly accessible" (rls_disabled_in_public):
-- with RLS off, anyone holding the public anon key — which ships inside the
-- booking widget — could read, edit, or delete every funnel event directly via
-- PostgREST, bypassing our server. Events carry customer names, zips, and cities,
-- so this is a real exposure.
--
-- The two server endpoints that use this table (api/log-event.js writes,
-- api/analytics.js reads) were switched to the SERVICE ROLE key (public schema)
-- in the same change, so forcing RLS here does NOT break event logging or the
-- analytics dashboard — the service role bypasses RLS. We add NO anon policies,
-- which means the public anon key is denied all access.
--
-- Safe to run in the Supabase SQL Editor. Idempotent.
-- ============================================================================

alter table public.events enable row level security;
alter table public.events force  row level security;

-- (No policies created on purpose: with RLS on and no policy, every non-service
--  role — including anon — is denied. The service role bypasses RLS entirely.)
