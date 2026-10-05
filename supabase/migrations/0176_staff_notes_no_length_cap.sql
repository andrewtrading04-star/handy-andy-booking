-- Owner 2026-10-05: no length limit on notes (Jiyah's change requests).
alter table app.staff_notes drop constraint if exists staff_notes_body_check;
alter table app.staff_notes add constraint staff_notes_body_check check (length(body) >= 1);
