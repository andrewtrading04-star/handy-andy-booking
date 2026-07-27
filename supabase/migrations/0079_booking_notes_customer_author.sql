-- Self-serve reschedule (customer email link) logs an internal note on the
-- booking so the office can see it happened without digging through email.
-- The existing author_kind check ('owner','secretary','technician') has no
-- slot for an action the CUSTOMER themself took -- add one instead of
-- mislabeling it as an office action.
alter table app.booking_notes drop constraint if exists booking_notes_author_kind_check;
alter table app.booking_notes add constraint booking_notes_author_kind_check
  check (author_kind in ('owner','secretary','technician','customer'));
