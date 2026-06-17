-- ============================================================================
-- Migration 0003: Full Handy Andy "TV Installation" option groups (Denver)
-- ----------------------------------------------------------------------------
-- Seeds the remaining configurable pricing from public/widget.js so the service
-- model is complete: Bracket, Fireplace, Wall Surface, Wire Hiding, Lifting
-- Help, Dismount, Add-ons. Prices/option-ids are the Denver set; per-territory
-- variance (Austin/Houston) goes in service_options.price_overrides later.
-- Run after 0001/0002. Idempotent (guards on service_id+key / option id).
-- ============================================================================
set search_path = app, public, extensions;

-- Helper view of the target service id (Handy Andy TV Installation).
-- Groups -----------------------------------------------------------------
insert into service_option_groups (business_id, service_id, key, label, min_select, max_select, sort_order)
select s.business_id, s.id, v.key, v.label, v.mins, v.maxs, v.ord
from services s join businesses b on b.id = s.business_id
join (values
  ('bracket',   'Bracket',       0, 1, 2),
  ('fireplace', 'Fireplace',     0, 1, 3),
  ('surface',   'Wall Surface',  0, 1, 4),
  ('wires',     'Wire Hiding',   0, 1, 5),
  ('lifting',   'Lifting Help',  0, 1, 6),
  ('dismount',  'Dismount',      0, 1, 7),
  ('extras',    'Add-ons',       0, 0, 8)
) as v(key, label, mins, maxs, ord) on true
where b.slug = 'handy-andy' and s.name = 'TV Installation'
on conflict (service_id, key) do nothing;

-- Options ----------------------------------------------------------------
insert into service_options (business_id, group_id, label, price, zenbooker_option_id, sort_order)
select g.business_id, g.id, v.label, v.price, v.zbk, v.ord
from service_option_groups g
join businesses b on b.id = g.business_id
join services s on s.id = g.service_id
join (values
  -- bracket
  ('bracket', 'I have my own bracket',                 0::numeric,  '1685657519638x296785870103780400', 1),
  ('bracket', 'Flat',                                  45::numeric, '1685657519638x151782031594280160', 2),
  ('bracket', 'Tilting (recommended)',                 60::numeric, '1685657519638x293251872070913660', 3),
  ('bracket', 'Full Motion',                           110::numeric,'1685657519638x327788739524076600', 4),
  ('bracket', '85"-100" TV Flat Bracket',              90::numeric, '1776229587207x710284994703786000', 5),
  ('bracket', '85"-100" TV Tilting Bracket',           110::numeric,'1776229598255x578976769128267800', 6),
  ('bracket', '85"-100" TV Full Motion Bracket',       190::numeric,'1776229610718x521138691917742100', 7),
  ('bracket', 'Samsung Frame TV in-box bracket',       25::numeric, '1736123941131x483930420018151400', 8),
  -- fireplace
  ('fireplace', 'TV not over a fireplace',             0::numeric,  '1690749164365x391343451869544450', 1),
  ('fireplace', 'TV above a fireplace',                30::numeric, '1690749240392x103535038030413820', 2),
  -- surface
  ('surface', 'Drywall',                               0::numeric,  '1685657520672x628368921210809000', 1),
  ('surface', 'Brick',                                 35::numeric, '1685657520672x962594124305617300', 2),
  ('surface', 'Uneven Stone or Tile',                  50::numeric, '1685658012495x711713122836807700', 3),
  ('surface', 'Outdoor/Stucco',                        45::numeric, '1692765788131x467716510198005800', 4),
  -- wires
  ('wires', 'Hide wires BEHIND the wall',              75::numeric, '1685657520215x679178310990983400', 1),
  ('wires', 'Hide wires OUTSIDE the wall',             25::numeric, '1685657520215x860675929308834800', 2),
  ('wires', 'Wall already has a plug behind the TV',   0::numeric,  '1685657520215x846697647726538900', 3),
  ('wires', 'Hang wires under the TV',                 0::numeric,  '1696472636219x934279187941818400', 4),
  -- lifting
  ('lifting', 'TV under 70 inches',                    0::numeric,  '1685657521270x971699776821509000', 1),
  ('lifting', '70-85 inches, I can help lift',         0::numeric,  '1685657521270x242389337506608420', 2),
  ('lifting', '70-85 inches, I cannot help lift',      70::numeric, '1685657521270x264421370121691100', 3),
  ('lifting', '85 inches or larger',                   70::numeric, '1747842781494x315473919196528640', 4),
  -- dismount
  ('dismount', 'Guaranteed Dismount Service',          35::numeric, '1685657521717x559414519649398460', 1),
  ('dismount', "No, I'll handle TV removal myself",    0::numeric,  '1751646796269x538012740525228000', 2),
  -- extras
  ('extras', 'Install Samsung Frame OneConnect box',   350::numeric,'1736124404151x401859929508413400', 1),
  ('extras', 'Apple TV installation',                  25::numeric, '1711776157524x348981049297469440', 2),
  ('extras', 'Soundbar Installation',                  50::numeric, '1698905037955x771952325080383500', 3),
  ('extras', 'Install shelf under TV',                 45::numeric, '1698905090848x173584167038615550', 4),
  ('extras', 'LED Lights',                             50::numeric, '1698905111338x528324964985864200', 5),
  ('extras', '1 hour of Handyman Labor',               85::numeric, '1715820772054x920882061736149000', 6),
  ('extras', 'Other',                                  0::numeric,  '1698905159794x117137493532868600', 7)
) as v(gkey, label, price, zbk, ord) on v.gkey = g.key
where b.slug = 'handy-andy' and s.name = 'TV Installation'
  and not exists (select 1 from service_options o where o.group_id = g.id and o.zenbooker_option_id = v.zbk);
