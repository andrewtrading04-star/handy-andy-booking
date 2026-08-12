// /api/_lib/broker-spec.js
// Working out WHICH priced options a brokered TV mount actually needs, and
// what the customer's quote looks like once it is brokered.
//
// A mount prices off three things: the size tier, the bracket, and the wire
// concealment. The estimate already names them in its own line items, but only
// as free text ("TV Size: 60\"-69\""), and the catalog labels get edited over
// time -- a real Aug 11 estimate still reads "Yes, hide the wires OUTSIDE the
// wall" while app.widget_prices now says "Hide wires OUTSIDE the wall". So the
// match here is BEST EFFORT and always correctable in the UI. It is never
// allowed to silently decide a price on its own.

export const BROKER_SECTIONS = [
  { key: 'size',    label: 'TV size',          prefixes: ['tv size', 'size'] },
  { key: 'bracket', label: 'Bracket',          prefixes: ['bracket'] },
  { key: 'wires',   label: 'Wire concealment', prefixes: ['wire hiding', 'wires', 'wire'] },
];

// Curly quotes, en/em dashes and punctuation all vary between the widget
// catalog and what got frozen into an old estimate's line items.
export function brokerNorm(s) {
  return String(s || '').toLowerCase()
    .replace(/[‘’“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s) { return new Set(brokerNorm(s).split(' ').filter(Boolean)); }

// Jaccard overlap. "yes hide the wires outside the wall" vs "hide wires
// outside the wall" scores ~0.83, while the BEHIND variant scores ~0.57, so
// the right one wins even after the rename.
export function brokerSimilarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Best catalog option for a free-text value, or null when nothing is close
// enough to be worth guessing.
export function brokerBestMatch(text, options) {
  if (!text) return null;
  const flat = brokerNorm(text).replace(/ /g, '');
  const exact = (options || []).find(o => brokerNorm(o.label).replace(/ /g, '') === flat);
  if (exact) return exact;
  let best = null, bestScore = 0;
  for (const o of (options || [])) {
    const s = brokerSimilarity(text, o.label);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return bestScore >= 0.4 ? best : null;
}

// Pull "TV Size: 60\"-69\"" style values out of an estimate's line items.
export function brokerValueFor(section, lineItems) {
  for (const it of (Array.isArray(lineItems) ? lineItems : [])) {
    const desc = String((it && it.description) || '');
    const idx = desc.indexOf(':');
    if (idx < 0) continue;
    const head = brokerNorm(desc.slice(0, idx));
    if (section.prefixes.some(p => head === brokerNorm(p))) return desc.slice(idx + 1).trim();
  }
  return null;
}

// Which option each section resolves to. A saved choice always wins over the
// guess; an unmatched section stays null so the UI asks rather than assumes.
export function brokerResolveSpec(est, catalog) {
  const saved = (est && est.broker_spec && typeof est.broker_spec === 'object') ? est.broker_spec : {};
  const items = (est && est.line_items) || [];
  const spec = {};
  for (const s of BROKER_SECTIONS) {
    const options = (catalog && catalog[s.key]) || [];
    if (saved[s.key] && options.some(o => o.row_key === saved[s.key])) { spec[s.key] = saved[s.key]; continue; }
    const hit = brokerBestMatch(brokerValueFor(s, items), options);
    spec[s.key] = hit ? hit.row_key : null;
  }
  // Carry the office's custom scope lines through. This object is rebuilt from
  // scratch on every load, so anything not copied here is silently lost.
  spec.custom = normalizeCustomLines(saved.custom);
  return spec;
}

// Extra scope this particular job needs that the widget catalog does not
// cover: "haul away the old mount", "second TV", "scaffold for a 20ft wall".
// Job-specific free text, so unlike the three catalog sections these are NOT
// written to a company's reusable rate card -- they live on the estimate, and
// each company's price for them lives on that company's bid.
export const MAX_CUSTOM_LINES = 8;

// Stable ids matter: a company's typed price is keyed to the line's id, so
// renaming or reordering lines must not silently move prices between them.
export function normalizeCustomLines(raw) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(raw) ? raw : [])) {
    const label = String((item && item.label) || '').trim().slice(0, 120);
    if (!label) continue;                       // a blank row is a deleted row
    let id = String((item && item.id) || '').trim().slice(0, 40);
    if (!id || seen.has(id)) {
      // New line, or a duplicated id we cannot trust. Derive a fresh one that
      // does not collide with the fixed section keys.
      let n = out.length + 1;
      do { id = `custom_${n++}`; } while (seen.has(id));
    }
    seen.add(id);
    out.push({ id, label });
    if (out.length >= MAX_CUSTOM_LINES) break;
  }
  return out;
}

// The custom lines currently on an estimate. Anything a bid priced that is no
// longer here has been deleted and must stop counting toward a total.
export function customLinesOf(spec) {
  return normalizeCustomLines(spec && spec.custom);
}

// Every line a company has to price for this job: the three catalog sections
// plus whatever custom lines the office added. One list so the total, the
// completeness check and the UI can never disagree about what is required.
export function brokerRequiredLines(spec) {
  const fixed = BROKER_SECTIONS.map(s => ({ key: s.key, label: s.label, custom: false, row_key: (spec && spec[s.key]) || null }));
  const custom = customLinesOf(spec).map(c => ({ key: c.id, label: c.label, custom: true, row_key: c.id }));
  return fixed.concat(custom);
}

// The customer's quote for a brokered job: ONE line at the sell price.
//
// This REPLACES the estimate's own itemization rather than adding to it. That
// itemization is our pricing for a job we are not doing ourselves, and leaving
// it in place adds to the brokered price instead of replacing it: a 254 dollar
// itemized LA quote plus a 652 dollar brokered line quoted the customer 906.
// Both estimate senders total line_items, so this function decides what the
// customer is actually charged.
export function brokerQuoteLineItems(serviceLabel, sellPrice) {
  return [{
    description: serviceLabel || 'Scheduled service',
    qty: 1,
    unit_price: sellPrice,
    broker: true,
  }];
}
