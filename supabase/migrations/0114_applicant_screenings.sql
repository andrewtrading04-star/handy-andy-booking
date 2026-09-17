-- ============================================================================
-- Migration 0114: technician applicant screenings
-- ----------------------------------------------------------------------------
-- Indeed applicants land on public/apply.html, leave their name/email/phone,
-- and take a fixed TV-mounting knowledge quiz (api/_lib/apply-quiz.js). Every
-- attempt is logged here -- pass or fail -- so nothing is lost even on a fail
-- and the Analytics tab can show who took it, their score, and which
-- questions people actually miss (ANALYTICS_TABS "Applicants" in admin.html).
--
-- Grading is plain JS (gradeAnswers in apply-quiz.js), not a database
-- function: there is no atomic multi-table write to protect here the way
-- claim_tech_invite (0111) protects account creation, so a stored procedure
-- would only add ceremony. A PASS instead creates a normal tech_invites row
-- (invitee_name/invitee_phone from this screening) and hands the applicant
-- straight into the existing, already-hardened join flow -- this migration
-- does not touch tech_invites or claim_tech_invite at all.
--
-- NO SAME-DAY RETAKES. Enforced in the API (api/tech.js applyStart /
-- applySubmit) by checking for any row with the same phone10 in the last 24
-- hours, not by a database constraint -- "today" depends on which metro's
-- clock you mean, and the API already knows the applicant's local day.
--
-- Idempotent. Run after 0113.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists applicant_screenings (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  service_area_id  uuid not null references service_areas(id) on delete cascade,
  name             text not null,
  email            text not null,
  phone            text not null,   -- E.164, like tech_invites.invitee_phone
  answers          jsonb not null default '[]'::jsonb,   -- [{"key":"q1","choice":0,"correct":true}, ...]
  short_answers    jsonb not null default '{}'::jsonb,    -- {"q21":"...", "q22":"..."} -- never graded, read by a human
  score            integer not null,
  total             integer not null,
  passed           boolean not null,
  invite_code      text,   -- the tech_invites.code minted on a pass; null on a fail
  created_at       timestamptz not null default now()
);

comment on table applicant_screenings is
  'Every /apply.html quiz attempt, pass or fail (0114). A pass mints a normal tech_invites row and hands off to /join.';

-- Applicants list (Analytics tab) reads newest-first; the retake gate looks up
-- by phone within the last 24h -- same shape of index either way.
create index if not exists idx_applicant_screenings_created on applicant_screenings (created_at desc);
create index if not exists idx_applicant_screenings_phone
  on applicant_screenings (right(regexp_replace(phone, '\D', '', 'g'), 10), created_at desc);

alter table applicant_screenings enable row level security;
alter table applicant_screenings force row level security;
revoke all on applicant_screenings from anon, authenticated;
grant all on applicant_screenings to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select passed, count(*) from app.applicant_screenings group by 1;
-- ============================================================================
