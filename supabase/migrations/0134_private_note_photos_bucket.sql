-- ============================================================================
-- Migration 0134: Private storage bucket for note photos
-- ----------------------------------------------------------------------------
-- Owner rule (2026-09-23): "i need to be able to view them securely" -- note
-- photos (staff_notes / tech_notes .photo_urls) were uploaded to the PUBLIC
-- booking-photos bucket, so the raw URL worked for anyone who had it, no
-- login required (obscured only by a random UUID, not actually access-
-- controlled). New notes now upload here instead -- private, served only
-- through the authenticated note_photo proxy in api/admin.js (same pattern
-- call_recording already uses for Twilio recordings). Old photo_urls already
-- posted stay on the public bucket (harmless, already out there) and keep
-- rendering as plain <img> the old way.
-- ============================================================================
set search_path = app, public, extensions;

insert into storage.buckets (id, name, public) values ('note-photos', 'note-photos', false)
on conflict (id) do update set public = false;
