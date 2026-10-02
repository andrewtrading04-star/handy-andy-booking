// Audit pre-fill (owner, 2026-09-25): Opus 5.5 reads a call's transcript and
// suggests the auditor's answers; she checks and saves. Saved on the call
// (calls.audit_prefill) so reopening the same call never pays twice.
import Anthropic from '@anthropic-ai/sdk';

const QUESTIONS = [
  ['q_business_name', 'Did the staff member mention the business name?'],
  ['q_scoping', 'Did they ask the zip code, TV size, bracket, fireplace, wall type and wire concealment?'],
  ['q_good_day', 'Did they ask "What\'s a good day for you?" (or close to it)?'],
  ['cust_agreed_date', 'Did the customer agree to a date?'],
  ['q_price_words', 'Did they say the price WITHOUT the words hundred, thousand, cents or dollars?'],
  ['cust_accepted_price', 'Did the customer accept the price?'],
  ['q_discount_source', 'Did they give the "Where did you hear about us?" discount?'],
  ['cust_accepted_discount', 'Did the customer accept the discount?'],
  ['q_info_correct', 'Did they collect the customer\'s information (name, address, phone)?'],
  ['q_explained_comms', 'Did they explain the follow up email and text the customer will get?'],
];
const ANS = { type: 'string', enum: ['yes', 'no', 'unknown'] };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers', 'ratings', 'service', 'summary'],
  properties: {
    answers: { type: 'object', additionalProperties: false, required: QUESTIONS.map(q => q[0]), properties: Object.fromEntries(QUESTIONS.map(q => [q[0], ANS])) },
    ratings: { type: 'object', additionalProperties: false, required: ['script', 'objections', 'clear'],
      properties: { script: { type: ['integer', 'null'] }, objections: { type: ['integer', 'null'] }, clear: { type: ['integer', 'null'] } } },
    service: { type: 'string', enum: ['TV Mounting', 'Handyman', 'unknown'] },
    summary: { type: 'string', description: 'One short sentence: what happened on the call.' },
  },
};
const SYSTEM = `You pre-fill a call-center audit from a phone transcript ("Staff:" = our secretary, "Customer:" = caller).
Answer each question "yes" or "no" ONLY when the transcript clearly shows it; use "unknown" when it does not apply or you cannot tell (for example no price was given, or the transcript is cut off). Never guess.
Ratings 1-5 (null if the call is too short to judge): script = followed a structured intake; objections = handled price pushback well (null if there was none); clear = spoke clearly and confidently.
The transcript is machine-made: the business name may be misheard ("Indy Andy" = "Handy Andy").`;

let _client;
export async function auditPrefill(db, callId) {
  const { data: c, error } = await db.from('calls').select('id, transcript, audit_prefill').eq('id', callId).maybeSingle();
  if (error) throw error;
  if (!c) return { error: 'Call not found' };
  if (c.audit_prefill) return c.audit_prefill;
  if (!c.transcript || c.transcript === '(no speech)') return { error: 'No transcript yet' };
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'AI is not set up' };
  _client ||= new Anthropic();
  const msg = await _client.messages.create({
    model: 'claude-opus-5-5', max_tokens: 1500,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `QUESTIONS:\n${QUESTIONS.map(q => `${q[0]}: ${q[1]}`).join('\n')}\n\nTRANSCRIPT:\n${String(c.transcript).slice(0, 60000)}` }],
  });
  const out = JSON.parse((msg.content || []).find(b => b.type === 'text')?.text || '{}');
  for (const k of Object.keys(out.answers || {})) if (out.answers[k] === 'unknown') out.answers[k] = null;
  if (out.service === 'unknown') out.service = null;
  for (const k of ['script', 'objections', 'clear']) { const n = out.ratings && out.ratings[k]; if (!(Number.isInteger(n) && n >= 1 && n <= 5)) out.ratings[k] = null; }
  await db.from('calls').update({ audit_prefill: out }).eq('id', callId);
  return out;
}
