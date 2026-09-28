// Tech calendar (owner 2026-09-29, after Gregory "wasn't aware" of a job he had
// been texted about twice):
//   1. A private calendar feed per technician (webcal / .ics). The tech adds it
//      once to Apple, Google or Samsung Calendar and every job they're on shows
//      up in the calendar they already look at, and keeps itself up to date.
//   2. An evening "your jobs tomorrow" text, sent once per tech per day.
// Read-only: nothing a calendar app does can change a booking.
import { signToken, verifyToken } from './auth.js';
import { sendSMSResult } from './sms.js';

const CAL_TTL = 10 * 365 * 86400;   // a subscription should outlive the phone
export const calToken = (techId) => signToken({ kind: 'tech_cal', tech_id: techId }, CAL_TTL);
export const calTechId = (token) => { const a = verifyToken(String(token || '')); return a && a.kind === 'tech_cal' && a.tech_id ? a.tech_id : null; };

function baseUrl() {
  return (process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')).replace(/\/$/, '');
}
export function calLinks(techId) {
  const https = `${baseUrl()}/api/tech?action=calendar&t=${encodeURIComponent(calToken(techId))}`;
  const webcal = https.replace(/^https?:/, 'webcal:');
  return { https, webcal, google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` };
}

const JOB_COLS = `id, status, scheduled_at, scheduled_end, customer_notes, address_line1, address_line2, city, state, postal_code,
  technician_id, secondary_technician_id, business_id,
  customer:customers ( name, phone ), service:services ( name ), business:businesses ( name ),
  line_items:booking_line_items ( name, quantity )`;

async function techJobs(db, techId, fromISO, toISO) {
  const { data, error } = await db.from('bookings').select(JOB_COLS)
    .or(`technician_id.eq.${techId},secondary_technician_id.eq.${techId}`)
    .not('status', 'in', '(cancelled,no_show)')
    .gte('scheduled_at', fromISO).lt('scheduled_at', toISO)
    .order('scheduled_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// RFC 5545 text: escape \ ; , and newlines, then fold lines at 75 octets.
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut), 'utf8') > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** The whole feed: 14 days back to 120 days ahead. */
export async function techIcs(db, techId) {
  const { data: tech } = await db.from('technicians').select('id, name, active').eq('id', techId).maybeSingle();
  if (!tech || tech.active === false) return null;
  const now = Date.now();
  const jobs = await techJobs(db, techId, new Date(now - 14 * 86400000).toISOString(), new Date(now + 120 * 86400000).toISOString());
  const stamp = icsTime(now);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Handy Andy//Tech jobs//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText('My jobs')}`, 'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  for (const j of jobs) {
    const start = new Date(j.scheduled_at);
    const end = j.scheduled_end ? new Date(j.scheduled_end) : new Date(start.getTime() + 2 * 3600000);
    const addr = [j.address_line1, j.address_line2, j.city, [j.state, j.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const items = (j.line_items || []).map(li => `${li.quantity > 1 ? li.quantity + '× ' : ''}${li.name}`).filter(Boolean);
    const second = j.secondary_technician_id === techId ? ' (2nd tech)' : '';
    const desc = [
      j.business?.name ? `For ${j.business.name}` : null,
      j.customer?.name ? `Customer: ${j.customer.name}` : null,
      j.customer?.phone ? `Phone: ${j.customer.phone}` : null,
      items.length ? `Job: ${items.slice(0, 8).join('; ')}` : (j.service?.name ? `Job: ${j.service.name}` : null),
      j.customer_notes ? `Notes: ${j.customer_notes}` : null,
      `Open in the app: ${baseUrl()}/tech.html`,
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${j.id}@handy-andy-jobs`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`,
      fold(`SUMMARY:${icsText(`${j.customer?.name || 'Job'}${second}${j.business?.name ? ' · ' + j.business.name : ''}`)}`),
      addr ? fold(`LOCATION:${icsText(addr)}`) : null,
      fold(`DESCRIPTION:${icsText(desc)}`),
      'STATUS:CONFIRMED', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Job coming up', 'TRIGGER:-PT60M', 'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n') + '\r\n';
}

/**
 * Evening text: every active tech with a job tomorrow (in the job's own
 * timezone) gets ONE text listing them. Once per tech per day (tech_sms_log
 * kind 'tomorrow' is the guard), so a re-run never texts twice.
 */
export async function sendTomorrowDigest(db, { dryRun = false } = {}) {
  const now = Date.now();
  // Tomorrow in Denver/Central is inside this window whenever the cron runs
  // in the evening US time; each job is then checked against its own day.
  const jobs = (await db.from('bookings').select(`id, scheduled_at, technician_id, secondary_technician_id, city,
      customer:customers ( name ), business:businesses ( name, timezone ), service_area:service_areas ( timezone )`)
    .not('status', 'in', '(cancelled,no_show,completed)')
    .gte('scheduled_at', new Date(now).toISOString()).lt('scheduled_at', new Date(now + 48 * 3600000).toISOString())
    .order('scheduled_at', { ascending: true })).data || [];
  const byTech = new Map();
  for (const j of jobs) {
    const tz = j.service_area?.timezone || j.business?.timezone || 'America/Denver';
    const day = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
    if (day(j.scheduled_at) !== day(now + 86400000)) continue;   // only TOMORROW, local to the job
    for (const t of [j.technician_id, j.secondary_technician_id].filter(Boolean)) {
      if (!byTech.has(t)) byTech.set(t, []);
      byTech.get(t).push({ ...j, tz });
    }
  }
  const sent = [], skipped = [];
  for (const [techId, list] of byTech) {
    const { data: tech } = await db.from('technicians').select('id, name, phone, active').eq('id', techId).maybeSingle();
    if (!tech || tech.active === false || !tech.phone) { skipped.push({ techId, why: 'no phone / inactive' }); continue; }
    const { data: already } = await db.from('tech_sms_log').select('id').eq('technician_id', techId).eq('kind', 'tomorrow')
      .gte('created_at', new Date(now - 20 * 3600000).toISOString()).limit(1);
    if (already && already.length) { skipped.push({ techId, why: 'already sent' }); continue; }
    const when = (j) => new Date(j.scheduled_at).toLocaleTimeString('en-US', { timeZone: j.tz, hour: 'numeric', minute: '2-digit' });
    const dayName = new Date(list[0].scheduled_at).toLocaleDateString('en-US', { timeZone: list[0].tz, weekday: 'long', month: 'short', day: 'numeric' });
    const rows = list.slice(0, 6).map(j => `• ${when(j)} ${j.customer?.name || 'Customer'}${j.city ? ', ' + j.city : ''}${j.business?.name ? ' (' + j.business.name + ')' : ''}`);
    const msg = `Your jobs tomorrow, ${dayName}:\n${rows.join('\n')}${list.length > 6 ? `\n+${list.length - 6} more` : ''}\nDetails: ${baseUrl()}/tech.html`;
    if (dryRun) { sent.push({ tech: tech.name, jobs: list.length, msg }); continue; }
    const { data: log } = await db.from('tech_sms_log').insert({ technician_id: techId, booking_id: list[0].id, kind: 'tomorrow', status: 'pending', to_phone: tech.phone }).select('id').maybeSingle();
    const statusCallback = log ? `${baseUrl()}/api/analytics?action=sms_status&token=${encodeURIComponent(signToken({ kind: 'tech_sms', tech_sms_log_id: log.id }, 86400))}` : undefined;
    const r = await sendSMSResult(tech.phone, msg, statusCallback ? { statusCallback } : {});
    if (log) await db.from('tech_sms_log').update(r.ok ? { status: 'pending' } : r.skipped ? { status: 'skipped', skip_reason: r.skipped } : { status: 'failed', error: String(r.error || '').slice(0, 500) }).eq('id', log.id);
    (r.ok ? sent : skipped).push({ tech: tech.name, jobs: list.length, ...(r.ok ? {} : { why: r.skipped || r.error }) });
  }
  return { sent, skipped };
}
