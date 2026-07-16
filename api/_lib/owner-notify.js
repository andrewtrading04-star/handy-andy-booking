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

// "Card didn't save" alert — fires when a public booking widget captured a
// payment_method_id but it never actually ended up on file (wrong/unset
// Stripe key, a Stripe error, etc.). This is the exact silent-failure class
// that caused a real customer's card to go untracked until a charge attempt
// failed at time of service (the "Annie" incident) — the booking itself
// still succeeds (never blocked on this), but someone needs to know to add
// the card manually before the appointment, not discover it days later.
//
// Unlike sendOwnerBookingAlert, this ALWAYS reaches the owner (not gated on
// PER_BOOKING_ALERTS) — a routine "someone booked" email can wait for the
// daily digest, but a card that silently failed to save needs action before
// the job's scheduled date, and is rare enough not to be noisy.
export async function sendCardSaveFailedAlert(d = {}) {
  try {
    if (!emailNotificationsOn()) return;
    const cfg = emailConfig(d.slug);
    if (!cfg.apiKey) return;

    const recipients = new Set([process.env.OWNER_NOTIFY_EMAIL || 'contact@ihandyandy.com']);
    const slug = String(d.slug || '').toLowerCase();
    if (slug === 'handy-andy') {
      recipients.add(process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
    } else if (slug === 'doms') {
      recipients.add(process.env.DOMS_SECRETARY_EMAIL || 'jyrsbries@gmail.com');   // Joey
    }
    recipients.delete('');
    if (!recipients.size) return;

    const c = d.customer || {};
    const rows = [
      ['Company', d.businessName],
      ['Customer', c.name],
      ['Phone', c.phone],
      ['Email', c.email],
      ['When', d.when],
      ['Reason', d.reason],
    ].filter(r => r[1]);
    const tbl = rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#111;">${escHtml(String(v))}</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 4px;color:#b91c1c;">⚠ A customer's card did not save</h2>
      <p style="margin:0 0 14px;color:#374151;">They entered a card when booking, but it never actually attached — the booking still went through, but there's no card to charge at service time.</p>
      <table style="border-collapse:collapse;">${tbl}</table>
      <p style="margin:16px 0 0;font-size:13px;">Open this booking and use <b>"Change card"</b> to add it before the appointment.</p>
      ${d.bookingId ? `<p style="margin:10px 0 0;font-size:12px;color:#6b7280;">Booking #${escHtml(d.bookingId)}</p>` : ''}
    </div>`;
    for (const to of recipients) {
      await sendEmail({ slug: d.slug, to, subject: `⚠ Card did not save — ${d.customer?.name || 'a customer'}`, html, replyTo: cfg.from });
    }
  } catch (e) {
    console.warn('[owner-notify] non-fatal:', e.message);
  }
}

// "Unrecognized line item" alert — fires when a public booking widget submits
// a line item that matches NEITHER a known service_options catalog price NOR
// one of our own fee/tax/coupon names (see reconcileLinesWithCatalog in
// api/book.js). The booking still goes through at the price submitted — a
// false positive here (a genuine new wording the catalog matcher doesn't
// recognize yet) must never block a real customer — but it's worth a human
// glancing at, since it's also exactly what a tampered/forged line item would
// look like. Always reaches the owner (not gated on PER_BOOKING_ALERTS), same
// urgency class as sendCardSaveFailedAlert.
export async function sendPriceMismatchAlert(d = {}) {
  try {
    if (!emailNotificationsOn()) return;
    const cfg = emailConfig(d.slug);
    if (!cfg.apiKey) return;

    const recipients = new Set([process.env.OWNER_NOTIFY_EMAIL || 'contact@ihandyandy.com']);
    const slug = String(d.slug || '').toLowerCase();
    if (slug === 'handy-andy') {
      recipients.add(process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
    } else if (slug === 'doms') {
      recipients.add(process.env.DOMS_SECRETARY_EMAIL || 'jyrsbries@gmail.com');   // Joey
    }
    recipients.delete('');
    if (!recipients.size) return;

    const c = d.customer || {};
    const money = (n) => '$' + (Number(n) || 0).toFixed(2);
    const rows = [
      ['Company', d.businessName],
      ['Customer', c.name],
      ['Phone', c.phone],
      ['Email', c.email],
    ].filter(r => r[1]);
    const tbl = rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#111;">${escHtml(String(v))}</td></tr>`).join('');
    const items = (Array.isArray(d.lineItems) ? d.lineItems : []).filter(Boolean)
      .map(li => `<tr><td style="padding:2px 10px 2px 0;">${escHtml(li.name || 'Item')}</td><td style="padding:2px 0;text-align:right;">${money(li.line_total != null ? li.line_total : li.unit_price)}</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 4px;color:#b91c1c;">⚠ Unrecognized line item on a new booking</h2>
      <p style="margin:0 0 14px;color:#374151;">One or more line items on this booking didn't match anything in the price catalog — the booking still went through at the price submitted, but it's worth a quick look to confirm it's correct.</p>
      <table style="border-collapse:collapse;">${tbl}</table>
      ${items ? `<h3 style="margin:16px 0 6px;font-size:14px;">Unrecognized item(s)</h3><table style="border-collapse:collapse;font-size:14px;">${items}</table>` : ''}
      ${d.bookingId ? `<p style="margin:16px 0 0;font-size:12px;color:#6b7280;">Booking #${escHtml(d.bookingId)}</p>` : ''}
    </div>`;
    for (const to of recipients) {
      await sendEmail({ slug: d.slug, to, subject: `⚠ Unrecognized line item — ${d.customer?.name || 'a customer'}`, html, replyTo: cfg.from });
    }
  } catch (e) {
    console.warn('[owner-notify] non-fatal:', e.message);
  }
}

// "New estimate request" heads-up email — the ONLY per-request email Heather
// (Handy Andy) / Joey (Doms) get for online activity now; a real booking no
// longer emails them (see mirror.js). Same recipient rule as the booking
// alert (secretary always, owner only when PER_BOOKING_ALERTS=1), same
// override env vars, but its own distinct content — this is a QUOTE request,
// not an appointment, so the email must never claim otherwise.
export async function sendOwnerEstimateAlert(d = {}) {
  try {
    if (!emailNotificationsOn()) return;
    const cfg = emailConfig(d.slug);
    if (!cfg.apiKey) return;

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

    const c = d.customer || {};
    const rows = [
      ['Company', d.businessName],
      ['Customer', c.name],
      ['Phone', c.phone],
      ['Email', c.email],
      ['ZIP', d.zip],
      ['Service', d.serviceLabel],
    ].filter(r => r[1]);
    const tbl = rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#111;">${escHtml(String(v))}</td></tr>`).join('');
    const slotsHtml = (Array.isArray(d.preferredSlots) && d.preferredSlots.length)
      ? `<p style="margin:14px 0 0;"><b>Preferred times:</b> ${escHtml(d.preferredSlots.map(s => s.label || s.slot_key).join(', '))}</p>` : '';
    const photoHtml = d.photoUrl ? `<p style="margin:14px 0 0;"><a href="${escHtml(d.photoUrl)}">View attached photo</a></p>` : '';
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 12px;">New estimate request — not a booking yet.</h2>
      <table style="border-collapse:collapse;">${tbl}</table>
      <p style="margin:14px 0 0;"><b>What they need:</b> ${escHtml(d.description || '')}</p>
      ${slotsHtml}
      ${photoHtml}
      <p style="margin:16px 0 0;font-size:12px;color:#6b7280;">Check the Estimates tab on the dashboard to price it and send an approval link.</p>
    </div>`;
    for (const to of recipients) {
      await sendEmail({ slug: d.slug, to, subject: 'New estimate request', html, replyTo: cfg.from });
    }
  } catch (e) {
    console.warn('[owner-notify] non-fatal:', e.message);
  }
}
