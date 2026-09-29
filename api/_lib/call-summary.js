// Call summary (owner, 2026-09-25: "3 with bubbles inside"): a few short
// bullets shown above a transcript so the office sees the gist at a glance.
// Made once per call and saved on calls.transcript_summary.
import Anthropic from '@anthropic-ai/sdk';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'text'],
      properties: {
        kind: { type: 'string', enum: ['job', 'place', 'price', 'booked', 'not_booked', 'other'] },
        text: { type: 'string' },
      } } },
  },
};
const SYSTEM = `Summarize a phone call between our office ("Staff:") and a customer ("Customer:") for a TV mounting / handyman company.
Return 2-5 bullets, each under 12 words, only facts in the transcript:
- job: what they want (TV size, soundbar, dismount, etc.). If the customer sent or will send a photo, say only that ("Customer sent a photo") -- skip receipts, wall details and other small stuff.
- place: city / zip
- price: the TOTAL price we quoted, and any change (e.g. "Quoted $339 total", "Quoted $204, dropped to $174"). Never list single fees or add-ons -- only the total.
- booked or not_booked: the outcome (e.g. "Not booked, will call back")
- other: anything else important
Skip kinds that are not in the call. The transcript is machine-made; fix obvious mishearings ("1 2nd" in a price is a pause).`;

let _client;
export async function callSummary(db, callId) {
  const { data: c, error } = await db.from('calls').select('id, transcript, transcript_summary, duration_sec').eq('id', callId).maybeSingle();
  if (error) throw error;
  if (!c) return null;
  if (c.transcript_summary) return c.transcript_summary;
  // Owner 2026-09-28: never summarize a call under 10 seconds.
  if (c.duration_sec != null && Number(c.duration_sec) < 10) return null;
  if (!c.transcript || !/^(Staff|Customer):/m.test(c.transcript) || c.transcript.length < 120) return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client ||= new Anthropic();
  const msg = await _client.messages.create({
    model: 'claude-opus-5-5', max_tokens: 600,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: String(c.transcript).slice(0, 40000) }],
  });
  const out = JSON.parse((msg.content || []).find(b => b.type === 'text')?.text || '{}');
  if (!Array.isArray(out.items) || !out.items.length) return null;
  await db.from('calls').update({ transcript_summary: out }).eq('id', callId);
  return out;
}
