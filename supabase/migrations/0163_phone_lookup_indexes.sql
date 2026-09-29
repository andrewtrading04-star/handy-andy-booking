-- Calls tab speed (owner 2026-09-30): the per-caller history lookups match on
-- phone. customers only had (business_id, phone), so the owner's lookup (no
-- business filter) was a full scan; messages/estimates had no phone index.
create index if not exists idx_customers_phone_only on app.customers (phone);
create index if not exists idx_messages_customer_phone_created on app.messages (customer_phone, created_at desc);
create index if not exists idx_estimates_customer_phone_created on app.estimates (customer_phone, created_at desc);
