-- Numbers whose calls and texts are never logged (owner call, 2026-09-06 --
-- the owner's own handset dialing the tracking lines to test them was filling
-- the Calls tab with fake leads and the Needs-callback queue with himself).
--
-- Deliberately NOT blocked_numbers: a blocked number is rejected before it
-- rings anyone, which is the opposite of what a test call needs. A silent
-- number rings, forwards, records and behaves exactly like any other caller --
-- it just leaves no row behind.
create table if not exists app.silent_numbers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,          -- 10-digit, same bare format as calls.caller_phone
  reason text,
  created_at timestamptz not null default now()
);

insert into app.silent_numbers (phone, reason)
values ('3374997817', 'Owner handset - test calls, do not log')
on conflict (phone) do nothing;
