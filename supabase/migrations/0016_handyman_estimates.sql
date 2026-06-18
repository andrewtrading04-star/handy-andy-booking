-- ============================================================================
-- Migration 0016: Handyman service category + Estimates (quote requests)
-- ----------------------------------------------------------------------------
-- 1. Adds a fixed set of 7 "Handyman" estimate-only services to BOTH businesses
--    (Handy Andy + Doms). They are flagged settings.estimate_service = true so
--    the public estimate page can list exactly this set per business.
-- 2. Creates app.estimates — customer-submitted quote requests (description +
--    optional photo + up to 5 preferred time slots). RLS denies anon; the API
--    reads/writes via the service-role key.
-- 3. Seeds per-business SMS notification recipients (owner + secretary) into
--    businesses.settings.estimate_notify_phones.
-- Idempotent. Run after 0015.
-- ============================================================================
set search_path = app, public, extensions;

-- ── 1. Handyman estimate services (both businesses) ──────────────────────────
insert into services (business_id, name, description, base_price, duration_minutes, category, active, sort_order, settings)
select b.id, v.name, v.descr, 0, v.dur, 'Handyman', true, v.ord,
       jsonb_build_object('booking_flow','quote_request','estimate_service',true)
from businesses b
cross join (values
  ('Home Repairs',      'General home repairs and small fix-it projects.',                 90, 1),
  ('Furniture Assembly','On-site assembly of flat-pack and boxed furniture.',              120,2),
  ('Art Mounting',      'Hanging and mounting art, mirrors, and shelving.',                 90, 3),
  ('Plumbing',          'Minor plumbing: faucets, fixtures, leaks, and installs.',          90, 4),
  ('Smart Home',        'Smart home device setup: cameras, doorbells, thermostats, hubs.',  90, 5),
  ('Drywall Repair',    'Patch holes, cracks, and seams; tape, mud, sand, and prime.',      120,6),
  ('Light Electrical',  'Light fixtures, switches, outlets, and ceiling fans.',             90, 7)
) as v(name, descr, dur, ord)
where b.slug in ('handy-andy','doms')
on conflict (business_id, name) do nothing;

-- Make sure any pre-existing rows with these exact names carry the estimate flag
-- (so the estimate page lists them) without disturbing other Handyman services.
update services s
set settings = s.settings || jsonb_build_object('booking_flow','quote_request','estimate_service',true)
where s.category = 'Handyman'
  and s.name in ('Home Repairs','Furniture Assembly','Art Mounting','Plumbing','Smart Home','Drywall Repair','Light Electrical')
  and s.business_id in (select id from businesses where slug in ('handy-andy','doms'));

-- ── 2. estimates table ───────────────────────────────────────────────────────
create table if not exists estimates (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  service_id      uuid references services(id) on delete set null,
  service_label   text,                                  -- snapshot of chosen task name
  customer_name   text,
  customer_phone  text,
  customer_email  text,
  description     text not null,                         -- "What can we help you with?"
  photo_url       text,                                  -- optional single photo (public URL)
  photo_path      text,                                  -- storage path for cleanup
  preferred_slots jsonb not null default '[]'::jsonb,    -- [{date, slot_key, label}] up to 5
  status          text not null default 'new',           -- new | contacted | scheduled | closed
  sms_consent     boolean not null default true,
  source          booking_source not null default 'widget',
  notes           text,                                  -- internal/office notes
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_estimates_business_created on estimates(business_id, created_at desc);
create index if not exists idx_estimates_business_status  on estimates(business_id, status);

drop trigger if exists trg_estimates_updated on estimates;
create trigger trg_estimates_updated before update on estimates
  for each row execute function set_updated_at();

-- RLS: lock to server-side (service role). No anon policies = anon denied.
alter table estimates enable row level security;
alter table estimates force  row level security;

grant all on estimates to service_role;

-- ── 3. Per-business SMS notification recipients ──────────────────────────────
-- Owner (3374997817) is notified for both. Secretary differs per business.
update businesses
set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','7203711561'))
where slug = 'handy-andy';

update businesses
set settings = settings || jsonb_build_object('estimate_notify_phones', jsonb_build_array('3374997817','3032190118'))
where slug = 'doms';

-- ============================================================================
-- DONE. Verify with:
--   select b.slug, s.name, s.settings->>'estimate_service' est
--   from services s join businesses b on b.id = s.business_id
--   where s.category = 'Handyman' order by b.slug, s.sort_order;
--   select slug, settings->'estimate_notify_phones' from businesses;
-- ============================================================================
