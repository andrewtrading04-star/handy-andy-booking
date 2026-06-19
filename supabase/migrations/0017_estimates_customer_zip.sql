-- Add customer_zip to app.estimates (collected on the estimate request form).
alter table app.estimates
  add column if not exists customer_zip text;
