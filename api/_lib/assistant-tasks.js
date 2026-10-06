// Tasks: Andrew -> Joey, or Joey's own (owner 2026-10-07, migration 0180).
// Only the owner and Joey use it. No clients, no assignee.
// Level lives in color: red Emergency, yellow ASAP, green Normal, white
// Someday. 'joey' is legacy (read as green, rewritten green on any edit).
// Status is derived, never stored:
//   open      done_at null
//   check     Joey ticked Andrew's task, not OK'd yet (done_at set, cleared_at null)
//   sent_back sent_back_at set (cleared on her next tick)
//   done      cleared_at set
// The server enforces every permission. View As sessions (token view_as) never write.
// Notify Joey (text and/or email): owner tap only, Emergency only, on shift only.
import crypto from 'crypto';
import { sendSMSResult, smsConfigured } from './sms.js';
import { sendEmail, emailConfig } from './email.js';
import { smsNotificationsOn, emailNotificationsOn } from './notify.js';
import { demoMode } from './demo.js';
import { signToken } from './auth.js';
import { cleanNotePhotos } from './notes.js';

const TZ = 'America/Denver';
const LEVEL_OF = { red: 'emergency', yellow: 'asap', green: 'normal', white: 'someday' };
const COLOR_OF = { emergency: 'red', asap: 'yellow', normal: 'green', someday: 'white' };
const COLORS = ['red', 'yellow', 'green', 'white'];
// Joey's hours: 6a-6p Denver, same as her shift pill. Days come from her
// My Availability (secretary_availability for doms, plus date exceptions).
const SHIFT_START = 6, SHIFT_END = 18;
const REPEAT_GUARD_MS = 60000;   // successful sends only
const CLAIM_STALE_MS = 30000;    // a crashed send frees its claim after this
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// " · $189" inside an old job label (Joey never sees prices).
const PRICE_RE = /\s\S\s\$\d[\d,]*(?:\.\d+)?/g;
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const iso = () => new Date().toISOString();
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
export const noPrice = (label) => String(label || '').replace(PRICE_RE, '');

export function isJoey(auth) { return !!auth && auth.role === 'secretary' && auth.name === 'Joey'; }
export function taskAccess(auth) { return !!auth && (auth.role === 'owner' || isJoey(auth)); }
export const colorOf = (c) => (c === 'joey' ? 'green' : c);
export const isMine = (t) => !!t && (t.created_by === 'Joey' || t.color === 'joey');
export function statusOf(t) {
  if (t.cleared_at) return 'done';
  if (t.done_at) return 'check';
  if (t.sent_back_at) return 'sent_back';
  return 'open';
}
// body.level ('emergency'|'asap'|'normal'|'someday') or body.color.
export function colorIn(body) {
  const v = String((body && (body.level != null ? body.level : body.color)) || '').toLowerCase();
  if (COLOR_OF[v]) return COLOR_OF[v];
  if (v === 'joey') return 'green';
  return COLORS.includes(v) ? v : null;
}
// undefined -> skip, null/'' -> clear, 'YYYY-MM-DD' -> date, anything else -> false.
export function dueIn(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : false;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function denverNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DOW[p.weekday] };
}
export function dueState(due, today) {
  if (!due) return null;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  return 'later';
}
export function cleanChecklist(items) {
  return (Array.isArray(items) ? items : []).map((i) => ({
    id: (i && typeof i.id === 'string' && /^[\w-]{1,64}$/.test(i.id)) ? i.id : crypto.randomUUID(),
    text: clip(String((i && i.text) || '').trim(), 300),
    done: !!(i && i.done),
  })).filter((i) => i.text).slice(0, 50);
}

// ── Shift: one helper decides on/off (owner 2026-10-07) ──────────────────────
// Off shift = no text, no email, nothing queued.
export async function joeyShift(db, now = new Date()) {
  const p = denverNow(now);
  const inHours = p.hour >= SHIFT_START && p.hour < SHIFT_END;
  let dayOn = true, source = 'default';
  try {
    const { data: biz, error } = await db.from('businesses').select('id').eq('slug', 'doms').maybeSingle();
    if (error) throw new Error(error.message);
    if (biz) {
      const [pat, exc] = await Promise.all([
        db.from('secretary_availability').select('is_available').eq('business_id', biz.id).eq('day_of_week', p.dow),
        db.from('secretary_availability_exceptions').select('is_available').eq('business_id', biz.id).eq('exception_date', p.date),
      ]);
      if (pat.error || exc.error) throw new Error((pat.error || exc.error).message);
      if (exc.data && exc.data.length) { dayOn = exc.data[0].is_available !== false; source = 'exception'; }
      else if (pat.data && pat.data.length) { dayOn = pat.data[0].is_available !== false; source = 'schedule'; }
    }
  } catch (e) { console.warn('[tasks] shift read failed, using 6a-6p every day:', e.message); }
  const on = dayOn && inHours;
  return { on, reason: on ? null : (dayOn ? 'off_hours' : 'day_off'), day_on: dayOn, start: '06:00', end: '18:00', tz: TZ, source };
}

// ── Who / where ──────────────────────────────────────────────────────────────
async function joeyPhone(db, fallback) {
  try {
    const { data } = await db.from('staff_users').select('phone').eq('name', 'Joey').eq('active', true).maybeSingle();
    if (data && data.phone) return data.phone;
  } catch { /* fallback below */ }
  return fallback || '';
}
// Same address Joey's booking alerts go to (owner-notify.js).
async function joeyEmail(db) {
  try {
    const { data } = await db.from('staff_users').select('email').eq('name', 'Joey').eq('active', true).maybeSingle();
    if (data && data.email) return data.email;
  } catch { /* fallback below */ }
  return process.env.DOMS_SECRETARY_EMAIL || 'jyrsbries@gmail.com';
}
function crmBase() {
  return (process.env.PUBLIC_DASHBOARD_URL || process.env.PUBLIC_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://handy-andy-booking.vercel.app')).replace(/\/+$/, '');
}
// Must match the URL handleTwilioStatus (analytics.js) rebuilds for the signature.
function statusBase() {
  return process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
}
export const taskLink = (id) => `${crmBase()}/admin.html?task=${id}`;
export const taskSmsBody = (title, id) => `URGENT from Andrew: ${clip(String(title || '').trim(), 120)}. ${taskLink(id)}`;

async function channels(db) {
  const smsCfg = smsConfigured(), smsOn = demoMode() || smsNotificationsOn();
  const to = await joeyEmail(db);
  const emCfg = demoMode() || !!emailConfig('doms').apiKey, emOn = demoMode() || emailNotificationsOn();
  return {
    text: { available: smsCfg && smsOn, reason: !smsCfg ? 'not_configured' : !smsOn ? 'notifications_off' : null },
    email: { available: !!to && emCfg && emOn, on_file: !!to, reason: !to ? 'no_email' : !emCfg ? 'not_configured' : !emOn ? 'notifications_off' : null },
  };
}

// ── Events (Activity thread) ─────────────────────────────────────────────────
async function addEvent(db, taskId, kind, body, by, { strict = false } = {}) {
  const { data, error } = await db.from('assistant_task_events')
    .insert({ task_id: taskId, kind, body: body ? clip(body, 2000) : null, by: by || null }).select('*').maybeSingle();
  if (error) { if (strict) throw error; console.warn('[tasks] event log failed:', error.message); }
  return data || null;
}

// ── Notify Joey: atomic claim, then send, then record (owner 2026-10-07) ────
function claimOr(prefix, okCol, now) {
  const guard = new Date(now - REPEAT_GUARD_MS).toISOString();
  const stale = new Date(now - CLAIM_STALE_MS).toISOString();
  const c = `${prefix}_claim_at`;
  return [`and(${c}.is.null,${okCol}.is.null)`, `and(${c}.is.null,${okCol}.lt.${guard})`,
    `and(${c}.lt.${stale},${okCol}.is.null)`, `and(${c}.lt.${stale},${okCol}.lt.${guard})`].join(',');
}
async function claim(db, id, prefix, okCol) {
  const now = Date.now(), at = new Date(now).toISOString();
  const { data, error } = await db.from('assistant_tasks').update({ [`${prefix}_claim_at`]: at })
    .eq('id', id).eq('color', 'red').is('done_at', null).is('deleted_at', null)
    .or(claimOr(prefix, okCol, now)).select('id');
  if (error) throw error;
  if (data && data.length) return { at };
  const { data: cur } = await db.from('assistant_tasks').select(`${okCol}, ${prefix}_claim_at`).eq('id', id).maybeSingle();
  if (cur && cur[okCol] && Date.parse(cur[okCol]) > now - REPEAT_GUARD_MS) return { busy: { ok: false, reason: 'recent', at: cur[okCol] } };
  if (cur && cur[`${prefix}_claim_at`]) return { busy: { ok: false, reason: 'in_progress' } };
  return { busy: { ok: false, reason: 'not_open' } };
}
async function sendTaskText(db, t, who, opts) {
  const c = await claim(db, t.id, 'text', 'texted_at');
  if (c.busy) return c.busy;
  const phone = await joeyPhone(db, opts.fallbackPhone);
  const base = statusBase();
  const statusCallback = base ? `${base}/api/analytics?action=sms_status&token=${encodeURIComponent(signToken({ kind: 'task_sms', task_id: t.id }, 3 * 86400))}` : undefined;
  let r;
  try { r = await sendSMSResult(phone, taskSmsBody(t.title, t.id), { statusCallback }); }
  catch (e) { r = { ok: false, error: e.message }; }
  const at = iso();
  if (r && r.ok) {
    await db.from('assistant_tasks').update({ texted_at: at, text_sid: r.sid || null, text_status: 'sent', text_error: null, text_claim_at: null, updated_at: at, updated_by: who }).eq('id', t.id);
    await addEvent(db, t.id, 'texted', null, who);
    return { ok: true, at, sid: r.sid || null, status: 'sent' };
  }
  const reason = clip((r && (r.skipped || r.error)) || 'not sent', 200);
  // text_sid cleared so a late callback for an older text can't flip this.
  await db.from('assistant_tasks').update({ text_error: reason, text_status: 'failed', text_sid: null, text_claim_at: null, updated_at: at, updated_by: who }).eq('id', t.id);
  await addEvent(db, t.id, 'text_failed', reason, who);
  return { ok: false, reason };
}
async function sendTaskEmail(db, t, who) {
  const c = await claim(db, t.id, 'email', 'emailed_at');
  if (c.busy) return c.busy;
  const to = await joeyEmail(db);
  const link = taskLink(t.id);
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111;">`
    + `<p><b>URGENT from Andrew:</b> ${esc(t.title)}</p>`
    + (t.notes ? `<p style="color:#444;white-space:pre-wrap;">${esc(clip(t.notes, 2000))}</p>` : '')
    + `<p><a href="${esc(link)}">Open the task</a></p></div>`;
  let r;
  try { r = await sendEmail({ slug: 'doms', to, subject: `URGENT: ${clip(String(t.title || '').trim(), 150)}`, html, idempotencyKey: `task-${t.id}-${c.at}` }); }
  catch (e) { r = { sent: false, error: e.message }; }
  const at = iso();
  if (r && r.sent) {
    await db.from('assistant_tasks').update({ emailed_at: at, email_error: null, email_claim_at: null, updated_at: at, updated_by: who }).eq('id', t.id);
    await addEvent(db, t.id, 'emailed', null, who);
    return { ok: true, at };
  }
  const reason = clip((r && (r.skipped || r.error)) || 'not sent', 200);
  await db.from('assistant_tasks').update({ email_error: reason, email_claim_at: null, updated_at: at, updated_by: who }).eq('id', t.id);
  await addEvent(db, t.id, 'email_failed', reason, who);
  return { ok: false, reason };
}
async function runNotify(db, t, want, me, opts) {
  const shift = await joeyShift(db);
  if (!shift.on) {
    const off = { ok: false, reason: 'off_shift' };
    return { skipped: 'off_shift', shift, text: want.text ? off : null, email: want.email ? off : null };
  }
  const [text, email] = await Promise.all([
    want.text ? sendTaskText(db, t, me.who, opts) : null,
    want.email ? sendTaskEmail(db, t, me.who) : null,
  ]);
  return { text, email };
}
const wantOf = (n) => ({ text: !!(n && n.text), email: !!(n && n.email) });

// ── Read model ───────────────────────────────────────────────────────────────
function textState(t) {
  if (t.text_claim_at && Date.parse(t.text_claim_at) > Date.now() - CLAIM_STALE_MS) return { state: 'sending' };
  if (t.text_status === 'failed') return { state: 'failed', error: t.text_error || null, at: t.texted_at || null };
  if (!t.texted_at) return { state: 'never' };
  const s = t.text_status === 'delivered' || t.text_status === 'undelivered' ? t.text_status : 'sent';
  return { state: s, at: t.texted_at };
}
function emailState(t) {
  if (t.email_claim_at && Date.parse(t.email_claim_at) > Date.now() - CLAIM_STALE_MS) return { state: 'sending' };
  if (t.email_error) return { state: 'failed', error: t.email_error, at: t.emailed_at || null };
  return t.emailed_at ? { state: 'sent', at: t.emailed_at } : { state: 'never' };
}
const NO_PERMS = { edit: false, level: false, red: false, tick: false, untick: false, ok: false, send_back: false, reopen: false, delete: false, undelete: false, comment: false, check_items: false, notify: false, order: false };
export function perms(t, me, shiftOn) {
  if (me.viewAs) return { ...NO_PERMS };
  const st = statusOf(t), mine = isMine(t), red = colorOf(t.color) === 'red', live = !t.deleted_at;
  if (!live) return { ...NO_PERMS, undelete: me.owner || mine };
  const openish = st === 'open' || st === 'sent_back';
  if (me.owner) {
    return { ...NO_PERMS, edit: true, level: true, red: true, tick: openish, ok: st === 'check', send_back: st === 'check',
      reopen: st === 'done', delete: true, comment: true, check_items: true, notify: red && openish && !!shiftOn, order: st !== 'done' };
  }
  if (mine) {
    return { ...NO_PERMS, edit: true, level: !red, tick: openish || st === 'check', untick: st === 'done', reopen: st === 'done', delete: true, comment: true, check_items: true };
  }
  return { ...NO_PERMS, tick: openish, untick: st === 'check', comment: true, check_items: st !== 'done' };
}
function decorate(t, ctx) {
  const color = colorOf(t.color), status = statusOf(t), me = ctx.me;
  const cs = ctx.comments.get(t.id) || [];
  const seen = me.owner ? t.seen_owner_at : t.seen_joey_at;
  const seenMs = seen ? Date.parse(seen) : 0;
  const unread = cs.filter((c) => (me.owner ? c.by === 'Joey' : c.by !== 'Joey') && Date.parse(c.created_at) > seenMs).length;
  const list = Array.isArray(t.checklist) ? t.checklist : [];
  const out = {
    ...t, color, level: LEVEL_OF[color] || 'normal', status, mine: isMine(t),
    replies: cs.length, unread,
    checklist: list, checklist_done: list.filter((i) => i && i.done).length, checklist_total: list.length,
    due_state: dueState(t.due_on, ctx.today),
    needs_you: !!me.owner && !t.deleted_at && status !== 'done' && (status === 'check' || unread > 0),
    text: textState(t), email: emailState(t),
    can: perms(t, me, ctx.shift && ctx.shift.on),
  };
  delete out.text_claim_at; delete out.email_claim_at;
  if (!me.owner && out.job_label) out.job_label = noPrice(out.job_label);
  return out;
}
function commentMap(rows) {
  const m = new Map();
  for (const r of rows || []) { if (!m.has(r.task_id)) m.set(r.task_id, []); m.get(r.task_id).push(r); }
  return m;
}
async function ctxFor(db, me, commentRows, shift) {
  return { me, comments: commentMap(commentRows), today: denverNow().date, shift: shift || await joeyShift(db) };
}
async function loadOne(db, id, me) {
  const [{ data: t, error }, { data: cs, error: e2 }] = await Promise.all([
    db.from('assistant_tasks').select('*').eq('id', id).maybeSingle(),
    db.from('assistant_task_events').select('task_id, by, created_at').eq('task_id', id).eq('kind', 'comment'),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  return t ? decorate(t, await ctxFor(db, me, cs)) : null;
}
async function getTask(db, id) {
  const { data, error } = await db.from('assistant_tasks').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
const byOrder = (a, b) => {
  const sa = a.sort_order == null ? Infinity : Number(a.sort_order), sb = b.sort_order == null ? Infinity : Number(b.sort_order);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return Date.parse(a.created_at) - Date.parse(b.created_at);
};

async function listV2(req, res, db, me) {
  const id = String(req.query.id || '');
  if (id) {
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id required' });
    const [{ data: t, error }, { data: ev, error: e2 }] = await Promise.all([
      db.from('assistant_tasks').select('*').eq('id', id).maybeSingle(),
      db.from('assistant_task_events').select('*').eq('task_id', id).order('created_at', { ascending: true }).limit(500),
    ]);
    if (error) throw error;
    if (e2) throw e2;
    if (!t) return res.status(404).json({ error: 'Not found' });
    const ctx = await ctxFor(db, me, (ev || []).filter((e) => e.kind === 'comment'));
    return res.status(200).json({ task: decorate(t, ctx), events: ev || [], shift: ctx.shift });
  }
  const [open, done, cs, shift, ch] = await Promise.all([
    db.from('assistant_tasks').select('*').is('deleted_at', null).is('cleared_at', null).order('created_at', { ascending: true }).limit(500),
    db.from('assistant_tasks').select('*').is('deleted_at', null).not('cleared_at', 'is', null).order('cleared_at', { ascending: false }).limit(300),
    db.from('assistant_task_events').select('task_id, by, created_at').eq('kind', 'comment').limit(10000),
    joeyShift(db),
    me.owner && !me.viewAs ? channels(db) : null,
  ]);
  for (const r of [open, done, cs]) if (r.error) throw r.error;
  const ctx = await ctxFor(db, me, cs.data, shift);
  const tasks = (open.data || []).sort(byOrder).map((t) => decorate(t, ctx));
  const doneList = (done.data || []).map((t) => decorate(t, ctx));
  const openish = (t) => t.status === 'open' || t.status === 'sent_back';
  const emergency = tasks.filter((t) => t.color === 'red' && openish(t)).length;
  const asap = tasks.filter((t) => t.color === 'yellow' && openish(t)).length;
  const needsYou = me.owner ? tasks.filter((t) => t.needs_you).length : 0;
  const joeyBadge = me.owner ? 0 : tasks.filter((t) => ((t.color === 'red' || t.color === 'yellow') && openish(t)) || t.unread > 0).length;
  return res.status(200).json({
    tasks, done: doneList,
    me: { role: me.owner ? 'owner' : 'joey', name: me.who, view_as: me.viewAs, read_only: me.viewAs },
    shift, channels: ch, today: ctx.today, tz: TZ,
    counts: {
      badge: me.owner ? needsYou : joeyBadge, needs_you: needsYou,
      emergency_open: emergency, asap_open: asap,
      check: tasks.filter((t) => t.status === 'check').length,
      unread: tasks.filter((t) => t.unread > 0).length,
    },
  });
}
// Old open tabs (one release): same rows as before.
async function listLegacy(res, db, me) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data, error } = await db.from('assistant_tasks').select('*').is('deleted_at', null)
    .or(`done_at.is.null,done_at.gte.${since}`).order('created_at', { ascending: true }).limit(300);
  if (error) throw error;
  const rows = (data || []).map((t) => (me.owner || !t.job_label ? t : { ...t, job_label: noPrice(t.job_label) }));
  return res.status(200).json({ tasks: rows });
}
// Job search for linking: customer name or phone, newest first. No price in labels.
async function jobSearch(req, res, db) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.status(200).json({ jobs: [] });
  const digits = q.replace(/\D/g, '');
  let cq = db.from('customers').select('id').limit(40);
  cq = digits.length >= 4 ? cq.ilike('phone', `%${digits.slice(-10)}%`) : cq.ilike('name', `%${q.replace(/[%,()]/g, '')}%`);
  const { data: cs } = await cq;
  const ids = (cs || []).map((c) => c.id);
  if (!ids.length) return res.status(200).json({ jobs: [] });
  const { data: bks } = await db.from('bookings').select('id, scheduled_at, customer:customers(name), business:businesses(slug, name)')
    .in('customer_id', ids).order('scheduled_at', { ascending: false }).limit(10);
  const jobs = (bks || []).map((b) => ({ id: b.id, slug: (b.business && b.business.slug) || null,
    label: [(b.customer && b.customer.name) || 'Customer',
      b.scheduled_at ? new Date(b.scheduled_at).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }) : '',
      (b.business && b.business.name) || ''].filter(Boolean).join(' · ') }));
  return res.status(200).json({ jobs });
}

// ── Edits ────────────────────────────────────────────────────────────────────
// Owner: any task. Joey: only her own (never red, never a red task's level).
function buildEdit(t, body, me) {
  if (!me.owner && !isMine(t)) return { status: 403, error: 'Only Andrew can change his tasks.' };
  const patch = {};
  if (has(body, 'title')) {
    const v = clip(String(body.title || '').trim(), 300);
    if (!v) return { status: 400, error: 'Write the task first.' };
    patch.title = v;
  }
  if (has(body, 'notes')) patch.notes = clip(String(body.notes || ''), 4000) || null;
  if (has(body, 'level') || has(body, 'color')) {
    const c = colorIn(body);
    if (!c) return { status: 400, error: 'Pick a level.' };
    if (c !== colorOf(t.color) && !me.owner && (c === 'red' || colorOf(t.color) === 'red')) return { status: 403, error: 'Only Andrew can set Emergency.' };
    patch.color = c;
  } else if (t.color === 'joey') patch.color = 'green';
  if (has(body, 'due_on')) {
    const d = dueIn(body.due_on);
    if (d === false) return { status: 400, error: 'Bad due date.' };
    patch.due_on = d;
  }
  if (has(body, 'booking_id')) {
    if (body.booking_id && UUID_RE.test(String(body.booking_id))) {
      patch.booking_id = String(body.booking_id);
      patch.job_slug = clip(body.job_slug || '', 60) || null;
      patch.job_label = noPrice(clip(body.job_label || '', 200)) || null;
    } else if (!body.booking_id) { patch.booking_id = null; patch.job_slug = null; patch.job_label = null; }
    else return { status: 400, error: 'Bad job.' };
  }
  if (has(body, 'photos')) patch.photo_urls = cleanNotePhotos(body.photos);
  if (has(body, 'checklist')) patch.checklist = cleanChecklist(body.checklist);
  return { patch };
}
async function offerNotify(db, me, prevColor, newColor, t) {
  if (!me.owner || newColor !== 'red' || colorOf(prevColor) === 'red' || t.done_at || t.deleted_at) return false;
  return (await joeyShift(db)).on;
}

// ── Router ───────────────────────────────────────────────────────────────────
// opts.fallbackPhone: Joey's mobile when staff_users has none (admin.js secretaryPhoneFor).
export async function assistantTasksHandler(req, res, db, auth, body, opts = {}) {
  if (!taskAccess(auth)) return res.status(403).json({ error: 'Not available for this login' });
  body = body || {};
  const me = { owner: auth.role === 'owner', viewAs: !!auth.view_as, who: auth.name || (auth.role === 'owner' ? 'Andrew' : 'Joey') };
  if (req.method === 'GET') {
    if (req.query.q != null) return jobSearch(req, res, db);
    if (String(req.query.v || '') === '2' || req.query.id) return listV2(req, res, db, me);
    return listLegacy(res, db, me);
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const op = String(body.op || '');
  // View As: read only. No writes, no Seen stamps.
  if (me.viewAs) {
    if (op === 'seen') return res.status(200).json({ ok: true, skipped: 'view_as' });
    return res.status(403).json({ error: 'View only.', code: 'view_as' });
  }
  const now = iso();
  const stamp = { updated_at: now, updated_by: me.who };

  if (op === 'create' || op === 'add') {
    const legacy = op === 'add';
    const title = clip(String(body.title || '').trim(), 300);
    if (!title) return res.status(400).json({ error: 'Write the task first.' });
    let color;
    if (me.owner) {
      color = colorIn(body);
      if (!color) { if (legacy) return res.status(400).json({ error: 'Pick a color.' }); color = 'green'; }
    } else {
      // Joey: ASAP / Normal / Someday, default Normal. Old tabs had no pick.
      color = legacy ? 'green' : (colorIn(body) || 'green');
      if (color === 'red') return res.status(403).json({ error: 'Only Andrew can set Emergency.' });
    }
    // Client-made id: a double tap returns the same task, never texts twice.
    const id = UUID_RE.test(String(body.id || '')) ? String(body.id) : null;
    if (id) {
      const dup = await getTask(db, id);
      if (dup) return res.status(200).json({ ok: true, duplicate: true, task: await loadOne(db, id, me), notify: null, texted: false });
    }
    const row = { title, color, notes: clip(String(body.notes || '').trim(), 4000) || null, created_by: me.who, photo_urls: cleanNotePhotos(body.photos), ...stamp };
    if (id) row.id = id;
    const due = dueIn(body.due_on);
    if (due === false) return res.status(400).json({ error: 'Bad due date.' });
    if (due) row.due_on = due;
    if (Array.isArray(body.checklist)) row.checklist = cleanChecklist(body.checklist);
    if (body.booking_id && UUID_RE.test(String(body.booking_id))) {
      row.booking_id = String(body.booking_id); row.job_slug = clip(body.job_slug || '', 60) || null; row.job_label = noPrice(clip(body.job_label || '', 200)) || null;
    }
    const { data, error } = await db.from('assistant_tasks').insert(row).select('*').maybeSingle();
    if (error) {
      if (id && error.code === '23505') return res.status(200).json({ ok: true, duplicate: true, task: await loadOne(db, id, me), notify: null, texted: false });
      throw error;
    }
    let notify = null;
    if (me.owner && color === 'red') {
      // New composer sends its toggles; an old tab's red add = Text ON (the default).
      const want = legacy ? { text: true, email: false } : wantOf(body.notify);
      if (want.text || want.email) notify = await runNotify(db, data, want, me, opts);
    }
    return res.status(200).json({ ok: true, task: await loadOne(db, data.id, me), notify, texted: !!(notify && notify.text && notify.text.ok) });
  }

  // Owner drag order; moving across groups changes level, never notifies.
  if (op === 'order') {
    if (!me.owner) return res.status(403).json({ error: 'Owner only' });
    let offer = false;
    if (body.id && (has(body, 'level') || has(body, 'color'))) {
      if (!UUID_RE.test(String(body.id))) return res.status(400).json({ error: 'id required' });
      const c = colorIn(body);
      if (!c) return res.status(400).json({ error: 'Pick a level.' });
      const prev = await getTask(db, String(body.id));
      if (!prev) return res.status(404).json({ error: 'Not found' });
      if (prev.color !== c) {
        const { error } = await db.from('assistant_tasks').update({ color: c, ...stamp }).eq('id', prev.id);
        if (error) throw error;
      }
      offer = await offerNotify(db, me, prev.color, c, prev);
    }
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x) => UUID_RE.test(String(x))).slice(0, 500);
    await Promise.all(ids.map((tid, i) => db.from('assistant_tasks').update({ sort_order: i }).eq('id', tid)));
    return res.status(200).json({ ok: true, offer_notify: offer });
  }

  const id = String(body.id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id required' });
  const t = await getTask(db, id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const mine = isMine(t), st = statusOf(t);
  const reply = async (extra = {}) => res.status(200).json({ ok: true, task: await loadOne(db, id, me), ...extra });

  // Edits. 'edit' is the new one; title/color/notes/photos are old tabs'.
  if (op === 'edit' || op === 'title' || op === 'color' || op === 'notes' || op === 'photos') {
    if (t.deleted_at) return res.status(409).json({ error: 'Task was deleted.' });
    let src = body;
    if (op === 'title') src = { title: body.title };
    else if (op === 'color') src = { color: body.color };
    else if (op === 'notes') src = { notes: body.notes };
    else if (op === 'photos') src = { photos: body.photos };
    const e = buildEdit(t, src, me);
    if (e.error) return res.status(e.status).json({ error: e.error });
    const already = op === 'color' && t.color === e.patch.color;
    if (!already && Object.keys(e.patch).length) {
      const { error } = await db.from('assistant_tasks').update({ ...e.patch, ...stamp }).eq('id', id);
      if (error) throw error;
    }
    // Recolor to red NEVER notifies; the UI may offer a Notify toast.
    const offer = e.patch.color ? await offerNotify(db, me, t.color, e.patch.color, t) : false;
    if (op === 'title' || op === 'color') return res.status(200).json({ ok: true, texted: false, already, offer_notify: offer });
    if (op === 'notes' || op === 'photos') return res.status(200).json({ ok: true });
    return reply({ offer_notify: offer });
  }

  // Tick. Owner: Done (Undo = untick). Joey on her own: Done.
  // Joey on Andrew's: Check, crossed out until he OKs it.
  const tick = async () => {
    if (t.deleted_at) return res.status(409).json({ error: 'Task was deleted.' });
    if (st === 'check') {
      if (me.owner) return okTask();
      if (!mine) return reply();
      // Her own task left crossed out by an old tab: straight to Done.
      const { error } = await db.from('assistant_tasks').update({ cleared_at: now, ...stamp }).eq('id', id).is('cleared_at', null);
      if (error) throw error;
      return reply({ undo: { op: 'untick', id } });
    }
    if (st === 'done') return reply();
    const toDone = me.owner || mine;
    const { error } = await db.from('assistant_tasks')
      .update({ done_at: now, done_by: me.who, cleared_at: toDone ? now : null, sent_back_at: null, ...stamp })
      .eq('id', id).is('done_at', null);
    if (error) throw error;
    return reply({ undo: { op: 'untick', id } });
  };
  // Untick. Owner / Joey's own: back to open. Joey on Andrew's: only before OK.
  const untick = async () => {
    if (me.owner || mine) {
      const { error } = await db.from('assistant_tasks').update({ done_at: null, done_by: null, cleared_at: null, ...stamp }).eq('id', id);
      if (error) throw error;
      return reply();
    }
    const { data: hit, error } = await db.from('assistant_tasks').update({ done_at: null, done_by: null, ...stamp })
      .eq('id', id).not('done_at', 'is', null).is('cleared_at', null).select('id');
    if (error) throw error;
    if (!(hit && hit.length) && st === 'done') return res.status(409).json({ error: "Andrew already OK'd this.", code: 'already_ok' });
    return reply();
  };
  const okTask = async () => {
    if (!me.owner) return res.status(403).json({ error: 'Only Andrew can OK tasks.' });
    const { data: hit, error } = await db.from('assistant_tasks').update({ cleared_at: now, ...stamp })
      .eq('id', id).not('done_at', 'is', null).is('cleared_at', null).select('id');
    if (error) throw error;
    if (!(hit && hit.length)) {
      if (op === 'clear' || op === 'done') return reply();
      return res.status(409).json({ error: 'Nothing to OK.', code: 'not_check' });
    }
    await addEvent(db, id, 'ok', null, me.who);
    return reply({ undo: { op: 'unok', id } });
  };

  if (op === 'tick') return tick();
  if (op === 'untick') return untick();
  if (op === 'done') return body.done ? tick() : untick();   // old tabs
  if (op === 'ok' || op === 'clear') return okTask();        // clear = old tabs
  if (op === 'unok') {
    if (!me.owner) return res.status(403).json({ error: 'Owner only' });
    const { data: hit, error } = await db.from('assistant_tasks').update({ cleared_at: null, ...stamp })
      .eq('id', id).not('done_at', 'is', null).not('cleared_at', 'is', null).select('id');
    if (error) throw error;
    if (hit && hit.length) {
      // Undo of OK: drop the OK line it just wrote.
      const { data: last } = await db.from('assistant_task_events').select('id').eq('task_id', id).eq('kind', 'ok')
        .gte('created_at', new Date(Date.now() - 5 * 60000).toISOString()).order('created_at', { ascending: false }).limit(1);
      if (last && last[0]) await db.from('assistant_task_events').delete().eq('id', last[0].id);
    }
    return reply();
  }
  if (op === 'send_back') {
    if (!me.owner) return res.status(403).json({ error: 'Only Andrew can send tasks back.' });
    const text = clip(String(body.body || body.reply || '').trim(), 2000);
    const { data: hit, error } = await db.from('assistant_tasks')
      .update({ done_at: null, done_by: null, cleared_at: null, sent_back_at: now, ...stamp, ...(text ? { seen_owner_at: now } : {}) })
      .eq('id', id).not('done_at', 'is', null).is('cleared_at', null).select('id');
    if (error) throw error;
    if (!(hit && hit.length)) return res.status(409).json({ error: 'Only a ticked task can go back.', code: 'not_check' });
    await addEvent(db, id, 'sent_back', null, me.who);
    if (text) await addEvent(db, id, 'comment', text, me.who);
    return reply();
  }
  if (op === 'reopen') {
    if (!me.owner && !mine) return res.status(403).json({ error: 'Only Andrew can reopen his tasks.' });
    if (t.deleted_at) return res.status(409).json({ error: 'Task was deleted.' });
    const { error } = await db.from('assistant_tasks').update({ done_at: null, done_by: null, cleared_at: null, sent_back_at: null, ...stamp }).eq('id', id);
    if (error) throw error;
    if (st !== 'open') await addEvent(db, id, 'reopened', null, me.who);
    return reply();
  }
  if (op === 'delete' || op === 'undelete') {
    if (!me.owner && !mine) return res.status(403).json({ error: 'Only Andrew can delete his tasks.' });
    const { error } = await db.from('assistant_tasks').update({ deleted_at: op === 'delete' ? now : null, ...stamp }).eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true, ...(op === 'delete' ? { undo: { op: 'undelete', id } } : { task: await loadOne(db, id, me) }) });
  }
  // Replies never text or email; they only raise badges.
  if (op === 'comment') {
    const text = clip(String(body.body || '').trim(), 2000);
    if (!text) return res.status(400).json({ error: 'Write a reply first.' });
    if (t.deleted_at) return res.status(409).json({ error: 'Task was deleted.' });
    const ev = await addEvent(db, id, 'comment', text, me.who, { strict: true });
    await db.from('assistant_tasks').update({ ...stamp, [me.owner ? 'seen_owner_at' : 'seen_joey_at']: now }).eq('id', id);
    return res.status(200).json({ ok: true, event: ev });
  }
  if (op === 'seen') {
    const col = me.owner ? 'seen_owner_at' : 'seen_joey_at';
    const { error } = await db.from('assistant_tasks').update({ [col]: now }).eq('id', id);
    if (error) throw error;
    return res.status(200).json({ ok: true, seen_at: now });
  }
  // Checklist: owner any; Joey adds/edits/removes on her own, ticks any open one.
  if (op === 'checklist') {
    const act = String(body.act || '');
    const shape = act === 'add' || act === 'edit' || act === 'remove' || act === 'set';
    if (!shape && act !== 'toggle') return res.status(400).json({ error: 'Unknown checklist act' });
    for (let tries = 0; tries < 3; tries++) {
      const cur = tries ? await getTask(db, id) : t;
      if (!cur || cur.deleted_at) return res.status(409).json({ error: 'Task was deleted.' });
      const p = perms(cur, me, false);
      if (shape ? !(me.owner || isMine(cur)) : !p.check_items) return res.status(403).json({ error: 'Only Andrew can change this list.' });
      let list = cleanChecklist(cur.checklist);
      const item = list.find((i) => i.id === String(body.item_id || ''));
      const text = clip(String(body.text || '').trim(), 300);
      if (act === 'add') {
        if (!text) return res.status(400).json({ error: 'Write the item first.' });
        if (list.length >= 50) return res.status(400).json({ error: 'List is full.' });
        list.push({ id: crypto.randomUUID(), text, done: false });
      } else if (act === 'set') {
        list = cleanChecklist(body.items);
      } else {
        if (!item) return res.status(404).json({ error: 'Item not found' });
        if (act === 'toggle') item.done = body.done == null ? !item.done : !!body.done;
        else if (act === 'edit') { if (!text) return res.status(400).json({ error: 'Write the item first.' }); item.text = text; }
        else list = list.filter((i) => i !== item);
      }
      let q = db.from('assistant_tasks').update({ checklist: list, updated_at: iso(), updated_by: me.who }).eq('id', id);
      q = cur.updated_at ? q.eq('updated_at', cur.updated_at) : q.is('updated_at', null);
      const { data: hit, error } = await q.select('id');
      if (error) throw error;
      if (hit && hit.length) return res.status(200).json({ ok: true, checklist: list });
    }
    return res.status(409).json({ error: 'Busy. Try again.' });
  }
  // Notify Joey: owner tap only, Emergency only, open only, on shift only.
  if (op === 'notify') {
    if (!me.owner) return res.status(403).json({ error: 'Only Andrew can notify Joey.' });
    if (t.deleted_at || t.done_at) return res.status(409).json({ error: 'Task is not open.', code: 'not_open' });
    if (colorOf(t.color) !== 'red') return res.status(409).json({ error: 'Emergency tasks only.', code: 'not_emergency' });
    const want = wantOf(body);
    if (!want.text && !want.email) return res.status(400).json({ error: 'Pick Text or Email.' });
    const r = await runNotify(db, t, want, me, opts);
    if (r.skipped === 'off_shift') return res.status(409).json({ error: 'Joey is off.', code: 'off_shift', shift: r.shift });
    const ok = (!want.text || (r.text && r.text.ok)) && (!want.email || (r.email && r.email.ok));
    return reply({ ok: !!ok, text: r.text, email: r.email });
  }
  return res.status(400).json({ error: 'Unknown op' });
}
