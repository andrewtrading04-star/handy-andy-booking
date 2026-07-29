// ============================================================================
// scripts/lib/website-lead-parse.mjs — website contact-form email → estimate
// ============================================================================
// The websites are built on LandingSite, whose contact form emails the owner a
// "New customer message from <email>" notification from forms@mail.landingsite.ai.
// That email is the ONLY machine-readable signal the form produces (there's no
// API and no webhook), so it's parsed here and turned into an estimate row —
// exactly the same approach the Grasshopper voicemail ingest takes.
//
// Body shape (labels on their own line, value on the following line(s)):
//
//   name:
//   Alberto Ramirez
//
//   email:
//   alberto.ramirez@frontlinecgroup.com
//
//   phone:
//   720 788 3990
//
//   zipcode:
//   80222
//
//   message:
//   Hello,
//   ...multiple lines...
//
//   analyticsId:
//   LS-dsx2a9bph3
//
// Pure functions (no I/O) so they can be unit-tested against real email text.
// ============================================================================

const FIELD_LABELS = ['name', 'email', 'phone', 'zipcode', 'zip', 'message', 'analyticsid'];

// Minimal HTML → text. The LandingSite mail is multipart; when only the HTML
// part survives forwarding, <br>/<p>/<div> have to become newlines BEFORE tags
// are stripped or every label and value collapses onto one unparseable line.
export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<(?:style|script)[^>]*>[\s\S]*?<\/(?:style|script)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ');
}

// Split the body into { label: value } by walking lines. A value runs until the
// next known label, so a multi-line message body is kept whole (blank lines and
// all) instead of being truncated at the first newline.
export function parseFields(text) {
  const out = {};
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let current = null, buf = [];
  const flush = () => {
    if (current) out[current] = buf.join('\n').trim();
    buf = [];
  };
  for (const line of lines) {
    const m = /^\s*([A-Za-z ]{2,20}?)\s*:\s*(.*)$/.exec(line);
    const label = m ? m[1].trim().toLowerCase().replace(/\s+/g, '') : null;
    if (label && FIELD_LABELS.includes(label)) {
      flush();
      current = label === 'zip' ? 'zipcode' : label;
      if (m[2].trim()) buf.push(m[2].trim());   // "name: Alberto" on one line
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// US phone → digits only, for consistent storage/dedupe. Leaves anything that
// isn't a 10/11-digit US number alone rather than mangling it.
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : String(raw || '').trim();
}

// Is this email a LandingSite contact-form notification? Checked on sender OR
// subject, since a forwarded copy's From: is the forwarder, not LandingSite.
export function isWebsiteLeadEmail({ from = '', subject = '', text = '', html = '' } = {}) {
  const body = (text && text.trim()) ? text : stripHtml(html);
  if (/landingsite\.ai/i.test(from)) return true;
  if (/new customer message from/i.test(subject)) return true;
  // Last resort: the distinctive label block, so a re-branded sender still works.
  return /(^|\n)\s*analyticsId\s*:/i.test(body) && /(^|\n)\s*message\s*:/i.test(body);
}

// Parse a whole email into a lead payload, or null if it isn't a website lead
// or is missing the minimum needed to act on it (a message plus a way to reply).
// `messageId` is the email's Message-ID header — the idempotency key, since the
// body itself carries no per-submission identifier (analyticsId is the SITE id
// and is identical on every message from that site).
export function parseWebsiteLeadEmail({ from = '', subject = '', text = '', html = '', messageId = '', receivedISO = '' } = {}) {
  if (!isWebsiteLeadEmail({ from, subject, text, html })) return null;
  const body = (text && text.trim()) ? text : stripHtml(html);
  const f = parseFields(body);

  const email = (f.email || '').trim().toLowerCase()
    // Fall back to the address in "New customer message from <addr>".
    || (/(new customer message from)\s+(\S+@\S+)/i.exec(subject || '')?.[2] || '').toLowerCase();
  const phone = normalizePhone(f.phone);
  const message = (f.message || '').trim();

  // Needs something to act on and someone to reply to; otherwise it's noise.
  if (!message) return null;
  if (!email && !phone) return null;

  return {
    external_key: (messageId || '').trim() || null,
    name: (f.name || '').trim().slice(0, 120) || 'Website visitor',
    email: email.slice(0, 200) || null,
    phone: phone ? String(phone).slice(0, 40) : null,
    zip: (f.zipcode || '').trim().slice(0, 10) || null,
    message: message.slice(0, 4000),
    analytics_id: (f.analyticsid || '').trim().slice(0, 60) || null,
    received_at: receivedISO || null,
  };
}
