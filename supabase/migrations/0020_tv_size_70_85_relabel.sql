-- ============================================================================
-- Migration 0020: Relabel the "70–84"" TV size tier to "70–85"" (both brands)
-- ----------------------------------------------------------------------------
-- The large-TV size tiers should read 70–85", 85–97", 98"+. Only the first one
-- needs changing (the others already match). Label-only — pricing, ids and the
-- second-technician / bracket-tier logic are unaffected: the admin reads the
-- bracket tier from a "> 85"" rule, so a 70–85" label stays on the STANDARD
-- bracket tier (a 75" TV must not jump to the 85"+ brackets).
--
-- Keyed by zenbooker_option_id (stable), scoped to each brand's TV size group.
-- Idempotent. Run after 0019.
--
-- NOTE: the deployed admin app also self-heals this on first New Booking open
-- (action `relabel_tv_size`), so this file is the auditable record of the same
-- change for environments applied via SQL.
-- ============================================================================
set search_path = app, public, extensions;

-- ── Handy Andy — "TV Installation" size group ───────────────────────────────
update service_options
set label = '70"–85"'
where zenbooker_option_id = '1685657519214x168809705059288930'
  and group_id in (
    select g.id from service_option_groups g
    join services s on s.id = g.service_id
    join businesses b on b.id = s.business_id
    where b.slug = 'handy-andy' and s.name = 'TV Installation' and g.key = 'size'
  );

-- ── Doms — "Dom's TV Mounting" size group ───────────────────────────────────
update service_options
set label = '70"–85"'
where zenbooker_option_id = '1764781654525x578089275773681700'
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
