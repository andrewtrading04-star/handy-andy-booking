-- ============================================================================
-- Migration 0116: Partial index for the Analytics overview's page_view pull
-- ----------------------------------------------------------------------------
-- analyticsOverview reads 30 days of page_view rows per multi-market site.
-- web_events only had an index on event_type, so Postgres walked every
-- page_view ever logged (400k-row table) and filtered by date afterwards:
-- 2.0s per 1,000-row page, four pages per load. Indexing created_at for
-- page_view rows only makes that a ~5ms range scan.
-- CONCURRENTLY so the live table is never locked. Applied to prod 2026-09-18.
-- ============================================================================
create index concurrently if not exists web_events_page_view_created_idx
  on public.web_events (created_at) where event_type = 'page_view';
