-- ============================================================================
-- Migration 0111: technician sign-up invites
-- ----------------------------------------------------------------------------
-- The owner sends a would-be technician a link from the Technicians tab. They
-- open it on their phone (public/join.html), create their own login (name,
-- phone, 4-digit PIN), tap the weekly times they can work, and hit Start. At
-- that moment they are an ACTIVE technician in the invite's metro WITH
-- availability rows, which is everything pickOpenTech() / publicOpenSlots()
-- (api/_lib/availability.js) need to start handing them jobs and everything
-- notifyTechAssigned() needs to text them. Nothing in dispatch changes.
-- Before this there was no way to create a technician from the UI at all:
-- every row was seeded by hand or by the Zenbooker import.
--
-- ONE ROW PER INVITE. The link carries only `code`. Everything that decides
-- where the tech lands (business, metro, starting daily cap, the phone it is
-- locked to) lives on this row and is NEVER read from the sign-up request.
-- `code` is stored in plaintext on purpose, like bookings.review_token, so the
-- owner can copy the link again days later; the table is service-role only
-- (RLS forced), and a code is 100 random bits, single-use, expiring and
-- revocable. status is pending -> joined | revoked; "expired" is DERIVED
-- (pending and expires_at <= now()) so no cron is needed and Resend revives
-- the same link by pushing expires_at out.
--
-- THE SIGN-UP COMMITS IN ONE TRANSACTION (claim_tech_invite below). The
-- technician row, its bcrypt PIN and its availability appear together or not
-- at all: a closed tab or a dead lambda never leaves a half-made tech, and a
-- double-tapped Start can never make two (the invite row is locked FOR UPDATE).
--
-- ONE ACTIVE TECHNICIAN PER PHONE NUMBER. verify_technician_pin() matches
-- technicians.phone as an exact string in ANY business and login() takes the
-- first hit, while the only uniqueness so far was (business_id, phone). Two
-- active rows sharing a number (different companies, or one number stored in
-- two formats) would make "who am I" depend on row order. Zero such pairs exist
-- (checked 2026-09-15); the partial index below keeps it that way and is also
-- the backstop for two different invites racing on one number.
--
-- THE PIN FUNCTIONS WERE CALLABLE WITH THE PUBLIC ANON KEY. anon has USAGE on
-- schema app (PostgREST serves it: serviceClient() uses db.schema 'app') and
-- Postgres grants EXECUTE on new functions to PUBLIC, so on 2026-09-15
-- has_function_privilege('anon', ...) was TRUE for verify_technician_pin (an
-- unthrottled 4-digit PIN oracle) and set_technician_pin (overwrite any tech's
-- PIN given their id). Only the service-role API ever calls them. This
-- migration mints new PIN accounts, so it closes that first and creates its own
-- SECURITY DEFINER function already locked.
--
-- Idempotent. Run after 0110.
-- ============================================================================
set search_path = app, public, extensions;

-- ── 1. Invites ──────────────────────────────────────────────────────────────
create table if not exists tech_invites (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  service_area_id  uuid not null references service_areas(id) on delete cascade,
  code             text not null unique,
  invitee_name     text,          -- optional; only used for "Hi Maria" in the text
  invitee_phone    text,          -- E.164; when set, sign-up MUST use this number
  max_jobs_per_day integer check (max_jobs_per_day is null or max_jobs_per_day >= 0),
  status           text not null default 'pending' check (status in ('pending', 'joined', 'revoked')),
  expires_at       timestamptz not null default (now() + interval '7 days'),
  created_by       text,
  sent_at          timestamptz,
  send_count       integer not null default 0,
  last_sms_log_id  uuid,          -- tech_sms_log row of the latest invite text (delivery status)
  opened_at        timestamptz,   -- first time the join page actually loaded it
  open_count       integer not null default 0,
  claim_nonce      text,          -- the joining device's retry key (see claim_tech_invite)
  joined_at        timestamptz,
  technician_id    uuid references technicians(id) on delete set null,
  sms_consent_at   timestamptz,   -- they ticked "text me my jobs" (never pre-checked)
  revoked_at       timestamptz,
  revoked_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table tech_invites is
  'Technician sign-up links (0111). Placement (business, metro, cap, bound phone) lives here, never in the sign-up request. Expired = pending and expires_at <= now().';

create index if not exists idx_tech_invites_business on tech_invites (business_id, created_at desc);

-- One live invite per number per business: re-inviting the same person updates
-- their pending invite (api/admin.js tech_invite_create) instead of stacking
-- duplicates that could each create an account.
create unique index if not exists uq_tech_invites_pending_phone
  on tech_invites (business_id, (right(regexp_replace(invitee_phone, '\D', '', 'g'), 10)))
  where status = 'pending' and invitee_phone is not null;

drop trigger if exists trg_tech_invites_updated on tech_invites;
create trigger trg_tech_invites_updated before update on tech_invites
  for each row execute function set_updated_at();

alter table tech_invites enable row level security;
alter table tech_invites force row level security;
revoke all on tech_invites from anon, authenticated;
grant all on tech_invites to service_role;

-- ── 2. One active technician per phone number ───────────────────────────────
do $$
begin
  if exists (
    select 1 from technicians
     where active and phone is not null and length(regexp_replace(phone, '\D', '', 'g')) >= 10
     group by right(regexp_replace(phone, '\D', '', 'g'), 10)
    having count(*) > 1
  ) then
    raise exception '0111: two ACTIVE technicians share a phone number. Blank or deactivate the stale one, then re-run.';
  end if;
end $$;

create unique index if not exists uq_technicians_active_phone10
  on technicians ((right(regexp_replace(phone, '\D', '', 'g'), 10)))
  where active and phone is not null and length(regexp_replace(phone, '\D', '', 'g')) >= 10;

-- ── 3. The sign-up, atomically ──────────────────────────────────────────────
-- The API (api/tech.js join_complete) validates shape first: name, E.164 phone,
-- 4-digit non-trivial PIN, normalizeSlots(), the consent tick. This function
-- owns every decision that must be atomic with the write. The PIN is hashed
-- here, like set_technician_pin, so it never touches a table in plaintext.
-- Soft failures RETURN an outcome instead of raising, so the API can map each
-- to a clear message:
--   joined | replay | used | revoked | expired | not_found | bad_input |
--   phone_mismatch | area_inactive | phone_in_use | past_profile
create or replace function claim_tech_invite(
  p_code  text,
  p_nonce text,
  p_name  text,
  p_phone text,    -- E.164, from the form (checked against invitee_phone when bound)
  p_pin   text,
  p_slots jsonb    -- [{"day_of_week":1,"slot_key":"s2"}, ...]
)
returns table (outcome text, tech_id uuid, biz_id uuid)
language plpgsql
security definer
set search_path = app, public, extensions
as $$
declare
  inv tech_invites%rowtype;
  d10 text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  tid uuid;
begin
  -- Row lock: a second Start (double tap, second tab, forwarded link) waits
  -- here and then sees status = 'joined'.
  select * into inv from tech_invites i where i.code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid; return;
  end if;

  if inv.status = 'joined' then
    -- The SAME device retrying after a lost response gets its account back
    -- instead of "already used".
    if inv.claim_nonce is not null and inv.claim_nonce = p_nonce then
      return query select 'replay'::text, inv.technician_id, inv.business_id;
    else
      return query select 'used'::text, null::uuid, null::uuid;
    end if;
    return;
  end if;
  if inv.status = 'revoked' then
    return query select 'revoked'::text, null::uuid, null::uuid; return;
  end if;
  if inv.expires_at <= now() then
    return query select 'expired'::text, null::uuid, null::uuid; return;
  end if;

  -- Defense in depth; the API has already checked all of this.
  if coalesce(p_pin, '') !~ '^\d{4}$'
     or length(d10) <> 10
     or length(btrim(coalesce(p_name, ''))) not between 2 and 60
     or jsonb_typeof(p_slots) is distinct from 'array'
     or jsonb_array_length(p_slots) not between 1 and 35 then
    return query select 'bad_input'::text, null::uuid, null::uuid; return;
  end if;

  -- An invite the owner texted to a number can only be claimed BY that number,
  -- so a forwarded link can't enrol someone else.
  if inv.invitee_phone is not null
     and right(regexp_replace(inv.invitee_phone, '\D', '', 'g'), 10) <> d10 then
    return query select 'phone_mismatch'::text, null::uuid, null::uuid; return;
  end if;

  -- A metro switched off after the invite went out kills the invite.
  if not exists (select 1 from service_areas sa
                  where sa.id = inv.service_area_id
                    and sa.business_id = inv.business_id
                    and sa.active) then
    return query select 'area_inactive'::text, null::uuid, null::uuid; return;
  end if;

  if exists (select 1 from technicians t
              where t.active and t.phone is not null
                and right(regexp_replace(t.phone, '\D', '', 'g'), 10) = d10) then
    return query select 'phone_in_use'::text, null::uuid, null::uuid; return;
  end if;

  -- A former tech of THIS company coming back: their old row holds the job
  -- history, reviews and payroll, so the office reactivates it (Show inactive
  -- -> Activate -> Set PIN) rather than a second row being created beside it.
  if exists (select 1 from technicians t
              where t.business_id = inv.business_id and not t.active and t.phone is not null
                and right(regexp_replace(t.phone, '\D', '', 'g'), 10) = d10) then
    return query select 'past_profile'::text, null::uuid, null::uuid; return;
  end if;

  begin
    insert into technicians
      (business_id, name, phone, pin_hash, status, active, service_area_id, max_jobs_per_day)
    values
      (inv.business_id, btrim(p_name), p_phone, crypt(p_pin, gen_salt('bf')),
       'available', true, inv.service_area_id, inv.max_jobs_per_day)
    returning id into tid;
  exception when unique_violation then
    -- uq_technicians_active_phone10 or (business_id, phone): another sign-up
    -- took this number between the check above and the insert.
    return query select 'phone_in_use'::text, null::uuid, null::uuid; return;
  end;

  -- Same rows availability_set writes. The table's CHECKs re-validate day 0-6
  -- and slot s1-s5; a bad value raises and rolls the whole sign-up back.
  insert into technician_availability (business_id, technician_id, day_of_week, slot_key)
  select distinct inv.business_id, tid, (s ->> 'day_of_week')::smallint, s ->> 'slot_key'
    from jsonb_array_elements(p_slots) s
  on conflict (technician_id, day_of_week, slot_key) do nothing;

  update tech_invites
     set status = 'joined', joined_at = now(), technician_id = tid,
         claim_nonce = p_nonce, sms_consent_at = now()
   where id = inv.id;

  return query select 'joined'::text, tid, inv.business_id;
end $$;

comment on function claim_tech_invite(text, text, text, text, text, jsonb) is
  'Atomic single-use claim of a technician invite (0111). service_role only.';

-- Born locked: without this, PUBLIC (hence anon via PostgREST) could mint
-- active technicians with nothing but the public anon key.
revoke all on function claim_tech_invite(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function claim_tech_invite(text, text, text, text, text, jsonb) to service_role;

-- ── 4. Close the existing PIN-function exposure (see header) ────────────────
revoke all on function verify_technician_pin(text, text) from public, anon, authenticated;
revoke all on function set_technician_pin(uuid, text)    from public, anon, authenticated;
grant execute on function verify_technician_pin(text, text) to service_role;
grant execute on function set_technician_pin(uuid, text)    to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select has_function_privilege('anon', 'app.claim_tech_invite(text,text,text,text,text,jsonb)', 'EXECUTE'); -- f
--   select has_function_privilege('anon', 'app.verify_technician_pin(text,text)', 'EXECUTE');                  -- f
--   select has_function_privilege('anon', 'app.set_technician_pin(uuid,text)', 'EXECUTE');                     -- f
--   select has_function_privilege('service_role', 'app.verify_technician_pin(text,text)', 'EXECUTE');          -- t
--   select status, count(*) from app.tech_invites group by 1;
-- ============================================================================
