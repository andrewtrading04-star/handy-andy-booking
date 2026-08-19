-- Twilio call tracking: real local numbers we own, with webhooks.
--
-- Grasshopper (see 0080) has no API, so its voicemail EMAIL is the only signal
-- it produces: no missed-call rows, no durations, no "was it answered", and
-- nothing at all for a call somebody picked up. Twilio numbers close that gap.
-- A call to one of these lines forwards to a real phone AND posts a webhook,
-- so app.calls gets a row the moment it rings — answered or not.
--
-- Because each number is its own line, putting a distinct one on an ad or a
-- location page turns app.calls into campaign attribution for free.

-- The lines we own on Twilio. Data, not code (same reasoning as
-- GRASSHOPPER_LINES): a new tracking number is a row, not a deploy.
create table if not exists app.tracking_numbers (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique,        -- 10 digits, no punctuation
  label         text not null,               -- what it is on: 'Austin Google Ads'
  business_slug text,                        -- 'handy-andy' | 'doms'
  market        text,                        -- 'Austin' | 'Denver' | 'Houston'
  forward_to    text,                        -- E.164 destination, null = voicemail only
  ring_seconds  smallint not null default 20,
  record_calls  boolean  not null default false,
  active        boolean  not null default true,
  created_at    timestamptz not null default now()
);

-- Where a call came from. Existing rows are all Grasshopper emails or the
-- office's own "Take a Call" wizard; both keep working untouched.
alter table app.calls add column if not exists source          text not null default 'grasshopper';
alter table app.calls add column if not exists tracking_label  text;
-- Twilio's CallSid. UNIQUE for the same reason email_message_id is: Twilio
-- retries webhooks, and a retry must update the row, never create a second one.
alter table app.calls add column if not exists twilio_call_sid text unique;
alter table app.calls add column if not exists answered        boolean;
alter table app.calls add column if not exists duration_sec    integer;
alter table app.calls add column if not exists recording_url   text;
alter table app.calls add column if not exists forwarded_to    text;

-- The Calls tab reads by sid on every status/recording callback.
create index if not exists calls_sid_idx on app.calls (twilio_call_sid);
