// Short "Someone just booked an appointment" heads-up email to the owner.
// Used by the public booking widgets (via mirrorBooking) and by the dashboard
// when a SECRETARY books a job. Best-effort: every send is wrapped so it can
// never block or break a booking. Recipient defaults to contact@ihandyandy.com;
// override with the OWNER_NOTIFY_EMAIL env var.
import { emailConfig, sendEmail } from './email.js';
import { emailNotificationsOn } from './notify.js';

function escHtml(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

export async function sendOwnerBookingAlert(d = {}) {
  try {
    if (!emailNotificationsOn()) return;
    const cfg = emailConfig(d.slug);
    if (!cfg.apiKey) return;

    // Recipients for the per-booking "someone just booked" email:
    //   • The OWNER only when PER_BOOKING_ALERTS=1 (they otherwise get the ONE
    //     8 PM Denver daily digest instead of 10-15 emails/day).
    //   • The business's SECRETARY, ALWAYS — Heather runs Handy Andy, Joey runs
    //     Doms, and they asked to be told on every booking. Emails are per-business
    //     (Heather gets Handy Andy bookings, Joey gets Doms) and override via
    //     HANDY_ANDY_SECRETARY_EMAIL / DOMS_SECRETARY_EMAIL.
    const recipients = new Set();
    if (process.env.PER_BOOKING_ALERTS === '1') {
      recipients.add(process.env.OWNER_NOTIFY_EMAIL || 'contact@ihandyandy.com');
    }
    const slug = String(d.slug || '').toLowerCase();
    if (slug === 'handy-andy') {
      recipients.add(process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
    } else if (slug === 'doms') {
      recipients.add(process.env.DOMS_SECRETARY_EMAIL || 'jyrsbries@gmail.com');   // Joey
    }
    recipients.delete('');
    if (!recipients.size) return;

    const tz = d.timezone || 'America/Denver';
    const money = (n) => '$' + (Number(n) || 0).toFixed(2);

    let when = '';
    if (d.scheduledAt) {
      try {
        const dt = new Date(d.scheduledAt);
        const datePart = dt.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        let timePart = dt.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        if (d.scheduledEnd) timePart += ' – ' + new Date(d.scheduledEnd).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
        when = `${datePart} · ${timePart}`;
      } catch (_) { when = String(d.scheduledAt); }
    } else if (d.timeWindow) { when = d.timeWindow; }

    const c = d.customer || {}, a = d.address || {};
    const addr = [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ');
    const rows = [
      ['Company', d.businessName],
      ['Booked by', d.bookedBy],
      ['Customer', c.name],
      ['Phone', c.phone],
      ['Email', c.email],
      ['Address', addr],
      ['Service', d.serviceName],
      ['When', when],
      ['Technician', d.technicianName || 'Unassigned'],
      ['Total', d.price != null ? money(d.price) : null],
    ].filter(r => r[1]);
    const tbl = rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#111;">${escHtml(String(v))}</td></tr>`).join('');
    const items = (Array.isArray(d.lineItems) ? d.lineItems : []).filter(Boolean)
      .map(li => `<tr><td style="padding:2px 10px 2px 0;">${escHtml(li.name || 'Item')}${(Number(li.quantity) || 1) > 1 ? ` ×${li.quantity}` : ''}</td><td style="padding:2px 0;text-align:right;">${money(li.line_total != null ? li.line_total : li.unit_price)}</td></tr>`).join('');
    const notes = d.customerNotes ? `<p style="margin:14px 0 0;"><b>Customer notes:</b> ${escHtml(d.customerNotes)}</p>` : '';
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 12px;">Someone just booked an appointment.</h2>
      <table style="border-collapse:collapse;">${tbl}</table>
      ${items ? `<h3 style="margin:16px 0 6px;font-size:14px;">Job</h3><table style="border-collapse:collapse;font-size:14px;">${items}</table>` : ''}
      ${notes}
      ${d.bookingId ? `<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">Booking #${escHtml(d.bookingId)}</p>` : ''}
    </div>`;
    for (const to of recipients) {
      await sendEmail({ slug: d.slug, to, subject: 'Someone just booked an appointment', html, replyTo: cfg.from });
    }
  } catch (e) {
    console.warn('[owner-notify] non-fatal:', e.message);
  }
}
