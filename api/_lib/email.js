// api/_lib/email.js
// Shared transactional-email helpers (Resend) used by the booking, estimate and
// review flows for BOTH businesses. Centralizes the per-business Resend config,
// a low-level send wrapper (gated by the notifications master switch), and the
// branded booking-confirmation template.
import { notificationsOn } from './notify.js';

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
  'handy-andy': { slug: 'handy-andy', name: 'Handy Andy',          accent: '#FF6B35', website: 'ihandyandy.com' },
  'doms':       { slug: 'doms',       name: "Dom's TV Mounting",   accent: '#2563EB', website: 'domstvmounting.com' },
};
export function brandFor(slug) { return EMAIL_BRANDS[slug] || EMAIL_BRANDS['handy-andy']; }

// ── Low-level send ──────────────────────────────────────────────────────────
// Returns { sent, skipped?, id?, error? } and never throws unless throwOnError.
// `notificationsOn()` is the global kill switch — while it is off, sends are
// skipped (and logged) so nothing goes out before the accounts are approved.
export async function sendEmail({ slug, to, subject, html, replyTo, throwOnError = false }) {
  if (!notificationsOn()) {
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

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
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
    row('Address', addressLine);

  // Price block — only rendered when the widget supplied line items + a total, so
  // we never show a guessed number. Mirrors the thank-you page (tip is separate;
  // no tax line, to stay consistent with what the customer saw on screen).
  let priceBlock = '';
  const lines = Array.isArray(details.lines) ? details.lines.filter(li => li && li.amount != null) : [];
  if (lines.length && details.total != null) {
    const lineRows = lines.map(li => `
          <tr>
            <td style="padding:7px 0;font-size:14px;color:#374151;">${esc(li.label)}${Number(li.qty) > 1 ? ` &times; ${Number(li.qty)}` : ''}</td>
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

  const confNum = details.jobId ? `
      <tr><td style="padding:16px 28px 0;">
        <div style="font-size:12px;color:#9ca3af;">Confirmation #: <span style="color:#6b7280;font-weight:600;">${esc(details.jobId)}</span></div>
      </td></tr>` : '';

  const subject = `Your ${b.name} booking is confirmed`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">You're booked with ${esc(b.name)}${details.dateLong ? ' — ' + esc(details.dateLong) : ''}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 2px 10px rgba(16,24,40,.06);">
        <tr><td style="background:${accent};padding:22px 28px;">
          <div style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${esc(b.name)}</div>
        </td></tr>
        <tr><td style="padding:30px 28px 6px;">
          <div style="font-size:22px;font-weight:800;color:#11181c;margin:0 0 7px;">You're booked! &#9989;</div>
          <div style="font-size:15px;color:#4b5563;line-height:1.55;">Hi ${esc(firstName || 'there')}, thanks for booking with ${esc(b.name)}. Here are your appointment details — we'll see you soon.</div>
        </td></tr>
        <tr><td style="padding:18px 28px 2px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #eceef1;border-radius:10px;">
            ${detailRows}
          </table>
        </td></tr>
        ${priceBlock}
        ${twoTechNote}
        ${confNum}
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
