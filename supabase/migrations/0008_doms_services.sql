-- ============================================================================
-- Migration 0008: Doms TV Mounting — complete service catalogue
-- ----------------------------------------------------------------------------
-- Replaces the 0001 placeholder "TV Installation" with real Doms services
-- sourced directly from Doms' Zenbooker account.
--
-- Services seeded:
--   Dom's TV Mounting         (bookable, full pricing)
--   Handyman Services         (quote request, min $170)
--   Art Mounting & Install    (quote request)
--   Furniture Assembly        (quote request)
--   Ring Doorbell Install     (bookable, base $119)
--   Drywall Repair            (quote request)
--   Gutter Cleaning           (quote request, min $250)
--   Home Theater Quote        (quote request)
--
-- Run after 0007. Idempotent.
-- ============================================================================
set search_path = app, public, extensions;

-- ── Rename the 0001 placeholder to the real service name ──────────────────
update services
set name                 = 'Dom''s TV Mounting',
    description          = 'Professional TV mounting and installation',
    base_price           = 0,
    duration_minutes     = 120,
    category             = 'TV Mounting',
    zenbooker_service_id = '1764781543375x970898546217713700',
    settings             = jsonb_build_object('booking_flow','bookable','credit_card_capture',true)
where business_id = (select id from businesses where slug = 'doms')
  and name = 'TV Installation';

-- ── Additional Doms services ───────────────────────────────────────────────
insert into services (business_id, name, description, base_price, duration_minutes, category, zenbooker_service_id, settings)
select b.id, v.name, v.descr, v.base_price, v.dur, v.cat, v.zbk,
       jsonb_build_object('booking_flow', v.flow, 'min_price', v.min_price)
from businesses b
cross join (values
  ('Handyman Services',
   'Book a handyman for home repairs and small projects. We handle drywall, leaky fixtures, furniture assembly, and more.',
   0, 90,  'Handyman', '1772707009158x823589363475393000', 'quote_request', 170.00::numeric),
  ('Art Mounting & Installation',
   'Professional art mounting for residential and commercial spaces. Homes, galleries, offices, hotels, and more.',
   0, 120, 'Handyman', '1772707400150x343043981157018050', 'quote_request', null::numeric),
  ('Furniture Assembly',
   'On-site furniture assembly for flat-pack and boxed items from IKEA, Wayfair, Amazon, and more.',
   0, 120, 'Handyman', '1772708206210x382142538367018940', 'quote_request', null),
  ('Ring Doorbell Installation',
   'Installation and setup of your Ring doorbell including mounting, wiring, Wi-Fi, and app configuration.',
   119.00, 60,  'Handyman', '1772710220269x639356084965264000', 'bookable', 119.00),
  ('Drywall Repair',
   'Drywall repair for holes, dents, popped screws, stress cracks, and seam repairs. Patch, tape, mud, sand, and prime.',
   0, 120, 'Handyman', '1772712131170x151769163563091100', 'quote_request', null),
  ('Gutter Cleaning',
   'Professional gutter cleaning — removes leaves and debris, clears downspouts, bags waste.',
   0, 120, 'Handyman', '1772712555965x204944881710067400', 'quote_request', 250.00),
  ('Home Theater Quote',
   'Custom home theater installation. Projectors, screens, surround sound, and more.',
   0, 60,  'Handyman', '1779489954923x916667929316261400', 'quote_request', null)
) as v(name, descr, base_price, dur, cat, zbk, flow, min_price)
where b.slug = 'doms'
on conflict (business_id, name) do nothing;

-- ============================================================================
-- Dom's TV Mounting — option groups
-- ============================================================================
insert into service_option_groups (business_id, service_id, key, label, min_select, max_select, sort_order)
select s.business_id, s.id, v.key, v.label, v.mins, v.maxs, v.ord
from services s
join businesses b on b.id = s.business_id
cross join (values
  ('size',      'TV Size',       1, 1, 1),
  ('bracket',   'Bracket',       1, 1, 2),
  ('fireplace', 'Fireplace',     1, 1, 3),
  ('wires',     'Wire Hiding',   0, 1, 4),
  ('surface',   'Wall Surface',  0, 1, 5),
  ('lifting',   'Lifting Help',  1, 1, 6),
  ('dismount',  'Dismount',      1, 1, 7),
  ('extras',    'Add-ons',       0, 0, 8)
) as v(key, label, mins, maxs, ord)
where b.slug = 'doms' and s.name = 'Dom''s TV Mounting'
on conflict (service_id, key) do nothing;

-- Dom's TV Mounting — options
insert into service_options (business_id, group_id, label, price, zenbooker_option_id, sort_order)
select g.business_id, g.id, v.label, v.price, v.zbk, v.ord
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
cross join (values
  -- size
  ('size', '32" Or Less',                                          95.00::numeric, '1764781594789x318721355074764800', 1),
  ('size', '33"-59"',                                            125.00,           '1764781624346x760390952972976100', 2),
  ('size', '60"-69"',                                            135.00,           '1764781641055x142375876391862270', 3),
  ('size', '70"-84"',                                            145.00,           '1764781654525x578089275773681700', 4),
  ('size', '85"-97"',                                            180.00,           '1764781660924x702639599859793900', 5),
  ('size', '98+',                                                240.00,           '1764781681218x409141618447220740', 6),
  -- bracket
  ('bracket', 'I have my own mounting bracket',                    0.00,           '1764781695979x585351672630607900', 1),
  ('bracket', 'Flat',                                             55.00,           '1764781724913x667945483404312600', 2),
  ('bracket', 'Tilting (recommended)',                            65.00,           '1764781740844x374872284807036900', 3),
  ('bracket', 'Full Motion',                                     115.00,           '1764781758821x396301420113952800', 4),
  ('bracket', 'Install customer supplied Mantel Mount',          195.00,           '1764781773911x692295442051891200', 5),
  ('bracket', 'Samsung Frame TV in-box bracket',                  30.00,           '1764781794581x623799211951128600', 6),
  -- fireplace
  ('fireplace', 'TV not over a fireplace',                         0.00,           '1764781821695x630871999156846600', 1),
  ('fireplace', 'TV above a fireplace',                           30.00,           '1764781843025x870286046585684000', 2),
  -- wires
  ('wires', 'Hide wires BEHIND the wall',                         75.00,           '1764781866356x438486166961913860', 1),
  ('wires', 'Hide wires OUTSIDE the wall',                        25.00,           '1764781906084x341563416629477400', 2),
  ('wires', 'Wall already has a plug behind the TV',               0.00,           '1764781916398x653623231273500700', 3),
  ('wires', 'Hang wires under the TV',                             0.00,           '1764781930302x564364127584649200', 4),
  -- surface
  ('surface', 'Drywall',                                           0.00,           '1764781965027x673354826810130400', 1),
  ('surface', 'Brick/Stone',                                      35.00,           '1764781987737x423735091930857500', 2),
  ('surface', 'Uneven Stone or Tile',                             50.00,           '1764782050919x142418167765401600', 3),
  ('surface', 'Outdoor/Stucco',                                   45.00,           '1764782067149x819906368310345700', 4),
  -- lifting
  ('lifting', 'My TV is under 70 inches',                          0.00,           '1764782088936x256465061194235900', 1),
  ('lifting', 'My TV is 70-85 inches and I can help lift',         0.00,           '1764782113636x102636028242952200', 2),
  ('lifting', 'My TV is 70-85 inches and I cannot help lift',     70.00,           '1764782128214x566028847520153600', 3),
  ('lifting', 'My TV is 86 inches or larger',                     70.00,           '1764782163472x384097097839018000', 4),
  -- dismount
  ('dismount', 'Guaranteed Dismount Service',                      35.00,          '1764782188853x808798292635025400', 1),
  ('dismount', 'No, I''ll handle TV removal myself',               0.00,           '1764782211660x555988338401083400', 2),
  -- extras
  ('extras', 'Install Samsung Frame OneConnect box',              350.00,          '1764782250840x266842303435112450', 1),
  ('extras', 'Apple TV installation',                              25.00,          '1764782279505x271635817643376640', 2),
  ('extras', 'Soundbar Installation',                              50.00,          '1764782290711x970982184191000600', 3),
  ('extras', 'Install shelf under TV',                             45.00,          '1764782309911x896006087691206700', 4),
  ('extras', 'LED Lights',                                         50.00,          '1764782317800x921128088064491500', 5),
  ('extras', 'Handyman Labor',                                     85.00,          '1764782333235x217237333436530700', 6),
  ('extras', 'Other',                                               0.00,          '1764782349563x143330046980390910', 7)
) as v(gkey, label, price, zbk, ord) on v.gkey = g.key
where b.slug = 'doms' and s.name = 'Dom''s TV Mounting'
  and not exists (select 1 from service_options o where o.group_id = g.id and o.zenbooker_option_id = v.zbk);

-- ============================================================================
-- Ring Doorbell Installation — option groups + options
-- ============================================================================
insert into service_option_groups (business_id, service_id, key, label, min_select, max_select, sort_order)
select s.business_id, s.id, v.key, v.label, v.mins, v.maxs, v.ord
from services s
join businesses b on b.id = s.business_id
cross join (values
  ('quantity', 'Number of Doorbells', 1, 1, 1),
  ('power',    'Power Type',          1, 1, 2)
) as v(key, label, mins, maxs, ord)
where b.slug = 'doms' and s.name = 'Ring Doorbell Installation'
on conflict (service_id, key) do nothing;

insert into service_options (business_id, group_id, label, price, zenbooker_option_id, sort_order)
select g.business_id, g.id, v.label, v.price, v.zbk, v.ord
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
cross join (values
  ('quantity', '1 Ring doorbell',                             0.00::numeric, '1772710220631x545902833582903040', 1),
  ('quantity', '2 Ring doorbells',                          119.00,          '1772710220714x371504513018741100', 2),
  ('quantity', '3 Ring doorbells',                          238.00,          '1772710220774x125326891867570060', 3),
  ('quantity', '4+ Ring doorbells (custom quote)',             0.00,          '1772710220826x524416023136133250', 4),
  ('power',    'Existing wired doorbell power',                0.00,          '1772710221297x647953480650737700', 1),
  ('power',    'Battery-powered installation',                 0.00,          '1772710221356x712672325553018500', 2),
  ('power',    'New hardwiring required (quote)',               0.00,          '1772710221414x198434752992714180', 3)
) as v(gkey, label, price, zbk, ord) on v.gkey = g.key
where b.slug = 'doms' and s.name = 'Ring Doorbell Installation'
  and not exists (select 1 from service_options o where o.group_id = g.id and o.zenbooker_option_id = v.zbk);

-- ============================================================================
-- DONE. Verify with:
--   select name, base_price, category from services
--   where business_id = (select id from businesses where slug = 'doms')
--   order by name;
-- ============================================================================
