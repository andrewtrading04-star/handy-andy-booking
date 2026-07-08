-- ============================================================================
-- Migration 0060: technician photo + short bio, for the "Meet your tech"
-- block in the booking confirmation email.
-- ----------------------------------------------------------------------------
-- photo_url   : public Supabase Storage URL (set via the dashboard's
--               Technicians tab, uploaded through the existing booking-photos
--               bucket helper).
-- bio_years   : years of experience, shown as "X+ years" — optional.
-- bio_blurb   : a short custom intro line. If blank, the email falls back to
--               a generated sentence from bio_years, or a generic line if
--               neither is set.
--
-- All optional/nullable — a technician with none of these set simply never
-- shows the "Meet your tech" block; nothing breaks.
-- ============================================================================
set search_path = app, public, extensions;

alter table technicians
  add column if not exists photo_url text,
  add column if not exists bio_years integer,
  add column if not exists bio_blurb text;
