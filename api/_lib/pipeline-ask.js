// Pipeline "Ask why" (owner 2026-09-27). Opus 5.5 reads everything we know
// about one card and says, in plain words, what's holding it back and what to
// do next. Completed cards get the review question instead. One answer is
// cached per card and redone only when the card changes.
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { loadPipelineRaw, loadHistory, buildPipeline } from './pipeline.js';

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    holding_back: { type: 'string' },
    what_went_wrong: { type: 'string' },
    next_step: { type: 'string' },
  },
  required: ['holding_back', 'what_went_wrong', 'next_step'],
};

const SYSTEM = `You help the owner of a small TV-mounting and handyman business (brands: Handy Andy, Dom's TV Mounting) understand his sales pipeline. Stages: New lead -> Talked to -> Quoted (estimate sent) -> Booked -> Completed. Secretaries (Heather, Joey, Alex, Joe) answer calls, send estimates and call customers back. Joey makes review calls.

You get one customer's full record. Answer in very short, simple sentences a busy owner can read in 10 seconds. Use names, times and facts from the record. Never invent facts; if something is unknown, say so.
- holding_back: ONE short sentence (under 20 words): why this customer has not moved to the next stage.
- what_went_wrong: ONE short sentence on a real mistake by us (who, what), or an empty string "" if none. If the customer paid, the price was agreed -- never bring up earlier quotes or price differences.
- next_step: ONE short sentence (under 15 words): the action, who, and when. Use as few words as possible everywhere.`;

const Q_STAGE = 'Why didn\'t this job proceed to the next pipeline card? What\'s holding it back?';
const Q_REVIEW = 'Why hasn\'t this customer left us a review? Did they open the review request? Has the secretary called? What can we do to get this person to leave us a review?';

let _client;
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };

export async function askWhy(db, auth, body, allowed) {
  const key = String(body.card_key || '');
  if (!/^c_[0-9a-f-]{36}$/i.test(key)) return { status: 400, json: { error: 'card_key is required' } };
  const isOwner = auth.role === 'owner';
  const nowMs = Date.now();
  const raw = await loadPipelineRaw(db, { nowMs, withAudits: isOwner });
  raw.history = await loadHistory(db, [...new Set((raw.calls || []).map((c) => String(c.caller_phone || '').replace(/\D/g, '').slice(-10)).filter(Boolean))].slice(0, 400));
  const board = buildPipeline(raw, nowMs, { isOwner, allowed, range: '30', business: 'all' });
  const card = (board.cards || []).find((c) => c.key === key);
  if (!card) return { status: 404, json: { error: 'That card is not on the board.' } };
  if (card.stage === 'booked') return { status: 400, json: { error: 'Ask why is not used on Booked.' } };

  const fp = createHash('sha1').update(JSON.stringify([card.stage, card.last_at, (card.timeline || []).length, card.review, card.estimate, card.next])).digest('hex');
  const { data: cached } = await db.from('pipeline_ask_why').select('fingerprint, answer, created_at').eq('card_key', key).maybeSingle();
  if (cached && cached.fingerprint === fp && !body.fresh) return { status: 200, json: { ...cached.answer, cached: true, at: cached.created_at } };

  // Extra context the board doesn't carry: call summaries/transcripts and full texts.
  const ph = String(card.phone || '').replace(/\D/g, '').slice(-10);
  let calls = [], texts = [];
  if (ph.length === 10) {
    const since = new Date(nowMs - 60 * 86400000).toISOString();
    const { data: cs } = await db.from('calls').select('occurred_at, kind, answered, duration_sec, handled_by, resolution, quoted_total, transcript_summary, transcript')
      .ilike('caller_phone', '%' + ph).gte('occurred_at', since).order('occurred_at').limit(20);
    calls = (cs || []).map((c) => ({ at: c.occurred_at, kind: c.kind, answered: c.answered, seconds: c.duration_sec, by: c.handled_by, outcome: c.resolution, quoted: c.quoted_total, summary: c.transcript_summary, transcript: clip(c.transcript, 5000) }));
    const { data: ms } = await db.from('messages').select('created_at, direction, sent_by, body')
      .ilike('customer_phone', '%' + ph).gte('created_at', since).order('created_at').limit(40);
    texts = (ms || []).map((m) => ({ at: m.created_at, from: m.direction === 'in' ? 'customer' : (m.sent_by || 'us'), text: clip(m.body, 400) }));
  }
  const record = {
    now: new Date(nowMs).toISOString(), stage: card.stage, name: card.name, phone: card.phone_pretty, brand: card.business && card.business.name,
    handled_by: card.secretary, came_in_via: card.source, opened_at: card.opened_at, amount: card.amount, next_step_shown: card.next,
    not_called_back: card.unanswered, estimate: card.estimate, booking: card.booking, review: card.review, history: card.history,
    timeline: card.timeline, calls, texts,
  };
  const question = card.stage === 'completed' ? Q_REVIEW : Q_STAGE;
  if (!process.env.ANTHROPIC_API_KEY) return { status: 503, json: { error: 'AI is not set up.' } };
  _client ||= new Anthropic();
  const msg = await _client.messages.create({
    model: 'claude-opus-5-5', max_tokens: 800,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${question}\n\nCustomer record (JSON):\n${JSON.stringify(record).slice(0, 60000)}` }],
  });
  const answer = JSON.parse((msg.content || []).find((b) => b.type === 'text')?.text || '{}');
  if (!answer.holding_back) return { status: 502, json: { error: 'Could not get an answer. Try again.' } };
  // Owner 2026-09-29: when the OWNER asks, the secretary who handled the card
  // (by name -- Joey and Joe are different people) gets a quiet note that
  // clears the moment they open the card (migrations 0159/0160).
  const forName = isOwner && card.secretary ? card.secretary : null;
  const forSlug = forName && card.business ? card.business.slug || null : null;
  await db.from('pipeline_ask_why').upsert({ card_key: key, fingerprint: fp, answer, asked_by: auth.name || auth.role || null, created_at: new Date().toISOString(),
    for_name: forName, for_slug: forSlug, seen_at: forName ? null : new Date().toISOString() });
  return { status: 200, json: { ...answer, cached: false, at: new Date().toISOString(), for_name: forName, seen_at: null } };
}
