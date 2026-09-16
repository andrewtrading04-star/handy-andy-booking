// Supplier messages are durable evidence, never instructions to change stock.
// Unknown products, quantities, provenance and partial receipts require review.
import { createHash } from 'node:crypto';

export function stripHtml(html = '') {
  return String(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<img\b[^>]*\balt=(["'])([\s\S]*?)\1[^>]*>/gi, '\n$2\n')
    .replace(/<\/?(?:br|p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/[ \t]+/g, ' ');
}
const walmartDomain = domain => /^(?:[a-z0-9-]+\.)*walmart\.com$/i.test(domain || '');
const addressDomain = address => String(address || '').trim().toLowerCase().split('@')[1] || '';
export function extractOrderNum(text = '') { return (String(text).match(/\b(\d{7}-\d{8})\b/) || [])[1] || null; }
export function extractOrderUrl(text = '') {
  for (const m of String(text).matchAll(/https:\/\/[^\s<>"')]+/gi)) {
    try { const u = new URL(m[0].replace(/&amp;/g, '&'));
      if ((walmartDomain(u.hostname) && /^\/orders(?:\/|$)/i.test(u.pathname)) || u.hostname === 'w-mt.co') return u.href;
    } catch (_) {}
  }
  return null;
}

// The scanner passes only Gmail's own Authentication-Results header. Forwarded
// evidence additionally requires an explicitly configured forwarding account.
export function walmartProvenance({ from = '', text = '', html = '', authenticationResults = '', trustedForwarders = [] } = {}) {
  const passed = [...String(authenticationResults).matchAll(/dkim=pass\b[^;\r\n]*?header\.(?:d|i)=@?([a-z0-9.-]+)/gi)].map(m => m[1]);
  const senderDomain = addressDomain(from);
  if (walmartDomain(senderDomain) && passed.some(walmartDomain)) return { trusted: true, kind: 'authenticated_supplier' };
  const allowed = trustedForwarders.map(v => String(v).toLowerCase()).includes(String(from).toLowerCase());
  const forwardAuth = passed.some(d => d === senderDomain);
  const content = text + '\n' + stripHtml(html);
  const originalFrom = /(?:^|\n)\s*(?:>\s*)?from:\s*[^\n]*[<\s]([a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*walmart\.com)>?/im.test(content);
  if (allowed && forwardAuth && originalFrom && extractOrderUrl(text + '\n' + html)) return { trusted: true, kind: 'authenticated_forwarder' };
  return { trusted: false, kind: 'unverified_supplier' };
}

function productType(title) {
  // New products require catalog confirmation. No generic word such as "flat"
  // can turn unrelated purchases into brackets.
  if (!/\bonn\b/i.test(title) || !/\btv\b/i.test(title) || !/\bwall\s+mount\b/i.test(title)) return null;
  const type = (title.match(/\b(full[\s-]?motion|tilting|fixed|flat)\b/i) || [])[1];
  return type ? (/full/i.test(type) ? 'full_motion' : /tilting/i.test(type) ? 'tilting' : 'flat') : null;
}
export function extractBracketEvidence(text = '') {
  const quantities = { flat: 0, tilting: 0, full_motion: 0 }, items = [], issues = [];
  const add = (title, rawQty) => {
    const qty = Number(rawQty), type = productType(title);
    if (!type || !Number.isInteger(qty) || qty < 1 || qty > 100) { issues.push('unrecognized_item_or_quantity'); return; }
    const label = title.replace(/\s+/g, ' ').trim().slice(0,250);
    if (items.some(i => i.label === label)) { issues.push('duplicate_item_line'); return; }
    items.push({ type, quantity:qty, label }); quantities[type] += qty;
  };
  // Each quantity applies only to its own product block. A second item with a
  // different format remains visible and makes the evidence incomplete.
  const blocks = String(text).split(/(?=\bquantity\s+\d+\s+item\b)/i);
  for (const block of blocks) {
    const primary = block.match(/^quantity\s+(\d+)\s+item\b\s*([^\n]*(?:\n(?!\s*(?:onn|quantity|order total|subtotal|shipping|delivery address|payment|view order|includes all fees))[^\n]*)?)/i);
    let remainder = block;
    if (primary) { add(primary[2],primary[1]); remainder = block.slice(primary[0].length); }
    for (const line of remainder.split(/\r?\n/)) {
      if (!/\bwall\s+mount\b/i.test(line)) continue;
      const quantity = line.match(/\bqty\s*:?\s*(\d+)\b/i);
      if (!quantity) { issues.push('quantity_missing'); continue; }
      add(line.slice(0,quantity.index),quantity[1]);
    }
  }
  return { quantities, items, confidence:items.length && !issues.length ? 'explicit' : 'unknown', issues:[...new Set(issues)] };
}
export function extractBrackets(text) { const q = extractBracketEvidence(text).quantities; return { flat:q.flat, tilting:q.tilting, fullMotion:q.full_motion }; }

export function detectStatus(subject = '', text = '') {
  const s = subject.replace(/^(?:(?:re|fwd?):\s*)+/gi, '').trim();
  const lead = String(text).split(/\n\s*(?:-{2,}\s*(?:forwarded|original)|on .+wrote:)/i)[0].slice(0,1800);
  if (/\b(?:not|never|hasn't|wasn't)\s+(?:been\s+)?delivered\b/i.test(s + '\n' + lead)) return 'in_route';
  if (/^(?:your\s+)?order\b.{0,60}\b(?:was |has been |is )?cancel[le]*d\b/i.test(s) || /\b(?:your|this) order (?:has been |was |is )cancel[le]*d\b/i.test(lead)) return 'canceled';
  if (/^your (?:package (?:has )?arrived|(?:entire )?order (?:has been |was |is )?delivered)\b/i.test(s) || /\b(?:completed your delivery|your (?:entire |whole )?order (?:has been |was )delivered|all (?:your )?items (?:have been |were )delivered)\b/i.test(lead)) return 'delivered';
  return 'in_route';
}
function receiptScope(subject, text) {
  const value = subject.replace(/^(?:(?:re|fwd?):\s*)+/gi, '').trim() + '\n' + text.slice(0,1800);
  if (/\b(?:partial|some items|part of your order|remaining items|another package)\b/i.test(value)) return 'unknown';
  return /^your (?:entire )?order (?:has been |was |is )?delivered\b/i.test(value) || /\b(?:your (?:entire|whole) order|all (?:your )?items) (?:has been |have been |was |were )?delivered\b/i.test(value) ? 'complete' : 'unknown';
}
export function extractDeliveryAddress(text = '') {
  const m = String(text).match(/(\d{1,6}\s+[A-Za-z][A-Za-z0-9.\-#/ ]{1,69}?(?:,\s*(?:[A-Za-z]{1,10}\.?\s*)?#?[A-Za-z0-9-]{1,12})?,\s*[A-Za-z .'\-]{2,40}?,\s*[A-Z]{2}\.?,?\s*\d{5}(?:-\d{4})?)/);
  return m ? m[1].replace(/\s+/g,' ').trim() : null;
}
export function extractOrderTotal(text = '') {
  const m = String(text).match(/(?:includes all fees|order\s*total)[^$]{0,100}\$\s*([\d,]+\.\d{2})/i), value = m ? Number(m[1].replace(/,/g,'')) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}
export function extractOrderDate(text = '', sourceDate) {
  const m = String(text).match(/order\s*date\s*:?\s*((?:[A-Za-z]{3,9},?\s+)?[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (m && Number.isFinite(Date.parse(m[1]))) return new Date(m[1]).toISOString().slice(0,10);
  return sourceDate && Number.isFinite(Date.parse(sourceDate)) ? new Date(sourceDate).toISOString().slice(0,10) : null;
}
export function extractArrivesDate(text = '', baseISO) {
  const m = String(text).match(/(?:arriv(?:es|ing)|estimated\s+delivery|expected\s+delivery|delivery\s+(?:by|date))\b[^A-Za-z0-9]{0,6}(?:[A-Za-z]{3,9}\.?,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if (!m) return null;
  const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].slice(0,3).toLowerCase());
  if (month < 0 || !baseISO || !Number.isFinite(Date.parse(baseISO))) return null;
  const base = new Date(baseISO), day = +m[2]; let year = m[3] ? +m[3] : base.getUTCFullYear();
  if (!m[3] && month < base.getUTCMonth() - 1) year++;
  const date = new Date(Date.UTC(year,month,day));
  return date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString().slice(0,10) : null;
}

export function parseWalmartEmails(input = {}) {
  const { subject = '', text = '', html = '', messageId = '', emailDateISO = null } = input;
  const bodies = [text,stripHtml(html)].filter(Boolean);
  const nums = [...new Set((subject + '\n' + bodies.join('\n')).match(/\b\d{7}-\d{8}\b/g) || [])];
  if (!nums.length) return [];
  const provenance = walmartProvenance(input);
  if (!provenance.trusted && !walmartDomain(addressDomain(input.from)) && !/\bwalmart\b/i.test(subject + '\n' + text + '\n' + html)) return [];
  return nums.map(orderNum => {
    const issues = [];
    if (!provenance.trusted) issues.push('supplier_unverified');
    if (nums.length > 1) issues.push('multiple_orders_in_message');
    const representations = bodies.map(body => {
      if (nums.length === 1) return body;
      const start = body.indexOf(orderNum); if (start < 0) return '';
      const tail = body.slice(start + orderNum.length), next = tail.search(/\b\d{7}-\d{8}\b/);
      return body.slice(start,next < 0 ? undefined : start + orderNum.length + next);
    });
    const evidence = representations.map(extractBracketEvidence), explicit = evidence.filter(e => e.confidence === 'explicit');
    if (explicit.length > 1 && explicit.some(e => JSON.stringify(e.quantities) !== JSON.stringify(explicit[0].quantities))) issues.push('body_quantity_conflict');
    const best = explicit[0] || evidence.find(e => e.items.length) || evidence[0] || { quantities:{flat:0,tilting:0,full_motion:0},items:[],confidence:'unknown',issues:[] };
    if (best.confidence !== 'explicit') issues.push(...best.issues);
    const body = representations.find((_,i) => evidence[i] === best) || representations[0] || '';
    const status = detectStatus(subject,body), scope = status === 'delivered' ? receiptScope(subject,body) : 'unknown';
    const confirmation = /(?:thanks for (?:your )?(?:delivery )?order|order confirmation|we(?:'ve| have) received your order)/i.test(subject);
    const eventKind = status === 'delivered' ? 'receipt' : status === 'canceled' ? 'cancellation' : confirmation ? 'confirmation' : /\b(?:shipped|on its way|arrives|arriving|preparing)\b/i.test(subject) ? 'shipment' : 'unknown';
    // Forwarding today does not turn an old receipt into a new physical event.
    const originalDate = provenance.kind === 'authenticated_forwarder' ? (body.match(/(?:^|\n)\s*(?:>\s*)?date:\s*([^\n]+)/i) || [])[1] : emailDateISO;
    const occurredAt = originalDate && Number.isFinite(Date.parse(originalDate)) ? new Date(originalDate).toISOString() : null;
    if (!occurredAt) issues.push('source_date_missing');
    if (status === 'delivered' && scope === 'unknown') issues.push('receipt_scope_unconfirmed');
    if (confirmation && best.confidence !== 'explicit') issues.push('order_quantities_unconfirmed');
    if (eventKind === 'unknown') issues.push('supplier_event_unrecognized');
    const authoritative = provenance.trusted && nums.length === 1 && best.confidence === 'explicit' && !issues.includes('body_quantity_conflict');
    const sourceKey = messageId.trim() || createHash('sha256').update(subject + '\n' + text + '\n' + html).digest('hex');
    return {
      walmart_order_num:orderNum, event_id:'walmart-mail:' + createHash('sha256').update(sourceKey + ':' + orderNum).digest('hex'),
      occurred_at:occurredAt, source:'walmart_email', provenance,
      ordered:confirmation && authoritative ? best.quantities : null,
      received:status === 'delivered' && scope === 'complete' && authoritative ? best.quantities : null,
      receipt_scope:scope, receipt_verified:provenance.trusted && nums.length === 1 && scope === 'complete' && !issues.includes('body_quantity_conflict'),
      quantities_confidence:authoritative ? 'explicit' : 'unknown', status,event_kind:eventKind,
      order_date:confirmation ? extractOrderDate(body,occurredAt) : extractOrderDate(body,null),
      delivered_date:status === 'delivered' && occurredAt ? occurredAt.slice(0,10) : null,
      estimated_delivery:extractArrivesDate(body,occurredAt), order_url:extractOrderUrl(body) || (nums.length === 1 ? extractOrderUrl(html) : null),
      delivery_address:extractDeliveryAddress(body), order_total:extractOrderTotal(body),
      evidence:{ message_id:messageId || null, subject:subject.slice(0,300), provenance:provenance.kind, items:best.items, issues:[...new Set(issues)] },
      review_reason:issues.length ? [...new Set(issues)].join(', ') : null,
    };
  });
}
export function parseWalmartEmail(input) { return parseWalmartEmails(input)[0] || null; }
