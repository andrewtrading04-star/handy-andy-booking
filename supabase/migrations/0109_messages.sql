-- ============================================================================
-- Migration 0109: two-way SMS — keep every text, both directions
-- ----------------------------------------------------------------------------
-- Until now an inbound text was RELAYED and then thrown away: handleSmsInbound
-- (api/analytics.js) forwarded the body to whoever the line forwards to and
-- dropped a kind='sms' row in `calls` whose only trace of the message was the
-- transcript column. There was no record of what we said back, because there
-- was no way to say anything back. So the office could not hold a conversation
-- with a customer who texted a business number.
--
-- This table is that record. One row per message, in or out, keyed to the pair
-- of phone numbers that defines the conversation.
--
-- THREAD KEY IS (our_phone, customer_phone), NOT (business, customer).
-- The same person can text two of our brands — they are published as separate
-- businesses with separate numbers — and those must read as two separate
-- conversations, or a reply lands in the wrong brand's voice. It is also what
-- makes a reply go back out FROM the number the customer actually texted,
-- which is the whole point of registering the local numbers for A2P.
--
-- Deliberately NOT touching `calls`: the kind='sms' rows keep being written
-- exactly as they are, so the Incoming Calls screen, its counts, and anything
-- reading that table are unaffected. This is additive.
--
-- Idempotent. Run after 0108.
-- ============================================================================
set search_path = app, public, extensions;

create table if not exists messages (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid references businesses(id) on delete cascade,

  -- 10-digit, no country code — matches digitsOf() in scripts/lib/gmb-locations.mjs
  -- and every other phone comparison in this codebase. Storing E.164 here would
  -- silently fail to match customers.phone.
  customer_phone text not null,
  our_phone      text not null,

  direction      text not null check (direction in ('in', 'out')),
  body           text,

  -- Twilio's message SID. UNIQUE so a webhook retry (Twilio retries on any
  -- non-2xx, and it has retried this endpoint before) can never double-insert
  -- the same text. Nullable only for a send we failed to hand to Twilio at all.
  twilio_sid     text unique,

  -- Outbound delivery lifecycle, fed by the existing sms_status webhook:
  -- queued -> sent -> delivered, or failed/undelivered. Null for inbound.
  status         text,
  error          text,

  customer_id    uuid references customers(id) on delete set null,

  -- Who on staff sent an outbound reply ('owner' | 'handy-andy' | 'doms'),
  -- so the thread shows who answered. Null for automated sends and inbound.
  sent_by        text,

  -- Null = unread. Only ever set on inbound rows; an outbound row is not
  -- something anyone needs to "read".
  read_at        timestamptz,

  created_at     timestamptz not null default now()
);

comment on table messages is
  'Every SMS in or out, one row each. Thread = (our_phone, customer_phone). Additive to calls: the kind=''sms'' rows there are still written unchanged.';
comment on column messages.our_phone is
  'Which of OUR numbers the customer texted. A reply MUST go back out from this number, not from a default sender.';

-- Reading one conversation, oldest-to-newest.
create index if not exists idx_messages_thread
  on messages(our_phone, customer_phone, created_at);

-- The conversation list: newest activity first, scoped to what a secretary
-- is allowed to see.
create index if not exists idx_messages_business_recent
  on messages(business_id, created_at desc);

-- The unread badge. Partial, so it stays tiny however big the table gets.
create index if not exists idx_messages_unread
  on messages(business_id, created_at desc)
  where direction = 'in' and read_at is null;

-- Matching a delivery receipt back to its row.
create index if not exists idx_messages_sid on messages(twilio_sid);

-- RLS: server-side only (service role), same as google_reviews and the other
-- ingest tables. Nothing in here is ever read by an anon client.
alter table messages enable row level security;
alter table messages force row level security;
grant all on messages to service_role;

-- ============================================================================
-- DONE. Verify with:
--   select direction, count(*) from app.messages group by 1;
--   select our_phone, customer_phone, count(*), max(created_at)
--     from app.messages group by 1,2 order by 4 desc;
-- ============================================================================
