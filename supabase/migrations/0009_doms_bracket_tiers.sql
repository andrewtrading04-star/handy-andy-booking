-- ============================================================================
-- Migration 0009: Doms TV Mounting — size-conditional bracket tiers
-- ----------------------------------------------------------------------------
-- Bracket price depends on TV size:
--   TVs under 85"  → standard brackets (Flat $55 / Tilting $65 / Full Motion $115)
--   TVs 85" and up → XL brackets       (Flat $90 / Tilting $110 / Full Motion $190)
--
-- Drives the New Booking walk-through: picking a size reveals only that
-- size's brackets. "Own bracket", "Mantel Mount" and "Samsung Frame" apply to
-- any size.
--
-- NOTE: the $90 Flat price for the 85"+ tier is assumed (mirrors the sister
-- brand). Confirm with Dom and adjust if different.
--
-- Run after 0008. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

-- 0) Make single-choice steps actually single-choice. 0008 created these with
--    max_select=0 (unlimited); size/bracket/fireplace/wires/surface are pick-one.
update service_option_groups g
set max_select = 1
from services s, businesses b
where g.service_id=s.id and s.business_id=b.id
  and b.slug='doms' and s.name='Dom''s TV Mounting'
  and g.key in ('size','bracket','fireplace','wires','surface');

-- 1) Tag each TV size with the bracket tier it should show.
update service_options o
set metadata = coalesce(o.metadata,'{}'::jsonb) || '{"bracket_tier":"standard"}'::jsonb
from service_option_groups g, services s, businesses b
where o.group_id=g.id and g.service_id=s.id and s.business_id=b.id
  and b.slug='doms' and s.name='Dom''s TV Mounting' and g.key='size'
  and o.label in ('32 inch Or Less','33-59 inch','60-69 inch','70-84 inch');

update service_options o
set metadata = coalesce(o.metadata,'{}'::jsonb) || '{"bracket_tier":"xl"}'::jsonb
from service_option_groups g, services s, businesses b
where o.group_id=g.id and g.service_id=s.id and s.business_id=b.id
  and b.slug='doms' and s.name='Dom''s TV Mounting' and g.key='size'
  and o.label in ('85-97 inch','98 plus');

-- 2) Tag existing brackets. Flat/Tilting/Full Motion are the under-85" tier;
--    own/mantel/frame apply to any size.
update service_options o
set metadata = coalesce(o.metadata,'{}'::jsonb) || '{"for_size":"standard"}'::jsonb
from service_option_groups g, services s, businesses b
where o.group_id=g.id and g.service_id=s.id and s.business_id=b.id
  and b.slug='doms' and s.name='Dom''s TV Mounting' and g.key='bracket'
  and o.label in ('Flat','Tilting (recommended)','Full Motion');

update service_options o
set metadata = coalesce(o.metadata,'{}'::jsonb) || '{"for_size":"any"}'::jsonb
from service_option_groups g, services s, businesses b
where o.group_id=g.id and g.service_id=s.id and s.business_id=b.id
  and b.slug='doms' and s.name='Dom''s TV Mounting' and g.key='bracket'
  and o.label in ('I have my own mounting bracket','Install customer supplied Mantel Mount','Samsung Frame TV in-box bracket');

-- 3) Insert the 85"+ bracket variants.
insert into service_options (business_id, group_id, label, price, zenbooker_option_id, sort_order, metadata)
select g.business_id, g.id, v.label, v.price, v.zbk, v.ord, v.meta
from service_option_groups g
join services s on s.id=g.service_id
join businesses b on b.id=s.business_id
join (values
  ('Flat (85" and up)',         90.00, 'doms-bracket-xl-flat', 7, '{"for_size":"xl"}'::jsonb),
  ('Tilting (85" and up)',     110.00, 'doms-bracket-xl-tilt', 8, '{"for_size":"xl"}'::jsonb),
  ('Full Motion (85" and up)', 190.00, 'doms-bracket-xl-full', 9, '{"for_size":"xl"}'::jsonb)
) as v(label, price, zbk, ord, meta) on true
where b.slug='doms' and s.name='Dom''s TV Mounting' and g.key='bracket'
  and not exists (select 1 from service_options o where o.group_id=g.id and o.zenbooker_option_id=v.zbk);
