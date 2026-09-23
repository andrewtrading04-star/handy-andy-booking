-- My Day: a habit can be SKIPPED for a day ("took a nap, Asleep by 1 AM isn't
-- needed today") instead of done. A skipped day doesn't break the streak and
-- doesn't trigger the 6 PM nudge. Owner rule 2026-09-23.
set search_path = app, public, extensions;
alter table owner_habit_checks add column if not exists skipped boolean not null default false;
