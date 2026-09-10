-- A market's street address is a real fact Google's video verifier checks
-- the location against, not a yes/no. Previously tracked as a has_address
-- checkbox on the launch checklist (settings.launch_checklist); that could
-- only say whether someone glanced at one, never what it actually is. Now a
-- first-class column, set via launch_market_address_set in api/admin.js.
alter table app.markets add column if not exists address text;
