-- A service area with no tech roster yet. The customer-facing widget never
-- reveals this (see public/widget.js) -- it only changes which flow renders:
-- staffed areas book a confirmed slot with a card; unstaffed areas collect
-- 3-4 preferred windows and submit as an estimate request instead, with no
-- payment step and no wording anywhere implying a confirmed appointment.
alter table app.service_areas
  add column if not exists unstaffed boolean not null default false;
