-- ============================================================================
-- Migration 0042: Google Business Profile reviews
-- ============================================================================
-- Stores reviews left on Google (ingested from the Google Business Profile
-- notification emails that land in domstvmounting@gmail.com). Each row is one
-- review. `technician_id` / `booking_id` are the best-effort attribution to the
-- tech who did the matching job (may be null when no confident match is found).
-- `seen` drives the dismissible "<Tech> just got a 5-star review" banner.
-- Idempotent ingest via the unique google_key. Run after 0041.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists google_reviews (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  reviewer_name  text,
  rating         integer,
  review_text    text,
  review_date    date,
  google_key     text not null,                                       -- dedupe key
  technician_id  uuid references technicians(id) on delete set null,  -- credited tech (nullable)
  booking_id     uuid references bookings(id) on delete set null,     -- matched job (nullable)
  seen           boolean not null default false,                      -- banner dismissed
  created_at     timestamptz not null default now(),
  unique (business_id, google_key)
);

create index if not exists idx_google_reviews_biz on google_reviews(business_id, created_at desc);

-- RLS: server-side only (service role), like the other ingest tables.
alter table google_reviews enable row level security;
alter table google_reviews force row level security;
grant all on google_reviews to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select reviewer_name, rating, technician_id, seen from google_reviews;
-- ============================================================================
