-- Blocked caller numbers (owner call, 2026-08-29 -- scammer/robocall volume on
-- the tracking lines). A blocked number is rejected before it ever rings
-- anyone, business-wide (a scammer calling one brand is calling all of them).
create table if not exists app.blocked_numbers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,          -- 10-digit, same bare format as calls.caller_phone
  reason text,
  blocked_by text,                     -- auth.name at the time it was blocked
  call_id uuid references app.calls(id) on delete set null,  -- the call that triggered the block, if any
  created_at timestamptz not null default now()
);

-- Per-line toggle for the "press 1 to continue" scam filter, defaulting ON --
-- some lines (e.g. a number only ever given out privately) may not need the
-- extra friction, so this stays a flag rather than a global behavior change.
alter table app.tracking_numbers add column if not exists ivr_gate_enabled boolean not null default true;
