// ============================================================================
// api/_lib/daily-digest.js — one nightly "here's everything booked today" email.
// ----------------------------------------------------------------------------
// Replaces the per-booking "Someone just booked an appointment" alerts (which
// piled up 10-15/day). Sends ONE summary at 8 PM Denver to OWNER_NOTIFY_EMAIL
// listing every appointment BOOKED (created) during the current Denver day
// across all active businesses. Best-effort: never throws.
//
// Scheduling: the GitHub Action fires at 02:00 AND 03:00 UTC daily; this guards
// on "is it 8 PM in Denver right now?" so exactly one run sends, year-round
// (handles the MDT/MST daylight-saving shift). Pass { force:true } to bypass the
// clock (manual test), { dryRun:true } to count without sending.
// ============================================================================
import { serviceClient } from './supabase.js';
import { emailConfig, sendEmail } from './email.js';
import { emailNotificationsOn } from './notify.js';
import { localDayStartUTC } from './time.js';

const DIGEST_TZ = 'America/Denver';

function escHtml(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function denverHour() {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: DIGEST_TZ, hour: '2-digit', hour12: false }).format(new Date())) % 24;
}
function fmtWhen(iso, tz) {
  if (!iso) return 'Unscheduled';
  try {
    const d = new Date(iso);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
    const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
    return `${day} · ${t}`;
  } catch { return String(iso); }
}

export async function sendDailyBookingDigest({ force = false, dryRun = false } = {}) {
  try {
    const hour = denverHour();
    // Which Denver day's digest is due right now? Robust to GitHub-cron delays,
    // which routinely slip an on-time 02:00/03:00 UTC run by hours (that's why an
    // exact "hour === 20" gate silently missed some nights): send tonight's from
    // 8 PM on, and if a run only lands after midnight, still send YESTERDAY's as a
    // catch-up. The Resend idempotency key (below) keys on the evening being
    // summarized, so the extra hourly attempts deliver exactly one email per day.
    let offset;
    if (force) offset = 0;
    else if (hour >= 20) offset = 0;        // this evening (8 PM–midnight Denver)
    else if (hour < 8)   offset = -1;       // overnight — catch up a delayed run
    else return { skipped: `not evening (Denver hour ${hour})`, denverHour: hour };

    if (!emailNotificationsOn()) return { skipped: 'notifications off' };
    const cfg = emailConfig('handy-andy');
    if (!cfg.apiKey) return { skipped: 'no email API key' };
    const to = process.env.OWNER_NOTIFY_EMAIL || 'contact@ihandyandy.com';

    const db = serviceClient();
    const start = localDayStartUTC(DIGEST_TZ, offset);       // 00:00 Denver of the target day
    const end   = localDayStartUTC(DIGEST_TZ, offset + 1);   // 00:00 Denver the next day
    const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: DIGEST_TZ }).format(start); // YYYY-MM-DD of target day

    // Everything BOOKED (created) during today's Denver day, any business, minus
    // cancellations.
    const { data: rows } = await db.from('bookings')
      .select(`id, created_at, scheduled_at, price, status, service_area_id,
               business:businesses ( name, timezone ),
               customer:customers ( name, phone, email ),
               technician:technicians!technician_id ( name ),
               address_line1, city, state, postal_code`)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .neq('status', 'cancelled')
      .order('created_at', { ascending: true });
    const bookings = rows || [];

    if (dryRun) return { would_send: bookings.length, to, denverHour: hour };
    // Nothing booked today → no email (keeps the inbox quiet on slow days).
    if (!bookings.length) return { sent: false, count: 0, reason: 'no new bookings today' };

    // Per-booking metro timezone (Central for Houston/Austin) so the scheduled
    // time reads correctly.
    const areaIds = [...new Set(bookings.map(b => b.service_area_id).filter(Boolean))];
    const tzByArea = {};
    if (areaIds.length) {
      try {
        const { data: areas } = await db.from('service_areas').select('id, timezone').in('id', areaIds);
        for (const a of (areas || [])) tzByArea[a.id] = a.timezone;
      } catch { /* fall back to business tz */ }
    }
    const rowTz = (b) => tzByArea[b.service_area_id] || b.business?.timezone || DIGEST_TZ;

    const money = (n) => '$' + (Number(n) || 0).toFixed(2);
    const total = bookings.reduce((s, b) => s + (Number(b.price) || 0), 0);
    const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: DIGEST_TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(start);

    const rowsHtml = bookings.map(b => {
      const addr = [b.address_line1, b.city, b.state, b.postal_code].filter(Boolean).join(', ');
      return `<tr style="border-top:1px solid #e5e7eb;">
        <td style="padding:9px 12px;vertical-align:top;">
          <div style="font-weight:700;color:#111;">${escHtml(b.customer?.name || 'Customer')}</div>
          <div style="color:#6b7280;font-size:12.5px;">${escHtml(b.business?.name || '')}</div>
          ${addr ? `<div style="color:#9ca3af;font-size:12px;margin-top:2px;">${escHtml(addr)}</div>` : ''}
        </td>
        <td style="padding:9px 12px;vertical-align:top;font-size:13px;color:#111;white-space:nowrap;">${escHtml(fmtWhen(b.scheduled_at, rowTz(b)))}</td>
        <td style="padding:9px 12px;vertical-align:top;font-size:13px;color:#111;white-space:nowrap;">${escHtml(b.customer?.phone || '—')}</td>
        <td style="padding:9px 12px;vertical-align:top;font-size:13px;color:#111;">${escHtml(b.technician?.name || 'Unassigned')}</td>
        <td style="padding:9px 12px;vertical-align:top;text-align:right;font-weight:700;color:#111;white-space:nowrap;">${b.price != null ? money(b.price) : '—'}</td>
      </tr>`;
    }).join('');

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:680px;">
      <h2 style="margin:0 0 2px;">${bookings.length} new appointment${bookings.length === 1 ? '' : 's'} booked today</h2>
      <div style="color:#6b7280;font-size:14px;margin-bottom:16px;">${escHtml(dateLabel)} · daily summary</div>
      <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead><tr style="background:#f9fafb;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;">
          <th style="padding:9px 12px;">Customer</th><th style="padding:9px 12px;">Appointment</th>
          <th style="padding:9px 12px;">Phone</th><th style="padding:9px 12px;">Tech</th>
          <th style="padding:9px 12px;text-align:right;">Total</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <div style="margin-top:14px;font-size:15px;"><b>Total booked value:</b> ${money(total)}</div>
      <div style="margin-top:18px;font-size:12px;color:#9ca3af;">You're getting one summary a day instead of an email per booking. Sent at 8 PM Denver.</div>
    </div>`;

    await sendEmail({
      slug: 'handy-andy', to,
      subject: `Daily booking summary — ${bookings.length} new appointment${bookings.length === 1 ? '' : 's'}`,
      html, replyTo: cfg.from,
      idempotencyKey: `daily-digest-${dayKey}`,   // exactly one delivery per Denver day
    });
    return { sent: true, count: bookings.length, to, dayKey };
  } catch (e) {
    console.warn('[daily-digest] non-fatal:', e.message);
    return { sent: false, error: e.message };
  }
}
