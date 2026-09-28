-- Gold-star customers: 3+ completed, paid jobs (owner 2026-09-28).
create or replace view app.vip_phones as
select right(regexp_replace(c.phone,'\D','','g'),10) as phone, count(*)::int as paid_jobs
from app.bookings b join app.customers c on c.id=b.customer_id
where b.status='completed' and b.payment_status='paid' and c.phone is not null
group by 1 having count(*) >= 3;
