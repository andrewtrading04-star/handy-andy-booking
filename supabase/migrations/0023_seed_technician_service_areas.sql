-- Assign technicians to their service areas based on city coverage
-- This enables cross-company secondary tech selection to filter by matching city

do $$
declare
  ha_id uuid;
  doms_id uuid;
  denver_ha_id uuid;
  austin_ha_id uuid;
  houston_ha_id uuid;
  denver_doms_id uuid;
begin
  -- Get business IDs
  select id into ha_id from app.businesses where slug = 'handy-andy' limit 1;
  select id into doms_id from app.businesses where slug = 'doms' limit 1;

  -- Get service area IDs
  select id into denver_ha_id from app.service_areas where business_id = ha_id and name = 'Denver' limit 1;
  select id into austin_ha_id from app.service_areas where business_id = ha_id and name = 'Austin' limit 1;
  select id into houston_ha_id from app.service_areas where business_id = ha_id and name = 'Houston' limit 1;
  select id into denver_doms_id from app.service_areas where business_id = doms_id and name = 'Denver' limit 1;

  -- Assign Handy Andy technicians
  if ha_id is not null then
    -- Kregg and Steve → Denver
    update app.technicians set service_area_id = denver_ha_id
    where business_id = ha_id and name in ('Kregg', 'Steve') and service_area_id is null;

    -- Zach → Austin
    update app.technicians set service_area_id = austin_ha_id
    where business_id = ha_id and name = 'Zach' and service_area_id is null;

    -- Juan → Houston
    update app.technicians set service_area_id = houston_ha_id
    where business_id = ha_id and name = 'Juan' and service_area_id is null;
  end if;

  -- Assign Doms technicians
  if doms_id is not null then
    -- TK and George → Denver
    update app.technicians set service_area_id = denver_doms_id
    where business_id = doms_id and name in ('TK', 'George') and service_area_id is null;
  end if;
end $$;
