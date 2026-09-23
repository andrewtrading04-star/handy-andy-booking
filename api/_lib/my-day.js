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
    const { data, error } = await db.from('owner_habit_checks').select('habit_id, day').in('habit_id', ids).gte('day', addDays(day, -120)).lte('day', day);
    if (error) throw error; checks = data || [];
  }
  const byHabit = new Map(ids.map(id => [id, new Set()]));
  for (const c of checks) byHabit.get(c.habit_id)?.add(String(c.day).slice(0, 10));
  const habitRows = (habits || []).map(h => {
    const set = byHabit.get(h.id);
    // Streak = consecutive checked days ending on this page, or ending
    // yesterday if this page isn't checked yet (the day isn't over).
    let d = set.has(day) ? day : addDays(day, -1), streak = 0;
    while (set.has(d)) { streak++; d = addDays(d, -1); }
    return { id: h.id, name: h.name, done: set.has(day), streak };
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
        ? db.from('owner_habit_checks').upsert({ habit_id: id, day: today }, { onConflict: 'habit_id,day' })
        : db.from('owner_habit_checks').delete().eq('habit_id', id).eq('day', today);
      break;
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
