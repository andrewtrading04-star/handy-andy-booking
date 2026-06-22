-- ============================================================================
-- Migration 0021: TV size tiers — 85–97" → 86–97" (no overlap at 85), and
--                 normalize Doms "98 plus" → 98"+
-- ----------------------------------------------------------------------------
-- The large-TV size tiers should read 70–85", 86–97", 98"+ — non-overlapping at
-- 85 (0020 set the 70–85" tier). Label-only; pricing, ids and the bracket-tier
-- logic are unaffected (a "> 85"" rule keeps 70–85" standard, 86–97" XL).
--
-- Keyed by zenbooker_option_id (stable), scoped to each brand's TV size group.
-- Idempotent. Run after 0020.
--
-- NOTE: the deployed admin app also self-heals this on first New Booking open
-- (action `relabel_tv_size`), so this file is the auditable record of the same
-- change for environments applied via SQL.
-- ============================================================================
set search_path = app, public, extensions;

-- ── Handy Andy — "TV Installation": 85–97" → 86–97" ─────────────────────────
update service_options
set label = '86"–97"'
where zenbooker_option_id = '1693451324278x246099356920840200'
  and group_id in (
    select g.id from service_option_groups g
    join services s on s.id = g.service_id
    join businesses b on b.id = s.business_id
    where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'size'
  );

-- ── Doms — "Dom's TV Mounting": 85–97" → 86–97", and "98 plus" → 98"+ ────────
update service_options
set label = '86"–97"'
where zenbooker_option_id = '1764781660924x702639599859793900'
  and group_id in (
    select g.id from service_option_groups g
    join services s on s.id = g.service_id
    join businesses b on b.id = s.business_id
    where b.slug = 'doms' and s.name = 'Dom''s TV Mounting' and g.key = 'size'
  );

update service_options
set label = '98"+'
where zenbooker_option_id = '1764781681218x409141618447220740'
  and group_id in (
    select g.id from service_option_groups g
    join services s on s.id = g.service_id
    join businesses b on b.id = s.business_id
    where b.slug = 'doms' and s.name = 'Dom''s TV Mounting' and g.key = 'size'
  );

-- ============================================================================
-- DONE. Verify with:
--   select b.slug, o.label, o.sort_order
--   from service_options o
--   join service_option_groups g on g.id = o.group_id
--   join services s on s.id = g.service_id
--   join businesses b on b.id = s.business_id
--   where g.key = 'size' order by b.slug, o.sort_order;
-- ============================================================================
