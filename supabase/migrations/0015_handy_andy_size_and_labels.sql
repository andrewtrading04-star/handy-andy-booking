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
-- Postgres UPDATE..FROM can't add JOINs after the first FROM table, so each
-- relabel is a standalone UPDATE scoped to the Handy Andy TV Installation group.

-- helper note: this CTE-free style avoids the 42P01 "invalid reference" error.
update service_options
set label = 'Samsung Frame TV bracket (box included)'
where zenbooker_option_id = '1736123941131x483930420018151400'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'bracket');

update service_options
set label = 'TV NOT above a fireplace'
where zenbooker_option_id = '1690749164365x391343451869544450'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'fireplace');

update service_options
set label = 'TV above a fireplace'
where zenbooker_option_id = '1690749240392x103535038030413820'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'fireplace');

update service_options
set label = 'Wall already has plug behind TV'
where zenbooker_option_id = '1685657520215x846697647726538900'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'wires');

update service_options
set label = 'Wires hang under the TV'
where zenbooker_option_id = '1696472636219x934279187941818400'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'wires');

update service_option_groups
set label = 'Second Technician (Large TVs)'
where key = 'lifting' and service_id in (select s.id from services s join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation');

update service_options
set label = 'TV under 70" (no lifting fee)'
where zenbooker_option_id = '1685657521270x971699776821509000'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'lifting');

update service_options
set label = '70–85" — customer can help lift'
where zenbooker_option_id = '1685657521270x242389337506608420'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'lifting');

update service_options
set label = '70–85" — customer cannot help lift'
where zenbooker_option_id = '1685657521270x264421370121691100'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'lifting');

update service_options
set label = '85"+ (second technician required)'
where zenbooker_option_id = '1747842781494x315473919196528640'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'lifting');

update service_options
set label = 'Guaranteed Dismount Service (when upgrading later)'
where zenbooker_option_id = '1685657521717x559414519649398460'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'dismount');

update service_options
set label = 'No — I''ll handle removal myself'
where zenbooker_option_id = '1751646796269x538012740525228000'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'dismount');

update service_options
set label = 'Install Samsung Frame OneConnect box behind TV'
where zenbooker_option_id = '1736124404151x401859929508413400'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'extras');

update service_options
set label = 'Apple TV installation (mounting bracket included)'
where zenbooker_option_id = '1711776157524x348981049297469440'
  and group_id in (select g.id from service_option_groups g join services s on s.id = g.service_id join businesses b on b.id = s.business_id where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'extras');

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
