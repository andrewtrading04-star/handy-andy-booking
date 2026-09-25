// "Ask Andrew" (owner, 2026-09-24): an AI version of the owner that staff can
// ask anything, so a new hire does a great job from day 1. Owner-only while
// it is being taught; later each staff role gets its own guidelines.
//
// Rules the owner set: extremely short, direct, accurate answers. If it does
// not actually know, it says "I don't know" -- never makes anything up -- and
// the question lands as an alert in the owner's Analytics tab, where he
// answers it once and the answer becomes knowledge. It may DRAFT an estimate
// (the office reviews and sends it); it never texts or books anything itself.
//
// Knowledge = app.ask_knowledge (seeded from the CRM's own phone script and
// rules, then taught by the owner) + a live read of prices, service areas,
// coupons and the zip in the question. Opus 5.5 only, no fallback model.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const clean = (v, n = 4000) => String(v == null ? '' : v).trim().slice(0, n);

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['known', 'ask_back', 'answer', 'draft_estimate'],
  properties: {
    ask_back: { type: 'boolean', description: 'true when the request is doable from the data but details are missing; answer = the short list of what to ask the customer. Not an "I do not know".' },
    known: { type: 'boolean', description: 'true ONLY if the answer is fully backed by KNOWLEDGE or LIVE CRM DATA below' },
    answer: { type: 'string', description: 'As few words as possible. If known=false: exactly "I don\'t know. Ask Andrew." plus at most one short sentence on what is missing.' },
    draft_estimate: {
      type: ['object', 'null'], additionalProperties: false,
      required: ['service_label', 'line_items', 'note'],
      description: 'Only when the user asks for an estimate/quote AND every price comes from LIVE CRM DATA. Otherwise null.',
      properties: {
        service_label: { type: 'string' },
        line_items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['description', 'qty', 'unit_price'],
          properties: { description: { type: 'string' }, qty: { type: 'number' }, unit_price: { type: 'number' } } } },
        note: { type: ['string', 'null'] },
      },
    },
  },
};

const SYSTEM = `You are "Ask Andrew": the owner of Handy Andy TV Mounting and Dom's TV Mounting, answering his office staff.
Style: extremely short. As few words as possible. Direct. No greetings, no filler, no explaining unless asked.
Accuracy is everything:
- Answer ONLY from KNOWLEDGE and LIVE CRM DATA in the message. Never use outside knowledge about how other companies work.
- If the answer is not clearly there, set known=false and answer "I don't know. Ask Andrew." Do NOT guess, estimate, or fill gaps. A wrong answer is far worse than "I don't know".
- Prices: only numbers that appear in the data. Say "before tax".
- If the request is doable but details are missing (wall type, wires, bracket...), set ask_back=true and answer with just the missing questions. That is not "I don't know".
- Business: use CURRENT BUSINESS unless the user names another.
- draft_estimate only when asked for a quote/estimate and every line price is in LIVE CRM DATA; otherwise null. Line items: one line per chosen option ("Group: Option"), Travel line if the zip has a travel fee, "Service minimum" top-up if needed. Prices before tax.`;

let _client;
function staffOnly(auth) { return auth && auth.role === 'owner'; }   // owner-only while being taught

async function liveData(db, question) {
  const out = {};
  const { data: biz } = await db.from('businesses').select('id, slug, name').in('slug', ['handy-andy', 'doms']);
  const byId = Object.fromEntries((biz || []).map(b => [b.id, b]));
  const ids = Object.keys(byId);
  if (!ids.length) return out;
  const [{ data: svcs }, { data: opts }, { data: areas }, { data: coupons }] = await Promise.all([
    db.from('services').select('id, business_id, name, base_price, duration_minutes, category').in('business_id', ids).eq('active', true).order('sort_order').limit(200),
    db.from('service_options').select('business_id, label, price, group:service_option_groups ( label, sort_order )').in('business_id', ids).eq('active', true).order('sort_order').limit(600),
    db.from('service_areas').select('id, business_id, name, state, unstaffed').in('business_id', ids).eq('active', true).limit(100),
    db.from('coupons').select('business_id, code, amount, expires_on').in('business_id', ids).eq('active', true).limit(100),
  ]);
  for (const b of biz || []) {
    out[b.name] = {
      services: (svcs || []).filter(s => s.business_id === b.id).map(s => ({ name: s.name, base_price: Number(s.base_price), minutes: s.duration_minutes, category: s.category })),
      tv_mounting_options_by_group: (opts || []).filter(o => o.business_id === b.id).reduce((m, o) => { const g = (o.group && o.group.label) || 'Other'; (m[g] ||= []).push(`${o.label} = $${Number(o.price)}`); return m; }, {}),
      service_areas: (areas || []).filter(a => a.business_id === b.id).map(a => `${a.name}${a.state ? ', ' + a.state : ''}${a.unstaffed ? ' (unstaffed)' : ''}`),
      active_coupons: (coupons || []).filter(c => c.business_id === b.id).map(c => ({ code: c.code, amount: Number(c.amount), expires: c.expires_on })),
    };
  }
  const zips = [...new Set(String(question).match(/\b\d{5}\b/g) || [])].slice(0, 3);
  if (zips.length) {
    const { data: z } = await db.from('service_area_zips').select('business_id, postal_code, surcharge, service_area_id').in('postal_code', zips).in('business_id', ids);
    const areaName = Object.fromEntries((areas || []).map(a => [a.id, a.name]));
    out.zip_lookup = zips.map(zip => {
      const rows = (z || []).filter(r => r.postal_code === zip);
      return rows.length ? rows.map(r => ({ zip, business: byId[r.business_id]?.name, area: areaName[r.service_area_id] || null, travel_fee_charged_to_customer: Number(r.surcharge) || 0 }))
        : [{ zip, served: false, note: 'zip not in any service area' }];
    }).flat();
  }
  return out;
}

async function ask(req, res, db, auth, body) {
  const question = clean(body.question, 2000);
  if (!question) return res.status(400).json({ error: 'Ask something first' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI is not set up.' });
  const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
    .map(h => ({ q: clean(h && h.q, 800), a: clean(h && h.a, 800) })).filter(h => h.q);
  const [{ data: know }, live] = await Promise.all([
    db.from('ask_knowledge').select('topic, body').eq('active', true).order('created_at').limit(500),
    liveData(db, question + ' ' + history.map(h => h.q).join(' ')),
  ]);
  const knowledge = (know || []).map(k => `- ${k.topic ? k.topic + ': ' : ''}${k.body}`).join('\n');
  const curBiz = { 'handy-andy': 'Handy Andy', doms: "Dom's TV Mounting" }[body.business] || null;
  const prompt = `CURRENT BUSINESS: ${curBiz || 'not set'}

KNOWLEDGE (the owner's rules):\n${knowledge || '(none yet)'}\n\nLIVE CRM DATA:\n${JSON.stringify(live)}\n\n` +
    (history.length ? `EARLIER IN THIS CHAT:\n${history.map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n')}\n\n` : '') +
    `QUESTION: ${question}`;
  _client ||= new Anthropic();
  let msg;
  try {
    msg = await _client.messages.create({
      model: MODEL, max_tokens: 2000,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    console.error('[ask] Claude call failed:', e.status, e.message);
    return res.status(502).json({ error: 'The AI could not be reached. Try again.' });
  }
  let out;
  try { out = JSON.parse((msg.content || []).find(b => b.type === 'text')?.text || ''); }
  catch { return res.status(502).json({ error: 'The AI answer could not be read. Try again.' }); }
  const askBack = !!out.ask_back;
  const known = askBack || !!out.known;
  const answer = clean(out.answer, 2000) || "I don't know. Ask Andrew.";
  const draft = known && out.draft_estimate && Array.isArray(out.draft_estimate.line_items) && out.draft_estimate.line_items.length ? out.draft_estimate : null;
  const { data: row } = await db.from('ask_questions').insert({
    asked_by: auth.name || (auth.role === 'owner' ? 'Andrew' : null), role: auth.role, business_slug: body.business || null,
    question, answer, known, draft,
  }).select('id').single();
  return res.status(200).json({ id: row && row.id, answer, known, ask_back: askBack, draft });
}

async function log(req, res, db) {
  const { data, error } = await db.from('ask_questions').select('*').order('created_at', { ascending: false }).limit(300);
  if (error) return res.status(500).json({ error: error.message });
  const rows = data || [];
  return res.status(200).json({
    questions: rows,
    unknown_open: rows.filter(r => !r.known && !r.taught_at).length,
    unseen: rows.filter(r => !r.seen_at).length,
  });
}

export async function askHandler(req, res, db, auth, body) {
  if (!staffOnly(auth)) return res.status(403).json({ error: 'Owner only for now' });
  if (req.method === 'GET') return log(req, res, db);
  const op = String(body.op || 'ask');
  if (op === 'ask') return ask(req, res, db, auth, body);
  if (op === 'seen') {
    await db.from('ask_questions').update({ seen_at: new Date().toISOString() }).is('seen_at', null);
    return res.status(200).json({ ok: true });
  }
  if (op === 'teach') {
    const id = clean(body.id, 64), text = clean(body.answer, 3000);
    if (!text) return res.status(400).json({ error: 'Write the answer first' });
    let topic = clean(body.topic, 200) || null;
    if (id) {
      const { data: q } = await db.from('ask_questions').select('question').eq('id', id).maybeSingle();
      if (q) topic = topic || clean(q.question, 200);
      await db.from('ask_questions').update({ taught_answer: text, taught_at: new Date().toISOString(), seen_at: new Date().toISOString() }).eq('id', id);
    }
    const { error } = await db.from('ask_knowledge').insert({ topic, body: text, source: 'owner' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
  if (op === 'knowledge') {
    const { data } = await db.from('ask_knowledge').select('*').eq('active', true).order('created_at', { ascending: false }).limit(500);
    return res.status(200).json({ knowledge: data || [] });
  }
  if (op === 'forget') {
    await db.from('ask_knowledge').update({ active: false, updated_at: new Date().toISOString() }).eq('id', clean(body.id, 64));
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: 'Unknown op' });
}
