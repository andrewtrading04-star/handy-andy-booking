-- Owner-editable PHP -> USD reference rate, per pay week (falls back to the
-- PHP_PER_USD constant in api/admin.js when not set). Lets the owner type in
-- the real rate instead of relying on a hardcoded approximation that drifts.
alter table app.office_pay_weekly add column if not exists php_rate numeric;
