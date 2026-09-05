-- Two things, both from the owner call 2026-09-06.
--
-- 1) LOGO SHOTS. The single most valuable photo a tech takes is the finished
--    mount with the company logo up on the customer's TV (the workflow the
--    tech app already coaches in #logoHelpModal). Those are the ones worth
--    posting, and until now finding them meant eyeballing the whole Photos
--    tab. A cron (migrate.js?action=photo_logo_scan) runs Claude vision over
--    each new photo and tags it, so the office can pull them up on demand.
alter table app.booking_photos add column if not exists logo_shot boolean;          -- null = not scanned yet
alter table app.booking_photos add column if not exists logo_scanned_at timestamptz;
alter table app.booking_photos add column if not exists logo_note text;             -- one-line reason from the model, for spot-checking

-- Partial index: the gallery only ever asks for the hits, and they're a small
-- fraction of the table.
create index if not exists idx_booking_photos_logo
  on app.booking_photos (business_id, created_at desc) where logo_shot;

-- The scan queue -- "oldest unscanned first" is the only other access pattern.
create index if not exists idx_booking_photos_logo_unscanned
  on app.booking_photos (created_at) where logo_scanned_at is null;

-- 2) TECH BONUSES. There was no general way to hand a tech a one-off bonus:
--    technicians.manual_pay_amount is a single slot that gets overwritten, and
--    tech_review_bonus (0090) is hardcoded to one specific $100 award. This is
--    the generic version -- many per tech, each with its own payroll label and
--    its own congratulations popup that must be dismissed once.
create table if not exists app.tech_bonuses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references app.businesses(id) on delete cascade,
  technician_id uuid not null references app.technicians(id) on delete cascade,
  amount numeric(10,2) not null,
  reason text not null,                 -- the payroll line label, e.g. "Photo bonus"
  message text,                         -- popup body; null = pay it quietly, no popup
  awarded_on date not null default current_date,   -- which pay week it lands in
  acknowledged_at timestamptz,          -- set when the tech closes the popup; null = still owed a popup
  created_at timestamptz not null default now()
);

create index if not exists idx_tech_bonuses_tech on app.tech_bonuses (technician_id, awarded_on);

alter table app.tech_bonuses enable row level security;
alter table app.tech_bonuses force row level security;
grant select, insert, update, delete on app.tech_bonuses to service_role;

-- Steve's $50 for the logo shots. `where not exists` rather than a unique
-- constraint: repeat bonuses for the same reason are legitimate later, this
-- guard only stops THIS seed from double-inserting on a re-run.
-- awarded_on is pinned rather than left to current_date: the DB clock is UTC,
-- and an award made late on a Saturday evening local time would otherwise fall
-- into the week that just closed (and may already be paid) instead of the open
-- one. 2026-09-06 is the Sunday that starts the current pay week.
insert into app.tech_bonuses (business_id, technician_id, amount, reason, message, awarded_on)
select t.business_id, t.id, 50, 'Photo bonus',
       'For acquiring the best pictures. Keep up the great work!', date '2026-09-06'
from app.technicians t
join app.businesses b on b.id = t.business_id
where b.slug = 'handy-andy' and t.name ilike 'steve%'
  and not exists (
    select 1 from app.tech_bonuses x
    where x.technician_id = t.id and x.reason = 'Photo bonus'
  );
