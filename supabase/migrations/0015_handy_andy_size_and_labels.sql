-- ============================================================================
-- Migration 0015: Handy Andy — add TV Size group + fix option labels
-- ----------------------------------------------------------------------------
-- Adds the missing 'size' option group (sort_order 1) with TX/Denver standard
-- pricing sourced from widget.js ZBK IDs. Also updates option labels across
-- all groups to match the official Handy Andy pricing PDF.
-- Idempotent. Run after 0014.
-- ============================================================================
set search_path = app, public, extensions;

-- ── 1. Add size group ────────────────────────────────────────────────────────
insert into service_option_groups (business_id, service_id, key, label, min_select, max_select, sort_order)
select s.business_id, s.id, 'size', 'TV Size', 1, 1, 1
from services s
join businesses b on b.id = s.business_id
where b.slug = 'handy-andy' and s.name = 'TV Installation'
on conflict (service_id, key) do nothing;

-- ── 2. Add size options (TX/Denver standard pricing) ─────────────────────────
insert into service_options (business_id, group_id, label, price, zenbooker_option_id, sort_order)
select g.business_id, g.id, v.label, v.price, v.zbk, v.ord
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
cross join (values
  ('32" or Less',  99::numeric,  '1685657519214x408615950244710660', 1),
  ('33"–59"',     109::numeric,  '1685657519214x406129807645840830', 2),
  ('60"–69"',     119::numeric,  '1685657519214x241977595988204900', 3),
  ('70"–84"',     149::numeric,  '1685657519214x168809705059288930', 4),
  ('85"–97"',     179::numeric,  '1693451324278x246099356920840200', 5),
  ('98"+',        229::numeric,  '1729566606709x280549383678984200', 6)
) as v(label, price, zbk, ord)
where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'size'
  and not exists (select 1 from service_options o where o.group_id = g.id and o.zenbooker_option_id = v.zbk);

-- ── 3. Update option labels to match pricing PDF ─────────────────────────────
-- Use a single UPDATE per group via a values table joined on ZBK id.

-- Bracket
update service_options so
set label = v.label
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
join (values
  ('1736123941131x483930420018151400', 'Samsung Frame TV bracket (box included)')
) as v(zbk, label) on so.zenbooker_option_id = v.zbk
where so.group_id = g.id and g.key = 'bracket'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- Fireplace
update service_options so
set label = v.label
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
join (values
  ('1690749164365x391343451869544450', 'TV NOT above a fireplace'),
  ('1690749240392x103535038030413820', 'TV above a fireplace')
) as v(zbk, label) on so.zenbooker_option_id = v.zbk
where so.group_id = g.id and g.key = 'fireplace'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- Wires
update service_options so
set label = v.label
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
join (values
  ('1685657520215x846697647726538900', 'Wall already has plug behind TV'),
  ('1696472636219x934279187941818400', 'Wires hang under the TV')
) as v(zbk, label) on so.zenbooker_option_id = v.zbk
where so.group_id = g.id and g.key = 'wires'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- Lifting group label
update service_option_groups g
set label = 'Second Technician (Large TVs)'
from services s
join businesses b on b.id = s.business_id
where g.service_id = s.id and g.key = 'lifting'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- Lifting options
update service_options so
set label = v.label
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
join (values
  ('1685657521270x971699776821509000', 'TV under 70" (no lifting fee)'),
  ('1685657521270x242389337506608420', '70–85" — customer can help lift'),
  ('1685657521270x264421370121691100', '70–85" — customer cannot help lift'),
  ('1747842781494x315473919196528640', '85"+ (second technician required)')
) as v(zbk, label) on so.zenbooker_option_id = v.zbk
where so.group_id = g.id and g.key = 'lifting'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- Dismount options
update service_options so
set label = v.label
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
join (values
  ('1685657521717x559414519649398460', 'Guaranteed Dismount Service (when upgrading later)'),
  ('1751646796269x538012740525228000', 'No — I''ll handle removal myself')
) as v(zbk, label) on so.zenbooker_option_id = v.zbk
where so.group_id = g.id and g.key = 'dismount'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- Extras
update service_options so
set label = v.label
from service_option_groups g
join services s on s.id = g.service_id
join businesses b on b.id = s.business_id
join (values
  ('1736124404151x401859929508413400', 'Install Samsung Frame OneConnect box behind TV'),
  ('1711776157524x348981049297469440', 'Apple TV installation (mounting bracket included)')
) as v(zbk, label) on so.zenbooker_option_id = v.zbk
where so.group_id = g.id and g.key = 'extras'
  and b.slug = 'handy-andy' and s.name = 'TV Installation';

-- ============================================================================
-- DONE. Verify with:
--   select g.key, g.label, o.label, o.price
--   from service_option_groups g
--   join service_options o on o.group_id = g.id
--   join services s on s.id = g.service_id
--   join businesses b on b.id = s.business_id
--   where b.slug = 'handy-andy' and s.name = 'TV Installation'
--   order by g.sort_order, o.sort_order;
-- ============================================================================
