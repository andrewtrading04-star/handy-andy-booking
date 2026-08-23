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
  if (slug === 'mile-high') {
    // Its own Resend account + verified domain. NOTE the deliberate absence of a
    // fallback to RESEND_API_KEY/ihandyandy.com: sending Mile High's customer
    // mail from Handy Andy's address would be worse than not sending it, so an
    // unset key yields no apiKey and sendEmail() skips with a logged reason.
    return {
      apiKey: process.env.MILE_HIGH_RESEND_API_KEY,
      from:   process.env.MILE_HIGH_EMAIL_FROM || 'contact@milehightvmounting.com',
    };
  }
  if (slug === 'austin') {
    // Same rule as Mile High: no fallback to Handy Andy's account, ever. Until
    // AUSTIN_RESEND_API_KEY is set, this brand's emails skip with a logged
    // reason instead of arriving from the wrong company.
    return {
      apiKey: process.env.AUSTIN_RESEND_API_KEY,
      from:   process.env.AUSTIN_EMAIL_FROM || 'contact@austinmounting.com',
    };
  }
  // Shared fallback account (owner's 2026-08-20 decision): rather than
  // paying/verifying a separate Resend account per new business, one account
  // — set up under houstonmounting.com — holds every OTHER brand's domain too
  // as an additional verified sender. The apiKey is the same across all of
  // them; only `from` differs, so each business's mail still arrives branded
  // correctly. A business's own dedicated key (if it has a real, separate
  // account already, e.g. one set up before this decision) always wins —
  // this is a fallback, not a replacement. Still never falls back to Handy
  // Andy's own account/address: that mistake (a Mile High customer greeted
  // by Handy Andy) is exactly what this whole per-business system exists to
  // prevent, and consolidating onto ANOTHER real business's account doesn't
  // reopen it as long as `from` stays that business's own address.
  if (slug === 'precision') {
    return {
      apiKey: process.env.PRECISION_RESEND_API_KEY || process.env.HOUSTONMOUNTING_RESEND_API_KEY,
      from:   process.env.PRECISION_EMAIL_FROM || 'contact@precisiontvinstallation.com',
    };
  }
  if (slug === 'houstonmounting') {
    // The shared account itself.
    return {
      apiKey: process.env.HOUSTONMOUNTING_RESEND_API_KEY,
      from:   process.env.HOUSTONMOUNTING_EMAIL_FROM || 'contact@houstonmounting.com',
    };
  }
  if (slug === 'houstontvinstallation') {
    return {
      apiKey: process.env.HOUSTONTVINSTALLATION_RESEND_API_KEY || process.env.HOUSTONMOUNTING_RESEND_API_KEY,
      from:   process.env.HOUSTONTVINSTALLATION_EMAIL_FROM || 'contact@houstontvinstallation.com',
    };
  }
  if (slug === 'tvhanginghouston') {
    return {
      apiKey: process.env.TVHANGINGHOUSTON_RESEND_API_KEY || process.env.HOUSTONMOUNTING_RESEND_API_KEY,
      from:   process.env.TVHANGINGHOUSTON_EMAIL_FROM || 'contact@tvhanginghouston.com',
    };
  }
  if (slug === 'htvmounting') {
    return {
      apiKey: process.env.HTVMOUNTING_RESEND_API_KEY || process.env.HOUSTONMOUNTING_RESEND_API_KEY,
      from:   process.env.HTVMOUNTING_EMAIL_FROM || 'contact@htvmounting.com',
    };
  }
  if (slug === 'tvmountingdenver') {
    return {
      apiKey: process.env.TVMOUNTINGDENVER_RESEND_API_KEY || process.env.HOUSTONMOUNTING_RESEND_API_KEY,
      from:   process.env.TVMOUNTINGDENVER_EMAIL_FROM || 'contact@tvmountingdenver.com',
    };
  }
  // Austin lead-gen quad — same per-brand-key-wins/shared-fallback pattern as
  // the Houston quad above, but on its OWN dedicated Resend account
  // (AUSTIN_LEADGEN_RESEND_API_KEY), NOT the houstonmounting shared account and
  // NOT the austin brand's AUSTIN_RESEND_API_KEY. And as everywhere else here:
  // never a fallback to Handy Andy's RESEND_API_KEY — a customer of one of
  // these brands greeted by Handy Andy is exactly the mistake this whole
  // per-business system exists to prevent. Until the shared key is set, these
  // brands' emails skip with a logged reason instead of arriving from the
  // wrong company.
  if (slug === 'atxmountpros') {
    return {
      apiKey: process.env.ATXMOUNTPROS_RESEND_API_KEY || process.env.AUSTIN_LEADGEN_RESEND_API_KEY,
      from:   process.env.ATXMOUNTPROS_EMAIL_FROM || 'contact@atxmountpros.com',
    };
  }
  if (slug === 'atxtvmount') {
    return {
      apiKey: process.env.ATXTVMOUNT_RESEND_API_KEY || process.env.AUSTIN_LEADGEN_RESEND_API_KEY,
      from:   process.env.ATXTVMOUNT_EMAIL_FROM || 'contact@atxtvmount.com',
    };
  }
  if (slug === 'austinmountingpros') {
    return {
      apiKey: process.env.AUSTINMOUNTINGPROS_RESEND_API_KEY || process.env.AUSTIN_LEADGEN_RESEND_API_KEY,
      from:   process.env.AUSTINMOUNTINGPROS_EMAIL_FROM || 'contact@austinmountingpros.com',
    };
  }
  if (slug === 'austintvinstall') {
    return {
      apiKey: process.env.AUSTINTVINSTALL_RESEND_API_KEY || process.env.AUSTIN_LEADGEN_RESEND_API_KEY,
      from:   process.env.AUSTINTVINSTALL_EMAIL_FROM || 'contact@austintvinstall.com',
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
  'handy-andy': { slug: 'handy-andy', name: 'Handy Andy',            accent: '#FF6B35', website: 'ihandyandy.com', heightCalc: 'https://www.ihandyandy.com/tv-height-calculator' },
  'doms':       { slug: 'doms',       name: "Dom's TV Mounting",     accent: '#2563EB', website: 'domstvmounting.com' },
  'mile-high':  { slug: 'mile-high',  name: 'Mile High TV Mounting', accent: '#1D9E75', website: 'milehightvmounting.com' },
  'austin':     { slug: 'austin',     name: 'TV Mounting & Handyman Austin', accent: '#1E56E0', website: 'austinmounting.com' },
  'precision':  { slug: 'precision',  name: 'Precision TV Installation',     accent: '#0288D1', website: 'precisiontvinstallation.com' },
  'tvmountingdenver': { slug: 'tvmountingdenver', name: 'TV Mounting Denver', accent: '#2F6BFF', website: 'tvmountingdenver.com' },
  'houstonmounting':       { slug: 'houstonmounting',       name: 'Houston Mounting',         accent: '#0288D1', website: 'houstonmounting.com' },
  'houstontvinstallation': { slug: 'houstontvinstallation', name: 'Houston TV Installation',  accent: '#0288D1', website: 'houstontvinstallation.com' },
  'tvhanginghouston':      { slug: 'tvhanginghouston',      name: 'TV Hanging Houston',       accent: '#0288D1', website: 'tvhanginghouston.com' },
  'htvmounting':           { slug: 'htvmounting',           name: 'HTV Mounting',             accent: '#0288D1', website: 'htvmounting.com' },
  // Austin lead-gen quad: accents match each site's own --accent token
  // (app/globals.css in each <slug>-site repo) so the email, widget and site
  // all read as one brand. atxtvmount deliberately shares austin's #1E56E0 —
  // that indigo is the color its site actually shipped with.
  'atxmountpros':       { slug: 'atxmountpros',       name: 'ATX Mount Pros',         accent: '#E8570A', website: 'atxmountpros.com' },
  'atxtvmount':         { slug: 'atxtvmount',         name: 'ATX TV Mounting',        accent: '#1E56E0', website: 'atxtvmount.com' },
  'austinmountingpros': { slug: 'austinmountingpros', name: 'Austin Mounting Pros',   accent: '#8A6A2C', website: 'austinmountingpros.com' },
  'austintvinstall':    { slug: 'austintvinstall',    name: 'Austin TV Installation', accent: '#0D7A68', website: 'austintvinstall.com' },
};
// An unknown slug used to fall back to Handy Andy, which meant a new business
// would send Handy-Andy-branded email to its own customers and look, to the
// reader, like the wrong company. Warn loudly; the fallback stays so a branding
// gap can never block a real confirmation email from going out.
export function brandFor(slug) {
  if (slug && !EMAIL_BRANDS[slug]) console.error(`[email] no brand for business "${slug}" — falling back to Handy Andy branding; add it to EMAIL_BRANDS`);
  return EMAIL_BRANDS[slug] || EMAIL_BRANDS['handy-andy'];
}

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

// Matches the real GDS line-item price used everywhere else (widget.js
// dismount step, api/admin.js gdsUpsellAdd) — kept in one place here too so
// the email copy can never drift from what the confirm page actually charges.
const GDS_UPSELL_PRICE = 35;

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
  // Tax reads as just "Tax"; the rate stays in the stored line name (the
  // booking editor's auto-recompute keys off it), customers don't see it.
  if (/^\s*tax\b/i.test(s)) return s.replace(/\s*\(\s*[\d.]+\s*%\s*\)/, '').trim() || 'Tax';
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

// ── "Add to calendar" buttons (Google + Apple + Outlook) ────────────────────
// Rendered only when the caller passes machine-readable start/end epochs
// (sec). Google uses its render URL (pre-fills the event); Outlook uses its
// web deep-link; Apple downloads an .ics from our own /api/book endpoint so a
// tap opens the native add-to-calendar sheet. Shared by the confirmation and
// 24-hour reminder emails so both offer the same one-tap calendar add.
function buildCalendarBlock({ startEpoch, endEpoch, businessName, addressLine, timeWindow, serviceName, baseUrl }) {
  const startSec = Number(startEpoch), endSec = Number(endEpoch);
  if (!startSec || !endSec) return '';
  const stamp = (sec) => {
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
  };
  const calTitle = `${businessName} - ${serviceName || 'TV Installation'}`;
  const calLoc   = addressLine;
  const calDesc  = `Your ${businessName} appointment${timeWindow ? ` (arrival window ${timeWindow})` : ''}. Reply to your confirmation email with any questions.`;
  const gcal = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(calTitle)}`
    + `&dates=${stamp(startSec)}/${stamp(endSec)}`
    + `&details=${encodeURIComponent(calDesc)}`
    + `&location=${encodeURIComponent(calLoc)}`;
  const base = String(baseUrl || '').replace(/\/$/, '');
  const icsUrl = `${base}/api/book?action=ics&title=${encodeURIComponent(calTitle)}&start=${startSec}&end=${endSec}`
    + `&location=${encodeURIComponent(calLoc)}&details=${encodeURIComponent(calDesc)}`;
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
  if (base) rows.push(calRow(icsUrl, favicon('apple.com'), 'Apple Calendar', false));

  return `
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
          <td style="padding:6px 0;font-size:12.5px;color:#8a8274;text-transform:uppercase;letter-spacing:.04em;vertical-align:top;">${esc(label)}</td>
          <td align="right" style="padding:6px 0;font-size:14.5px;color:#ffffff;font-weight:700;vertical-align:top;">${esc(val)}</td>
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
            <td style="padding:5px 0;font-size:14px;color:#d8d2c6;">${esc(cleanLineLabel(li.label))}${Number(li.qty) > 1 ? ` &times; ${Number(li.qty)}` : ''}</td>
            <td align="right" style="padding:5px 0;font-size:14px;color:#d8d2c6;white-space:nowrap;">${money(li.amount)}</td>
          </tr>`).join('');
    const tipRow = Number(details.tip) > 0 ? `
          <tr>
            <td style="padding:5px 0;font-size:14px;color:#d8d2c6;">Tip for technician</td>
            <td align="right" style="padding:5px 0;font-size:14px;color:#d8d2c6;white-space:nowrap;">${money(details.tip)}</td>
          </tr>` : '';
    const grand = (Number(details.total) || 0) + (Number(details.tip) || 0);
    priceBlock = `
      <tr><td style="padding:0 26px;"><div style="border-top:2px dashed #3a3127;margin:22px 0;"></div></td></tr>
      <tr><td style="padding:0 26px;">
        <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8a8274;margin-bottom:10px;">Your quote</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${lineRows}${tipRow}
          <tr>
            <td style="padding:10px 0 0;font-size:15px;font-weight:900;color:#fff;">Total</td>
            <td align="right" style="padding:10px 0 0;font-size:17px;font-weight:900;color:${accent};white-space:nowrap;">${money(grand)}</td>
          </tr>
        </table>
      </td></tr>`;
  }

  const twoTechNote = details.twoTechs ? `
      <tr><td style="padding:14px 28px 0;">
        <div style="background:#2a2118;border:1px solid #4a3a28;border-radius:10px;padding:12px 14px;font-size:13px;color:#f2c98a;line-height:1.5;">
          <strong>Two technicians</strong> are scheduled for this job to safely handle the larger TV.
        </div>
      </td></tr>` : '';

  // ── "Want to upgrade?" GDS upsell — shown only when the caller (book.js /
  // admin.js) determined this is a TV-mounting job that didn't already add
  // Guaranteed Dismount Service. gdsUpsellUrl is a signed one-time link to
  // /add-gds.html; the button never mutates the ticket itself — it just
  // opens a confirm page (see api/admin.js gdsUpsellAdd) so a mail client
  // prefetching this link can't silently add a charge to the customer.
  // Styled as a continuation of the "Your quote" receipt above it (option 3
  // of 3 shown) rather than a separate colored banner — same card tone
  // (#181410), same uppercase label convention, price right-aligned like a
  // real line item, single accent-colored button.
  let gdsUpsellBlock = '';
  if (details.gdsUpsellUrl) {
    gdsUpsellBlock = `
      <tr><td style="padding:22px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#20190f;border:1px solid #3a3127;border-radius:14px;">
          <tr><td style="padding:18px 20px;">
            <div style="font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8a8274;margin-bottom:12px;">Add to your ticket</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              <td valign="top">
                <div style="font-size:14.5px;font-weight:800;color:#fff;margin-bottom:4px;">Guaranteed Dismount Service</div>
                <div style="font-size:12.5px;color:#d8d2c6;line-height:1.5;">Free removal whenever you move or need this TV taken down.</div>
              </td>
              <td valign="top" align="right" style="padding-left:14px;white-space:nowrap;">
                <span style="font-size:16px;font-weight:900;color:#fff;">${money(GDS_UPSELL_PRICE)}</span>
              </td>
            </tr></table>
            <div style="margin-top:14px;">
              <a href="${esc(details.gdsUpsellUrl)}" style="display:block;text-align:center;text-decoration:none;font-weight:800;border-radius:10px;padding:13px 22px;font-size:14.5px;background:${accent};color:#ffffff;">Add Guaranteed Dismount &rarr;</a>
              <div style="font-size:11.5px;color:#8a8274;line-height:1.5;margin-top:10px;text-align:center;">Click this button and confirm and we will add it to your ticket. No need to call us.</div>
            </div>
          </td></tr>
        </table>
      </td></tr>`;
  }

  // ── Self-serve reschedule button — lives in the hero card, right below the
  // GDS upsell and above the "Add to calendar" card, per request (it used to
  // be buried at the bottom of "What to expect", well past where anyone
  // scrolled). Same signed link as before (api/admin.js reschedule_info/
  // reschedule_submit) — this only moved WHERE it renders, not what it does.
  const rescheduleBlock = details.rescheduleUrl ? `
      <tr><td style="padding:16px 28px 0;text-align:center;">
        <a href="${esc(details.rescheduleUrl)}" style="display:inline-block;text-decoration:none;font-weight:700;border-radius:10px;padding:12px 24px;font-size:13.5px;background:transparent;border:1px solid rgba(255,255,255,.22);color:#eef2f7;">Reschedule this appointment &rarr;</a>
      </td></tr>` : '';

  // ── "Add to calendar" buttons (Google + Apple + Outlook) ────────────────────
  const calendarBlock = buildCalendarBlock({
    startEpoch: details.startEpoch, endEpoch: details.endEpoch,
    businessName: b.name, addressLine, timeWindow: details.timeWindow,
    serviceName: details.serviceName, baseUrl: details.baseUrl,
  });

  // ── "Meet your tech" — a photo + short intro for the assigned technician.
  // Only renders when BOTH a name and a photo are on file (set from the
  // Technicians tab in the dashboard) — a tech with neither configured yet
  // simply never shows this block, so nothing looks broken or half-filled.
  // Bio text: a custom blurb wins; otherwise a sentence built from bio_years;
  // otherwise a generic line that still reads as intentional.
  // Handy Andy ONLY: tech photos are shot with Handy Andy branding in frame,
  // so any other brand's email must never render the photo card. The tech's
  // NAME still appears in the details rows above for every brand.
  let meetTechBlock = '';
  if (b.slug === 'handy-andy' && details.technicianName && details.technicianPhotoUrl) {
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
      <tr><td style="padding:20px 26px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#231d16;border-radius:16px;">
          <tr>
            <td width="148" valign="top" style="padding:18px 0 18px 18px;">
              <img src="${esc(details.technicianPhotoUrl)}" width="130" height="130" alt="${techName}" style="display:block;width:130px;height:130px;border-radius:20px;object-fit:cover;">
            </td>
            <td valign="top" style="padding:18px 18px 18px 14px;">
              <div style="margin:0 0 7px;">
                <span style="font-size:16.5px;font-weight:800;color:#ffffff;">${techName}</span>
                <span style="display:inline-block;margin-left:8px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${accent};background:rgba(${rgb},0.16);padding:3px 9px;border-radius:100px;vertical-align:middle;">Lead installer</span>
              </div>
              <div style="font-size:14px;color:#a89f8f;line-height:1.6;">${bioText}</div>
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
                <li style="${li}">Cancellations or last-minute rescheduling within 24 hours incur an automatic $50 charge.</li>
              </ul>
              <div style="${para}margin-top:8px;">${details.rescheduleUrl ? 'Use the "Reschedule this appointment" button near the top of this email to pick a new time yourself.' : "To make changes, just reply to this email or give us a call and we'll take care of it."}</div>`)}
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
<body style="margin:0;padding:0;background:#f4f1ea;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">You're booked with ${esc(b.name)}${details.dateLong ? ' - ' + esc(details.dateLong) : ''}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <!-- Hero ticket card: confirmation, details, quote, upgrade, tech -->
        <tr><td style="background:#181410;border-radius:22px;overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:28px 26px 0;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${accent};">Booking confirmed</div>
              <div style="font-size:24px;font-weight:900;color:#fff;margin-top:6px;letter-spacing:-.01em;line-height:1.25;">${esc(firstName || 'there')}, you're on the schedule.</div>
            </td></tr>
            <tr><td style="padding:20px 26px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#231d16;border-radius:16px;">
                <tr><td style="padding:16px 20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    ${detailRows}
                  </table>
                </td></tr>
              </table>
            </td></tr>
            ${priceBlock}
            ${gdsUpsellBlock}
            ${rescheduleBlock}
            ${twoTechNote}
            ${meetTechBlock}
            <tr><td style="height:26px;"></td></tr>
          </table>
        </td></tr>

        <tr><td style="height:16px;"></td></tr>

        <!-- Everything-else card: calendar, what to expect, footer -->
        <tr><td style="background:#ffffff;border-radius:22px;overflow:hidden;box-shadow:0 2px 10px rgba(16,24,40,.06);">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${calendarBlock}
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
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html };
}

// ── 24-hour appointment reminder email ──────────────────────────────────────
// Sent when appointment is exactly 24 hours away. `details` includes:
//   firstName, dateLong, timeWindow, serviceName,
//   address: { line1, city, state, zip },
//   technicianName, technicianPhotoUrl, technicianBioYears, technicianBioBlurb,
//   startEpoch, endEpoch, baseUrl   (all optional — each block hides itself if missing)
// Same dark "ticket stub" visual family as bookingConfirmationEmail, so the
// two emails read as one connected system.
// Returns { subject, html }.
export function appointmentReminderEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const accent = b.accent;
  const rgb = hexRgb(accent);
  const firstName = (details.firstName || '').trim();
  const a = details.address || {};
  const addressLine = [a.line1, [a.city, a.state].filter(Boolean).join(', '), a.zip]
    .filter(Boolean).join(', ');
  const mapsUrl = addressLine ? `https://maps.google.com/?q=${encodeURIComponent(addressLine)}` : null;

  const row = (label, valHtml) => !valHtml ? '' : `
        <tr>
          <td style="padding:6px 0;font-size:12.5px;color:#8a8274;text-transform:uppercase;letter-spacing:.04em;vertical-align:top;">${esc(label)}</td>
          <td align="right" style="padding:6px 0;font-size:14.5px;color:#ffffff;font-weight:700;vertical-align:top;">${valHtml}</td>
        </tr>`;
  const detailRows =
    row('Date', details.dateLong ? esc(details.dateLong) : '') +
    row('Arrival window', details.timeWindow ? esc(details.timeWindow) : '') +
    row('Service', details.serviceName ? esc(details.serviceName) : '') +
    row('Technician', details.technicianName ? esc(details.technicianName) : '') +
    row('Address', addressLine ? (mapsUrl ? `<a href="${esc(mapsUrl)}" style="color:#ffffff;text-decoration:underline;">${esc(addressLine)}</a>` : esc(addressLine)) : '');

  // Handy Andy ONLY (same rule as the confirmation email): photos carry
  // Handy Andy branding, so other brands get the name in the rows, no photo.
  let meetTechBlock = '';
  if (b.slug === 'handy-andy' && details.technicianName && details.technicianPhotoUrl) {
    const techName = esc(details.technicianName);
    let bioText;
    if (details.technicianBioBlurb) bioText = esc(details.technicianBioBlurb);
    else if (Number(details.technicianBioYears) > 0) bioText = `${techName} has been doing this for over ${Number(details.technicianBioYears)} years, so you're in good hands.`;
    else bioText = `${techName} is your installer for this job.`;
    meetTechBlock = `
      <tr><td style="padding:20px 26px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#231d16;border-radius:16px;">
          <tr>
            <td width="148" valign="top" style="padding:18px 0 18px 18px;">
              <img src="${esc(details.technicianPhotoUrl)}" width="130" height="130" alt="${techName}" style="display:block;width:130px;height:130px;border-radius:20px;object-fit:cover;">
            </td>
            <td valign="top" style="padding:18px 18px 18px 14px;">
              <div style="margin:0 0 7px;">
                <span style="font-size:16.5px;font-weight:800;color:#ffffff;">${techName}</span>
                <span style="display:inline-block;margin-left:8px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${accent};background:rgba(${rgb},0.16);padding:3px 9px;border-radius:100px;vertical-align:middle;">Your installer</span>
              </div>
              <div style="font-size:14px;color:#a89f8f;line-height:1.6;">${bioText}</div>
            </td>
          </tr>
        </table>
      </td></tr>`;
  }

  const calendarBlock = buildCalendarBlock({
    startEpoch: details.startEpoch, endEpoch: details.endEpoch,
    businessName: b.name, addressLine, timeWindow: details.timeWindow,
    serviceName: details.serviceName, baseUrl: details.baseUrl,
  });

  const subject = `Your appointment is 24 hours away!`;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f4f1ea;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your appointment with ${esc(b.name)} is 24 hours away. Here's everything you need to know.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <!-- Hero ticket card: countdown, details, tech -->
        <tr><td style="background:#181410;border-radius:22px;overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:28px 26px 0;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${accent};">Tomorrow${details.timeWindow ? ' &middot; ' + esc(details.timeWindow) : ''}</div>
              <div style="font-size:24px;font-weight:900;color:#fff;margin-top:6px;line-height:1.25;">${esc(firstName || 'Hey')}, we'll see you tomorrow.</div>
            </td></tr>
            <tr><td style="padding:20px 26px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#231d16;border-radius:16px;">
                <tr><td style="padding:16px 20px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    ${detailRows}
                  </table>
                </td></tr>
              </table>
            </td></tr>
            ${meetTechBlock}
            <tr><td style="padding:0 26px;"><div style="border-top:2px dashed #3a3127;margin:22px 0;"></div></td></tr>
            <tr><td style="padding:0 26px 26px;">
              <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#8a8274;margin-bottom:12px;">On the day</div>
              <div style="font-size:14px;color:#d8d2c6;line-height:1.7;margin-bottom:6px;"><strong style="color:#fff;">1.</strong> Arrival within your 2-hour window.</div>
              <div style="font-size:14px;color:#d8d2c6;line-height:1.7;margin-bottom:6px;"><strong style="color:#fff;">2.</strong> An "on-my-way" text with ETA once your tech is en route.</div>
              <div style="font-size:14px;color:#d8d2c6;line-height:1.7;">${details.technicianName ? esc(details.technicianName) : 'Your tech'} is ready to start as soon as they arrive &mdash; please have the install area clear.</div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="height:16px;"></td></tr>

        <!-- Everything-else card: calendar + policy notices -->
        <tr><td style="background:#ffffff;border-radius:22px;overflow:hidden;box-shadow:0 2px 10px rgba(16,24,40,.06);">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${calendarBlock}

            <tr><td style="padding:24px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;">
                <tr>
                  <td width="50" valign="top" style="padding:15px 0 15px 16px;font-size:20px;">&#9888;&#65039;</td>
                  <td valign="top" style="padding:15px 16px 15px 6px;">
                    <div style="font-size:14px;font-weight:800;color:#92400e;margin:0 0 4px;">Choose your TV placement carefully</div>
                    <div style="font-size:13px;color:#9a6a13;line-height:1.6;">Once the installation is complete and the technician leaves, they can't adjust the TV position or change the bracket without a new scheduled appointment, and a <strong>full charge</strong> applies. Please confirm the exact location before they leave.</div>
                  </td>
                </tr>
              </table>
            </td></tr>

            <tr><td style="padding:14px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">
                <tr>
                  <td width="50" valign="top" style="padding:15px 0 15px 16px;font-size:20px;">&#128222;</td>
                  <td valign="top" style="padding:15px 16px 15px 6px;">
                    <div style="font-size:14px;font-weight:800;color:#991b1b;margin:0 0 4px;">Within the 24-hour window</div>
                    <div style="font-size:13px;color:#b4453f;line-height:1.6;">Your appointment is <strong>no longer cancelable online</strong>. If you still need to cancel, please call us and a <strong>$50 late cancellation fee</strong> will be applied to your card.</div>
                  </td>
                </tr>
              </table>
            </td></tr>

            <tr><td style="padding:24px 28px 30px;">
              <div style="border-top:1px solid #eef0f2;padding-top:18px;text-align:center;font-size:12px;color:#9ca3af;">${esc(b.website)}</div>
            </td></tr>

          </table>
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
  const techFirst = (details.technicianName || '').trim().split(/\s+/)[0] || '';

  const subject = `How did we do?`;

  // Deliberately familiar rather than official-looking: a clean white card,
  // an outlined-then-gold 5-star row, and a blue rounded "pill" button in the
  // same family of blue review platforms use — but no borrowed logos or marks
  // of any kind, so it reads as "this looks like the reviews I already know"
  // without ever claiming to BE Google (or anyone else's) UI.
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">How did we do? ${esc(b.name)} would love to hear from you.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;box-shadow:0 2px 10px rgba(16,24,40,.08);border:1px solid #e1e4e8;">

        <tr><td style="padding:30px 32px 0;text-align:center;">
          <div style="font-size:14px;color:#5f6368;font-weight:500;">${esc(b.name)}</div>
        </td></tr>

        <tr><td style="padding:8px 32px 0;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:#202124;line-height:1.35;">How was your service${firstName ? ', ' + esc(firstName) : ''}?</div>
          <div style="font-size:14px;color:#5f6368;line-height:1.6;margin-top:8px;max-width:400px;margin-left:auto;margin-right:auto;">${techFirst ? `${esc(techFirst)} just finished your job.` : 'Your job is complete.'} Tap a star to leave a quick review.</div>
        </td></tr>

        <!-- Star row: all five neutral gray until the customer actually rates on review.html -->
        <tr><td style="padding:26px 20px 6px;text-align:center;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>
            <td style="padding:0 4px;"><a href="${esc(clickUrl)}" style="text-decoration:none;font-size:36px;line-height:1;color:#dadce0;display:inline-block;">&#9733;</a></td>
            <td style="padding:0 4px;"><a href="${esc(clickUrl)}" style="text-decoration:none;font-size:36px;line-height:1;color:#dadce0;display:inline-block;">&#9733;</a></td>
            <td style="padding:0 4px;"><a href="${esc(clickUrl)}" style="text-decoration:none;font-size:36px;line-height:1;color:#dadce0;display:inline-block;">&#9733;</a></td>
            <td style="padding:0 4px;"><a href="${esc(clickUrl)}" style="text-decoration:none;font-size:36px;line-height:1;color:#dadce0;display:inline-block;">&#9733;</a></td>
            <td style="padding:0 4px;"><a href="${esc(clickUrl)}" style="text-decoration:none;font-size:36px;line-height:1;color:#dadce0;display:inline-block;">&#9733;</a></td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:20px 32px 4px;text-align:center;">
          <a href="${esc(clickUrl)}" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;font-size:14.5px;font-weight:500;padding:12px 28px;border-radius:24px;letter-spacing:.15px;">Share your feedback &rarr;</a>
        </td></tr>

        <tr><td style="padding:10px 32px 34px;text-align:center;">
          <div style="font-size:12px;color:#80868b;">Takes about 10 seconds</div>
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
  // Sign-aware: discount lines are legitimately negative and must read
  // "-$30.00", never "$-30.00".
  const money = n => {
    const v = Math.round((Number(n) || 0) * 100) / 100;
    return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
  };

  // Keep only line items that have a description or a nonzero price — same
  // keep-rule as the server's sanitizeLineItems, so a negative (discount)
  // line is counted by BOTH this email's total and every other total.
  const lineItems = (Array.isArray(details.lineItems) ? details.lineItems : [])
    .map(it => ({
      description: String((it && it.description) || '').trim(),
      qty: Number(it && it.qty) || 0,
      unit_price: Number(it && it.unit_price) || 0,
    }))
    .filter(it => (it.description || it.unit_price !== 0) && !isDefaultTypeLabel(it.description));
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
          <td style="padding:4px 0 0;font-size:14px;color:#5b6470;">Tax</td>
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
      </table>`;
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

// Sent when the office declines an estimate as outside what the business does
// (e.g. a request for work that isn't TV mounting or handyman repairs). Short
// and apologetic on purpose — this is a "we can't help with THIS" message, not
// a sales pitch, so it stays out of the priced-quote template's layout and
// just points at what the business does handle.
export function outOfScopeEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const firstName = (details.firstName || '').trim();
  const servicesUrl = (details.servicesUrl || '').trim();
  const subject = `About your ${b.name} estimate request`;
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#eef1f5;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">An update on your estimate request from ${esc(b.name)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;box-shadow:0 6px 24px rgba(16,24,40,.10);">
        <tr><td style="background:${b.accent};padding:18px 28px;font-size:18px;font-weight:800;color:#ffffff;letter-spacing:.2px;">${esc(b.name)}</td></tr>
        <tr><td style="padding:30px 28px;">
          <div style="font-size:20px;font-weight:800;color:#11181c;margin:0 0 14px;">Sorry, this one's outside what we do</div>
          <div style="font-size:15px;color:#3a4453;line-height:1.7;">Hi ${esc(firstName || 'there')}, thanks for reaching out. We took a look at your request, and it looks like it's outside of what we're able to help with.</div>
          ${servicesUrl ? `
          <div style="font-size:15px;color:#3a4453;line-height:1.7;margin-top:14px;">Here's a list of what we do handle, in case any of it's useful:</div>
          <div style="text-align:center;margin-top:22px;">
            <a href="${esc(servicesUrl)}" style="display:inline-block;background:${b.accent};color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:13px 32px;border-radius:10px;">See what we do &rarr;</a>
          </div>` : ''}
          <div style="font-size:13px;color:#9ca3af;line-height:1.6;margin-top:24px;">Sorry we couldn't help with this one — feel free to reach back out if anything changes.</div>
        </td></tr>
        <tr><td style="padding:8px 28px 32px;">
          <div style="border-top:1px solid #eef0f2;padding-top:18px;text-align:center;">
            <div style="font-size:12px;color:#9ca3af;">${esc(b.website)}</div>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}

// ── Receipt / invoice ────────────────────────────────────────────────────────
// One template, two headings, driven by whether the job is actually paid:
//   paid      -> "RECEIPT", with a PAID stamp showing how and when it was paid
//   not paid  -> "INVOICE", with an AMOUNT DUE block instead
// A receipt is a document a customer files, forwards to an insurer, or hands to
// an accountant, so this is deliberately plain and light (not the dark branded
// shell the confirmation email uses) and prints cleanly.
//
// `details`:
//   kind         'receipt' | 'invoice'   (caller decides from payment state)
//   receiptNo    short human reference (first 8 of the booking id, uppercased)
//   customerName
//   serviceDate  long-form date string, already formatted in the metro tz
//   paidDate     long-form date string, or null
//   technicianName
//   address      { line1, city, state, zip }
//   lines        [{ label, qty, amount }]  pre-tax items (tax passed separately)
//   tax, adjustment, tip, total
//   netPaid, amountDue   computed ONCE server-side (paid minus refunds) and
//                        rendered verbatim, so the status stamp can never
//                        derive a figure that contradicts the printed Total
//   amountRefunded, refundedDate
//   paymentLabel e.g. "Visa ending 4242" / "Cash" / "Zelle"
//   businessPhone
export function receiptEmail(details = {}, brand = EMAIL_BRANDS['handy-andy']) {
  const b = brand || EMAIL_BRANDS['handy-andy'];
  const accent = b.accent;
  // Three documents, one template. The caller decides which from the booking's
  // real payment state; this never infers it, so the heading and the stamp can
  // never disagree with each other.
  //   receipt   money cleared and stayed  -> green PAID
  //   refunded  money cleared then went back -> grey REFUNDED, never "PAID"
  //   invoice   money still owed          -> orange AMOUNT DUE
  const kind = ['receipt', 'invoice', 'refunded'].includes(details.kind) ? details.kind : 'receipt';
  const isReceipt = kind === 'receipt';
  const isRefunded = kind === 'refunded';
  const heading = kind === 'invoice' ? 'Invoice' : 'Receipt';
  const a = details.address || {};
  // "123 Main St, Houston, TX 77006" -- no comma before the ZIP, which is the
  // standard US postal form and matters on a document a customer may file or
  // forward to an insurer.
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  const addressLine = [a.line1, [cityState, a.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');

  // Money lines. Tax and tip are their own rows; a coupon/discount already
  // arrives as a negative line item and renders naturally.
  const lines = Array.isArray(details.lines)
    ? details.lines.filter(li => li && li.amount != null && !isDefaultTypeLabel(li.label))
    : [];
  const lineRows = lines.map(li => `
          <tr>
            <td style="padding:7px 0;font-size:14px;color:#374151;border-bottom:1px solid #f1f2f4;">${esc(cleanLineLabel(li.label))}${Number(li.qty) > 1 ? ` &times; ${Number(li.qty)}` : ''}</td>
            <td align="right" style="padding:7px 0;font-size:14px;color:#374151;white-space:nowrap;border-bottom:1px solid #f1f2f4;">${money(li.amount)}</td>
          </tr>`).join('');
  const subtotal = lines.reduce((s, li) => s + (Number(li.amount) || 0), 0);
  const sumRow = (label, val, strong) => `
          <tr>
            <td style="padding:${strong ? '11px 0 0' : '5px 0 0'};font-size:${strong ? '15px' : '13.5px'};color:${strong ? '#11181c' : '#6b7280'};font-weight:${strong ? '800' : '400'};">${esc(label)}</td>
            <td align="right" style="padding:${strong ? '11px 0 0' : '5px 0 0'};font-size:${strong ? '18px' : '13.5px'};color:${strong ? accent : '#6b7280'};font-weight:${strong ? '900' : '400'};white-space:nowrap;">${money(val)}</td>
          </tr>`;
  const taxRow = Number(details.tax) > 0 ? sumRow('Tax', details.tax) : '';
  const tipRow = Number(details.tip) > 0 ? sumRow('Tip for technician', details.tip) : '';
  const refunded = Number(details.amountRefunded) || 0;
  const refundRow = refunded > 0 ? sumRow('Refunded', -refunded) : '';
  // Caller-supplied reconciling line, so subtotal + tax + adjustment always
  // equals the Total actually charged. See receiptSend: some older jobs carry
  // a discount in `price` that was never itemized, and a customer must never
  // be handed a document whose own numbers do not add up.
  const adjustment = Number(details.adjustment) || 0;
  const adjustmentRow = Math.abs(adjustment) > 0.005 ? sumRow('Adjustment', adjustment) : '';

  const meta = (label, val) => !val ? '' : `
          <tr>
            <td style="padding:3px 0;font-size:12px;color:#8b93a1;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</td>
            <td align="right" style="padding:3px 0;font-size:13.5px;color:#11181c;font-weight:600;">${esc(val)}</td>
          </tr>`;

  // Status stamp. Every number here is supplied by the caller (amountDue and
  // netPaid are computed once, server-side, from the booking's real payment
  // state) so this block can never derive a figure that contradicts the Total
  // printed above it.
  const total = Number(details.total) || 0;
  const tip = Number(details.tip) || 0;
  const netPaid = Number(details.netPaid) || 0;
  const due = Math.max(0, Number(details.amountDue) || 0);
  const stamp = (bg, border, fg, dim, title, sub) => `
      <tr><td style="padding:18px 30px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};border:1px solid ${border};border-radius:12px;">
          <tr><td style="padding:14px 18px;">
            <div style="font-size:15px;font-weight:900;color:${fg};letter-spacing:.04em;">${title}</div>
            ${sub ? `<div style="font-size:13px;color:${dim};margin-top:3px;">${sub}</div>` : ''}
          </td></tr>
        </table>
      </td></tr>`;
  let statusBlock;
  if (isRefunded) {
    statusBlock = stamp('#f8fafc', '#cbd5e1', '#334155', '#475569', 'REFUNDED',
      `${esc(money(refunded))} refunded${details.refundedDate ? ' on ' + esc(details.refundedDate) : ''}. Nothing is owed.`);
  } else if (isReceipt) {
    statusBlock = stamp('#ecfdf5', '#a7f3d0', '#047857', '#065f46',
      `PAID${refunded > 0 ? ' (partially refunded)' : ''}`,
      esc([details.paymentLabel, details.paidDate].filter(Boolean).join(' · ')) || 'Thank you for your payment');
  } else {
    statusBlock = `
      <tr><td style="padding:18px 30px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;">
          <tr><td style="padding:14px 18px;">
            <div style="font-size:12px;font-weight:800;color:#9a3412;letter-spacing:.06em;text-transform:uppercase;">Amount due</div>
            <div style="font-size:22px;font-weight:900;color:#9a3412;margin-top:2px;">${money(due)}</div>
            ${netPaid > 0 ? `<div style="font-size:13px;color:#9a3412;margin-top:3px;">${money(netPaid)} already paid</div>` : ''}
          </td></tr>
        </table>
      </td></tr>`;
  }

  const subject = `${heading} from ${b.name}${details.receiptNo ? ` (#${details.receiptNo})` : ''}`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:26px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

        <tr><td style="padding:26px 30px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-size:17px;font-weight:900;color:#11181c;">${esc(b.name)}</td>
            <td align="right" style="font-size:13px;font-weight:800;color:${accent};letter-spacing:.1em;text-transform:uppercase;">${esc(heading)}</td>
          </tr></table>
          <div style="border-top:1px solid #e9ebee;margin-top:16px;"></div>
        </td></tr>

        <tr><td style="padding:16px 30px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${meta(heading + ' #', details.receiptNo)}
            ${meta('Service date', details.serviceDate)}
            ${isReceipt ? meta('Date paid', details.paidDate) : ''}
            ${meta('Technician', details.technicianName)}
          </table>
        </td></tr>

        <tr><td style="padding:16px 30px 0;">
          <div style="font-size:12px;color:#8b93a1;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">Billed to</div>
          <div style="font-size:14.5px;color:#11181c;font-weight:700;">${esc(details.customerName || 'Customer')}</div>
          ${addressLine ? `<div style="font-size:13.5px;color:#4b5563;margin-top:2px;line-height:1.5;">${esc(addressLine)}</div>` : ''}
        </td></tr>

        <tr><td style="padding:20px 30px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            ${lineRows}
            ${sumRow('Subtotal', subtotal)}
            ${taxRow}
            ${adjustmentRow}
            ${tipRow}
            ${sumRow('Total', total + tip, true)}
            ${refundRow}
          </table>
        </td></tr>

        ${statusBlock}

        <tr><td style="padding:22px 30px 28px;">
          <div style="border-top:1px solid #e9ebee;padding-top:14px;font-size:12.5px;color:#8b93a1;line-height:1.6;">
            Questions about this ${esc(heading.toLowerCase())}? Just reply to this email${details.businessPhone ? ' or call ' + esc(details.businessPhone) : ''}.
            <br>${esc(b.name)}${b.website ? ' · ' + esc(b.website) : ''}
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, html };
}
