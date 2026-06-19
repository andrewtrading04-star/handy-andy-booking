-- ============================================================================
-- Migration 0007: Booking photos + internal notes
-- ----------------------------------------------------------------------------
-- Two new capabilities, both INTERNAL (never shown to the customer):
--
--   booking_photos  Photos a technician attaches to a job from their phone.
--                   The tech app REQUIRES at least 2 photos before a job can be
--                   marked completed (enforced in the API, not just the UI).
--                   Shown on the job ticket AND in a business-wide photo gallery.
--                   Files live in a Supabase Storage bucket (see below); this
--                   table stores the path + public URL + who/when.
--
--   booking_notes   Free-form internal notes on a job. Anyone on staff (owner,
--                   secretary) or the assigned technician can add them; the
--                   customer never sees them. Each note records its author and
--                   timestamp. Notes are visible until deleted; deleting is a
--                   permanent hard delete (no soft-delete/restore).
--
-- Run after 0006. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

-- ── booking_photos ──────────────────────────────────────────────────────────
create table if not exists booking_photos (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  booking_id      uuid not null references bookings(id) on delete cascade,
  technician_id   uuid references technicians(id) on delete set null,  -- who uploaded (if a tech)
  uploaded_by_kind text not null default 'technician'
                    check (uploaded_by_kind in ('technician','owner','secretary')),
  uploader_name   text,                       -- display label captured at upload time
  storage_path    text not null,              -- path inside the Storage bucket
  url             text not null,              -- public URL for <img src>
  caption         text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_booking_photos_booking  on booking_photos(booking_id, created_at);
create index if not exists idx_booking_photos_business on booking_photos(business_id, created_at desc);

-- ── booking_notes ───────────────────────────────────────────────────────────
create table if not exists booking_notes (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  booking_id    uuid not null references bookings(id) on delete cascade,
  author_kind   text not null check (author_kind in ('owner','secretary','technician')),
  author_id     uuid,                          -- technician id when author_kind='technician'
  author_name   text not null,                 -- display name (e.g. 'Owner', 'Office', tech name)
  body          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_booking_notes_booking  on booking_notes(booking_id, created_at);
create index if not exists idx_booking_notes_business on booking_notes(business_id);

-- ── Lock to server-side (service role) access, like every other app table ────
alter table booking_photos enable row level security;
alter table booking_photos force  row level security;
alter table booking_notes  enable row level security;
alter table booking_notes  force  row level security;

grant all on booking_photos to service_role;
grant all on booking_notes  to service_role;

-- ── Storage bucket for the job photos ───────────────────────────────────────
-- Public-read bucket (URLs hold unguessable UUIDs); writes happen only through
-- our serverless API using the service role key, never from the browser.
-- Wrapped so that if this project restricts writes to the storage schema, the
-- rest of the migration still succeeds and the bucket can be made by hand.
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('booking-photos', 'booking-photos', true)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Could not create the booking-photos storage bucket automatically (%). Create it once in the Supabase dashboard: Storage → New bucket → name "booking-photos" → Public bucket ON.', sqlerrm;
end $$;

-- ============================================================================
-- DONE. Verify with:
--   select count(*) from booking_photos;
--   select count(*) from booking_notes;
--   select id, public from storage.buckets where id = 'booking-photos';
-- If the storage.buckets insert errored (insufficient privilege on some
-- projects), create the bucket once in the Supabase dashboard:
--   Storage → New bucket → name "booking-photos" → Public bucket → ON.
-- ============================================================================
