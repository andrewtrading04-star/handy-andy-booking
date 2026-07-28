-- Inbound call / voicemail tracking from the Grasshopper phone system.
--
-- Grasshopper has no API, no webhooks and no Zapier integration (verified Jul
-- 2026), so its notification EMAIL is the only machine-readable signal it
-- produces. A Google Apps Script on the owner's own Gmail forwards each one to
-- api/admin.js?action=call_ingest, which parses it with api/_lib/grasshopper.js
-- and writes a row here.
--
-- Today every message Grasshopper sends is a voicemail (confirmed against the
-- owner's whole inbox). `kind` exists so missed-call notifications can be
-- added later without a schema change if that ever becomes available.
create table if not exists app.calls (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid references app.businesses(id) on delete set null,
  service_area_id    uuid references app.service_areas(id) on delete set null,

  kind               text not null default 'voicemail',   -- 'voicemail' | 'missed'
  caller_phone       text not null,                       -- 10 digits, no punctuation
  grasshopper_number text,                                -- 10 digits: the line dialed
  extension          text,                                -- raw, e.g. '1 - TV Mounting'
  extension_no       smallint,                            -- 1, 2, 6 ... (routes to a person)
  service            text,                                -- 'TV Mounting' | 'Handyman'
  market             text,                                -- 'Denver' | 'Houston' | 'Austin'
  occurred_at        timestamptz not null,
  transcript         text,
  has_recording      boolean not null default false,

  -- Resolved at ingest: the customer whose phone matches, and the booking that
  -- was created AFTER this call for that customer (i.e. the call became a job).
  customer_id        uuid references app.customers(id) on delete set null,
  booking_id         uuid references app.bookings(id) on delete set null,

  -- Follow-up queue, mirroring the review-call queue the office already uses.
  status             text not null default 'new',         -- 'new' | 'called_back' | 'resolved' | 'ignored'
  handled_by         text,
  handled_at         timestamptz,
  notes              text,

  warnings           text[],                              -- parser notes for the office to see
  -- Gmail's immutable message id. UNIQUE is what makes re-running the forwarder
  -- (or a backfill overlapping live traffic) safe: the same email can be posted
  -- any number of times and only ever produces one row.
  email_message_id   text unique,
  notified_at        timestamptz,                         -- when staff were alerted

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists calls_occurred_idx  on app.calls (occurred_at desc);
create index if not exists calls_caller_idx    on app.calls (caller_phone);
create index if not exists calls_customer_idx  on app.calls (customer_id);
-- Partial index: the follow-up queue only ever reads the unresolved rows, and
-- that list stays small even as the full history grows.
create index if not exists calls_open_idx      on app.calls (occurred_at desc)
  where status in ('new', 'called_back');

-- Which phone extensions ring which staff member, so a voicemail alerts the
-- person whose extension it actually came in on rather than everyone.
-- Owner-provided (Jul 2026): Heather is extensions 1 and 2, Joey is 6.
-- Stored as data, not code, so it can be corrected without a deploy.
alter table app.staff_users
  add column if not exists grasshopper_extensions smallint[];

update app.staff_users set grasshopper_extensions = '{1,2}' where name = 'Heather' and grasshopper_extensions is null;
update app.staff_users set grasshopper_extensions = '{6}'   where name = 'Joey'    and grasshopper_extensions is null;
