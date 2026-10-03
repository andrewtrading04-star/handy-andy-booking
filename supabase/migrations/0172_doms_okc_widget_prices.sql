-- Dom's Oklahoma City widget prices (city_key 'oklahoma_city').
-- One row per Dom's 'default' (Denver) row, same option ids/labels; prices
-- mirror Handy Andy Denver where an equivalent item exists, else Dom's Denver.
insert into app.widget_prices (business_id, city_key, section_key, option_id, label, price, sort_order, row_key)
select d.business_id, 'oklahoma_city', d.section_key, d.option_id, d.label,
       case d.row_key
         when 'bracket_11' then 45   -- Flat (HA 45)
         when 'bracket_13' then 110  -- Full Motion (HA 110)
         when 'bracket_15' then 25   -- Samsung Frame in-box bracket (HA bracket_17)
         when 'size_1' then 99
         when 'size_2' then 109
         when 'size_3' then 119
         when 'size_4' then 149
         when 'size_5' then 189
         when 'size_6' then 250
         else d.price                -- identical in HA, or no HA equivalent
       end,
       d.sort_order, d.row_key
from app.widget_prices d
join app.businesses b on b.id = d.business_id and b.slug = 'doms'
where d.city_key = 'default'
  and not exists (select 1 from app.widget_prices x
                  where x.business_id = d.business_id and x.city_key = 'oklahoma_city' and x.option_id = d.option_id);
