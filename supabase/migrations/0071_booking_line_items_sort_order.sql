-- Line items can now be dragged into a custom order in the admin booking
-- modal. Without an explicit sort column, a delete-and-reinsert save (as
-- bookingLineItemsSave already does) has no reliable way to preserve the
-- edited order on the next read — created_at is identical for every row in
-- the same insert statement, and id is a random uuid.
alter table app.booking_line_items add column if not exists sort_order integer not null default 0;
