-- Set technician colors for Handy Andy dashboard
update app.technicians
set color = case
  when name = 'Juan' then '#2563eb'  -- blue
  when name = 'Kregg' then '#16a34a' -- green
  when name = 'Steve' then '#ca8a04' -- yellow
  when name = 'Zach' then '#6b7280'  -- grey
  else color
end
where business_id = (select id from app.businesses where slug = 'handy-andy')
  and name in ('Juan', 'Kregg', 'Steve', 'Zach');
