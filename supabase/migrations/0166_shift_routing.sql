-- Shift routing (owner 2026-10-02): Joey's 7 lines ring whoever is scheduled
-- that day (Alex Mon-Thu, Joe Wed/Fri-Sun; Alex wins Wednesday), the owner
-- after hours. Alex/Joe paid PHP 2,000 per scheduled day (code constant).
alter table app.tracking_numbers add column if not exists route_team text;
alter table app.staff_schedules add column if not exists phone text;
alter table app.staff_schedules add column if not exists priority int not null default 9;
