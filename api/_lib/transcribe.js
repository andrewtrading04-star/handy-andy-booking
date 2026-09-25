// Call transcripts via Twilio Voice Intelligence (owner, 2026-09-25: "add
// transcribing to Jiyah's voice recordings ... I already have Twilio").
//
// Every answered call is recorded dual-channel (record-from-answer-dual):
// channel 1 = the caller, channel 2 = whoever picked up. When a recording
// lands, startTranscript() asks Twilio to transcribe it; Twilio calls
// api/analytics?action=vi_webhook when it's done and finishTranscript() writes
// "Customer: ... / Staff: ..." into calls.transcript. The webhook payload is
// never trusted: it only names a transcript sid, which is re-read from
// Twilio with our own credentials and matched back to the call by the
// CustomerKey we set (the call id).
const VI = 'https://intelligence.twilio.com/v2';
const SERVICE_NAME = 'crm-call-transcripts';
let _serviceSid = process.env.TWILIO_VI_SERVICE_SID || null;

function authHeader() {
  const a = process.env.TWILIO_ACCOUNT_SID, t = process.env.TWILIO_AUTH_TOKEN;
  if (!a || !t) throw new Error('Twilio credentials missing');
  return 'Basic ' + Buffer.from(`${a}:${t}`).toString('base64');
}
async function vi(path, { method = 'GET', form } = {}) {
  const r = await fetch(VI + path, {
    method,
    headers: { Authorization: authHeader(), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio VI ${r.status}: ${(j && (j.message || j.detail)) || 'error'}`);
  return j;
}
function baseUrl() {
  return process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
}

export async function ensureService() {
  if (_serviceSid) return _serviceSid;
  const list = await vi('/Services?PageSize=50');
  const hit = (list.services || []).find(s => s.unique_name === SERVICE_NAME);
  if (hit) return (_serviceSid = hit.sid);
  const made = await vi('/Services', { method: 'POST', form: {
    UniqueName: SERVICE_NAME, FriendlyName: 'CRM call transcripts', LanguageCode: 'en-US',
    AutoTranscribe: 'false', DataLogging: 'false', AutoRedaction: 'false',
    WebhookUrl: `${baseUrl()}/api/analytics?action=vi_webhook`, WebhookHttpMethod: 'POST',
  } });
  return (_serviceSid = made.sid);
}

export async function startTranscript(db, callId, recordingSid) {
  if (!callId || !/^RE[0-9a-f]{32}$/i.test(String(recordingSid || ''))) return null;
  const service = await ensureService();
  const t = await vi('/Transcripts', { method: 'POST', form: {
    ServiceSid: service,
    Channel: JSON.stringify({ media_properties: { source_sid: recordingSid } }),
    CustomerKey: callId,
  } });
  await db.from('calls').update({ transcript_sid: t.sid, transcript_status: t.status || 'queued' }).eq('id', callId);
  return t.sid;
}

export async function finishTranscript(db, transcriptSid) {
  if (!/^GT[0-9a-f]{32}$/i.test(String(transcriptSid || ''))) return false;
  const t = await vi(`/Transcripts/${transcriptSid}`);
  const callId = t.customer_key;
  if (!callId) return false;
  if (t.status !== 'completed') {
    await db.from('calls').update({ transcript_status: t.status }).eq('id', callId).eq('transcript_sid', transcriptSid);
    return false;
  }
  const sentences = [];
  let url = `/Transcripts/${transcriptSid}/Sentences?PageSize=1000`;
  for (let i = 0; url && i < 10; i++) {
    const page = await vi(url);
    sentences.push(...(page.sentences || []));
    const next = page.meta && page.meta.next_page_url;
    url = next ? next.replace(VI, '') : null;
  }
  sentences.sort((a, b) => (a.sentence_index ?? 0) - (b.sentence_index ?? 0));
  // Merge back-to-back sentences from the same side into one turn.
  const turns = [];
  for (const s of sentences) {
    const who = Number(s.media_channel) === 2 ? 'Staff' : 'Customer';
    const text = String(s.transcript || '').trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.who === who) last.text += ' ' + text; else turns.push({ who, text, at: Number(s.start_time) || 0 });
  }
  // Each turn starts with its time in the call, e.g. "Staff: [1:05] ..." (owner, 2026-09-25).
  const stamp = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const body = turns.map(x => `${x.who}: [${stamp(x.at)}] ${x.text}`).join('\n') || '(no speech)';
  await db.from('calls').update({ transcript: body, transcript_status: 'done' }).eq('id', callId).eq('transcript_sid', transcriptSid);
  try { await (await import('./call-summary.js')).callSummary(db, callId); } catch (e) { console.error('[call-summary]', e.message); }
  return true;
}
