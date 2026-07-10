// api/_lib/email.js
// Shared transactional-email helpers (Resend) used by the booking, estimate and
// review flows for BOTH businesses. Centralizes the per-business Resend config,
// a low-level send wrapper (gated by the notifications master switch), and the
// branded booking-confirmation template.
import { emailNotificationsOn } from './notify.js';
import { demoMode } from './demo.js';

// ── Per-business Resend config ──────────────────────────────────────────────
// Each business may use its own Resend account — the free tier allows one
// verified domain per account, so Doms gets its own key + domain without forcing
// the shared account onto a paid plan. When DOMS_RESEND_API_KEY is unset (e.g.
// both domains live on one paid account) Doms transparently falls back to the
// shared RESEND_API_KEY. Handy Andy's behavior is unchanged.
export function emailConfig(slug) {
  if (slug === 'doms') {
    return {
      apiKey: process.env.DOMS_RESEND_API_KEY || process.env.RESEND_API_KEY,
      from:   process.env.DOMS_EMAIL_FROM || 'contact@domstvmounting.com',
    };
  }
  return {
    apiKey: process.env.RESEND_API_KEY,
    from:   process.env.HANDY_ANDY_EMAIL_FROM || 'contact@ihandyandy.com',
  };
}

// Brand presets for customer-facing emails. Colors match the booking widgets and
// admin dashboard: Handy Andy = orange, Doms = blue.
export const EMAIL_BRANDS = {
  'handy-andy': { slug: 'handy-andy', name: 'Handy Andy',          accent: '#FF6B35', website: 'ihandyandy.com', heightCalc: 'https://www.ihandyandy.com/tv-height-calculator' },
  'doms':       { slug: 'doms',       name: "Dom's TV Mounting",   accent: '#2563EB', website: 'domstvmounting.com' },
};
export function brandFor(slug) { return EMAIL_BRANDS[slug] || EMAIL_BRANDS['handy-andy']; }

// ── Low-level send ──────────────────────────────────────────────────────────
// Returns { sent, skipped?, id?, error? } and never throws unless throwOnError.
// `emailNotificationsOn()` is the email kill switch — while it is off, sends are
// skipped (and logged) so nothing goes out before the accounts are approved.
export async function sendEmail({ slug, to, subject, html, replyTo, throwOnError = false, idempotencyKey = null }) {
  // Demo mode: pretend the email went out (no Resend call, nothing delivered).
  if (demoMode()) {
    console.log(`[email:demo] pretend-sent "${subject}" to ${to}`);
    return { sent: true, id: 'demo_email', demo: true };
  }
  if (!emailNotificationsOn()) {
    console.log(`[email] notifications off; not sending "${subject}" to ${to}`);
    return { sent: false, skipped: 'notifications_off' };
  }
  if (!to) return { sent: false, skipped: 'no_recipient' };
  const { apiKey, from } = emailConfig(slug);
  if (!apiKey) {
    console.warn(`[email] no Resend key for "${slug}"; not sending "${subject}"`);
    return { sent: false, skipped: 'no_api_key' };
  }

  const payload = { from, to, subject, html };
  if (replyTo) payload.reply_to = replyTo;

  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  // Resend dedupes POSTs that carry the same Idempotency-Key for 24h — so a job
  // that legitimately fires more than once (e.g. a delay-tolerant hourly cron)
  // delivers exactly one email.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);

  try {
    // Hard 8s cap on the Resend call. Without it, a stalled connection hangs the
    // whole serverless response — booking creation awaits these sends AFTER the
    // booking row exists, so an unbounded email fetch = the office UI stuck on
    // "Processing…" for a booking that actually succeeded. 8s is far above
    // Resend's normal latency; on abort the caller gets { sent:false, error }.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const msg = `Resend ${res.status}: ${errText.slice(0, 400)}`;
      if (throwOnError) throw new Error(msg);
      console.error('[email]', msg);
      return { sent: false, error: msg };
    }
    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data.id || null };
  } catch (e) {
    if (throwOnError) throw e;
    console.error('[email] send failed:', e.message);
    return { sent: false, error: e.message };
  }
}

// ── Helpers (pure) ──────────────────────────────────────────────────────────
function money(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// Parse a #rrggbb hex into "r, g, b" for use in rgba() tints.
function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '17, 24, 28';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
// Lighten (amt > 0) or darken (amt < 0) a hex color toward white/black.
function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const t = amt < 0 ? 0 : 255;
    return Math.round((t - v) * Math.abs(amt) + v);
  });
  return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join('');
}

// Tidy a line-item label for the customer receipt: drop the option-group prefix
// ("TV Size:", "Bracket:", "Fireplace:", "Wall Surface:", …) so it reads as the
// bare option, and shorten "Guaranteed Dismount Service" to "GDS".
function cleanLineLabel(name) {
  const s = String(name || '');
  if (/guaranteed\s+dismount/i.test(s)) return 'GDS';
  const i = s.indexOf(':');
  let out = (i > -1 ? s.slice(i + 1) : s).trim() || s;
  // Drop a trailing "×3" baked into the label — the qty renders separately. Only
  // the × sign counts (not a letter "x", e.g. "4 x 6" dimensions).
  out = out.replace(/\s*[×✕✖]\s*\d+\s*$/, '').trim() || out;
  return out;
}
// The default "TV Type: Regular TV" line is noise on the receipt — hide it.
// Frame and other non-default TV types still show.
function isDefaultTypeLabel(name) { return /^\s*tv\s*type\s*:\s*regular\b/i.test(String(name || '')); }

// ── Branded booking-confirmation email ──────────────────────────────────────
// `details` mirrors the booking summary the widget shows on the thank-you page:
//   firstName, dateLong, timeWindow, serviceName,
//   address: { line1, city, state, zip },
//   lines: [{ label, qty, amount }]   (optional — price block hidden if absent)
//   total, tip, twoTechs, jobId
// Returns { subject, html }.
export function bookingConfirmationEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const accent = b.accent;
  const rgb = hexRgb(accent);                  // "r, g, b" for tinted icon chips
  const firstName = (details.firstName || '').trim();
  const a = details.address || {};
  const addressLine = [a.line1, [a.city, a.state].filter(Boolean).join(', '), a.zip]
    .filter(Boolean).join(', ');

  const row = (label, val) => !val ? '' : `
        <tr>
          <td style="padding:9px 16px;font-size:13px;color:#6b7280;width:118px;vertical-align:top;">${esc(label)}</td>
          <td style="padding:9px 16px;font-size:14px;color:#11181c;font-weight:600;vertical-align:top;">${esc(val)}</td>
        </tr>`;

  const detailRows =
    row('Date', details.dateLong) +
    row('Arrival window', details.timeWindow) +
    row('Service', details.serviceName || 'TV Installation') +
    row('Your technician', details.technicianName) +
    row('Address', addressLine);

  // Price block — only rendered when the widget supplied line items + a total, so
  // we never show a guessed number. Mirrors the thank-you page (tip is separate;
  // no tax line, to stay consistent with what the customer saw on screen).
  let priceBlock = '';
  const lines = Array.isArray(details.lines) ? details.lines.filter(li => li && li.amount != null && !isDefaultTypeLabel(li.label)) : [];
  if (lines.length && details.total != null) {
    const lineRows = lines.map(li => `
          <tr>
            <td style="padding:7px 0;font-size:14px;color:#374151;">${esc(cleanLineLabel(li.label))}${Number(li.qty) > 1 ? ` &times; ${Number(li.qty)}` : ''}</td>
            <td align="right" style="padding:7px 0;font-size:14px;color:#374151;white-space:nowrap;">${money(li.amount)}</td>
          </tr>`).join('');
    const tipRow = Number(details.tip) > 0 ? `
          <tr>
            <td style="padding:7px 0;font-size:14px;color:#374151;">Tip for technician</td>
            <td align="right" style="padding:7px 0;font-size:14px;color:#374151;white-space:nowrap;">${money(details.tip)}</td>
          </tr>` : '';
    const grand = (Number(details.total) || 0) + (Number(details.tip) || 0);
    priceBlock = `
      <tr><td style="padding:6px 28px 0;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#9ca3af;margin:14px 0 4px;">Summary</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${lineRows}${tipRow}
          <tr><td colspan="2" style="border-top:1px solid #eceef1;padding-top:0;"></td></tr>
          <tr>
            <td style="padding:10px 0 0;font-size:16px;font-weight:800;color:#11181c;">Total</td>
            <td align="right" style="padding:10px 0 0;font-size:16px;font-weight:800;color:${accent};white-space:nowrap;">${money(grand)}</td>
          </tr>
        </table>
      </td></tr>`;
  }

  const twoTechNote = details.twoTechs ? `
      <tr><td style="padding:14px 28px 0;">
        <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px 14px;font-size:13px;color:#9a3412;line-height:1.5;">
          <strong>Two technicians</strong> are scheduled for this job to safely handle the larger TV.
        </div>
      </td></tr>` : '';

  // ── "Add to calendar" buttons (Google + Apple) ──────────────────────────────
  // Rendered only when the caller passes machine-readable start/end epochs (sec).
  // Google uses its render URL (pre-fills the event); Apple downloads an .ics from
  // our own /api/calendar endpoint so a tap opens the native add-to-calendar sheet.
  let calendarBlock = '';
  const startSec = Number(details.startEpoch), endSec = Number(details.endEpoch);
  if (startSec && endSec) {
    const stamp = (sec) => {
      const d = new Date(sec * 1000);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
    };
    const calTitle = `${b.name} - ${details.serviceName || 'TV Installation'}`;
    const calLoc   = addressLine;
    const calDesc  = `Your ${b.name} appointment${details.timeWindow ? ` (arrival window ${details.timeWindow})` : ''}. Reply to your confirmation email with any questions.`;
    const gcal = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + `&text=${encodeURIComponent(calTitle)}`
      + `&dates=${stamp(startSec)}/${stamp(endSec)}`
      + `&details=${encodeURIComponent(calDesc)}`
      + `&location=${encodeURIComponent(calLoc)}`;
    const base = String(details.baseUrl || '').replace(/\/$/, '');
    const icsUrl = `${base}/api/book?action=ics&title=${encodeURIComponent(calTitle)}&start=${startSec}&end=${endSec}`
      + `&location=${encodeURIComponent(calLoc)}&details=${encodeURIComponent(calDesc)}`;
    // Outlook (web) deep-link — prefills a new event. Works without a base URL.
    const isoStamp = (sec) => new Date(sec * 1000).toISOString();
    const outlook = 'https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent'
      + `&subject=${encodeURIComponent(calTitle)}`
      + `&startdt=${encodeURIComponent(isoStamp(startSec))}`
      + `&enddt=${encodeURIComponent(isoStamp(endSec))}`
      + `&body=${encodeURIComponent(calDesc)}`
      + `&location=${encodeURIComponent(calLoc)}`;

    // Provider logos: served from Google's stable favicon CDN so the recipient's
    // mail client renders the real Google / Outlook / Apple marks. If a client
    // blocks images, each row still reads as plain text (the provider name).
    const favicon = (domain) => `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
    const calRow = (href, iconUrl, label, first) => `
            <a href="${esc(href)}" style="display:block;text-decoration:none;${first ? '' : 'border-top:1px solid #eef0f2;'}">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td width="44" valign="middle" style="padding:15px 0 15px 18px;"><img src="${esc(iconUrl)}" width="26" height="26" alt="" style="display:block;border:0;"></td>
                <td valign="middle" style="padding:15px 18px 15px 12px;font-size:16px;font-weight:600;color:#11181c;">${label}</td>
              </tr></table>
            </a>`;
    const rows = [
      calRow(gcal, favicon('calendar.google.com'), 'Google Calendar', true),
      calRow(outlook, favicon('outlook.com'), 'Outlook Calendar', false),
    ];
    // Apple row only when we have an absolute base URL to serve the .ics from.
    if (base) rows.push(calRow(icsUrl, favicon('apple.com'), 'Apple Calendar', false));

    calendarBlock = `
      <tr><td style="padding:24px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="padding-bottom:12px;">
            <span style="display:inline-block;border:1px solid #e5e7eb;border-radius:999px;padding:12px 26px;font-size:16px;font-weight:600;color:#11181c;">&#128197;&nbsp;&nbsp;Add to Calendar</span>
          </td></tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e9ebee;border-radius:16px;">
          <tr><td>${rows.join('')}</td></tr>
        </table>
      </td></tr>`;
  }

  // ── "Meet your tech" — a photo + short intro for the assigned technician.
  // Only renders when BOTH a name and a photo are on file (set from the
  // Technicians tab in the dashboard) — a tech with neither configured yet
  // simply never shows this block, so nothing looks broken or half-filled.
  // Bio text: a custom blurb wins; otherwise a sentence built from bio_years;
  // otherwise a generic line that still reads as intentional.
  let meetTechBlock = '';
  if (details.technicianName && details.technicianPhotoUrl) {
    const techName = esc(details.technicianName);
    let bioText;
    if (details.technicianBioBlurb) {
      bioText = esc(details.technicianBioBlurb);
    } else if (Number(details.technicianBioYears) > 0) {
      bioText = `${techName} has been doing this for over ${Number(details.technicianBioYears)} years, so you're in good hands.`;
    } else {
      bioText = `${techName} is your installer for this job.`;
    }
    meetTechBlock = `
      <tr><td style="padding:20px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #eceef1;border-radius:16px;">
          <tr>
            <td width="148" valign="top" style="padding:18px 0 18px 18px;">
              <img src="${esc(details.technicianPhotoUrl)}" width="130" height="130" alt="${techName}" style="display:block;width:130px;height:130px;border-radius:20px;object-fit:cover;">
            </td>
            <td valign="top" style="padding:18px 18px 18px 14px;">
              <div style="margin:0 0 7px;">
                <span style="font-size:16.5px;font-weight:800;color:#11181c;">${techName}</span>
                <span style="display:inline-block;margin-left:8px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#a1490f;background:#ffe4cf;padding:3px 9px;border-radius:100px;vertical-align:middle;">Lead installer</span>
              </div>
              <div style="font-size:14px;color:#4b5563;line-height:1.6;">${bioText}</div>
            </td>
          </tr>
        </table>
      </td></tr>`;
  }

  // ── "What to expect" — appointment-day guidance, shown as icon cards ─────────
  // Reusable inline-style snippets keep the markup email-client safe.
  const para = 'font-size:13.5px;color:#4b5563;line-height:1.62;margin:0;';
  const ul   = 'margin:2px 0 0;padding-left:18px;color:#4b5563;font-size:13.5px;line-height:1.6;';
  const li   = 'margin:5px 0;';
  // Brand-specific height-calculator button (only brands that have a page).
  const heightCalcBtn = b.heightCalc ? `
            <a href="${esc(b.heightCalc)}" style="display:inline-block;margin:12px 0 2px;background:${accent};color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 16px;border-radius:8px;">TV Mounting Height Calculator &rarr;</a>` : '';

  // One guidance topic rendered as an icon chip + content card.
  const card = (icon, title, bodyHtml) => `
      <tr><td style="padding:10px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #eceef1;border-radius:14px;">
          <tr>
            <td width="54" valign="top" style="padding:16px 0 16px 16px;">
              <div style="width:38px;height:38px;border-radius:10px;background:rgba(${rgb},0.10);text-align:center;font-size:19px;line-height:38px;">${icon}</div>
            </td>
            <td valign="top" style="padding:16px 16px 16px 12px;">
              <div style="font-size:14.5px;font-weight:800;color:#11181c;margin:0 0 6px;">${title}</div>
              ${bodyHtml}
            </td>
          </tr>
        </table>
      </td></tr>`;

  const expectBlock = `
      <tr><td style="padding:28px 28px 4px;">
        <div style="border-top:1px solid #eef0f2;padding-top:26px;">
          <div style="font-size:18px;font-weight:800;color:#11181c;margin:0 0 4px;">What to expect from your installation</div>
          <div style="font-size:13.5px;color:#6b7280;line-height:1.6;">Here is some critical information you'll need for your appointment.</div>
        </div>
      </td></tr>
      ${card('&#128208;', 'TV mounting height', `
              <div style="${para}">During the installation, our skilled technician will give input on the optimal height for mounting your TV. Once the technician leaves your home, there is a charge if they need to return to adjust the TV's position (moving it up or down) &mdash; so please make sure the TV is placed exactly where you want it, and that you're happy with the bracket choice, before the technician leaves.</div>
              <div style="${para}margin-top:8px;">For extra guidance, we've put together a helpful tool for finding the ideal TV height. You can always talk it over with your technician for a professional opinion.</div>
              ${heightCalcBtn}`)}
      ${card('&#128276;', 'On-the-way notification', `
              <ul style="${ul}">
                <li style="${li}">Once your technician is en route, you'll get an "on-the-way" text message.</li>
                <li style="${li}">This typically arrives within 30 to 60 minutes of your scheduled time.</li>
                <li style="${li}">Your technician will arrive within the 2-hour window of your appointment time.</li>
              </ul>`)}
      ${card('&#128179;', 'Payment', `
              <ul style="${ul}">
                <li style="${li}">Payment is processed after the job is successfully completed by your technician.</li>
                <li style="${li}">Your technician will have a card reader on hand for your convenience.</li>
                <li style="${li}">If you'd like to show your appreciation, our technicians receive 100% of tips!</li>
              </ul>`)}
      ${card('&#9993;', 'Updates &amp; reminders', `
              <div style="${para}">Keep an eye on your email for important updates and reminders about your appointment.</div>`)}
      ${card('&#128197;', 'Cancellation &amp; rescheduling', `
              <ul style="${ul}">
                <li style="${li}">You can cancel or reschedule any time, as long as it's not within 24 hours of your scheduled time.</li>
                <li style="${li}">To make changes, just reply to this email or give us a call and we'll take care of it.</li>
                <li style="${li}">Cancellations or last-minute rescheduling within 24 hours incur an automatic $50 charge.</li>
              </ul>`)}
      <tr><td style="padding:14px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;">
          <tr>
            <td width="46" valign="top" style="padding:15px 0 15px 16px;font-size:20px;line-height:1.2;">&#9888;&#65039;</td>
            <td valign="top" style="padding:15px 16px 15px 10px;font-size:13px;color:#92400e;line-height:1.6;">
              <strong>Important:</strong> Once our technician completes the installation and leaves your home, they can't adjust the TV position or make changes without a scheduled appointment. If you later decide the TV needs to move up or down, or you want to change the bracket, there is a charge for those adjustments. Please make sure the TV is in the correct location before the technician leaves to avoid additional charges.
            </td>
          </tr>
        </table>
      </td></tr>`;

  const subject = `Your ${b.name} booking is confirmed`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">You're booked with ${esc(b.name)}${details.dateLong ? ' - ' + esc(details.dateLong) : ''}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 2px 10px rgba(16,24,40,.06);">
        <tr><td style="background:${accent};padding:22px 28px;">
          <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${esc(b.name)}</div>
        </td></tr>
        <tr><td style="padding:30px 28px 6px;">
          <div style="font-size:22px;font-weight:800;color:#11181c;margin:0 0 7px;">You're booked! &#9989;</div>
          <div style="font-size:15px;color:#4b5563;line-height:1.55;">Hi ${esc(firstName || 'there')}, thanks for booking with ${esc(b.name)}. Here are your appointment details. We'll see you soon.</div>
        </td></tr>
        <tr><td style="padding:18px 28px 2px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eceef1;border-radius:10px;">
            ${detailRows}
          </table>
        </td></tr>
        ${priceBlock}
        ${twoTechNote}
        ${calendarBlock}
        ${meetTechBlock}
        ${expectBlock}
        <tr><td style="padding:24px 28px 30px;">
          <div style="border-top:1px solid #eef0f2;padding-top:18px;font-size:13px;color:#6b7280;line-height:1.65;">
            Need to make a change or have a question? Just <strong>reply to this email</strong> and our team will help.<br>
            <span style="color:#9ca3af;">${esc(b.website)}</span>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

// ── 24-hour appointment reminder email ──────────────────────────────────────
// Sent when appointment is exactly 24 hours away. `details` includes:
//   firstName, dateLong, timeWindow, address: { line1, city, state, zip }
// Returns { subject, html }.
export function appointmentReminderEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const accent = b.accent;
  const rgb = hexRgb(accent);                  // "r, g, b" for tints
  const tintBg   = `rgba(${rgb},0.06)`;         // very light accent wash
  const tintCard = `rgba(${rgb},0.10)`;         // badge / icon background
  const accentDk = shade(accent, -0.22);        // darker accent for depth
  const firstName = (details.firstName || '').trim();
  const a = details.address || {};
  const addressLine = [a.line1, [a.city, a.state].filter(Boolean).join(', '), a.zip]
    .filter(Boolean).join(', ');

  // One step in the "What to expect" timeline: numbered accent badge + title/body.
  const step = (n, icon, title, body) => `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;">
          <tr>
            <td width="48" valign="top" style="padding:6px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td align="center" valign="middle" width="38" height="38" style="width:38px;height:38px;background:${tintCard};border-radius:19px;font-size:18px;line-height:38px;">${icon}</td>
              </tr></table>
            </td>
            <td valign="top" style="padding:6px 0 6px 6px;">
              <div style="font-size:14.5px;font-weight:800;color:#11181c;margin:0 0 2px;">${esc(title)}</div>
              <div style="font-size:13px;color:#5b6470;line-height:1.55;">${body}</div>
            </td>
          </tr>
        </table>`;

  const subject = `Your appointment is 24 hours away!`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your appointment with ${esc(b.name)} is 24 hours away. Here's everything you need to know.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 6px 24px rgba(16,24,40,.10);">

        <!-- Header -->
        <tr><td style="background:${accent};padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${esc(b.name)}</td>
            <td align="right" style="font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:rgba(255,255,255,.82);">Appointment Reminder</td>
          </tr></table>
        </td></tr>

        <!-- Countdown hero -->
        <tr><td style="background:${tintBg};padding:34px 28px 30px;text-align:center;">
          <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 16px;"><tr>
            <td align="center" valign="middle" width="104" height="104" style="width:104px;height:104px;background:${accent};border-radius:52px;text-align:center;">
              <div style="font-size:34px;font-weight:800;color:#ffffff;line-height:1;">24</div>
              <div style="font-size:11px;font-weight:700;letter-spacing:.14em;color:rgba(255,255,255,.85);margin-top:3px;">HOURS</div>
            </td>
          </tr></table>
          <div style="font-size:23px;font-weight:800;color:#11181c;margin:0 0 6px;">Your appointment is almost here!</div>
          <div style="font-size:14.5px;color:#5b6470;line-height:1.55;max-width:420px;margin:0 auto;">Hi ${esc(firstName || 'there')}, you're just one day away. Here's everything you need to know before your technician arrives.</div>
        </td></tr>

        <!-- Appointment details card -->
        <tr><td style="padding:24px 28px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ebef;border-radius:12px;">
            <tr>
              <td width="56" valign="middle" style="padding:14px 0 14px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" width="40" height="40" style="width:40px;height:40px;background:${tintCard};border-radius:20px;font-size:18px;line-height:40px;">&#128197;</td></tr></table>
              </td>
              <td valign="middle" style="padding:14px 16px 14px 8px;">
                <div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9aa2ad;margin:0 0 2px;">When</div>
                <div style="font-size:15px;font-weight:700;color:#11181c;">${esc(details.dateLong || '')}</div>
                <div style="font-size:13.5px;color:#5b6470;margin-top:1px;">${esc(details.timeWindow || '')}</div>
              </td>
            </tr>
            <tr><td colspan="2" style="padding:0 16px;"><div style="border-top:1px solid #eef0f2;"></div></td></tr>
            <tr>
              <td width="56" valign="middle" style="padding:14px 0 14px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" width="40" height="40" style="width:40px;height:40px;background:${tintCard};border-radius:20px;font-size:18px;line-height:40px;">&#128205;</td></tr></table>
              </td>
              <td valign="middle" style="padding:14px 16px 14px 8px;">
                <div style="font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#9aa2ad;margin:0 0 2px;">Where</div>
                <div style="font-size:14.5px;font-weight:700;color:#11181c;line-height:1.45;">${esc(addressLine)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- What to expect timeline -->
        <tr><td style="padding:26px 28px 2px;">
          <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:${accentDk};margin:0 0 10px;">On the day</div>
          ${step('1', '&#128663;', 'Arrival window', 'Your technician will arrive within the <strong>2-hour window</strong> of your scheduled time.')}
          ${step('2', '&#128241;', 'On-my-way text', 'When the technician is en route, they’ll send an <strong>"on-my-way" text</strong> with their estimated time of arrival (ETA).')}
          ${step('3', '&#9989;', 'Be prepared', 'Please be ready for their arrival so the installation can start right on time.')}
        </td></tr>

        <!-- Important notice -->
        <tr><td style="padding:18px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;">
            <tr>
              <td width="50" valign="top" style="padding:15px 0 15px 16px;font-size:20px;">&#9888;&#65039;</td>
              <td valign="top" style="padding:15px 16px 15px 6px;">
                <div style="font-size:14px;font-weight:800;color:#92400e;margin:0 0 4px;">Choose your TV placement carefully</div>
                <div style="font-size:13px;color:#9a6a13;line-height:1.6;">Once the installation is complete and the technician leaves, they can't adjust the TV position or change the bracket without a new scheduled appointment, and a <strong>full charge</strong> applies. Please confirm the exact location before they leave. Your technician is happy to help you choose the perfect height.</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Cancellation policy -->
        <tr><td style="padding:14px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">
            <tr>
              <td width="50" valign="top" style="padding:15px 0 15px 16px;font-size:20px;">&#128222;</td>
              <td valign="top" style="padding:15px 16px 15px 6px;">
                <div style="font-size:14px;font-weight:800;color:#991b1b;margin:0 0 4px;">Within the 24-hour window</div>
                <div style="font-size:13px;color:#b4453f;line-height:1.6;">Your appointment is <strong>no longer cancelable online</strong>. If you still need to cancel, please call us and a <strong>$50 late cancellation fee</strong> will be applied to your card. Give us a call for any further information.</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:26px 28px 32px;">
          <div style="border-top:1px solid #eef0f2;padding-top:18px;text-align:center;">
            <div style="font-size:14px;font-weight:700;color:#11181c;margin:0 0 3px;">Questions or need to reschedule?</div>
            <div style="font-size:13px;color:#6b7280;line-height:1.6;">Just give us a call and our team will be glad to help.</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:10px;">${esc(b.website)}</div>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

// ── Customer review request email ──────────────────────────────────────────────
// Sent immediately when job is marked complete. Invites customer to leave a star
// rating and optional feedback. If 5-star, also offers "Post to Google" button.
// `details` includes:
//   firstName, reviewUrl, businessName
// Returns { subject, html }.
export function reviewEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const accent = b.accent;
  const rgb = hexRgb(accent);
  const tintBg   = `rgba(${rgb},0.06)`;
  const firstName = (details.firstName || '').trim();
  // clickUrl is the click-tracking redirect endpoint (/api/book?action=review_click&token=X&ch=email)
  // which logs the click, then redirects to review.html. Replaces the old separate pixel URL.
  // Accept the legacy `reviewUrl` param too so an out-of-date caller can never
  // produce an email whose button goes nowhere.
  const clickUrl = details.clickUrl || details.reviewUrl || '#';

  const subject = `How did we do?`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">How did we do? ${esc(b.name)} would love to hear from you.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 6px 24px rgba(16,24,40,.10);">

        <!-- Header -->
        <tr><td style="background:${accent};padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${esc(b.name)}</td>
            <td align="right" style="font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:rgba(255,255,255,.82);">Feedback Request</td>
          </tr></table>
        </td></tr>

        <!-- Main content -->
        <tr><td style="background:${tintBg};padding:34px 28px 30px;text-align:center;">
          <div style="font-size:26px;font-weight:800;color:#11181c;margin:0 0 12px;">How was your experience?</div>
          <div style="font-size:15px;color:#5b6470;line-height:1.6;max-width:420px;margin:0 auto;">Hi ${esc(firstName || 'there')}, your job is complete! We'd love to hear about your experience. Your feedback helps us serve you better.</div>
        </td></tr>

        <!-- Call-to-action button -->
        <tr><td style="padding:28px 28px 8px;text-align:center;">
          <a href="${esc(clickUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;letter-spacing:.3px;">Share Your Feedback</a>
        </td></tr>

        <!-- Info -->
        <tr><td style="padding:16px 28px 28px;text-align:center;">
          <div style="font-size:13px;color:#6b7280;line-height:1.6;">Click the button above to rate your experience and leave feedback. Your response is reviewed daily and helps us improve.</div>
        </td></tr>

        <!-- Why we ask -->
        <tr><td style="padding:0 28px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;">
            <tr><td style="padding:16px;">
              <div style="font-size:13px;font-weight:700;color:#11181c;margin:0 0 8px;">Why your feedback matters</div>
              <ul style="margin:0;padding-left:18px;font-size:13px;color:#5b6470;line-height:1.6;">
                <li style="margin:4px 0;">Your honest experience helps us identify what we're doing well</li>
                <li style="margin:4px 0;">We use your suggestions to improve our service quality</li>
                <li style="margin:4px 0;">Your review is seen and acted on by our team daily</li>
              </ul>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 28px 32px;">
          <div style="border-top:1px solid #eef0f2;padding-top:18px;text-align:center;">
            <div style="font-size:13px;color:#6b7280;line-height:1.6;">Thank you for choosing ${esc(b.name)}!</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:10px;">${esc(b.website)}</div>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

// ── Estimate / quote email ──────────────────────────────────────────────────
// Sent from the admin Estimates tab when the office emails a customer their
// quote. Mirrors the house style (accent header, tinted body, content card,
// website footer).
// `details`: { firstName, serviceLabel, description, lineItems, taxRate }
//   lineItems: [{ description, qty, unit_price }] — when present, renders a
//   priced quote table + total; otherwise falls back to the request description.
//   taxRate: fraction (e.g. 0.0875) — adds a subtotal + tax + total breakdown.
export function estimateEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const accent = b.accent;
  const rgb = hexRgb(accent);
  const tintBg = `rgba(${rgb},0.06)`;
  const firstName = (details.firstName || '').trim();
  const serviceLabel = (details.serviceLabel || '').trim();
  const description = (details.description || '').trim();
  const approveUrl = (details.approveUrl || '').trim();
  const money = n => '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

  // Keep only line items that have a description or a price.
  const lineItems = (Array.isArray(details.lineItems) ? details.lineItems : [])
    .map(it => ({
      description: String((it && it.description) || '').trim(),
      qty: Number(it && it.qty) || 0,
      unit_price: Number(it && it.unit_price) || 0,
    }))
    .filter(it => it.description || it.unit_price > 0);
  const hasLineItems = lineItems.length > 0;
  const subtotal = Math.round(lineItems.reduce((t, it) => t + it.qty * it.unit_price, 0) * 100) / 100;
  const taxRate = Number(details.taxRate) > 0 ? Number(details.taxRate) : 0;
  const taxAmt = Math.round(subtotal * taxRate * 100) / 100;
  const total = Math.round((subtotal + taxAmt) * 100) / 100;

  // Recommended add-ons the office attached. Email can't do live totals reliably,
  // so we render a non-interactive teaser and drive the tap to the approve page,
  // where the customer toggles what they want and the total updates live.
  const upsells = (Array.isArray(details.upsells) ? details.upsells : [])
    .map(u => ({
      description: String((u && u.description) || '').trim(),
      unit_price: Number(u && u.unit_price) || 0,
      qty: Number(u && u.qty) || 1,
      blurb: String((u && u.blurb) || '').trim(),
    }))
    .filter(u => u.description);
  const hasUpsells = upsells.length > 0 && !!approveUrl;

  const subject = `Your ${b.name} Estimate`;

  const serviceRow = serviceLabel
    ? `<div style="font-size:15px;font-weight:800;color:#11181c;margin:0 0 8px;">${esc(serviceLabel)}</div>`
    : '';

  // Priced quote table when line items exist; plain description otherwise.
  let bodyRow;
  if (hasLineItems) {
    const rows = lineItems.map(it => {
      const qtyTxt = it.qty && it.qty !== 1 ? `<span style="color:#8a909c;font-weight:600;">×${it.qty}</span> ` : '';
      const lineTotal = it.qty * it.unit_price;
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #eef0f2;font-size:14px;color:#3a4453;">${qtyTxt}${esc(it.description || 'Item')}</td>
        <td style="padding:10px 0;border-bottom:1px solid #eef0f2;font-size:14px;color:#11181c;font-weight:700;text-align:right;white-space:nowrap;">${money(lineTotal)}</td>
      </tr>`;
    }).join('');
    // When tax applies, show a subtotal + tax breakdown above the total.
    const taxRows = taxRate > 0 ? `
        <tr>
          <td style="padding:12px 0 0;font-size:14px;color:#5b6470;">Subtotal</td>
          <td style="padding:12px 0 0;font-size:14px;color:#11181c;text-align:right;white-space:nowrap;">${money(subtotal)}</td>
        </tr>
        <tr>
          <td style="padding:4px 0 0;font-size:14px;color:#5b6470;">Tax (${(taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%)</td>
          <td style="padding:4px 0 0;font-size:14px;color:#11181c;text-align:right;white-space:nowrap;">${money(taxAmt)}</td>
        </tr>` : '';
    // No description paragraph here — the line-item list below IS the breakdown,
    // so repeating it as prose just duplicates the same content.
    bodyRow = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows}
        ${taxRows}
        <tr>
          <td style="padding:14px 0 0;font-size:15px;font-weight:800;color:#11181c;">Estimated total</td>
          <td style="padding:14px 0 0;font-size:18px;font-weight:800;color:${accent};text-align:right;white-space:nowrap;">${money(total)}</td>
        </tr>
      </table>
      <div style="font-size:12px;color:#9ca3af;line-height:1.6;margin-top:12px;">This is an estimate, not a final invoice. Final pricing may vary based on on-site conditions.</div>`;
  } else {
    bodyRow = description
      ? `<div style="font-size:14px;color:#3a4453;line-height:1.6;white-space:pre-wrap;">${esc(description)}</div>`
      : `<div style="font-size:14px;color:#5b6470;line-height:1.6;">Details of your estimate request.</div>`;
  }

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your estimate from ${esc(b.name)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 6px 24px rgba(16,24,40,.10);">

        <!-- Header -->
        <tr><td style="background:${accent};padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:18px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${esc(b.name)}</td>
            <td align="right" style="font-size:11px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:rgba(255,255,255,.82);">Your Estimate</td>
          </tr></table>
        </td></tr>

        <!-- Intro -->
        <tr><td style="background:${tintBg};padding:30px 28px 26px;">
          <div style="font-size:22px;font-weight:800;color:#11181c;margin:0 0 10px;">Here's your estimate</div>
          <div style="font-size:15px;color:#5b6470;line-height:1.6;">Hi ${esc(firstName || 'there')}, thanks for reaching out. Here are the details of the estimate you requested:</div>
        </td></tr>

        <!-- Estimate card -->
        <tr><td style="padding:24px 28px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;">
            <tr><td style="padding:18px 18px;">
              ${serviceRow}
              ${bodyRow}
            </td></tr>
          </table>
        </td></tr>

        ${hasUpsells ? `
        <!-- Recommended add-ons teaser -->
        <tr><td style="padding:6px 28px 4px;">
          <div style="font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:${accent};margin:0 0 10px;">Recommended for your job</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${tintBg};border:1px solid #eef0f2;border-radius:12px;">
            <tr><td style="padding:14px 16px;">
              ${upsells.map(u => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td style="padding:5px 0;font-size:14px;color:#11181c;font-weight:700;">${esc(u.description)}${u.blurb ? `<div style="font-size:12.5px;color:#5b6470;font-weight:500;margin-top:2px;">${esc(u.blurb)}</div>` : ''}</td>
                <td style="padding:5px 0;font-size:14px;color:${accent};font-weight:800;text-align:right;white-space:nowrap;vertical-align:top;">+${money(u.unit_price)}</td>
              </tr></table>`).join('')}
            </td></tr>
          </table>
          <div style="font-size:13px;color:#5b6470;line-height:1.6;margin-top:10px;">Choose the ones you'd like on the next screen — your total updates as you pick.</div>
        </td></tr>` : ''}

        <!-- Next steps -->
        <tr><td style="padding:18px 28px 22px;">
          <div style="font-size:14px;color:#3a4453;line-height:1.6;">A member of our team will reach out shortly to finalize the details and get you scheduled. If you have any questions, just reply to this email.</div>
        </td></tr>
        ${approveUrl ? `
        <!-- Approve CTA -->
        <tr><td style="padding:0 28px 30px;">
          <div style="text-align:center;">
            <a href="${esc(approveUrl)}" style="display:inline-block;background:${accent};color:#ffffff;text-decoration:none;font-size:16px;font-weight:800;padding:15px 42px;border-radius:10px;letter-spacing:.3px;">${hasUpsells ? 'Review &amp; choose your estimate &rarr;' : '&#10003; I approve this estimate'}</a>
            <div style="font-size:12px;color:#9ca3af;line-height:1.6;margin-top:11px;">${hasUpsells ? 'Pick any upgrades you want and approve — takes about a minute.' : 'Click above to let us know you\'d like to move forward with this quote.'}</div>
          </div>
        </td></tr>` : ''}

        <!-- Footer -->
        <tr><td style="padding:8px 28px 32px;">
          <div style="border-top:1px solid #eef0f2;padding-top:18px;text-align:center;">
            <div style="font-size:13px;color:#6b7280;line-height:1.6;">Thank you for choosing ${esc(b.name)}!</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:10px;">${esc(b.website)}</div>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}
