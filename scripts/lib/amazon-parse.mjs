// ============================================================================
// scripts/lib/amazon-parse.mjs  —  Parse an Amazon order email into a payload
// ============================================================================
// Pure functions (no I/O) so they can be unit-tested against real email text.
//
// SAFETY: this parser must only ever match the WIRE CONCEALMENT PLATE product,
// never the owner's other Amazon purchases. So it is deliberately STRICT — an
// email is only treated as a plate order if BOTH:
//   1. it has an Amazon order number, AND
//   2. its text matches PLATE_MATCH (the product's identifying words).
// If the match is too strict it simply finds nothing (safe — no inventory is
// touched). If it were too loose it could add plates for unrelated orders
// (unsafe). When in doubt, tighten PLATE_MATCH against a real order email.
//
// Tune PLATE_MATCH from the FIRST real Amazon plate-order email (the exact
// product title). Until then these are the obvious identifying words for the
// product (https://amzn.to/4wamlNJ — recessed in-wall cable/wire concealment).
// ============================================================================

// Words that identify the plate product in the email body/subject. Strict by
// design. Override at runtime with AMAZON_PLATE_MATCH (a regex source string).
// Default is tuned to the actual product ordered — ANONION "Single Brush Wall
// Plate ... Cable Pass Through Insert ... Low Voltage Mounting Bracket" — using
// distinctive phrases (not the brand) so a same-type reorder still matches while
// a USB charger never does.
export const PLATE_MATCH = process.env.AMAZON_PLATE_MATCH
  ? new RegExp(process.env.AMAZON_PLATE_MATCH, 'i')
  : /brush\s+wall\s+plate|cable\s+pass[\s-]*through|low\s+voltage\s+mounting\s+bracket|(?:wire|cable|cord)[\s-]*(?:concealment|conceal|hider|pass[\s-]*through)|recessed\s+(?:cable|wire|media)\s+plate|in[\s-]?wall\s+(?:cable|wire|cord)/i;

// One Amazon unit yields this many plates. Stated by the owner: "each 1 purchased
// supplies 5 behind the wall wire concealments." The sync endpoint re-derives
// plates from units server-side, but we surface it here too.
export const PLATES_PER_UNIT = parseInt(process.env.PLATES_PER_UNIT) || 5;

// Minimal HTML → text, keeping <img alt> (some Amazon line items live there).
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

// Amazon order number: 3 digits - 7 digits - 7 digits (e.g. 123-1234567-1234567),
// often labeled "Order #" or "Order number".
export function extractOrderNum(text) {
  if (!text) return null;
  const m = text.match(/order\s*(?:number|#|id)?\s*:?\s*#?(\d{3}-\d{7}-\d{7})/i)
         || text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
  return m ? m[1] : null;
}

// Quantity ordered. Amazon shows "Qty: N" or "Quantity: N" per line item; sum
// the quantities of the lines that match the plate product. If a quantity can't
// be found but the product clearly matches, assume 1.
export function extractUnits(text) {
  if (!text) return 0;
  let units = 0, hits = 0;
  const re = /(?:qty|quantity)\s*:?\s*(\d{1,3})/gi;
  let m;
  while ((m = re.exec(text))) { units += parseInt(m[1], 10) || 0; hits++; }
  if (hits) return units;
  // Amazon delivery/confirmation emails often show "N item(s) from Amazon"
  // instead of a Qty field. One ORDER LINE of this 10-pack is one purchased
  // unit (= 5 concealments), regardless of how many physical plates are inside.
  const im = text.match(/\b(\d{1,3})\s+items?\s+from\s+amazon/i);
  if (im) return parseInt(im[1], 10) || 1;
  return PLATE_MATCH.test(text) ? 1 : 0;
}

// Order status from subject + body.
//   in_route  — ordered / shipped / out for delivery / arriving
//   delivered — delivered
//   canceled  — canceled / refunded
export function detectStatus(subject, text) {
  const s = ((subject || '') + ' ' + (text || '')).toLowerCase();
  if (/cancel(?:l?ed|lation)?\b|\brefund(?:ed)?\b|return\s+(?:initiated|complete)/i.test(s)) return 'canceled';
  if (/\bdelivered\b|was delivered|has been delivered|delivery complete|package was left/i.test(s)) return 'delivered';
  return 'in_route';
}

// Clickable Amazon order link.
export function extractOrderUrl(text) {
  if (!text) return null;
  const urls = [...(text.matchAll(/https?:\/\/[^\s<>"')]+/gi) || [])].map(m => m[0]);
  return urls.find(u => /amazon\.[a-z.]+\/.*(?:order|gp\/css|your-orders)/i.test(u))
      || urls.find(u => /amazon\.[a-z.]+/i.test(u))
      || urls.find(u => /amzn\.to/i.test(u))
      || null;
}

// Order date → YYYY-MM-DD; today if absent.
export function extractOrderDate(text, todayISO) {
  const today = todayISO || new Date().toISOString().slice(0, 10);
  if (!text) return today;
  const m = text.match(/order\s*(?:date|placed)\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i)
         || text.match(/order\s*(?:date|placed)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (m) {
    const d = new Date(m[1]);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return today;
}

// Parse a whole email into a plate-order payload, or null if it isn't an
// identifiable Amazon plate order. Strict: requires an order number AND a
// product-name match, so it never fires on unrelated Amazon purchases.
export function parseAmazonPlateEmail({ subject = '', text = '', html = '', todayISO } = {}) {
  const body = (text && text.trim()) ? text : stripHtml(html);
  const hay = (subject || '') + '\n' + body;
  if (!PLATE_MATCH.test(hay)) return null;            // not a plate order — ignore
  const orderNum = extractOrderNum(hay);
  if (!orderNum) return null;                         // can't key it idempotently — ignore

  const units = Math.max(0, extractUnits(body) || (PLATE_MATCH.test(body) ? 1 : 0));
  if (units <= 0) return null;

  const status = detectStatus(subject, body);
  return {
    amazon_order_num: orderNum,
    units,
    plates: units * PLATES_PER_UNIT,
    status,
    order_date: extractOrderDate(body, todayISO),
    delivered_date: status === 'delivered' ? (todayISO || new Date().toISOString().slice(0, 10)) : null,
    order_url: extractOrderUrl(body) || extractOrderUrl(html),
  };
}
