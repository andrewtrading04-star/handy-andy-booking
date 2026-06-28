// ============================================================================
// scripts/lib/walmart-parse.mjs  —  Parse a Walmart order email into a payload
// ============================================================================
// Pure functions (no I/O) so they can be unit-tested against real email text.
// Built against the ACTUAL Walmart "Thanks for your delivery order" email, whose
// line items appear as image alt-text:
//   "quantity 3 item onn Tilting TV Wall Mount for 50 to 86 ..."
// Walmart bracket type words: "Fixed" (= flat), "Tilting", "Full Motion".
// Order number format: 7 digits, dash, 8 digits (often "Order number: #…").
// ============================================================================

// Minimal HTML → text, used only when an email has no text/plain part. Keeping
// image alt-text (Walmart lists line items there) is essential, so we convert
// <img alt="…"> to its alt text before stripping tags.
export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<img[^>]*\balt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ');
}

// Walmart order number: 7 digits - 8 digits, optionally prefixed with '#'
// and an "Order number:" label.
export function extractOrderNum(text) {
  if (!text) return null;
  const m = text.match(/order\s*(?:number|#)\s*:?\s*#?(\d{7}-\d{8})/i)
         || text.match(/#?\b(\d{7}-\d{8})\b/);
  return m ? m[1] : null;
}

// Bracket type + quantity from the line-item alt-text. Anchor the type word to
// the "quantity N item … <type>" structure and take the FIRST type token after
// "item" (a Full Motion item's description also contains the word "Tilting"
// further along, so a naive contains() would misclassify it).
export function extractBrackets(text) {
  let flat = 0, tilting = 0, fullMotion = 0;
  const add = (typeWord, qty) => {
    const t = typeWord.toLowerCase().replace(/[\s-]/g, '');
    if (t === 'fullmotion') fullMotion += qty;
    else if (t === 'tilting') tilting += qty;
    else if (t === 'fixed' || t === 'flat') flat += qty;
  };

  // Primary: "quantity N item … <type>"  (real Walmart confirmation format)
  const re = /quantity\s+(\d+)\s+item\b[\s\S]{0,80}?\b(full[\s-]?motion|tilting|fixed|flat)\b/gi;
  let m, hits = 0;
  while ((m = re.exec(text))) { add(m[2], parseInt(m[1], 10) || 1); hits++; }
  if (hits) return { flat, tilting, fullMotion };

  // Fallback: "<type> … Wall Mount" with no quantity structure → count one each.
  const re2 = /\b(full[\s-]?motion|tilting|fixed|flat)\b[^\n]{0,40}?\bwall mount\b/gi;
  while ((m = re2.exec(text))) add(m[1], 1);
  return { flat, tilting, fullMotion };
}

// Order status from subject + body. Three states the office cares about:
//   in_route  — placed / preparing / shipped / "arrives" / on its way
//   delivered — actually delivered
//   canceled  — order canceled
// "delivery order" (the confirmation subject) must NOT read as "delivered".
export function detectStatus(subject, text) {
  const s = ((subject || '') + ' ' + (text || '')).toLowerCase();
  if (/cancel(?:l?ed|lation)?\b/i.test(s)) return 'canceled';
  if (/\bdelivered\b|has been delivered|was delivered|delivery complete/i.test(s)) return 'delivered';
  return 'in_route';
}

// Clickable Walmart order/tracking link (walmart.com/orders or the w-mt.co
// tracking shortlink Walmart uses in emails).
export function extractOrderUrl(text) {
  if (!text) return null;
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"')]+/gi)].map(m => m[0]);
  return urls.find(u => /walmart\.com\/orders/i.test(u))
      || urls.find(u => /w-mt\.co/i.test(u))
      || null;
}

// Order date → YYYY-MM-DD. "Order date: Sun, Jun 28, 2026" or m/d/Y; today if absent.
export function extractOrderDate(text, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  if (!text) return today;
  const m = text.match(/order\s*date\s*:?\s*([A-Za-z]{3,9},?\s+[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i)
         || text.match(/order\s*date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return today;
}

// Parse a whole email (subject + body text) into a bracket-sync payload, or null
// if it isn't an identifiable Walmart order email.
export function parseWalmartEmail({ subject = '', text = '', html = '', todayISO } = {}) {
  // Use ONE body representation for quantity/number/date parsing. An email
  // carries the same items in both text/plain and text/html — concatenating
  // them would double-count every line item. Prefer the plaintext part; fall
  // back to stripped HTML only when there is no plaintext.
  const body = (text && text.trim()) ? text : stripHtml(html);
  const forNum = subject + '\n' + body;

  const walmart_order_num = extractOrderNum(forNum);
  if (!walmart_order_num) return null;

  const status = detectStatus(subject, body);
  const { flat, tilting, fullMotion } = extractBrackets(body);
  const order_url = extractOrderUrl(html || body);
  const order_date = extractOrderDate(forNum, todayISO);
  const today = todayISO || new Date().toISOString().slice(0, 10);

  return {
    walmart_order_num,
    flat_qty: flat,
    tilting_qty: tilting,
    full_motion_qty: fullMotion,
    status,
    order_date,
    delivered_date: status === 'delivered' ? today : null,
    order_url,
  };
}
