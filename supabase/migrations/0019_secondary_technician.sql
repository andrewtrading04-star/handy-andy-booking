-- Add secondary_technician_id to bookings for jobs requiring 2 techs
alter table if exists app.bookings
add column if not exists secondary_technician_id uuid references app.technicians(id) on delete set null;

-- Track the lifting need and TV size for reference
alter table if exists app.bookings
add column if not exists needs_lifting boolean default false;

alter table if exists app.bookings
add column if not exists tv_size_category text;  -- 'under_70', '70_to_85', 'can_help_lift'

create index if not exists idx_bookings_secondary_tech on app.bookings(secondary_technician_id);
