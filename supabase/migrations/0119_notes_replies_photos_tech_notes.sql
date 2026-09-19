-- ============================================================================
-- Migration 0119: note photos, secretary replies, and notes for technicians
-- ----------------------------------------------------------------------------
-- 1. staff_notes.photo_urls: photos attached to an owner->secretary note.
-- 2. staff_note_reads.reply / replied_at / reply_seen_at: an OPTIONAL reply a
--    secretary can send back when she ticks a note off. reply_seen_at is when
--    the owner first saw it (drives the "new replies" count on Other).
-- 3. tech_notes: owner -> technician notes, aimed one of three ways:
--      target_type 'tech'  -> one technician (technician_id)
--      target_type 'city'  -> every active tech whose service area is named
--                             `city` (Denver spans Handy Andy and Dom's)
--      target_type 'all'   -> every technician
--    mode/show_from behave exactly like staff_notes (Denver date; today /
--    today+tomorrow / until dismissed).
-- 4. tech_note_dismissals: one row per (note, tech) X-tap, so a note aimed at
--    several techs is cleared by each of them independently and the owner can
--    see who has seen it.
-- Service-role only, like the rest of app. Idempotent. Applied 2026-09-19.
-- ============================================================================
set search_path = app, public, extensions;

alter table staff_notes add column if not exists photo_urls text[] not null default '{}';
alter table staff_note_reads add column if not exists reply text;
alter table staff_note_reads add column if not exists replied_at timestamptz;
alter table staff_note_reads add column if not exists reply_seen_at timestamptz;

create table if not exists tech_notes (
  id                uuid primary key default gen_random_uuid(),
  body              text not null check (length(body) between 1 and 2000),
  target_type       text not null check (target_type in ('tech', 'city', 'all')),
  technician_id     uuid references technicians(id) on delete cascade,
  city              text,
  mode              text not null default 'today' check (mode in ('today', 'two_days', 'until_read')),
  show_from         date not null,
  photo_urls        text[] not null default '{}',
  created_by        text,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  check ((target_type = 'tech' and technician_id is not null)
      or (target_type = 'city' and city is not null)
      or target_type = 'all')
);
create index if not exists tech_notes_live_idx on tech_notes (created_at) where deleted_at is null;

create table if not exists tech_note_dismissals (
  note_id       uuid not null references tech_notes(id) on delete cascade,
  technician_id uuid not null references technicians(id) on delete cascade,
  dismissed_at  timestamptz not null default now(),
  primary key (note_id, technician_id)
);

alter table tech_notes enable row level security;
alter table tech_note_dismissals enable row level security;
revoke all on tech_notes, tech_note_dismissals from anon, authenticated;
grant all on tech_notes, tech_note_dismissals to service_role;

notify pgrst, 'reload schema';
