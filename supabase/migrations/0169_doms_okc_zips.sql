-- 0169: Dom's Oklahoma City metro zips.
-- Census 2023 ZCTA centroids within 30 mi (haversine) of 73099 (Yukon, OK),
-- home zip of the incoming OKC tech. ZCTAs exclude PO-box-only zips. 76 zips.
-- All fees/payouts 0 (column defaults). Area stays unstaffed=true until the
-- tech finishes sign-up and sets weekly times.
insert into app.service_area_zips (business_id, service_area_id, postal_code, surcharge, tech_payout, travel_fee, travel_payout)
select '6a716a5d-431f-40cf-822b-18219e200047', '87844ace-8282-4893-a64e-3cdeca0efcdc', z, 0, 0, 0, 0
from unnest(array['73003','73004','73007','73008','73010','73012','73013','73014','73016','73019','73020','73022','73025','73034','73036','73049','73059','73064','73065','73066','73069','73070','73071','73072','73078','73079','73084','73089','73090','73097','73099','73102','73103','73104','73105','73106','73107','73108','73109','73110','73111','73112','73114','73115','73116','73117','73118','73119','73120','73121','73122','73127','73128','73129','73130','73131','73132','73134','73135','73139','73141','73142','73145','73149','73150','73151','73159','73160','73162','73165','73169','73170','73173','73179','73750','73762']) as z
on conflict (business_id, postal_code) do nothing;
