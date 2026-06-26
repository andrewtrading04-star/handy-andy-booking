-- ============================================================================
-- Migration 0030: Pending (unassigned) bracket deliveries + order link
-- ============================================================================
-- Extends the existing bracket inventory system (0029) so a Walmart delivery
-- can be recorded BEFORE it's assigned to a technician, and so the office can
-- click straight through to the Walmart order/tracking page.
--
-- Changes (all additive / idempotent):
--   1. bracket_purchases.technician_id becomes NULLABLE. A row with a NULL
--      technician_id is a "just delivered, not yet assigned" delivery. The
--      Bracket tab shows these at the bottom with an Assign control; assigning
--      sets technician_id and bumps that tech's bracket_inventory.
--   2. bracket_purchases.order_url stores the Walmart tracking/order link so the
--      "Recent Walmart Orders" rows are clickable.
--
-- Run after 0029.
-- ============================================================================
set search_path = app, public, extensions;

-- 1. Allow deliveries to exist before they're assigned to a tech.
alter table bracket_purchases alter column technician_id drop not null;

-- 2. Store the clickable Walmart order/tracking link.
alter table bracket_purchases add column if not exists order_url text;

-- ── One-time test seed: 4 full-motion brackets delivered (order #2000149-89433822)
-- Idempotent: only inserts if this order isn't already recorded.
insert into bracket_purchases
  (business_id, technician_id, walmart_order_num, flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url)
select
  b.id, null, '2000149-89433822', 0, 0, 4, 'delivered', date '2026-06-25', current_date,
  'https://w-mt.co/g/rptrcks/comm-smart-app/services/tracking/clickTracker?redirectTo=2lj3oPhC84oBjNCv5yk1gEXwZ69r8oON9Pvugo23Ccb3LVeMHqkCFuKiKjXWISYlOB1bmkz1%2Fnaegm%2B9GUEttp6nPb4P59EuPWOLV5IdTqoYJ5wK9NUZddl%2B6BvMzQVwm1GYQv0HkzIgoJ4kPto3Snc4cLc7nQXJDxm%2BIKGivqPIfOwLxLgCSpFwYiuU8EODd00rkyCmSWwoDpFNVHykkZxDkeTCWUxy9JbahRxklwjvpNc8zUHqJEIpkZRlpsoMCsKwzTaDIGOXTC%2FVL8lOB48XV7sy764CxFSSvDfyK2UOqVhnG6Hu1z6QdyaZ%2FgRNCAqwBuevcvAWPVrFf0RYh2qps3tVTJmEibuzPRWxhngqRNx%2Bga61pOIjq4BJSMZMP1JKHYFYQuMZFLyRf5gTu4RSIYFjSbIcmJ0z1LHfKn%2B0UxqtRy8AxcQcerhPbS%2FDi3rOSTsR9MGDrTbde0DUvgL%2Bwn5Jdp38T06HT1TG0FKT%2BGMCzFEX7vwDaQro%2FsxdHZ19ZU26pyXSSETWjYnOOa88OOXBk0IAZRTupnGOX%2BYhaqYXIfuJdnDC6v6r9RjJ1%2FDuc0E%2ButE%2Bo9hV4ySeOC7rPnGPZtN8AAxtosLM8rMak0R1taSvTmBHiQZpgCAAGdBhaR928R93d4FD9Z2oGJ2nlSDG7CbytQy9EMPs3bySAVsn56u5YXsFFP67Tg%2FQLI1lOy8QGSod8O3Ins4hucUMLK6RiPunrrGhQcou1COy62Ptjg6HV1vz6JAOhdz%2BdX4Y4LISBJfBHOJywalir84LQWceJnXW%2BdhfLdB5PJ4MbbDoGlxVwEZEHWjDcbyitJFocw2zeCZgDpwGkmGBDA6eXi9xm1qhZPKPopGZSRgv1iGohOjYKAl6yrvWyaiD&meta=5wqTmm2t22u%2BolvNhW5Wb7vSl9Y2MdQ%2BWWTy3sVBbhzbFetv1gKIOQeFmj3aKiMtiLusNi0Ka0PKPF%2F2qc%2Bnwe8TY3rt%2FkIwvhW5Zqzs8tVu%2BZNZzmBnhPZ6u4KdyTdOqfDmAH2Gc%2BXCPu9ZXkpOFaQ0kcT6tMg2PcsjZpePaTPaxrSiUergNmdqCab0ZOKefSglVN61ZeyE8303KylE8w%3D%3D&iv=HAwYkd8J9%2BMdsCGEpnzSTA%3D%3D'
from businesses b
where b.slug = 'handy-andy'
  and not exists (
    select 1 from bracket_purchases bp
    where bp.business_id = b.id and bp.walmart_order_num = '2000149-89433822'
  );

-- ============================================================================
-- DONE. Verify with:
--   select walmart_order_num, full_motion_qty, status, technician_id, order_url
--     from bracket_purchases where walmart_order_num = '2000149-89433822';
-- ============================================================================
