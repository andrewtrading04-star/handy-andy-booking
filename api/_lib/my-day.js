// api/_lib/my-day.js
// "My Day" -- the owner's personal notepad planner (owner rule 2026-09-23).
// Owner-only, one action (admin.js `my_day`): GET reads a page, POST { op }
// changes it. Tables: migration 0137.
//
// Notepad model: every task is written on a page (origin_day). If it isn't
// crossed off it simply keeps appearing on every later page -- "turn to the
// next sheet" without copying anything -- with a "carried N days" count.
// A crossed-off task stays on the page it was crossed off (done_day), struck
// through, like ink on paper.
//
// A "day" is Bangkok time and turns over at 5 AM, not midnight: the owner
// works late, so 2 AM is still "today" (owner picked Bangkok; 5 AM was the
// suggested turnover since his bedtime goal is 1 AM).
import Anthropic from '@anthropic-ai/sdk';

const TZ = 'Asia/Bangkok';
const DAY_STARTS_HOUR = 5;

export function myDayToday(now = new Date()) {
  const shifted = new Date(now.getTime() - DAY_STARTS_HOUR * 3600000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}
const addDays = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const clean = (s, max = 300) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);

async function readPage(db, day) {
  const today = myDayToday();
  const isToday = day === today;
  // Open tasks written on or before this page, plus tasks crossed off ON it.
  const [{ data: open, error: e1 }, { data: done, error: e2 }] = await Promise.all([
    isToday
      ? db.from('owner_tasks').select('*').is('done_at', null).is('deleted_at', null).lte('origin_day', day)
      // A past page shows what was still open at the end of that day: written
      // by then and crossed off later (or never).
      : db.from('owner_tasks').select('*').is('deleted_at', null).lte('origin_day', day).or(`done_day.is.null,done_day.gt.${day}`),
    db.from('owner_tasks').select('*').is('deleted_at', null).eq('done_day', day),
  ]);
  if (e1) throw e1; if (e2) throw e2;
  const tasks = [...(open || []).map(t => ({ ...t, done: false })), ...(done || []).map(t => ({ ...t, done: true }))]
    .map(t => ({ id: t.id, title: t.title, starred: t.starred, time_hint: t.time_hint, done: t.done,
      carried: Math.max(0, daysBetween(t.origin_day, day)), origin_day: t.origin_day, done_at: t.done_at }));

  const { data: habits, error: e3 } = await db.from('owner_habits').select('id, name, sort').eq('active', true).order('sort').order('created_at');
  if (e3) throw e3;
  const ids = (habits || []).map(h => h.id);
  let checks = [];
  if (ids.length) {
    const { data, error } = await db.from('owner_habit_checks').select('habit_id, day, skipped').in('habit_id', ids).gte('day', addDays(day, -120)).lte('day', day);
    if (error) throw error; checks = data || [];
  }
  const byHabit = new Map(ids.map(id => [id, new Map()]));   // day -> 'done' | 'skip'
  for (const c of checks) byHabit.get(c.habit_id)?.set(String(c.day).slice(0, 10), c.skipped ? 'skip' : 'done');
  const habitRows = (habits || []).map(h => {
    const m = byHabit.get(h.id);
    // Streak = consecutive done days ending on this page (or yesterday if this
    // page isn't settled yet). A SKIPPED day ("took a nap") neither breaks the
    // streak nor adds to it.
    let d = m.has(day) ? day : addDays(day, -1), streak = 0;
    while (m.has(d)) { if (m.get(d) === 'done') streak++; d = addDays(d, -1); }
    return { id: h.id, name: h.name, done: m.get(day) === 'done', skipped: m.get(day) === 'skip', streak };
  });

  const { data: list, error: e4 } = await db.from('owner_list_items').select('id, title, done_at').is('deleted_at', null)
    .or(`done_at.is.null,done_at.gte."${new Date(Date.now() - 86400000).toISOString()}"`).order('created_at');
  if (e4) throw e4;
  return { day, today, is_today: isToday, tasks, habits: habitRows, list: (list || []).map(x => ({ ...x, done: !!x.done_at })) };
}

export async function myDay(req, res, db, auth, body) {
  if (auth.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const today = myDayToday();
  if (req.method === 'GET') {
    const day = isDay(req.query.day) ? req.query.day : today;
    return res.status(200).json(await readPage(db, day > today ? today : day));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const op = String(body.op || ''), id = String(body.id || '');
  let q;
  switch (op) {
    case 'task_add': {
      const title = clean(body.title); if (!title) return res.status(400).json({ error: 'Write a task first' });
      q = db.from('owner_tasks').insert({ title, origin_day: today, starred: !!body.starred, time_hint: clean(body.time_hint, 40) || null }); break;
    }
    case 'task_done':
      q = body.done
        ? db.from('owner_tasks').update({ done_at: new Date().toISOString(), done_day: today }).eq('id', id)
        : db.from('owner_tasks').update({ done_at: null, done_day: null }).eq('id', id);
      break;
    case 'task_edit': {
      const patch = {};
      if ('title' in body) { const t = clean(body.title); if (!t) return res.status(400).json({ error: 'Title can\'t be empty' }); patch.title = t; }
      if ('starred' in body) patch.starred = !!body.starred;
      if ('time_hint' in body) patch.time_hint = clean(body.time_hint, 40) || null;
      q = db.from('owner_tasks').update(patch).eq('id', id); break;
    }
    case 'task_delete': q = db.from('owner_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id); break;
    case 'habit_check':
      q = body.done
        ? db.from('owner_habit_checks').upsert({ habit_id: id, day: today, skipped: false }, { onConflict: 'habit_id,day' })
        : db.from('owner_habit_checks').delete().eq('habit_id', id).eq('day', today);
      break;
    case 'habit_skip':
      q = body.skip
        ? db.from('owner_habit_checks').upsert({ habit_id: id, day: today, skipped: true }, { onConflict: 'habit_id,day' })
        : db.from('owner_habit_checks').delete().eq('habit_id', id).eq('day', today);
      break;
    case 'smart': return await smart(req, res, db, body);
    case 'habit_add': {
      const name = clean(body.name, 60); if (!name) return res.status(400).json({ error: 'Name the habit' });
      q = db.from('owner_habits').insert({ name, sort: 100 }); break;
    }
    case 'habit_remove': q = db.from('owner_habits').update({ active: false }).eq('id', id); break;
    case 'list_add': {
      const title = clean(body.title); if (!title) return res.status(400).json({ error: 'Write something first' });
      q = db.from('owner_list_items').insert({ title }); break;
    }
    case 'list_done': q = db.from('owner_list_items').update({ done_at: body.done ? new Date().toISOString() : null }).eq('id', id); break;
    case 'list_delete': q = db.from('owner_list_items').update({ deleted_at: new Date().toISOString() }).eq('id', id); break;
    default: return res.status(400).json({ error: 'Unknown op' });
  }
  const { error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(await readPage(db, today));
}

// ── "Tell it anything" ──────────────────────────────────────────────────────
// Owner rule 2026-09-23: "a place i can enter complex things and it arranges
// it accordingly -- like today i took a nap so asleep by 1am isnt needed."
// Claude reads the sentence against today's page and returns a list of plain
// actions (structured output, schema below); the server applies them with
// the same writes the buttons use, then replies with what it did.
const ACTION_TYPES = ['add_task', 'complete_task', 'delete_task', 'star_task', 'set_time', 'check_habit', 'skip_habit', 'add_habit', 'add_list_item'];
const SMART_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'actions'],
  properties: {
    reply: { type: 'string', description: 'One or two short, plain sentences telling the owner what was done. No jargon.' },
    actions: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['type', 'title', 'day', 'time_hint', 'starred', 'target_id'],
      properties: {
        type: { type: 'string', enum: ACTION_TYPES },
        title: { type: ['string', 'null'], description: 'Task / list item / habit text for add_* actions' },
        day: { type: ['string', 'null'], description: 'YYYY-MM-DD page the task belongs on. null = today.' },
        time_hint: { type: ['string', 'null'], description: 'Loose time like "3 PM" or "morning". null if none.' },
        starred: { type: ['boolean', 'null'], description: 'true if it is a must-do / urgent' },
        target_id: { type: ['string', 'null'], description: 'id of the existing task or habit this acts on' },
      },
    } },
  },
};

const SMART_SYSTEM = `You manage a personal day planner for a busy business owner who works chaotic hours and plans loosely, like a paper notepad.
Turn what he says into actions on his planner. Rules:
- skip_habit when a daily habit doesn't apply today (for example he napped, so a bedtime habit isn't needed; he's sick, so no gym). check_habit when he says he did it.
- add_task for anything to do. Keep titles short and clear, in his words. Split separate to-dos into separate tasks.
- For a future day ("tomorrow", "Friday"), set day to that YYYY-MM-DD; otherwise null (today). Put loose times ("5pm", "after lunch") in time_hint.
- starred only when he signals it's important or urgent.
- add_list_item for undated things to remember or buy (groceries, errands with no day).
- complete_task, delete_task, star_task and set_time act on an existing task: use its id from open_tasks as target_id. check_habit and skip_habit use a habit id.
- add_habit only when he asks to track something every day.
- If nothing applies, return no actions and say so in reply. Never invent tasks he didn't mention.
Unused fields are null.`;

let _client;
async function smart(req, res, db, body) {
  const text = clean(body.text, 2000);
  if (!text) return res.status(400).json({ error: 'Say something first' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI is not set up (ANTHROPIC_API_KEY missing).' });
  const today = myDayToday();
  const page = await readPage(db, today);
  const clock = new Date().toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const context = {
    today_page: today,
    now_in_bangkok: clock,
    note: 'A day runs from 5 AM to 5 AM Bangkok time, so 2 AM still belongs to the previous page.',
    habits: page.habits.map(h => ({ id: h.id, name: h.name, today: h.done ? 'done' : h.skipped ? 'skipped' : 'open' })),
    open_tasks: page.tasks.filter(t => !t.done).map(t => ({ id: t.id, title: t.title, starred: t.starred, time_hint: t.time_hint })),
    keep_in_mind_list: page.list.filter(x => !x.done).map(x => x.title),
  };
  _client ||= new Anthropic();
  let msg;
  try {
    msg = await _client.beta.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      // A safety decline re-runs on Anthropic's recommended fallback model
      // inside the same call instead of failing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SMART_SCHEMA } },
      system: SMART_SYSTEM,
      messages: [{ role: 'user', content: `Planner right now:\n${JSON.stringify(context)}\n\nHe says: ${text}` }],
    });
  } catch (e) {
    console.error('[my_day smart] Claude call failed:', e.status, e.message);
    return res.status(502).json({ error: 'The AI could not be reached. Try again.' });
  }
  if (msg.stop_reason === 'refusal') return res.status(422).json({ error: 'The AI declined that one. Try rewording it.' });
  const raw = (msg.content || []).find(b => b.type === 'text')?.text || '';
  let plan;
  try { plan = JSON.parse(raw); } catch { return res.status(502).json({ error: 'The AI answer could not be read. Try again.' }); }

  const habitIds = new Set(page.habits.map(h => h.id));
  const taskIds = new Set(page.tasks.map(t => t.id));
  let applied = 0;
  for (const a of (plan.actions || []).slice(0, 25)) {
    const tid = String(a.target_id || '');
    const day = isDay(a.day) && a.day >= today ? a.day : today;
    let r;
    switch (a.type) {
      case 'add_task': if (!clean(a.title)) continue;
        r = await db.from('owner_tasks').insert({ title: clean(a.title), origin_day: day, starred: !!a.starred, time_hint: clean(a.time_hint, 40) || null }); break;
      case 'complete_task': if (!taskIds.has(tid)) continue;
        r = await db.from('owner_tasks').update({ done_at: new Date().toISOString(), done_day: today }).eq('id', tid); break;
      case 'delete_task': if (!taskIds.has(tid)) continue;
        r = await db.from('owner_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', tid); break;
      case 'star_task': if (!taskIds.has(tid)) continue;
        r = await db.from('owner_tasks').update({ starred: a.starred !== false }).eq('id', tid); break;
      case 'set_time': if (!taskIds.has(tid)) continue;
        r = await db.from('owner_tasks').update({ time_hint: clean(a.time_hint, 40) || null }).eq('id', tid); break;
      case 'check_habit': case 'skip_habit': if (!habitIds.has(tid)) continue;
        r = await db.from('owner_habit_checks').upsert({ habit_id: tid, day: today, skipped: a.type === 'skip_habit' }, { onConflict: 'habit_id,day' }); break;
      case 'add_habit': if (!clean(a.title, 60)) continue;
        r = await db.from('owner_habits').insert({ name: clean(a.title, 60), sort: 100 }); break;
      case 'add_list_item': if (!clean(a.title)) continue;
        r = await db.from('owner_list_items').insert({ title: clean(a.title) }); break;
      default: continue;
    }
    if (r && r.error) { console.error('[my_day smart] action failed', a.type, r.error.message); continue; }
    applied++;
  }
  const out = await readPage(db, today);
  return res.status(200).json({ ...out, smart_reply: String(plan.reply || '').slice(0, 500), smart_count: applied });
}
