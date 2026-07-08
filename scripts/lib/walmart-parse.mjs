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
  // Walmart's delivery email: subject "Your package arrived", body "<driver>
  // completed your delivery from store at …". Note "delivery order" (the
  // confirmation) and "arrives" (an ETA) must NOT read as delivered.
  if (/\bdelivered\b|has been delivered|was delivered|delivery complete|package (?:has )?arrived|completed your delivery/i.test(s)) return 'delivered';
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

// Delivery address from the order email — the line carrying street, city, ST,
// ZIP (e.g. "10507 Vaughn St, Commerce City, CO, 80022, USA"). Bracket orders
// ship to a tech's home, so this is how we auto-assign the order to that tech.
// Loose on formatting on purpose: the downstream match is strict (street number
// AND ZIP must equal a known tech), so a stray/incorrect capture simply doesn't
// match anyone and the order stays unassigned — never mis-assigned.
export function extractDeliveryAddress(text) {
  if (!text) return null;
  // Street number, then a name that STARTS with a letter (so a stray number at
  // the end of the previous line — "Arrives Jul 7" — can't become the number),
  // then an OPTIONAL apartment/unit field the email sometimes splits into its own
  // comma section ("…Ave, Apt 8T, Denver…"). The apt part must contain a digit so
  // it can never swallow the city (which has none), then city, ST, ZIP.
  const m = text.match(/(\d{1,6}\s+[A-Za-z][A-Za-z0-9.\-#/ ]{1,49}?(?:,\s*(?:[A-Za-z]{1,8}\.?\s*)?#?\d[A-Za-z0-9\- ]{0,8})?,\s*[A-Za-z .'\-]{2,40}?,\s*[A-Z]{2}\.?,?\s*\d{5}(?:-\d{4})?)/);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
}

// Order total (what we paid) from the email — "Order total … $178.61" or
// "Includes all fees, taxes and discounts $178.61". Anchored to those labels so
// it doesn't grab a per-item price; returns null if no labeled total is found.
export function extractOrderTotal(text) {
  if (!text) return null;
  const m = text.match(/includes all fees[^$]*\$\s*([\d,]+\.\d{2})/i)
         || text.match(/order\s*total[^$]{0,60}?\$\s*([\d,]+\.\d{2})/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

// Estimated arrival → YYYY-MM-DD. Walmart order/shipping emails carry an
// "Arrives <Mon DD>" (sometimes "Arriving …" / "Estimated delivery …") line.
// The year is usually omitted, so we anchor to the order date's year and roll to
// next year if the month already passed (a late-Dec order arriving in Jan).
// Returns null when no arrival line is present.
export function extractArrivesDate(text, orderISO) {
  if (!text) return null;
  const m = text.match(/(?:arriv(?:es|ing)|estimated\s+delivery|expected\s+delivery|delivery\s+(?:by|date))\b[^A-Za-z0-9]{0,12}([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (!m) return null;
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const mon = months[m[1].slice(0, 3).toLowerCase()];
  if (mon == null) return null;
  const day = parseInt(m[2], 10);
  if (!(day >= 1 && day <= 31)) return null;
  const base = orderISO && /^\d{4}-\d{2}-\d{2}$/.test(orderISO) ? orderISO : new Date().toISOString().slice(0, 10);
  let year = m[3] ? parseInt(m[3], 10) : parseInt(base.slice(0, 4), 10);
  if (!m[3]) {
    const orderMon = parseInt(base.slice(5, 7), 10) - 1;
    if (mon < orderMon - 1) year += 1; // arrival month well before order month → next year
  }
  const d = new Date(Date.UTC(year, mon, day));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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
// Parse a whole email into an ARRAY of order payloads. A forwarded Walmart
// "conversation" can bundle several orders in one message; each order has its
// own "Order number:" marker followed by its own item list. We segment the body
// at those markers and parse each segment independently, so items never bleed
// from one order into another. Returns [] if no Walmart order is found.
export function parseWalmartEmails({ subject = '', text = '', html = '', todayISO } = {}) {
  // Use ONE body representation. An email carries the same items in both
  // text/plain and text/html — concatenating them would double-count every
  // line. Prefer plaintext; fall back to stripped HTML only when absent.
  const body = (text && text.trim()) ? text : stripHtml(html);
  const today = todayISO || new Date().toISOString().slice(0, 10);

  // Every "Order number: #XXXXXXX-XXXXXXXX" marker and where it starts.
  const markerRe = /order\s*(?:number|#)\s*:?\s*#?(\d{7}-\d{8})/gi;
  const markers = [];
  let m;
  while ((m = markerRe.exec(body))) markers.push({ num: m[1], index: m.index });

  // No labeled marker — fall back to a single bare order number anywhere.
  if (!markers.length) {
    const num = extractOrderNum(subject + '\n' + body);
    if (!num) return [];
    markers.push({ num, index: 0 });
  }

  const out = [];
  for (let i = 0; i < markers.length; i++) {
    // An order's items live between its marker and the next order's marker.
    const seg = body.slice(markers[i].index, (i + 1 < markers.length) ? markers[i + 1].index : body.length);
    const { flat, tilting, fullMotion } = extractBrackets(seg);
    const status = detectStatus(subject, seg);
    const orderDate = extractOrderDate(seg, today);
    out.push({
      walmart_order_num: markers[i].num,
      flat_qty: flat,
      tilting_qty: tilting,
      full_motion_qty: fullMotion,
      status,
      order_date: orderDate,
      estimated_delivery: extractArrivesDate(seg, orderDate) || extractArrivesDate(body, orderDate),
      delivered_date: status === 'delivered' ? today : null,
      order_url: extractOrderUrl(seg) || extractOrderUrl(html),
      delivery_address: extractDeliveryAddress(seg) || extractDeliveryAddress(body),
      order_total: extractOrderTotal(seg) || extractOrderTotal(body),
    });
  }
  return out;
}

// Back-compat single-order helper: first order found, or null.
export function parseWalmartEmail(input) {
  const all = parseWalmartEmails(input);
  return all.length ? all[0] : null;
}
