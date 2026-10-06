// Scheduled tech invite texts (owner 2026-10-06, migration 0178).
// Runs on the 10-min tech_late_check cron:
//  1. Texts each pending invite whose send_at has passed and that was never
//     sent, using its custom_message.
//  2. 24h after a text, if they still haven't signed up, puts one red task on
//     the owner's dashboard (assistant_tasks).
import { sendTechSms, inviteLink, smsFailReason } from './tech-invite.js';

const DAY_MS = 864e5;

export async function runScheduledInvites(db, { dryRun = false } = {}) {
  const now = new Date();
  const out = { sent: [], failed: [], nudged: [] };

  const { data: due, error } = await db.from('tech_invites')
    .select('id, code, invitee_name, invitee_phone, custom_message, send_count, business_id, expires_at')
    .eq('status', 'pending').is('sent_at', null).not('send_at', 'is', null)
    .lte('send_at', now.toISOString()).not('invitee_phone', 'is', null);
  if (error) throw error;
  for (const inv of due || []) {
    if (new Date(inv.expires_at) < now) continue;
    const message = inv.custom_message || `Set up your account here: ${inviteLink(inv.code)}`;
    if (dryRun) { out.sent.push(inv.invitee_name); continue; }
    const r = await sendTechSms(db, { kind: 'tech_invite', businessId: inv.business_id, phone: inv.invitee_phone, message });
    const patch = { last_sms_log_id: r.logId || null };
    if (r.ok) { patch.sent_at = now.toISOString(); patch.send_count = (inv.send_count || 0) + 1; }
    else patch.send_at = null;   // don't retry every 10 min; the owner sees the failure on the invite
    await db.from('tech_invites').update(patch).eq('id', inv.id);
    (r.ok ? out.sent : out.failed).push(r.ok ? inv.invitee_name : `${inv.invitee_name}: ${smsFailReason(r)}`);
  }

  const { data: stale, error: sErr } = await db.from('tech_invites')
    .select('id, code, invitee_name, invitee_phone, service_areas ( name ), businesses ( name )')
    .eq('status', 'pending').is('nudged_at', null).not('send_at', 'is', null)
    .lte('sent_at', new Date(now.getTime() - DAY_MS).toISOString());
  if (sErr) throw sErr;
  for (const inv of stale || []) {
    if (dryRun) { out.nudged.push(inv.invitee_name); continue; }
    const where = [inv.businesses?.name, inv.service_areas?.name].filter(Boolean).join(' · ');
    await db.from('assistant_tasks').insert({
      title: `${inv.invitee_name || 'New tech'} hasn't signed up (${where})`,
      color: 'red',
      notes: `Texted 24h ago. Call ${inv.invitee_phone}. Link: ${inviteLink(inv.code)}`,
      created_by: 'System',
    });
    await db.from('tech_invites').update({ nudged_at: now.toISOString() }).eq('id', inv.id);
    out.nudged.push(inv.invitee_name);
  }
  return out;
}
