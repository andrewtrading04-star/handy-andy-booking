-- Link app.calls to app.tracking_numbers so the Calls tab can group/filter
-- by number (and, transitively, by market) without re-deriving the mapping
-- on every read. Only backfills source='twilio' rows: Grasshopper-sourced
-- calls (the majority today) use a disjoint number pool that has no matching
-- row in tracking_numbers (see docs/twilio-tracking-numbers.md) and are left
-- NULL here on purpose -- the Calls tab shows those as "Unattributed" rather
-- than silently dropping them from the count.
alter table app.calls add column if not exists tracking_number_id uuid references app.tracking_numbers(id);

update app.calls c
set tracking_number_id = t.id
from app.tracking_numbers t
where c.grasshopper_number = t.phone
  and c.tracking_number_id is null;

comment on column app.calls.tracking_number_id is 'FK to tracking_numbers. Only populated for source=twilio rows whose grasshopper_number matched a known tracking number; legacy Grasshopper rows stay null (different number pool).';

-- RecordingSid was arriving on both the voicemail transcribeCallback and the
-- (new) <Dial> recordingStatusCallback but being discarded on arrival -- see
-- api/analytics.js handleVoiceRecording. Captured so a specific recording can
-- be looked up or deleted without parsing it back out of the URL.
alter table app.calls add column if not exists recording_sid text;

-- Number/market filtering and pagination at fleet scale (14 numbers today,
-- 30+ expected).
create index if not exists idx_calls_tracking_number_occurred on app.calls (tracking_number_id, occurred_at desc);
create index if not exists idx_calls_occurred_at on app.calls (occurred_at desc);
create index if not exists idx_tracking_numbers_market_active on app.tracking_numbers (market, active);
