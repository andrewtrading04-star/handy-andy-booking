-- AI pre-fill for "Build an estimate" on a Pipeline card (owner 2026-09-28):
-- the TV options read from the call, per business ({ business_id: result }).
alter table app.calls add column if not exists estimate_prefill jsonb;
