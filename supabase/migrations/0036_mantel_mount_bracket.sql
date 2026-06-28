-- ============================================================================
-- Migration 0036: Add "Mantel Mount" bracket option for Handy Andy
-- ----------------------------------------------------------------------------
-- Adds a new choice at the BOTTOM of the Bracket list in the admin New Booking
-- form: "Mantel Mount" — $195 to the customer. The technician is paid $110 for
-- it (handled in api/_lib/payroll.js, not stored here).
--
-- Idempotent: only inserts if it isn't already there. Run after 0035.
-- ============================================================================
set search_path = app, public, extensions;

insert into service_options (business_id, group_id, label, price, sort_order, active)
select s.business_id, g.id, 'Mantel Mount', 195, 99, true
from service_option_groups g
join services s   on s.id = g.service_id
join businesses b on b.id = s.business_id
where b.slug = 'handy-andy'
  and g.key = 'bracket'
  and not exists (
    select 1 from service_options o where o.group_id = g.id and o.label = 'Mantel Mount'
  );

-- ============================================================================
-- DONE. Verify with:
--   select o.label, o.price, o.sort_order
--     from service_options o
--     join service_option_groups g on g.id = o.group_id
--     join services s on s.id = g.service_id
--     join businesses b on b.id = s.business_id
--    where b.slug = 'handy-andy' and g.key = 'bracket'
--    order by o.sort_order;
-- ============================================================================
