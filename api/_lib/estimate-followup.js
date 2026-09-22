// api/_lib/estimate-followup.js
// Automatic follow-up EMAIL on a sent estimate that got no response.
// Owner rule (2026-09-23): 3 hours after the quote goes out with no approval,
// email the customer the same estimate again under the subject
// "We finished your estimate. Did you see it?". Email only -- never a text.
// One time per estimate, stamped in estimates.followup_emailed_at (migration
// 0131), which is both the idempotency guard and what the card shows as
// "Follow-up email automatically sent".
//
// Driven by the same scheduled trigger as tech-late.js / paid-not-complete.js:
//   GET /api/migrate?action=estimate_followup_check&secret=CRON_SECRET
// (every 10 minutes in vercel.json).
import { serviceClient } from './supabase.js';
import { emailConfig, sendEmail, estimateEmail, brandFor } from './email.js';
import { emailNotificationsOn } from './notify.js';
import { signToken } from './auth.js';

const HOUR = 3600000;
export const FOLLOWUP_EMAIL_AFTER_MS = 3 * HOUR;
// Don't chase quotes that were already old when this shipped, or that have
// gone stale -- a 5-day-old estimate getting a "did you see it?" reads as spam.
const LOOKBACK_MS = 3 * 24 * HOUR;
const STARTS_AT = Date.parse('2026-09-22T00:00:00-06:00'); // same clean-slate line as the Follow up tab

export async function checkEstimateFollowups(opts = {}) {
  const dryRun = !!opts.dryRun;
  const db = serviceClient();
  const now = Date.now();
  const summary = { checked: 0, sent: 0, skipped: 0, errors: 0, details: [] };
  if (!emailNotificationsOn()) { summary.details.push('email notifications off'); return summary; }

  const { data: rows, error } = await db.from('estimates')
    .select('id, business_id, customer_name, customer_email, service_label, description, customer_note, line_items, tax_rate, upsells, status, approved_at, emailed_at, texted_at, contacted_at, followup_emailed_at, business:businesses(slug)')
    .eq('status', 'contacted').is('approved_at', null).is('followup_emailed_at', null)
    .not('customer_email', 'is', null)
    .gte('contacted_at', new Date(Math.max(STARTS_AT, now - LOOKBACK_MS)).toISOString())
    .limit(200);
  if (error) throw new Error(`estimates query failed: ${error.message}`);

  const ms = (t) => (t ? Date.parse(t) : 0) || 0;
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

  for (const e of (rows || [])) {
    summary.checked++;
    // "Sent" = the latest send on any channel. 3h from THAT, so a resend
    // pushes the follow-up out rather than firing on top of it.
    const sentAt = Math.max(ms(e.contacted_at), ms(e.texted_at), ms(e.emailed_at));
    if (!sentAt || sentAt > now - FOLLOWUP_EMAIL_AFTER_MS) { summary.skipped++; continue; }
    const slug = e.business && e.business.slug;
    if (!slug || !emailConfig(slug).apiKey) { summary.skipped++; continue; }
    if (!String(e.customer_email).includes('@')) { summary.skipped++; continue; }

    if (dryRun) { summary.details.push({ id: e.id, customer: e.customer_name, email: e.customer_email, sent_at: new Date(sentAt).toISOString() }); continue; }

    // Claim the row FIRST (only if still unstamped) so two overlapping cron
    // runs can't both email the same customer. If the send then fails, clear
    // the stamp so the next run retries.
    const stamp = new Date().toISOString();
    const { data: claimed, error: claimErr } = await db.from('estimates')
      .update({ followup_emailed_at: stamp }).eq('id', e.id).is('followup_emailed_at', null).select('id');
    if (claimErr) { summary.errors++; console.error('[estimate_followup] claim failed', e.id, claimErr.message); continue; }
    if (!claimed || !claimed.length) { summary.skipped++; continue; }

    try {
      const firstName = (e.customer_name || '').trim().split(/\s+/)[0];
      const approveToken = signToken({ kind: 'estimate_approve', estimate_id: e.id }, 7776000); // 90 days, same as the original
      const approveUrl = baseUrl ? `${baseUrl}/estimate-approve.html?token=${encodeURIComponent(approveToken)}&via=email` : '';
      const upsells = (Array.isArray(e.upsells) ? e.upsells : []).map(u => ({
        id: u.id, description: u.description, qty: u.qty, unit_price: u.unit_price,
        badge: u.badge || '', blurb: u.blurb || '', default_on: !!u.default_on,
      }));
      const { subject, html } = estimateEmail(
        { firstName, serviceLabel: e.service_label, description: e.description, customerNote: e.customer_note,
          lineItems: e.line_items, taxRate: e.tax_rate, approveUrl, upsells, followUp: true },
        brandFor(slug)
      );
      await sendEmail({ slug, to: e.customer_email, subject, html, throwOnError: true, idempotencyKey: `est-followup-${e.id}` });
      summary.sent++;
      summary.details.push({ id: e.id, customer: e.customer_name, email: e.customer_email });
    } catch (err) {
      summary.errors++;
      console.error('[estimate_followup] send failed, unstamping for retry', e.id, err.message);
      await db.from('estimates').update({ followup_emailed_at: null }).eq('id', e.id);
    }
  }
  return summary;
}
