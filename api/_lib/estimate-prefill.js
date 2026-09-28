// Estimate pre-fill (owner, 2026-09-28): "Build an estimate" on a Pipeline card
// reads the customer's last real call and ticks the same TV options the office
// would have picked. Only option ids from this business's own price list can
// come back, so every price still comes from the catalog, never from the AI.
// Saved on the call (calls.estimate_prefill, keyed by business) so reopening
// costs nothing.
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You read a phone call between our office ("Staff:") and a customer ("Customer:") for a TV mounting company, and pick what the customer wants from our price list.
Rules:
- Only pick options the transcript clearly supports. Leave a question out when the call did not cover it. Never guess.
- TV size: one pick per TV, with count = how many TVs of that size.
- The other TV questions (bracket, fireplace, wall surface, wire hiding, lifting) are per TV too: count = how many TVs it applies to.
- "I already have the mount/bracket" = the "have my own bracket" option.
- Add-ons (soundbar, shelf, Apple TV, etc.): count = how many.
- zip: the customer's 5-digit ZIP if said (fix spoken digits, e.g. "8 0 2 3 3" = 80233), else null.
- If the call is not about mounting a TV, return no selections.
The transcript is machine-made; fix obvious mishearings.`;

let _client;

async function tvCatalog(db, businessId) {
  const { data: svc } = await db.from('services').select('id').eq('business_id', businessId).eq('category', 'TV Mounting').limit(1);
  const serviceId = svc && svc[0] && svc[0].id;
  if (!serviceId) return null;
  const { data: groups } = await db.from('service_option_groups').select('id, key, label').eq('business_id', businessId).eq('service_id', serviceId).order('sort_order');
  const ids = (groups || []).map(g => g.id);
  if (!ids.length) return null;
  const { data: opts } = await db.from('service_options').select('id, group_id, label').in('group_id', ids).eq('active', true).order('sort_order');
  return (groups || []).map(g => ({ ...g, options: (opts || []).filter(o => o.group_id === g.id) }));
}

/** @returns {{ call_id, selections: {option_id, count}[], zip: string|null } | { error }} */
export async function estimatePrefill(db, businessId, phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return { error: 'No phone number' };
  const { data: calls, error } = await db.from('calls').select('id, transcript, estimate_prefill')
    .eq('caller_phone', digits).not('transcript', 'is', null).order('occurred_at', { ascending: false }).limit(5);
  if (error) throw error;
  const c = (calls || []).find(x => /^(Staff|Customer):/m.test(x.transcript || '') && x.transcript.length > 120);
  if (!c) return { error: 'No call transcript for this customer' };
  const cached = c.estimate_prefill && c.estimate_prefill[businessId];
  if (cached) return cached;
  const groups = await tvCatalog(db, businessId);
  if (!groups) return { error: 'No TV price list for this business' };
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'AI is not set up' };

  const allIds = groups.flatMap(g => g.options.map(o => o.id));
  const schema = {
    type: 'object', additionalProperties: false, required: ['selections', 'zip'],
    properties: {
      selections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['option_id', 'count'],
        properties: { option_id: { type: 'string', enum: allIds }, count: { type: 'integer' } } } },
      zip: { type: ['string', 'null'] },
    },
  };
  const list = groups.map(g => `${g.label} (${g.key}):\n${g.options.map(o => `  ${o.id} = ${o.label}`).join('\n')}`).join('\n');
  _client ||= new Anthropic();
  const msg = await _client.messages.create({
    model: 'claude-opus-5-5', max_tokens: 1500,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `PRICE LIST (option id = label):\n${list}\n\nTRANSCRIPT:\n${String(c.transcript).slice(0, 40000)}` }],
  });
  const out = JSON.parse((msg.content || []).find(b => b.type === 'text')?.text || '{}');
  const valid = new Set(allIds);
  const result = {
    call_id: c.id,
    selections: (out.selections || []).filter(s => valid.has(s.option_id)).map(s => ({ option_id: s.option_id, count: Math.min(10, Math.max(1, Number(s.count) || 1)) })),
    zip: /^\d{5}$/.test(String(out.zip || '')) ? String(out.zip) : null,
  };
  await db.from('calls').update({ estimate_prefill: { ...(c.estimate_prefill || {}), [businessId]: result } }).eq('id', c.id);
  return result;
}
