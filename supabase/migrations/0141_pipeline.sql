-- "Pipeline" tab: one card per customer inquiry, New lead -> Paid (owner
-- approved 2026-09-24: "build it"). Cards are computed on read in
-- api/_lib/pipeline.js from the rows the CRM already writes; only the manual
-- decisions about a card and each outbound callback try are stored here.
-- Applied to prod on 2026-09-23 through the Supabase MCP (name 0141_pipeline);
-- the statements below are exactly what ran.
create table if not exists app.pipeline_marks (
  card_key text primary key,
  business_id uuid,
  phone text,
  lost_reason text,
  lost_note text,
  lost_at timestamptz,
  lost_by text,
  not_a_lead boolean not null default false,
  not_a_lead_by text,
  not_a_lead_at timestamptz,
  reopened_at timestamptz,
  reopened_by text,
  no_talk_call_ids uuid[] not null default '{}',
  talk_call_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table app.pipeline_marks enable row level security;

create table if not exists app.call_attempts (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  business_id uuid,
  our_phone text,
  staff_name text,
  source text not null,
  twilio_sid text,
  started_at timestamptz not null default now(),
  staff_status text,
  dial_status text,
  duration_sec int,
  talked boolean,
  talked_set_by text,
  ended_at timestamptz,
  card_key text
);
create index if not exists call_attempts_phone_idx on app.call_attempts (phone, started_at desc);
alter table app.call_attempts enable row level security;

alter table app.estimates add column if not exists call_id uuid;
alter table app.calls add column if not exists inbound_call_id uuid;
create index if not exists calls_caller_phone_idx on app.calls (caller_phone);
