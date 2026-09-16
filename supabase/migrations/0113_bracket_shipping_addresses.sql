-- Managed delivery addresses. Existing street-number/ZIP guesses are not
-- imported: the owner verifies each complete home/unit address before use.
set search_path = app, public, extensions;
create table if not exists bracket_shipping_addresses (
  id uuid primary key default gen_random_uuid(),
  technician_id uuid not null references technicians(id) on delete restrict,
  address text not null check (length(trim(address)) between 10 and 400),
  normalized_address text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bracket_shipping_addresses_tech on bracket_shipping_addresses(technician_id);
drop trigger if exists trg_bracket_shipping_addresses_updated on bracket_shipping_addresses;
create trigger trg_bracket_shipping_addresses_updated before update on bracket_shipping_addresses for each row execute function set_updated_at();
alter table bracket_shipping_addresses enable row level security;
alter table bracket_shipping_addresses force row level security;
revoke all on bracket_shipping_addresses from public,anon,authenticated;
grant all on bracket_shipping_addresses to service_role;
