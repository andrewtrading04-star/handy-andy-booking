-- Add service_area_id FK to technicians table for city-based filtering
alter table if exists app.technicians
add column if not exists service_area_id uuid references app.service_areas(id) on delete set null;

create index if not exists idx_technicians_service_area on app.technicians(service_area_id);
