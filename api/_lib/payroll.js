// ============================================================================
// Payroll calculation engine — Handy Andy + Dom's TV Mounting
// ----------------------------------------------------------------------------
// Single source of truth for "how much does a tech earn on a job?". Encodes the
// owner's rate sheet (Payroll Rules & Rates Reference, rev. 2026-06-19).
//
// DESIGN PRINCIPLE: "perfect, no exceptions" means we NEVER silently guess. A
// line item is either matched to a known rate (deterministic) or pushed to
// `flags[]` for owner review. The UI surfaces flags so a human resolves the
// ambiguous cases instead of paying a wrong number.
//
// Pure module: no DB, no network. computeJobPay(job, techName) -> result.
// Run `node api/_lib/payroll.js` to execute the built-in self-tests.
// ============================================================================

// ── Payroll week math (Sunday–Saturday; paid the SECOND Monday after close) ──
// Period ends Saturday; money hits accounts on the Saturday + 9 days, which is
// always the second Monday after the week closes. Owner's examples:
//   week May 31–Jun 6 (Sat) -> paid Mon Jun 15  (Jun 6 + 9)
//   week Jun 7 –Jun 13 (Sat) -> paid Mon Jun 22  (Jun 13 + 9)
export const PAY_DATE_OFFSET_DAYS = 9;    // days after the period-end Saturday

// ── Tech classification ──────────────────────────────────────────────────────
// Juan earns enhanced rates on base + brackets + wires + fireplace. Everyone
// else ("Other Techs") earns the standard column. TK is a normal paid tech.
// Evan is retired — never paid (callers should exclude; we also guard here).
export function isJuan(techName) {
  return /\bjuan\b/i.test(String(techName || ''));
}
export function isRetired(techName) {
  return /\bevan\b/i.test(String(techName || ''));
}

// ── Rate sheet ───────────────────────────────────────────────────────────────
// Each entry: { juan, other }. Whole dollars. Matching is by a normalized name
// (see normalize()) so DB label variants between Handy Andy and Dom's collapse
// to one key.

// TV base pay by size bracket (Handy Andy 6-bracket sheet).
const TV_SIZE_RATES = [
  { test: /(32|thirty.?two).*(less|under|below)|under.*32|32"?\s*or\s*less/, juan: 50, other: 50, label: '32" & under' },
  { test: /33.*59|33"?–?59/,                                                  juan: 60, other: 60, label: '33"–59"' },
  { test: /60.*69|60"?–?69/,                                                  juan: 80, other: 70, label: '60"–69"' },
  { test: /70.*84|70"?–?84/,                                                  juan: 90, other: 80, label: '70"–84"' },
  { test: /85.*97|85"?–?97/,                                                  juan: 110, other: 110, label: '85"–97"' },
  { test: /98|98"?\+|9[0-9]"?\s*\+/,                                          juan: 130, other: 130, label: '98"+' },
];

// Brackets, add-ons, wires, fireplace, surface, lifting — keyed by normalized name.
// `null` rate-pair means "known item that pays nothing" (no flag).
const ITEM_RATES = {
  // Brackets (Other techs paid $0 — bracket cost is a customer add-on, not labor;
  // Juan is the documented exception).
  'flat bracket':            { juan: 25, other: 0 },
  'flat':                    { juan: 25, other: 0 },
  'tilting bracket':         { juan: 35, other: 0 },
  'tilting':                 { juan: 35, other: 0 },
  'full motion bracket':     { juan: 60, other: 0 },
  'full motion':             { juan: 60, other: 0 },
  'customer supplied bracket': { juan: 0, other: 0 },
  'i have my own bracket':   { juan: 0, other: 0 },
  'i have my own mounting bracket': { juan: 0, other: 0 },

  // Add-ons (same for everyone).
  'samsung frame box':       { juan: 15, other: 15 },
  'samsung frame tv in box bracket': { juan: 15, other: 15 },
  'soundbar':                { juan: 35, other: 35 },
  'soundbar installation':   { juan: 35, other: 35 },
  'apple tv':                { juan: 15, other: 15 },
  'apple tv installation':   { juan: 15, other: 15 },
  'led light strip':         { juan: 35, other: 35 },
  'led lights':              { juan: 35, other: 35 },
  'shelf installation':      { juan: 35, other: 35 },
  'install shelf under tv':  { juan: 35, other: 35 },
  'oneconnect box':          { juan: 170, other: 170 },
  'install samsung frame oneconnect box': { juan: 170, other: 170 },
  'install samsung frame oneconnect box behind tv': { juan: 170, other: 170 },

  // Wires / fireplace / surface.
  'behind wall wires':       { juan: 45, other: 35 },
  'hide wires behind the wall': { juan: 45, other: 35 },
  'outside wall wires':      { juan: 15, other: 15 },
  'hide wires outside the wall': { juan: 15, other: 15 },
  'hang wires under the tv': { juan: 0, other: 0 },
  'wires hang under the tv': { juan: 0, other: 0 },
  'above fireplace':         { juan: 25, other: 20 },
  'tv above a fireplace':    { juan: 25, other: 20 },
  'not over fireplace':      { juan: 0, other: 0 },
  'tv not over a fireplace': { juan: 0, other: 0 },
  'tv not above a fireplace': { juan: 0, other: 0 },
  'brick stone surface':     { juan: 25, other: 25 },
  'brick':                   { juan: 25, other: 25 },
  'brick stone':             { juan: 25, other: 25 },
  'tile uneven stone':       { juan: 40, other: 40 },
  'uneven stone or tile':    { juan: 40, other: 40 },
  'stucco outdoor':          { juan: 35, other: 35 },
  'outdoor stucco':          { juan: 35, other: 35 },
  'drywall surface':         { juan: 0, other: 0 },
  'drywall':                 { juan: 0, other: 0 },
  'cannot lift 86':          { juan: 60, other: 60 },
  'lifting help':            { juan: 60, other: 60 },
  'wall already has a plug behind the tv': { juan: 0, other: 0 },
  'wall already has plug behind tv': { juan: 0, other: 0 },
};

// Assurion fixed rates (Steve only; never deferred). Matched from job notes.
const ASSURION_RATES = {
  'tv installation': 60,
  'television': 60,
  'soundbar': 35,
  'frame box': 75,
  'frame tv': 75,
};

// Job-number overrides from the rate sheet (zenbooker_job_number -> tech pay).
export const CUSTOM_PAY = { '020989': 60, '690071': 50 };
export const ASSURION_TOTAL = { '143430': 60, '708972': 60, '811856': 70 };

// ── Normalization ────────────────────────────────────────────────────────────
// Collapse a DB label to a stable lookup key: lowercase, strip punctuation and
// filler words, squeeze whitespace.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/["'’“”]/g, '')
    .replace(/[()\-–—/.,+&]/g, ' ')
    .replace(/\b(the|a|an|of|to|behind|under|recommended|installation|service|per|tv)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// A looser key that keeps a few structural words (for wires/fireplace/brackets).
function keyOf(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/["'’“”]/g, '')
    .replace(/[()\-–—/.,+&]/g, ' ')
    .replace(/\brecommended\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSize(name) {
  const n = String(name || '').toLowerCase();
  for (const r of TV_SIZE_RATES) if (r.test.test(n)) return r;
  return null;
}
function matchItem(name) {
  const k = keyOf(name);
  if (ITEM_RATES[k]) return { key: k, ...ITEM_RATES[k] };
  // try the stripped variant too
  const n = normalize(name);
  if (ITEM_RATES[n]) return { key: n, ...ITEM_RATES[n] };
  return null;
}

const round0 = (n) => Math.floor(Number(n) || 0);   // drop cents to whole dollars

// ── Payment gating ───────────────────────────────────────────────────────────
// Paid: payment_status 'paid', OR notes mention cash/venmo (treat as paid).
// Fully unpaid w/ balance: DEFERRED (not this week). Partial: FLAG for review.
export function paymentState(job) {
  const status = String(job.payment_status || '').toLowerCase();
  const price = Number(job.price) || 0;
  const paid = Number(job.amount_paid) || 0;
  const notes = String(job.notes || '') + ' ' + String(job.customer_notes || '');
  const cashVenmo = /\b(paid\s*cash|cash\b|venmo)\b/i.test(notes);

  if (status === 'paid' || cashVenmo) return 'paid';
  if (price <= 0) return 'paid';                 // $0 job (e.g. GD redeemed / quote) — gate elsewhere
  if (paid > 0 && paid < price) return 'partial';
  return 'deferred';                              // unpaid with a balance
}

// ── Tips (100% to tech) ──────────────────────────────────────────────────────
function tipFor(job) {
  let tip = Number(job.tip) || 0;
  for (const li of job.line_items || []) {
    if (/\btip\b/i.test(li.name || '')) tip += Number(li.line_total) || 0;
  }
  return tip;
}

// ── Special-service detection ────────────────────────────────────────────────
function detectSpecial(job) {
  const svc = String(job.service_name || '').toLowerCase();
  const allNames = (job.line_items || []).map(li => String(li.name || '').toLowerCase());
  const has = (re) => re.test(svc) || allNames.some(n => re.test(n));
  if (has(/\btv\s*swap\b/)) return 'tv_swap';
  if (has(/\b(estimate|quote)\b/)) return 'estimate';
  if (has(/\bpre.?paid\b/)) return 'prepaid';
  if (has(/\bhandyman\b/) || has(/\bhandyman labor\b/)) return 'handyman';
  return null;
}

// ── Core: compute one job's tech pay ─────────────────────────────────────────
// Returns { pay, breakdown:[{label,amount}], flags:[string], state }.
// `state` is 'paid' | 'deferred' | 'partial' | 'excluded'.
export function computeJobPay(job, techName) {
  const flags = [];
  const breakdown = [];
  const juan = isJuan(techName);
  const rate = (pair) => (juan ? pair.juan : pair.other);

  // Hard exclusions.
  if (isRetired(techName)) return { pay: 0, breakdown, flags: ['Retired tech — never paid'], state: 'excluded' };
  if (String(job.status || '').toLowerCase() !== 'completed') {
    return { pay: 0, breakdown, flags: [], state: 'excluded' };
  }

  // Job-number overrides win outright.
  const jn = String(job.zenbooker_job_number || '').trim();
  if (jn && CUSTOM_PAY[jn] != null) {
    return { pay: CUSTOM_PAY[jn], breakdown: [{ label: `Custom pay (job #${jn})`, amount: CUSTOM_PAY[jn] }], flags, state: 'paid' };
  }
  if (jn && ASSURION_TOTAL[jn] != null) {
    return { pay: ASSURION_TOTAL[jn], breakdown: [{ label: `Assurion override (job #${jn})`, amount: ASSURION_TOTAL[jn] }], flags, state: 'paid' };
  }

  // Assurion (Steve): pay comes from the job note "Tech pay: $X".
  const notes = String(job.notes || '');
  if (/assurion/i.test(notes)) {
    const m = notes.match(/Tech pay:\s*\$?(\d+)/i);
    if (m) {
      const amt = parseInt(m[1], 10);
      // Assurion is NEVER deferred, even if unpaid.
      return { pay: amt, breakdown: [{ label: 'Assurion (per job note)', amount: amt }], flags, state: 'paid' };
    }
    flags.push('Assurion job but no "Tech pay:" note found');
  }

  // Payment gating for everything else.
  const state = paymentState(job);
  if (state === 'deferred') {
    return { pay: 0, breakdown, flags: ['Unpaid — deferred to a future week'], state: 'deferred' };
  }
  if (state === 'partial') {
    flags.push('Partially paid — owner review required');
  }

  const tip = tipFor(job);
  const special = detectSpecial(job);

  // ── Special services short-circuit the line-item walk where the rule says so.
  if (special === 'tv_swap') {
    breakdown.push({ label: 'TV Swap (flat)', amount: 60 });
    let pay = 60 + tip;
    if (tip) breakdown.push({ label: 'Tip (100%)', amount: tip });
    return { pay: round0(pay), breakdown, flags, state: state === 'partial' ? 'partial' : 'paid' };
  }
  if (special === 'prepaid') {
    return { pay: round0(tip), breakdown: tip ? [{ label: 'Tip (100%)', amount: tip }] : [], flags: ['Pre-paid service — base pay $0 per owner'], state: 'paid' };
  }
  if (special === 'estimate') {
    const customerPaid = (Number(job.price) || 0) > 0;
    const amt = customerPaid ? 50 : 0;
    if (!customerPaid) flags.push('Unpaid estimate — flagged ($0)');
    breakdown.push({ label: 'Estimate', amount: amt });
    let pay = amt + tip;
    if (tip) breakdown.push({ label: 'Tip (100%)', amount: tip });
    return { pay: round0(pay), breakdown, flags, state: 'paid' };
  }
  if (special === 'handyman') {
    // Tech paid $65/hr, 2-hr minimum. Hours inferred from customer subtotal @ $85/hr.
    const subtotal = Number(job.subtotal) || Number(job.price) || 0;
    const hours = Math.max(2, Math.round(subtotal / 85));
    const amt = hours * 65;
    breakdown.push({ label: `Handyman ${hours}h @ $65`, amount: amt });
    let pay = amt + tip;
    if (tip) breakdown.push({ label: 'Tip (100%)', amount: tip });
    return { pay: round0(pay), breakdown, flags, state: state === 'partial' ? 'partial' : 'paid' };
  }

  // ── Standard TV-mounting walk: base (by size) + each add-on line item.
  let pay = 0;
  let sawSize = false;
  const businessSlug = String(job.business_slug || '').toLowerCase();

  for (const li of job.line_items || []) {
    const name = li.name || '';
    const lt = Number(li.line_total) || 0;

    // Skip non-labor bookkeeping lines.
    if (li.kind === 'fee' || /^tax\b/i.test(name) || /\btip\b/i.test(name) || /travel fee/i.test(name)) continue;

    // Dismount (threshold) — standalone or line item.
    if (/guaranteed dismount/i.test(name)) {
      // Sold (charged ~$35) -> $0; Redeemed (charged $0) -> $60.
      const amt = lt > 0 ? 0 : 60;
      breakdown.push({ label: amt ? 'Guaranteed Dismount (redeemed)' : 'Guaranteed Dismount (sold)', amount: amt });
      pay += amt;
      continue;
    }
    if (/\bdismount\b/i.test(name)) {
      const amt = lt > 60 ? 60 : 50;
      breakdown.push({ label: `Dismount (cust $${round0(lt)})`, amount: amt });
      pay += amt;
      continue;
    }

    // TV size = base pay.
    const sz = matchSize(name);
    if (sz) {
      sawSize = true;
      const amt = rate(sz);
      breakdown.push({ label: `TV base ${sz.label}`, amount: amt });
      pay += amt;
      continue;
    }
    // Dom's size buckets don't map to the 6-bracket sheet — flag, don't guess.
    if (/my tv is|under 70 inches|70-85 inches|86 inches/i.test(name)) {
      flags.push(`Dom's size "${name}" has no rate-sheet bracket — owner review`);
      continue;
    }

    // Known add-on / wire / surface / bracket.
    const item = matchItem(name);
    if (item) {
      const amt = rate(item);
      if (amt) breakdown.push({ label: name, amount: amt });
      pay += amt;
      continue;
    }

    // Unmatched, non-zero labor line -> flag for owner review (never silently $0).
    if (lt > 0) flags.push(`Unmatched line item "${name}" ($${round0(lt)} to customer) — owner review`);
  }

  // A TV-mounting job with no recognizable size base is suspicious.
  if (!sawSize && !special && (job.line_items || []).some(li => matchSize(li.name))) {
    // (unreachable guard kept for clarity)
  }
  if (!sawSize && !special && businessSlug !== '' && (job.line_items || []).length) {
    flags.push('No TV size base detected — owner review');
  }

  if (tip) { breakdown.push({ label: 'Tip (100%)', amount: tip }); pay += tip; }

  return { pay: round0(pay), breakdown, flags, state: state === 'partial' ? 'partial' : 'paid' };
}

// ── Self-tests ───────────────────────────────────────────────────────────────
// `node api/_lib/payroll.js` — validates the engine against the rate sheet's
// concrete examples. Exits non-zero on any failure.
function runSelfTests() {
  let fails = 0;
  const eq = (got, want, msg) => {
    const ok = got === want;
    if (!ok) { fails++; console.error(`✗ ${msg}: got ${got}, want ${want}`); }
    else console.log(`✓ ${msg}`);
  };
  const job = (over) => ({ status: 'completed', payment_status: 'paid', price: 200, line_items: [], ...over });

  // Base by size, non-Juan vs Juan.
  eq(computeJobPay(job({ line_items: [{ kind: 'option', name: '33"–59"', line_total: 109 }] }), 'Kregg').pay, 60, '50in non-Juan base = 60');
  eq(computeJobPay(job({ line_items: [{ kind: 'option', name: '60"–69"', line_total: 119 }] }), 'Kregg').pay, 70, '60-69 non-Juan = 70');
  eq(computeJobPay(job({ line_items: [{ kind: 'option', name: '60"–69"', line_total: 119 }] }), 'Juan').pay, 80, '60-69 Juan = 80');
  eq(computeJobPay(job({ line_items: [{ kind: 'option', name: '98"+', line_total: 229 }] }), 'Juan').pay, 130, '98+ Juan = 130');

  // Brackets: Other $0, Juan paid.
  eq(computeJobPay(job({ line_items: [{ name: '32" or Less', line_total: 99 }, { name: 'Tilting (recommended)', line_total: 0 }] }), 'Zach').pay, 50, 'tilting Other adds 0');
  eq(computeJobPay(job({ line_items: [{ name: '32" or Less', line_total: 99 }, { name: 'Tilting (recommended)', line_total: 0 }] }), 'Juan').pay, 85, 'tilting Juan adds 35');

  // Wires (Juan vs other).
  eq(computeJobPay(job({ line_items: [{ name: '33"–59"', line_total: 109 }, { name: 'Hide wires BEHIND the wall', line_total: 60 }] }), 'Steve').pay, 95, 'behind-wall other = 60+35');
  eq(computeJobPay(job({ line_items: [{ name: '33"–59"', line_total: 109 }, { name: 'Hide wires BEHIND the wall', line_total: 60 }] }), 'Juan').pay, 105, 'behind-wall Juan = 60+45');

  // Handyman $65/hr, 2h min.
  eq(computeJobPay(job({ service_name: 'Handyman Services', subtotal: 255, line_items: [{ name: 'Handyman Labor', line_total: 255 }] }), 'Kregg').pay, 195, 'handyman 255 -> 3h*65=195');
  eq(computeJobPay(job({ service_name: 'Handyman Services', subtotal: 50, line_items: [] }), 'Kregg').pay, 130, 'handyman min 2h = 130');

  // Dismount thresholds.
  eq(computeJobPay(job({ line_items: [{ name: 'Dismount', line_total: 80 }] }), 'Zach').pay, 60, 'dismount >60 -> 60');
  eq(computeJobPay(job({ line_items: [{ name: 'Dismount', line_total: 45 }] }), 'Zach').pay, 50, 'dismount <=60 -> 50');

  // Guaranteed Dismount sold vs redeemed.
  eq(computeJobPay(job({ line_items: [{ name: 'Guaranteed Dismount Service', line_total: 35 }] }), 'Zach').pay, 0, 'GD sold = 0');
  eq(computeJobPay(job({ price: 0, line_items: [{ name: 'Guaranteed Dismount Service', line_total: 0 }] }), 'Zach').pay, 60, 'GD redeemed = 60');

  // TV swap flat.
  eq(computeJobPay(job({ service_name: 'TV Swap', line_items: [{ name: 'TV Swap', line_total: 120 }] }), 'Zach').pay, 60, 'tv swap flat 60');

  // Tips 100%.
  eq(computeJobPay(job({ tip: 20, line_items: [{ name: '33"–59"', line_total: 109 }] }), 'Zach').pay, 80, 'base 60 + tip 20');

  // Assurion via note.
  eq(computeJobPay(job({ payment_status: 'unpaid', price: 0, notes: 'Assurion job\nTelevision — $60\n\nTech pay: $60', line_items: [] }), 'Steve').pay, 60, 'assurion note 60 (not deferred)');

  // Deferred (unpaid w/ balance).
  eq(computeJobPay(job({ payment_status: 'unpaid', price: 150, amount_paid: 0, line_items: [{ name: '33"–59"', line_total: 109 }] }), 'Zach').state, 'deferred', 'unpaid -> deferred');

  // Job-number override.
  eq(computeJobPay(job({ zenbooker_job_number: '020989', line_items: [] }), 'Kregg').pay, 60, 'CUSTOM_PAY 020989 = 60');

  console.log(fails ? `\n${fails} FAILED` : '\nAll payroll self-tests passed');
  return fails;
}

// ESM "run if main".
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runSelfTests() ? 1 : 0);
}
