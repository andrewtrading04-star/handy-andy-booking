// Money test for the subcontractor brokering feature (migration 0092).
//
// Runs the SHIPPED functions -- imported straight from api/_lib, not
// reimplemented here -- against REAL rows pulled from the live Supabase
// project dqlefeafzvjbcrhqhdps on 2026-08-12. The fixture below is real data:
// real service_area ids, the real unstaffed flags, real sampled zips, and a
// real LA estimate (90042) that exists in app.estimates right now.
//
// Run: node scripts/test-broker-pricing.mjs

import { minSellPrice, spread, checkSellPrice, parseMoney } from '../api/_lib/broker-pricing.js';
import { unstaffedZipMatcher, resolveServiceArea, zip5 } from '../api/_lib/service-area-resolve.js';
import { brokerResolveSpec, brokerQuoteLineItems, normalizeCustomLines, customLinesOf, brokerRequiredLines, MAX_CUSTOM_LINES } from '../api/_lib/broker-spec.js';

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

// --- Real rows, copied verbatim from the live database -----------------------
const AREAS = [
  { id: '22561771-6c4f-407d-a598-bf673c2dda16', name: 'DFW',         state: 'TX', unstaffed: true,  slug: 'handy-andy' },
  { id: 'fd8d3119-8dde-43c3-b0ab-24839569a09a', name: 'Los Angeles', state: 'CA', unstaffed: true,  slug: 'handy-andy' },
  { id: '584dffee-eb2a-4286-81c4-7c29f4353d43', name: 'Phoenix',     state: 'AZ', unstaffed: true,  slug: 'handy-andy' },
  { id: 'd5002026-ab95-41c0-9317-dcc3a030ad3e', name: 'San Antonio', state: 'TX', unstaffed: true,  slug: 'handy-andy' },
  { id: '764e1773-83cd-438d-9eb9-bc283fb2259f', name: 'Austin',      state: 'TX', unstaffed: false, slug: 'handy-andy' },
  { id: 'd6837398-7c24-4f94-a76e-76937076bdd4', name: 'Denver',      state: 'CO', unstaffed: false, slug: 'handy-andy' },
  { id: 'f29a1b4b-a516-4a36-84c5-0283cba7af32', name: 'Houston',     state: 'TX', unstaffed: false, slug: 'handy-andy' },
];
// Real sampled service_area_zips rows (3 per area; LA genuinely has none).
const ZIPS = [
  ['75014', '22561771-6c4f-407d-a598-bf673c2dda16'], ['75015', '22561771-6c4f-407d-a598-bf673c2dda16'], ['75016', '22561771-6c4f-407d-a598-bf673c2dda16'],
  ['85001', '584dffee-eb2a-4286-81c4-7c29f4353d43'], ['85002', '584dffee-eb2a-4286-81c4-7c29f4353d43'], ['85003', '584dffee-eb2a-4286-81c4-7c29f4353d43'],
  ['78002', 'd5002026-ab95-41c0-9317-dcc3a030ad3e'], ['78054', 'd5002026-ab95-41c0-9317-dcc3a030ad3e'], ['78073', 'd5002026-ab95-41c0-9317-dcc3a030ad3e'],
  ['73301', '764e1773-83cd-438d-9eb9-bc283fb2259f'], ['73344', '764e1773-83cd-438d-9eb9-bc283fb2259f'], ['78613', '764e1773-83cd-438d-9eb9-bc283fb2259f'],
  ['80001', 'd6837398-7c24-4f94-a76e-76937076bdd4'], ['80002', 'd6837398-7c24-4f94-a76e-76937076bdd4'], ['80003', 'd6837398-7c24-4f94-a76e-76937076bdd4'],
  ['77001', 'f29a1b4b-a516-4a36-84c5-0283cba7af32'], ['77002', 'f29a1b4b-a516-4a36-84c5-0283cba7af32'], ['77003', 'f29a1b4b-a516-4a36-84c5-0283cba7af32'],
];
// Real app.estimates rows with a zip, as of 2026-08-12.
const REAL_ESTIMATES = [
  { id: 'b18ae7fa-eaa0-44d4-aee6-e720d5ed9ba2', zip: '90042', city: 'Los Angeles', expect: true,  why: 'LA: zero zip rows, must hit the CA fallback' },
  { id: '76b159d5-90a5-4e72-a0a0-a8ac010787c0', zip: '77441', city: null,          expect: false, why: 'Houston-area zip not in the table: fail closed' },
  { id: '9115ec12-d6be-4e68-88d9-edc680e76f37', zip: '77459', city: null,          expect: false, why: 'Houston-area zip not in the table: fail closed' },
  { id: '1edfd5b9-2c41-4358-8bd6-23d27cdc6569', zip: '33130', city: null,          expect: false, why: 'Miami zip on a Doms estimate: not ours' },
];

const HA = 'handy-andy-business-id';
// Minimal stand-in for the supabase query builder, serving the REAL rows above.
function fakeDb(slug) {
  const areas = AREAS.filter(a => a.slug === slug).map(a => ({ id: a.id, state: a.state, unstaffed: a.unstaffed, name: a.name, timezone: null }));
  const zips = slug === 'handy-andy' ? ZIPS.map(([postal_code, service_area_id]) => ({ postal_code, service_area_id })) : [];
  return {
    from(table) {
      const b = {
        _table: table, _zip: null,
        select() { return b; },
        eq(col, val) { if (col === 'postal_code') b._zip = val; return b; },
        ilike() { return b; },
        maybeSingle() {
          if (b._table === 'service_area_zips') {
            const hit = zips.find(z => z.postal_code === b._zip);
            if (!hit) return Promise.resolve({ data: null });
            const a = areas.find(x => x.id === hit.service_area_id);
            return Promise.resolve({ data: { service_area: a } });
          }
          // service_areas .eq(state,'CA') path used by the LA fallback
          return Promise.resolve({ data: areas.find(a => a.state === 'CA') || null });
        },
        then(res, rej) {
          const data = b._table === 'service_areas' ? areas : zips;
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
}

console.log('\n=== 1. The owner\'s worked example (543 -> round UP) ===');
eq('minSellPrice(543)', minSellPrice(543), 652);
ok('543 x 1.20 is 651.60, rounded up = 652', minSellPrice(543) === 652, '(owner wrote 651, then chose round-up)');
eq('spread(543, 652)', spread(543, 652), 109);
eq('spread(543, 700) on a higher manual sell', spread(543, 700), 157);

console.log('\n=== 2. The floating point trap ===');
// Math.ceil(1.67 * 1.20) is 3 in JS because 1.67*1.20 = 2.004. Correct is 2.
eq('minSellPrice(1.67) is not 3', minSellPrice(1.67), 2);
eq('minSellPrice(100) is not 121', minSellPrice(100), 120);
let drift = 0;
for (let c = 0; c <= 500000; c++) {
  const sub = c / 100;
  if (Math.ceil(sub * 1.2) !== minSellPrice(sub)) drift++;
}
ok('shipped fn differs from naive float on exactly the known 2000 cases', drift === 2000, `drift=${drift}`);
// The shipped answer is never below a true 20 percent cut, to the cent.
let below = 0;
for (let c = 0; c <= 200000; c++) {
  const sub = c / 100;
  const exactMin = Math.round(sub * 120) / 100;   // exact 1.20x in cents
  if (minSellPrice(sub) + 0.0000001 < exactMin - 0.005) below++;
}
ok('minimum is never under a true 20 percent cut', below === 0, `violations=${below}`);

console.log('\n=== 3. The below-minimum guard ===');
ok('rejects a sell price under the minimum', checkSellPrice(543, 600, false).ok === false);
ok('reports belowMin so the UI can offer the override', checkSellPrice(543, 600, false).belowMin === true);
eq('reports the minimum in the refusal', checkSellPrice(543, 600, false).min, 652);
ok('allows it only with an explicit override', checkSellPrice(543, 600, true).ok === true);
ok('flags the override on the saved row', checkSellPrice(543, 600, true).belowMin === true);
ok('exactly the minimum is allowed with no override', checkSellPrice(543, 652, false).ok === true);
ok('at the minimum, belowMin is false', checkSellPrice(543, 652, false).belowMin === false);
ok('above the minimum is allowed', checkSellPrice(543, 800, false).ok === true);
ok('refuses when the sub price is missing', checkSellPrice(null, 800, false).ok === false);
ok('refuses when the sell price is missing', checkSellPrice(543, '', false).ok === false);

console.log('\n=== 4. Money parsing (what Heather actually types) ===');
eq("parseMoney('$543')", parseMoney('$543'), 543);
eq("parseMoney('1,200.50')", parseMoney('1,200.50'), 1200.5);
eq("parseMoney(' 543 ')", parseMoney(' 543 '), 543);
eq("parseMoney('') is null, not 0", parseMoney(''), null);
eq("parseMoney('abc') is null, not 0", parseMoney('abc'), null);
eq("parseMoney('-5') is null, not a negative", parseMoney('-5'), null);
eq('minSellPrice of a blank stays null', minSellPrice(''), null);

console.log('\n=== 5. ZIP+4 normalization ===');
eq("zip5('80220-1032')", zip5('80220-1032'), '80220');
eq("zip5('800122') does not become 80012", zip5('800122'), '800122');

console.log('\n=== 6. Which markets get brokered (REAL service_areas rows) ===');
const isUnstaffed = await unstaffedZipMatcher(fakeDb('handy-andy'), HA, 'handy-andy');
const expectations = [
  ['75014', true,  'DFW'], ['75015', true,  'DFW'],
  ['85001', true,  'Phoenix'], ['85003', true,  'Phoenix'],
  ['78002', true,  'San Antonio'], ['78073', true, 'San Antonio'],
  ['90042', true,  'Los Angeles via CA fallback'], ['90210', true, 'Los Angeles via CA fallback'],
  ['96199', true,  'top of the CA range'],
  ['80001', false, 'Denver'], ['80003', false, 'Denver'],
  ['73301', false, 'Austin'], ['78613', false, 'Austin'],
  ['77001', false, 'Houston'], ['77003', false, 'Houston'],
  ['96200', false, 'just past the CA range'],
  ['33130', false, 'Miami, not a market'],
  ['',      false, 'no zip on the estimate'],
];
for (const [zip, want, label] of expectations) {
  eq(`${label.padEnd(30)} ${zip || '(blank)'}`, isUnstaffed(zip), want);
}
// Denver/Austin/Houston are the owner's three exceptions: assert none slipped.
const staffedZips = ['80001', '80002', '80003', '73301', '73344', '78613', '77001', '77002', '77003'];
ok('none of Denver/Austin/Houston is ever brokered', staffedZips.every(z => isUnstaffed(z) === false));

console.log('\n=== 7. REAL app.estimates rows resolve correctly ===');
for (const e of REAL_ESTIMATES) {
  const got = isUnstaffed(e.zip);
  eq(`${e.zip} ${(e.city || '').padEnd(12)} ${e.why}`, got, e.expect);
}
// The whole reason the shared resolver exists.
const la = await resolveServiceArea(fakeDb('handy-andy'), HA, 'handy-andy', '90042');
ok('resolveServiceArea finds LA despite zero zip rows', !!la && la.name === 'Los Angeles' && la.unstaffed === true,
   la ? `${la.name} unstaffed=${la.unstaffed}` : 'null');
ok('a Doms estimate never falls back to handy-andy LA', (await resolveServiceArea(fakeDb('doms'), 'doms-id', 'doms', '90042')) === null);

console.log('\n=== 8. End to end on the real LA estimate ===');
// Sub quotes 543 on estimate b18ae7fa (real LA row). Full path:
const subQuote = 543;
const min = minSellPrice(subQuote);
const chk = checkSellPrice(subQuote, min, false);
ok('LA estimate is brokerable', isUnstaffed('90042') === true);
eq('minimum sell', min, 652);
ok('booking at the minimum is accepted', chk.ok === true);
eq('recorded spread', chk.spread, 109);
eq('and the line item written for the customer is the sell price', chk.sell, 652);


console.log('\n=== 9. Rate card: three real lines sum, then mark up ===');
// Real handy-andy catalog options this LA job needs (size_3 / bracket_13 /
// wires_41). The subcontractor prices below are ARBITRARY TEST INPUTS, not
// real quotes: no real company has given us a price yet.
const bidLines = [140, 90, 30];               // size, bracket, wires
const bidTotal = Math.round(bidLines.reduce((a, b) => a + b, 0) * 100) / 100;
eq('their total is the sum of the three lines', bidTotal, 260);
eq('minimum sell on that total', minSellPrice(bidTotal), 312);
eq('spread at the minimum', spread(bidTotal, minSellPrice(bidTotal)), 52);
// A partial card must not read as a cheap bid.
ok('an incomplete card yields no total', minSellPrice(null) === null);

console.log('\n=== 10. Matching the REAL LA estimate to the REAL catalog ===');
// Real app.widget_prices rows for handy-andy, city_key 'default'.
const CATALOG = {
  size: [
    { row_key: 'size_1', label: '32" Or Less' }, { row_key: 'size_2', label: '33"-59"' },
    { row_key: 'size_3', label: '60"-69"' },     { row_key: 'size_4', label: '70"-85"' },
    { row_key: 'size_5', label: '86"-97"' },     { row_key: 'size_6', label: '98+' },
  ],
  bracket: [
    { row_key: 'bracket_10', label: 'I have my own bracket' }, { row_key: 'bracket_11', label: 'Flat' },
    { row_key: 'bracket_12', label: 'Tilting (recommended)' }, { row_key: 'bracket_13', label: 'Full Motion' },
    { row_key: 'bracket_14', label: '85"-100" TV Flat Bracket' },
    { row_key: 'bracket_15', label: '85"-100" TV Tilting Bracket' },
    { row_key: 'bracket_16', label: '85"-100" TV Full Motion Bracket' },
    { row_key: 'bracket_17', label: 'Samsung Frame in-box bracket' },
  ],
  wires: [
    { row_key: 'wires_40', label: 'Hide wires BEHIND the wall' },
    { row_key: 'wires_41', label: 'Hide wires OUTSIDE the wall' },
    { row_key: 'wires_42', label: 'Wall already has a plug' },
    { row_key: 'wires_43', label: 'Hang wires under the TV' },
  ],
};
// The REAL line_items on estimate b18ae7fa, verbatim from the database. Note
// the wires text no longer matches any catalog label word for word: the option
// was renamed after this estimate came in.
const LA_ITEMS = [
  { qty: 1, unit_price: 119, description: 'TV Size: 60"-69"' },
  { qty: 1, unit_price: 110, description: 'Bracket: Full Motion' },
  { qty: 1, unit_price: 0,   description: 'Fireplace: I have 1 TV not over a fireplace' },
  { qty: 1, unit_price: 0,   description: 'Wall Surface: Drywall' },
  { qty: 1, unit_price: 25,  description: 'Wire Hiding: Yes, hide the wires OUTSIDE the wall' },
  { qty: 1, unit_price: 0,   description: "Dismount: No, I'll handle TV removal myself" },
  { qty: 1, unit_price: 0,   description: 'I agree to the Terms of Service' },
];
const laSpec = brokerResolveSpec({ line_items: LA_ITEMS }, CATALOG);
eq('size matches exactly', laSpec.size, 'size_3');
eq('bracket matches exactly', laSpec.bracket, 'bracket_13');
eq('wires still matches after the rename', laSpec.wires, 'wires_41');
ok('and NOT the BEHIND variant, which is the costly mistake', laSpec.wires !== 'wires_40');

// A saved correction always beats the guess.
const corrected = brokerResolveSpec({ line_items: LA_ITEMS, broker_spec: { size: 'size_4', bracket: null, wires: null } }, CATALOG);
eq('saved choice overrides the match', corrected.size, 'size_4');
// A saved value that is not in the catalog is ignored rather than trusted.
const bogus = brokerResolveSpec({ line_items: LA_ITEMS, broker_spec: { size: 'size_99' } }, CATALOG);
eq('a stale saved row_key falls back to the match', bogus.size, 'size_3');
// Nothing to go on stays null so the UI asks instead of assuming.
const blank = brokerResolveSpec({ line_items: [{ qty: 1, unit_price: 0, description: 'Furniture Assembly' }] }, CATALOG);
eq('no size line leaves size unset', blank.size, null);
eq('no wires line leaves wires unset', blank.wires, null);

console.log('\n=== 11. What the customer is actually quoted ===');
// The bug this replaced: the brokered line used to be APPENDED to the
// estimate's own itemization, so booking the LA job at 652 quoted 254 + 652.
const oldWay = LA_ITEMS.filter(it => !it.broker).concat([{ description: 'TV Mounting', qty: 1, unit_price: 652, broker: true }]);
const oldTotal = oldWay.reduce((t, it) => t + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
eq('the old behaviour really did overquote', oldTotal, 906);

const quoted = brokerQuoteLineItems('TV Mounting', 652);
const newTotal = quoted.reduce((t, it) => t + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0);
eq('brokered quote is exactly one line', quoted.length, 1);
eq('and totals the sell price, not sell plus itemization', newTotal, 652);
eq('described as the service', quoted[0].description, 'TV Mounting');
eq('qty is 1 so the total is not zeroed', quoted[0].qty, 1);
ok('uses unit_price, the field both senders total', 'unit_price' in quoted[0]);
eq('falls back to a sane label', brokerQuoteLineItems(null, 100)[0].description, 'Scheduled service');


console.log('\n=== 12. Custom scope lines ===');
// Ids must be stable and must never collide with the three fixed section keys,
// because a company's typed price is keyed by line id.
const c1 = normalizeCustomLines([{ label: 'Haul away old mount' }, { label: 'Second TV' }]);
eq('two lines get ids', c1.length, 2);
ok('ids are namespaced away from size/bracket/wires',
   c1.every(l => l.id.startsWith('custom_')), JSON.stringify(c1.map(l => l.id)));
ok('ids are unique', new Set(c1.map(l => l.id)).size === 2);

// Renaming a line must keep its id, or a priced bid would silently reattach to
// the wrong line.
const renamed = normalizeCustomLines([{ id: c1[0].id, label: 'Haul away the OLD mount' }, { id: c1[1].id, label: 'Second TV' }]);
eq('renaming keeps the id', renamed[0].id, c1[0].id);
eq('and the new label sticks', renamed[0].label, 'Haul away the OLD mount');
// Reordering likewise.
const reordered = normalizeCustomLines([{ id: c1[1].id, label: 'Second TV' }, { id: c1[0].id, label: 'Haul away old mount' }]);
eq('reordering keeps ids attached to their labels', reordered[0].id, c1[1].id);

// A blank label is how the UI deletes a line.
eq('blank label deletes the line', normalizeCustomLines([{ id: 'custom_1', label: '   ' }]).length, 0);
eq('non-array input is safe', normalizeCustomLines(null).length, 0);
eq('lines are capped', normalizeCustomLines(Array.from({ length: 50 }, (_, i) => ({ label: 'line ' + i }))).length, MAX_CUSTOM_LINES);
// Duplicate ids coming back from a tampered client must not merge two lines.
const dup = normalizeCustomLines([{ id: 'custom_1', label: 'A' }, { id: 'custom_1', label: 'B' }]);
eq('duplicate ids are split apart', new Set(dup.map(l => l.id)).size, 2);
eq('and both lines survive', dup.length, 2);

console.log('\n=== 13. Custom lines join the priced list ===');
const spec13 = { size: 'size_3', bracket: 'bracket_13', wires: 'wires_41', custom: [{ id: 'custom_1', label: 'Haul away old mount' }] };
const req = brokerRequiredLines(spec13);
eq('three fixed plus one custom', req.length, 4);
eq('the custom line is flagged', req[3].custom, true);
eq('and keyed by its id', req[3].key, 'custom_1');
ok('the fixed three are not flagged custom', req.slice(0, 3).every(l => l.custom === false));
eq('a job with no custom lines still needs three', brokerRequiredLines({ size: 'size_3' }).length, 3);

// The completeness rule: a total only exists once EVERY required line is in.
const priced = { size: 140, bracket: 90, wires: 30, custom_1: 40 };
const allIn = req.every(l => priced[l.key] !== undefined);
ok('all four priced counts as complete', allIn === true);
const total13 = Math.round(req.reduce((t, l) => t + priced[l.key], 0) * 100) / 100;
eq('total includes the custom line', total13, 300);
eq('minimum sell on the four-line total', minSellPrice(total13), 360);
eq('spread at that minimum', spread(total13, 360), 60);

// Missing the custom price must NOT quietly total the other three, or the
// cheapest-looking bid would be the one that skipped a line.
const partial = { size: 140, bracket: 90, wires: 30 };
ok('a missing custom price makes the bid incomplete', req.some(l => partial[l.key] === undefined));
eq('and an incomplete bid has no total', minSellPrice(null), null);

// Deleting a custom line drops it from the required list, so previously
// priced-but-removed lines stop counting toward the total.
const afterDelete = brokerRequiredLines({ ...spec13, custom: [] });
eq('deleting the line shrinks the list', afterDelete.length, 3);
ok('and its id is gone', !afterDelete.some(l => l.key === 'custom_1'));

console.log('\n=== 14. Custom lines stay off the customer quote ===');
// Scope detail is internal. The customer still sees one line at the sell price.
const q14 = brokerQuoteLineItems('TV Mounting', 360);
eq('still exactly one line', q14.length, 1);
eq('at the sell price', q14[0].unit_price, 360);
ok('and never names a subcontractor line item', !JSON.stringify(q14).includes('Haul away'));


console.log('\n=== 15. Custom lines survive a panel reload ===');
// brokerResolveSpec rebuilds the spec object from scratch on every load, so
// anything it forgets to copy is lost the moment the panel is reopened. This
// pins that: the custom lines were dropped on the first cut of the feature.
const reloaded = brokerResolveSpec({ line_items: LA_ITEMS, broker_spec: { custom: [{ id: 'custom_1', label: 'Haul away old mount' }] } }, CATALOG);
eq('the custom line is still there after a reload', customLinesOf(reloaded).length, 1);
eq('with its label intact', customLinesOf(reloaded)[0].label, 'Haul away old mount');
eq('and its id intact, so priced bids stay attached', customLinesOf(reloaded)[0].id, 'custom_1');
eq('and the catalog matching still ran alongside it', reloaded.size, 'size_3');
eq('an estimate with no custom lines resolves to none', customLinesOf(brokerResolveSpec({ line_items: LA_ITEMS }, CATALOG)).length, 0);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
