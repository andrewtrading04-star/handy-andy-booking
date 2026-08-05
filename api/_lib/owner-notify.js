// Short "Someone just booked an appointment" heads-up email to the owner.
// Used by the public booking widgets (via mirrorBooking) and by the dashboard
// when a SECRETARY books a job. Best-effort: every send is wrapped so it can
// never block or break a booking. Recipient defaults to contact@ihandyandy.com;
// override with the OWNER_NOTIFY_EMAIL env var.
import { emailConfig, sendEmail } from './email.js';
import { emailNotificationsOn } from './notify.js';
import { sendSMS } from './sms.js';
import { computeJobPay } from './payroll.js';
import { signToken } from './auth.js';

// ── Big-bracket-job SMS alert ────────────────────────────────────────────────
// The owner wants a text whenever a single booked ticket carries 4+ brackets
// (a big multi-TV job worth eyeballing for stock and staffing). Counts bracket
// line items by name; "I have my own bracket" is the customer's own hardware,
// so it never counts. Shared by the public widget bookings (api/book.js) and
// the dashboard's manual booking_create (api/admin.js).
const BIG_BRACKET_ALERT_PHONE = process.env.BIG_BRACKET_ALERT_PHONE || '3374997817';
const BIG_BRACKET_THRESHOLD = 4;
export function bracketCountFromLines(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((n, l) => {
    const name = String(l.name || l.label || '');
    if (/i have my own bracket/i.test(name)) return n;
    const isBracket = /\bbracket\b/i.test(name)
      || /^flat$/i.test(name.trim())
      || /^tilting/i.test(name.trim())
      || /^full motion/i.test(name.trim());
    return isBracket ? n + (Number(l.quantity ?? l.qty) || 1) : n;
  }, 0);
}
export function maybeSendBigBracketAlert({ lines, customerName, whenStr }) {
  try {
    const count = bracketCountFromLines(lines);
    if (count < BIG_BRACKET_THRESHOLD) return;
    const msg = `Attention: job with ${customerName || 'a customer'} has ${count} brackets on it. It is scheduled for ${whenStr || 'an upcoming date'}.`;
    sendSMS(BIG_BRACKET_ALERT_PHONE, msg).catch(e => console.warn('[big-bracket] alert SMS failed:', e.message));
  } catch (e) { console.warn('[big-bracket] alert error:', e.message); }
}

// ── One-time "first ever use" SMS alerts ────────────────────────────────────
// Fires an SMS exactly once, ever, no matter how many serverless cold-starts
// or duplicate calls happen afterward — claimed atomically via a primary-key
// insert into system_flags (migration 0074). If two bookings somehow trigger
// this in the same instant, only the one that wins the insert sends the text.
async function claimOnce(db, key) {
  const { error } = await db.from('system_flags').insert({ key, value: { at: new Date().toISOString() } });
  return !error; // true only for whoever actually inserted the row first
}

const MULTI_TV_DISCOUNT_ALERT_PHONE = process.env.BIG_BRACKET_ALERT_PHONE || '3374997817';
export async function maybeSendFirstMultiTvDiscountAlert(db, { discountAmt, customerName, whenStr }) {
  try {
    if (!discountAmt || discountAmt <= 0) return;
    const first = await claimOnce(db, 'multi_tv_discount_first_used');
    if (!first) return; // already notified once before — never again
    const msg = `Heads up: the multi-TV discount was just used for the first time — ${customerName || 'a customer'}'s job (scheduled ${whenStr || 'soon'}) saved $${discountAmt.toFixed(2)}.`;
    sendSMS(MULTI_TV_DISCOUNT_ALERT_PHONE, msg).catch(e => console.warn('[multi-tv-discount] alert SMS failed:', e.message));
  } catch (e) { console.warn('[multi-tv-discount] alert error:', e.message); }
}

// ── $0 non-GDS / low-profit SMS alert ──────────────────────────────────────
// The owner wants a text the moment a job books in that's either priced at $0
// without being a real Guaranteed Dismount Service (a likely mis-priced or
// bare ticket), or whose estimated profit (price minus estimated tech payout)
// comes in under $20 — including negative. Detected the same way tech.js's
// isDismountLi does (pattern match, not an exact string, so a category prefix
// or wording variant is still caught). Profit is an ESTIMATE at booking time:
// computeJobPay only pays out on a *completed* job, so this runs the real
// rate table against a synthetic "already completed & paid" copy of the job
// just to price it out — never touches or reads the real booking's status.
const GDS_ALERT_RE = /guarante\w*\s+dismount|dismount\s+service|\btv removal\b/i;
export function linesHaveGds(lines) {
  return (Array.isArray(lines) ? lines : []).some(l => GDS_ALERT_RE.test(String((l && (l.name || l.label)) || '')));
}

// ── "Want to upgrade?" GDS upsell link for the confirmation email ──────────
// Returns null when the job already has GDS, isn't eligible (not a TV
// mounting job), or there's no base URL to build an absolute link from —
// bookingConfirmationEmail simply omits the block in any of those cases.
// The 90-day token mirrors the estimate-approve link's TTL/shape.
export function gdsUpsellUrlFor({ lines, bookingId, baseUrl, eligible = true }) {
  if (!eligible || !bookingId || !baseUrl) return null;
  if (linesHaveGds(lines)) return null;
  const token = signToken({ kind: 'add_gds', booking_id: bookingId }, 7776000);
  return `${String(baseUrl).replace(/\/$/, '')}/add-gds.html?token=${token}`;
}

// ── Self-serve reschedule link for the confirmation email ──────────────────
// Signed link to /reschedule.html (kind=reschedule, booking_id) -- mirrors the
// GDS upsell/estimate-approve tokens' shape and 90-day TTL. The page itself
// (api/admin.js reschedule_info/reschedule_submit) is what actually enforces
// the 24-hour cutoff and blocks a completed/cancelled booking -- this helper
// just builds the link, so it's safe to always include on every confirmation.
export function rescheduleUrlFor({ bookingId, baseUrl }) {
  if (!bookingId || !baseUrl) return null;
  const token = signToken({ kind: 'reschedule', booking_id: bookingId }, 7776000);
  return `${String(baseUrl).replace(/\/$/, '')}/reschedule.html?token=${token}`;
}
export function estimateJobProfit({ price, lines, techName, scheduled_at }) {
  try {
    const synthetic = {
      status: 'completed', payment_status: 'paid',
      price, subtotal: price, amount_paid: price,
      line_items: Array.isArray(lines) ? lines : [],
      scheduled_at,
    };
    const result = computeJobPay(synthetic, techName || '');
    return (Number(price) || 0) - (Number(result.pay) || 0);
  } catch (e) { console.warn('[low-profit] estimate error:', e.message); return null; }
}
export function maybeSendZeroOrLowProfitAlert({ price, lines, techName, customerName, whenStr, scheduled_at }) {
  try {
    const phone = process.env.OWNER_PHONE_NUMBER;
    if (!phone) return;
    const p = Number(price) || 0;
    const isGds = linesHaveGds(lines);
    if (p === 0 && !isGds) {
      const msg = `Heads up: ${customerName || 'a customer'}'s job (${whenStr || 'scheduled'}) was booked at $0 and is NOT Guaranteed Dismount Service — worth checking it's priced correctly.`;
      sendSMS(phone, msg).catch(e => console.warn('[zero-profit] alert SMS failed:', e.message));
      return; // one heads-up per job — don't also fire the low-profit text below
    }
    // A real GDS job is SUPPOSED to run negative every time -- $0 to the
    // customer, $60 out to the tech, by design (a free-redo goodwill service).
    // Without this it tripped the low-profit alert on literally every GDS job,
    // paging the owner for something that was never a problem (Dalton Chapa's
    // job, Jul 2026 -- "nothing is wrong, this is a normal thing").
    if (isGds) return;
    const profit = estimateJobProfit({ price, lines, techName, scheduled_at });
    if (profit != null && profit < 20) {
      const msg = `Heads up: ${customerName || 'a customer'}'s job (${whenStr || 'scheduled'}) has an estimated profit of $${profit.toFixed(2)} — under $20.`;
      sendSMS(phone, msg).catch(e => console.warn('[low-profit] alert SMS failed:', e.message));
    }
  } catch (e) { console.warn('[zero/low-profit] alert error:', e.message); }
}

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
    if (slug === 'handy-andy' || slug === 'mile-high') {
      // Heather runs both -- same Denver market, same techs (see PARTNER_SLUG
      // in availability.js). MILE_HIGH_SECRETARY_EMAIL overrides independently
      // if that ever needs to change without touching Handy Andy's routing.
      recipients.add(process.env.MILE_HIGH_SECRETARY_EMAIL || process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
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
    if (slug === 'handy-andy' || slug === 'mile-high') {
      // Heather runs both -- same Denver market, same techs (see PARTNER_SLUG
      // in availability.js). MILE_HIGH_SECRETARY_EMAIL overrides independently
      // if that ever needs to change without touching Handy Andy's routing.
      recipients.add(process.env.MILE_HIGH_SECRETARY_EMAIL || process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
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

// A customer told Joey on the follow-up call that something went wrong. This is
// the ONLY way that ever reaches the owner: the complaint is typed into the
// review-call card and would otherwise sit in a column nobody opens until the
// customer has already left a public one-star review. Texts immediately (these
// are time-sensitive: the window to fix it quietly is hours, not days) and
// emails the detail, since a complaint rarely fits in an SMS.
export async function sendReviewCallComplaintAlert(d = {}) {
  // The text goes out even when email is switched off or unconfigured — the two
  // channels fail independently on purpose, so a mail problem cannot swallow the
  // only signal the owner gets that a job went badly.
  try {
    const phone = process.env.OWNER_PHONE_NUMBER;
    if (phone) {
      const who = d.customerName || 'A customer';
      const note = String(d.note || '').replace(/\s+/g, ' ').trim();
      const msg = `Complaint from ${who} (${d.businessName || 'job'}${d.techName ? `, tech ${d.techName}` : ''})`
        + `${note ? `: "${note.slice(0, 220)}"` : '.'}`
        + ` Logged by ${d.loggedBy || 'the office'} on the review call.`;
      await sendSMS(phone, msg).catch(e => console.warn('[review-complaint] SMS failed:', e.message));
    }
  } catch (e) { console.warn('[review-complaint] SMS error:', e.message); }

  try {
    if (!emailNotificationsOn()) return;
    const cfg = emailConfig(d.slug);
    if (!cfg.apiKey) return;
    const recipients = new Set([process.env.OWNER_NOTIFY_EMAIL || 'contact@ihandyandy.com']);
    recipients.delete('');
    if (!recipients.size) return;

    const rows = [
      ['Company', d.businessName],
      ['Customer', d.customerName],
      ['Phone', d.phone],
      ['Email', d.email],
      ['Job', d.serviceName],
      ['Technician', d.techName],
      ['Job date', d.whenStr],
      ['Logged by', d.loggedBy],
      ['What they said', (d.tags || []).join(', ')],
    ].filter(r => r[1]);
    const tbl = rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top;">${k}</td><td style="padding:3px 0;color:#111;">${escHtml(String(v))}</td></tr>`).join('');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#111;line-height:1.5;">
      <h2 style="margin:0 0 4px;color:#b91c1c;">⚠ A customer said something went wrong</h2>
      <p style="margin:0 0 14px;color:#374151;">This came up on the follow-up call, so they have told us before telling the internet. No review request was sent.</p>
      ${d.note ? `<blockquote style="margin:0 0 14px;padding:11px 14px;background:#fef2f2;border-left:4px solid #b91c1c;border-radius:6px;color:#7f1d1d;">${escHtml(String(d.note))}</blockquote>` : ''}
      <table style="border-collapse:collapse;">${tbl}</table>
      ${d.bookingId ? `<p style="margin:14px 0 0;font-size:12px;color:#6b7280;">Booking #${escHtml(d.bookingId)}</p>` : ''}
    </div>`;
    for (const to of recipients) {
      await sendEmail({ slug: d.slug, to, subject: `⚠ Complaint on the review call — ${d.customerName || 'a customer'}`, html, replyTo: cfg.from });
    }
  } catch (e) {
    console.warn('[review-complaint] non-fatal:', e.message);
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
    if (slug === 'handy-andy' || slug === 'mile-high') {
      // Heather runs both -- same Denver market, same techs (see PARTNER_SLUG
      // in availability.js). MILE_HIGH_SECRETARY_EMAIL overrides independently
      // if that ever needs to change without touching Handy Andy's routing.
      recipients.add(process.env.MILE_HIGH_SECRETARY_EMAIL || process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
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
    if (slug === 'handy-andy' || slug === 'mile-high') {
      // Heather runs both -- same Denver market, same techs (see PARTNER_SLUG
      // in availability.js). MILE_HIGH_SECRETARY_EMAIL overrides independently
      // if that ever needs to change without touching Handy Andy's routing.
      recipients.add(process.env.MILE_HIGH_SECRETARY_EMAIL || process.env.HANDY_ANDY_SECRETARY_EMAIL || 'heather.handyandy@gmail.com');
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
