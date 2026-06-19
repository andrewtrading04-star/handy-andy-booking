-- ============================================================================
-- Migration 0002: Asurion channel wiring
-- ----------------------------------------------------------------------------
-- Asurion is a booking CHANNEL into Handy Andy that books Steve. Asurion jobs
-- are Handy Andy bookings with source = 'asurion'. This links Steve to his
-- Zenbooker provider id (so mirrored Asurion jobs attach to him automatically)
-- and adds the $0 "Asurion TV Service" line. Run after 0001. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

-- Link Steve to his Zenbooker provider id (from api/assurion-book.js).
update technicians t
   set zenbooker_provider_id = '1688834379840x866068852960133100'
  from businesses b
 where t.business_id = b.id
   and b.slug = 'handy-andy'
   and t.name ilike 'steve'
   and (t.zenbooker_provider_id is null or t.zenbooker_provider_id <> '1688834379840x866068852960133100');

-- The Asurion service (customer pays $0; tech payout tracked in the job notes).
insert into services (business_id, name, description, base_price, duration_minutes, category)
select b.id, 'Asurion TV Service', 'Asurion-channel install handled by Steve', 0, 120, 'Asurion'
from businesses b
where b.slug = 'handy-andy'
on conflict (business_id, name) do nothing;
