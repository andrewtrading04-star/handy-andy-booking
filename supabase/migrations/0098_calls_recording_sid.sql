-- RecordingSid arrives on Twilio's recording callbacks but was being
-- discarded on arrival (see api/analytics.js handleVoiceRecording). Captured
-- so a specific recording can be looked up or deleted without parsing it back
-- out of the recording_url.
alter table app.calls add column if not exists recording_sid text;

comment on column app.calls.recording_sid is 'Twilio RecordingSid, captured from the voice_recording callback (used by both the voicemail <Record> and, when record_calls is on, the <Dial> recordingStatusCallback).';
