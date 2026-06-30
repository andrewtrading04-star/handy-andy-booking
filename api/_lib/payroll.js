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
// else ("Other Techs") earns the standard column — TK included for rates.
// Evan is retired — never paid (callers should exclude; we also guard here).
export function isJuan(techName) {
  return /\bjuan\b/i.test(String(techName || ''));
}
// Techs who work two-person jobs with their OWN helper (a spouse/partner who is
// NOT a paid tech in the system): Juan and TK. They are NEVER split — each keeps
// the full base/tips AND the entire $60 two-person add-on (not the $30 half).
export function bringsOwnSecond(techName) {
  return isJuan(techName) || /\btk\b/i.test(String(techName || ''));
}
export function isRetired(techName) {
  // Dismissed techs — never paid (rate sheet §10): Evan and Israel.
  return /\b(evan|israel)\b/i.test(String(techName || ''));
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
  { test: /70.*8[45]|70"?[–-]?8[45]/,                                         juan: 90, other: 80, label: '70"–84"' },
  { test: /8[56].*97|8[56]"?[–-]?97/,                                         juan: 110, other: 110, label: '85"–97"' },
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
  // Mantel Mount: $195 to the customer, $110 to the tech (paid labor, all techs).
  'mantel mount':            { juan: 110, other: 110 },
  'customer supplied bracket': { juan: 0, other: 0 },
  'i have my own bracket':   { juan: 0, other: 0 },
  'i have my own mounting bracket': { juan: 0, other: 0 },
  // Bracket choice for 85"–100" TVs (verbose widget labels). Brackets still pay
  // $0 to other techs; Juan keeps his bracket reimbursement.
  '85 100 flat bracket':        { juan: 25, other: 0 },
  '85 100 tilting bracket':     { juan: 35, other: 0 },
  '85 100 full motion bracket': { juan: 60, other: 0 },
  // Samsung Frame "bracket in the box" (verbose widget wording -> $15 both).
  'i will be using the bracket that comes in the box samsung frame tv': { juan: 15, other: 15 },

  // Add-ons (same for everyone).
  'samsung frame box':       { juan: 15, other: 15 },
  'samsung frame tv in box bracket': { juan: 15, other: 15 },
  'soundbar':                { juan: 35, other: 35 },
  'soundbar installation':   { juan: 35, other: 35 },
  'apple tv':                { juan: 15, other: 15 },
  'apple tv installation':   { juan: 15, other: 15 },
  'apple tv installation mounting bracket included': { juan: 15, other: 15 },
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
  'yes hide the wires behind the wall': { juan: 45, other: 35 },
  'outside wall wires':      { juan: 15, other: 15 },
  'hide wires outside the wall': { juan: 15, other: 15 },
  'yes hide the wires outside the wall': { juan: 15, other: 15 },
  'hang wires under the tv': { juan: 0, other: 0 },
  'wires hang under the tv': { juan: 0, other: 0 },
  'above fireplace':         { juan: 25, other: 20 },
  'tv above a fireplace':    { juan: 25, other: 20 },
  'i have 1 tv above a fireplace': { juan: 25, other: 20 },
  'not over fireplace':      { juan: 0, other: 0 },
  'tv not over a fireplace': { juan: 0, other: 0 },
  'i have 1 tv not over a fireplace': { juan: 0, other: 0 },
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

// ── Travel / service-area surcharge → tech payout ────────────────────────────
// The customer's service-area surcharge is split: the business keeps part, the
// tech earns the rest as a per-trip travel stipend (NOT split between two techs).
// Mapping from the distance tiers (migration 0032): surcharge → tech payout.
//   $15 → $10,  $65 → $50,  $100 → $75.
// Derived straight from the surcharge line on the ticket so the tech always gets
// their share even when the per-zip payout column was never configured.
const TRAVEL_TIERS = [
  { surcharge: 100, payout: 75 },
  { surcharge: 65,  payout: 50 },
  { surcharge: 15,  payout: 10 },
];
export function travelPayoutForSurcharge(amount) {
  const a = Number(amount) || 0;
  for (const t of TRAVEL_TIERS) if (a >= t.surcharge) return t.payout;
  return 0;
}

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
  // The booking widget's LIFTING question answers ("My TV is 70-85 inches and I
  // can help lift it", "My TV is 85 inches or larger") embed a size range but are
  // NOT a TV-size base selection. Never let them score base pay — the real size
  // options ("70\"-85\"", "33\"-59\"") never say "my tv is" / "lift" / "help" / "larger".
  if (/my tv is|\b(?:lift|help|larger)\b/i.test(n)) return null;
  for (const r of TV_SIZE_RATES) if (r.test.test(n)) return r;
  return null;
}
// Some booking paths prefix a line item with its option group, e.g.
// "Wall Surface: Outdoor/Stucco" or "Add-ons: Soundbar Installation". Match on the
// part AFTER the prefix too, so the rate lookup isn't defeated by the category.
function afterPrefix(name) {
  const s = String(name || '');
  const i = s.indexOf(':');
  const tail = i > -1 ? s.slice(i + 1).trim() : '';
  return tail;
}
function matchItem(name) {
  const cands = [name];
  const tail = afterPrefix(name);
  if (tail) cands.push(tail);
  for (const cand of cands) {
    const k = keyOf(cand);
    if (ITEM_RATES[k]) return { key: k, ...ITEM_RATES[k] };
    const n = normalize(cand);
    if (ITEM_RATES[n]) return { key: n, ...ITEM_RATES[n] };
  }
  return null;
}

const round0 = (n) => Math.floor(Number(n) || 0);   // drop cents to whole dollars

// How many of a line item to PAY for (e.g. 3 tilting brackets -> pay 3). Prefer
// the stored quantity; if that's 1 but the price is a clean multiple of the unit
// price (some booking paths fold the count into the total), infer it. Mirrors the
// app's display logic so pay and the customer charge always agree.
function payQty(li) {
  const q = Math.round(Number(li && li.quantity) || 0);
  if (q > 1) return q;
  const u = Number(li && li.unit_price) || 0, t = Number(li && li.line_total) || 0;
  if (u > 0) { const r = t / u; if (Math.abs(r - Math.round(r)) < 0.02 && Math.round(r) > 1) return Math.round(r); }
  return 1;
}

// Quantity on a dismount line: an explicit Nx / xN prefix in the label wins,
// else the line's quantity field, else 1.
function dismountQty(name, li) {
  const m = String(name || '').match(/\bx\s*(\d+)\b|\b(\d+)\s*x\b/i);
  if (m) return Math.max(1, parseInt(m[1] || m[2], 10));
  const q = Number(li && li.quantity);
  return q > 1 ? Math.round(q) : 1;
}

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

// The line-item wordings that signal a two-person ("lift help") job. Covers the
// internal "Second Technician"/"Lifting Help" markers AND the customer-facing
// widget options ("…I cannot help lift it", "My TV is 85 inches or larger").
// NOTE: "…I CAN help lift it" must NOT match — the negative lookalike is excluded
// by requiring "cannot" in the lift branch.
const SECOND_TECH_RE = /second\s*technician|cannot\s*(?:help\s*)?lift|lifting\s*help|8[56]\s*inch(?:es)?\s*or\s*larger/i;

// ── Multi-tech detection (when a two-person "lift help" line item exists) ──
// Returns { hasSecondTech: boolean, secondTechBonus: number }.
// Bonus is $30 per tech if the customer paid for it (line_total >= 70), else $0.
// (Customer pays $70; the ~$60 add-on splits $30/$30 between the two techs.)
function detectMultiTech(job) {
  for (const li of job.line_items || []) {
    const name = String(li.name || '').toLowerCase();
    if (SECOND_TECH_RE.test(name)) {
      const lt = Number(li.line_total) || 0;
      const bonus = lt >= 70 ? 30 : 0;
      return { hasSecondTech: true, secondTechBonus: bonus };
    }
  }
  return { hasSecondTech: false, secondTechBonus: 0 };
}

// ── Special-service detection ────────────────────────────────────────────────
function detectSpecial(job) {
  const svc = String(job.service_name || '').toLowerCase();
  const allNames = (job.line_items || []).map(li => String(li.name || '').toLowerCase());
  const has = (re) => re.test(svc) || allNames.some(n => re.test(n));
  if (has(/\btv\s*swap\b/)) return 'tv_swap';
  if (has(/\b(estimate|quote)\b/)) return 'estimate';
  if (has(/\bpre.?paid\b/)) return 'prepaid';
  // Handyman is a PURE-handyman job only. A real TV-mounting job that merely has a
  // "handyman labor" ADD-ON line (alongside TV sizes/brackets) must NOT be
  // reclassified as handyman — doing so throws away the whole mounting breakdown
  // and pays hours off the entire ticket. So only treat it as handyman when there
  // is NO TV-size base line; otherwise the add-on is priced in the line walk below.
  const hasTvBase = (job.line_items || []).some(li => matchSize(li.name));
  if (!hasTvBase && (has(/\bhandyman\b/) || has(/\bhandyman labor\b/))) return 'handyman';
  return null;
}

// ── Core: compute one job's tech pay ─────────────────────────────────────────
// Returns { pay, breakdown:[{label,amount}], flags:[string], state }.
// `state` is 'paid' | 'deferred' | 'partial' | 'excluded'.
export function computeJobPay(job, techName) {
  const flags = [];
  const breakdown = [];
  const juan = isJuan(techName);
  const ownHelper = bringsOwnSecond(techName);   // Juan or TK — never split, full $60
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

  // ── Detect multi-tech: when a two-person "lift help" line item is present, OR
  // the caller tells us a second technician is assigned to the job. Either way the
  // job's pay is computed then split 50/50 between the two techs.
  const multiTech = detectMultiTech(job);
  if (job.second_tech) multiTech.hasSecondTech = true;

  // ── Detect after-hours fee: $75 bonus for 8 PM-or-later jobs ──
  let afterHoursBonus = 0;
  for (const li of job.line_items || []) {
    if (/after.?hours|8\s*pm/i.test(li.name || '')) {
      afterHoursBonus = 75;  // Hard rule: $75 bonus to tech
      break;
    }
  }

  // ── Travel payout: the tech's share of the service-area surcharge. Prefer the
  // surcharge line actually on the ticket (source of truth — the customer paid $X
  // surcharge, so the tech earns the matching tier: $65→$50, etc.), but never pay
  // less than the per-zip payout the caller looked up (job.travel_payout). Treated
  // like the after-hours bonus — a per-trip stipend, NOT split, so each tech on
  // the trip earns it.
  let travelPayout = Number(job.travel_payout) || 0;
  for (const li of job.line_items || []) {
    if (/service area surcharge/i.test(li.name || '')) {
      travelPayout = Math.max(travelPayout, travelPayoutForSurcharge(li.line_total));
      break;
    }
  }


  // ── Standard TV-mounting walk: base (by size) + each add-on line item.
  let pay = 0;
  let sawSize = false;
  const businessSlug = String(job.business_slug || '').toLowerCase();

  for (const li of job.line_items || []) {
    const name = li.name || '';
    const lt = Number(li.line_total) || 0;

    // Skip non-labor bookkeeping lines. Includes fees that sometimes arrive as a
    // plain 'service' line (Zenbooker custom_service) instead of kind 'fee' — the
    // service-area surcharge pays the tech nothing here (the travel payout comes
    // separately from the zip tier) and the after-hours fee adds its $75 bonus
    // separately, so neither should be priced or flagged as an unmatched line.
    if (li.kind === 'fee' || /^tax\b/i.test(name) || /\btip\b/i.test(name) || /travel fee/i.test(name)
        || /service area surcharge/i.test(name) || /after.?hours/i.test(name)) continue;

    // Skip the two-person "lift help" marker — it's not a labor line to price.
    // The $60 ($30/tech) bonus is added separately when the split runs.
    if (SECOND_TECH_RE.test(name)) continue;

    // Dismount pay (rate sheet §5):
    //  • Guaranteed Dismount SOLD (a charged line, per-unit lt > 0)     -> $0 (counts as sold)
    //  • Guaranteed Dismount REDEEMED ($0 standalone, per-unit lt <= 0) -> $60
    //  • Plain dismount CHARGED: per-unit customer charge > $60 -> $60, else $50
    //  • Plain dismount NOT charged ($0): the customer DECLINED it (a widget
    //    answer like "Dismount: No, I will handle it myself") -> $0. Never pay
    //    for a dismount the customer didn't buy.
    //  • Quantity (Nx prefix or qty field) multiplies the per-unit pay.
    if (/dismount/i.test(name)) {
      const isGuaranteed = /guaranteed/i.test(name);
      const qty = dismountQty(name, li);
      const perUnit = lt / qty;
      const unit = isGuaranteed
        ? (perUnit > 0 ? 0 : 60)
        : (perUnit <= 0 ? 0 : (perUnit > 60 ? 60 : 50));
      const amt = unit * qty;
      if (amt) breakdown.push({ label: `${isGuaranteed ? 'Guaranteed Dismount' : 'Dismount'}${qty > 1 ? ` ×${qty}` : ''}`, amount: amt });
      pay += amt;
      continue;
    }

    // Handyman labor as an ADD-ON line on a mounting job: pay the tech $65/hr.
    // Hours come from the label ("1 hour of Handyman Labor"); if unstated, infer
    // from the line's own customer price at $85/hr. (A PURE handyman job never
    // reaches here — it's handled by the special short-circuit above.)
    if (/handyman/i.test(name)) {
      const m = name.match(/(\d+(?:\.\d+)?)\s*hours?\b/i);
      const hours = m ? parseFloat(m[1]) : Math.max(1, Math.round((lt || 0) / 85));
      const amt = Math.round(hours * 65);
      if (amt) breakdown.push({ label: `Handyman ${hours}h @ $65`, amount: amt });
      pay += amt;
      continue;
    }

    // TV size = base pay (× quantity if the same size line covers several TVs).
    const sz = matchSize(name);
    if (sz) {
      sawSize = true;
      const n = payQty(li);
      const amt = rate(sz) * n;
      breakdown.push({ label: `TV base ${sz.label}${n > 1 ? ` ×${n}` : ''}`, amount: amt });
      pay += amt;
      continue;
    }
    // The widget's lifting-question answers ("My TV is under 70 inches", "…I can
    // help lift it") are $0 no-ops — skip them silently. Only flag a "My TV is…"
    // descriptor we couldn't price when the customer was actually CHARGED for it.
    if (/my tv is|under 70|70.?85|86\s*\+?/i.test(name) && !matchSize(name)) {
      if (lt > 0) flags.push(`Size descriptor "${name}" — verify rate bracket for pay calculation`);
      continue;
    }

    // Known add-on / wire / surface / bracket — paid per unit (3 brackets -> ×3).
    const item = matchItem(name);
    if (item) {
      const n = payQty(li);
      const amt = rate(item) * n;
      if (amt) breakdown.push({ label: `${name}${n > 1 ? ` ×${n}` : ''}`, amount: amt });
      pay += amt;
      continue;
    }

    // Anything else that reached here with a real charge is a CUSTOM JOB (e.g.
    // "Mounting of Dry Erase Board"). All custom work is billed hourly at $85/hr
    // to the customer, so the tech earns $65/hr. Infer the hours from the line
    // price ($170 -> 2h -> $130). Flag only when the price isn't a clean hourly
    // multiple, so the inferred hours can be double-checked.
    if (lt > 0) {
      const rawHours = lt / 85;
      const hours = Math.max(1, Math.round(rawHours));
      const amt = hours * 65;
      breakdown.push({ label: `Custom job ${hours}h @ $65`, amount: amt });
      pay += amt;
      if (Math.abs(rawHours - hours) > 0.1) {
        flags.push(`Custom job "${name}" ($${round0(lt)}) — paid ${hours}h @ $65; verify the hours`);
      }
    }
  }

  // A TV-mounting job with no recognizable size base is suspicious.
  if (!sawSize && !special && (job.line_items || []).some(li => matchSize(li.name))) {
    // (unreachable guard kept for clarity)
  }
  if (!sawSize && !special && businessSlug !== '' && (job.line_items || []).length) {
    flags.push('No TV size base detected — owner review');
  }

  // ── Multi-tech handling: split base pay and tips 50/50, add $60 bonus if applicable.
  // EXCEPTION (hard rule, per owner): Juan and TK work two-person jobs with their
  // OWN helper, who is NOT a paid tech in the system. So they are NEVER split — they
  // keep the full base/tips and collect the ENTIRE $60 two-person add-on themselves
  // (handled in the single-tech branch below). Everyone else still splits 50/50.
  if (multiTech.hasSecondTech && !ownHelper) {
    // Split the base pay (everything before tips) 50/50.
    const newBreakdown = breakdown.map(item => ({
      ...item,
      amount: round0(item.amount / 2)
    }));
    // Re-sum to get the halved base.
    let basePay = 0;
    for (const item of newBreakdown) {
      basePay += item.amount;
    }
    // Split tips 50/50.
    const tippay = tip ? round0(tip / 2) : 0;
    if (tippay) newBreakdown.push({ label: 'Tip (50%)', amount: tippay });
    // Add the second-tech bonus.
    if (multiTech.secondTechBonus) {
      newBreakdown.push({ label: 'Second Technician bonus', amount: multiTech.secondTechBonus });
    }
    // Add after-hours bonus (8 PM jobs).
    if (afterHoursBonus) {
      newBreakdown.push({ label: 'After-Hours bonus (8 PM)', amount: afterHoursBonus });
    }
    // Travel-tier payout (not split — each tech on the trip earns it).
    if (travelPayout) {
      newBreakdown.push({ label: 'Travel payout', amount: travelPayout });
    }
    const finalPay = basePay + tippay + multiTech.secondTechBonus + afterHoursBonus + travelPayout;
    flags.push(`Multi-tech job (split 50/50) — verify second tech assignment`);
    return { pay: round0(finalPay), breakdown: newBreakdown, flags, state: state === 'partial' ? 'partial' : 'paid' };
  } else {
    // Single tech — OR Juan/TK on a two-person job (never split; see exception above).
    // Full tips + after-hours + travel. When the customer PAID for the two-person
    // option, the own-helper tech keeps the WHOLE $60 add-on (not the $30 half).
    if (tip) breakdown.push({ label: 'Tip (100%)', amount: tip });
    const wholeBonus = (ownHelper && multiTech.hasSecondTech && multiTech.secondTechBonus > 0) ? 60 : 0;
    if (wholeBonus) breakdown.push({ label: 'Second person — brings own helper (full $60)', amount: wholeBonus });
    if (afterHoursBonus) breakdown.push({ label: 'After-Hours bonus (8 PM)', amount: afterHoursBonus });
    if (travelPayout) breakdown.push({ label: 'Travel payout', amount: travelPayout });
    pay += tip + wholeBonus + afterHoursBonus + travelPayout;
    return { pay: round0(pay), breakdown, flags, state: state === 'partial' ? 'partial' : 'paid' };
  }
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

  // Juan's 70"-85" base premium: $90 (others $80). Locked from the Juliana Schmidt
  // job — 70-85 TV + Outdoor/Stucco + Soundbar must total $90+$35+$35 for Juan.
  // Real-world labels carry an option-group prefix ("Wall Surface:", "Add-ons:")
  // and a service-area surcharge line — both must resolve cleanly, no review flags.
  const julianaItems = [
    { name: '70"-85"', line_total: 149 },
    { name: 'Wall Surface: Outdoor/Stucco', line_total: 45 },
    { name: 'Add-ons: Soundbar Installation', line_total: 60 },
    { name: 'Service area surcharge', line_total: 65 },
  ];
  // Pay = base labor (160 Juan / 150 other) PLUS the tech's $50 travel share of
  // the $65 service-area surcharge on the ticket. So 210 Juan / 200 other.
  eq(computeJobPay(job({ line_items: julianaItems }), 'Juan').pay, 210, 'Juan 70-85 + outdoor + soundbar (160) + $50 travel = 210');
  eq(computeJobPay(job({ line_items: julianaItems }), 'Juan').flags.length, 0, 'Juliana job: no unmatched/review flags');
  eq(computeJobPay(job({ line_items: julianaItems }), 'Kregg').pay, 200, 'Other tech same job = 150 base + $50 travel = 200');
  // The Juliana job is a flagged two-person lift (a 2nd tech is on the booking),
  // but Juan brings his wife → he is NOT split, still the full $160 + $50 travel.
  // A normal tech on the same two-person job has the BASE halved (74) but still
  // earns the full $50 travel (not split) → 124.
  eq(computeJobPay(job({ line_items: julianaItems, second_tech: true }), 'Juan').pay, 210, 'Juan two-person job NOT split = 160 + 50 travel = 210');
  eq(computeJobPay(job({ line_items: julianaItems, second_tech: true }), 'Kregg').pay, 124, 'Other tech two-person: 74 split base + 50 travel = 124');
  // Customer PAID for the two-person option ("cannot help lift" $70): Juan keeps
  // the WHOLE $60 add-on on top of his full base. 70-85 base 90 + 60 = 150.
  eq(computeJobPay(job({ line_items: [
    { name: '70"-85"', line_total: 149 },
    { name: 'My TV is 70-85 inches and I cannot help lift it', line_total: 70 },
  ] }), 'Juan').pay, 150, 'Juan paid two-person: 90 base + full 60 = 150');

  // Mixed job: TV mounting + a handyman ADD-ON line must NOT be reclassified as a
  // pure handyman job (the Cecil Cofie bug — it paid $650 as "10h handyman" and
  // wiped the whole mounting breakdown). Juan: 80+60+35+45+35+35 base + 75
  // after-hours + 65 (1h handyman add-on) + 10 travel ($15 surcharge tier) = 440.
  eq(computeJobPay(job({ price: 891, subtotal: 823, line_items: [
    { name: '60"-69"', line_total: 119 },
    { name: '33"-59"', line_total: 109 },
    { name: 'Tilting (recommended)', line_total: 120 },
    { name: 'Yes, hide the wires BEHIND the wall', line_total: 150 },
    { name: 'Soundbar Installation', line_total: 50 },
    { name: 'LED Lights', line_total: 100 },
    { name: '1 hour of Handyman Labor', line_total: 85 },
    { name: 'Service area surcharge', line_total: 15, kind: 'fee' },
    { name: 'After-hours fee (8 PM)', line_total: 75, kind: 'fee' },
    { name: 'Tax (8.25%)', line_total: 67.9, kind: 'fee' },
  ] }), 'Juan').pay, 440, 'mixed TV+handyman add-on (Juan) = 440 (430 + $10 travel)');

  // Custom jobs are hourly: $85/hr to the customer -> $65/hr to the tech. An
  // unrecognized service line (e.g. "Mounting of Dry Erase Board") is paid by
  // inferring hours from its price. $170 -> 2h -> $130. No review flag when the
  // price is a clean hourly multiple.
  eq(computeJobPay(job({ line_items: [{ name: 'Mounting of Dry Erase Board 4 x 6', line_total: 170 }] }), 'Kregg').pay, 130, 'custom job $170 -> 2h @ $65 = 130');
  eq(computeJobPay(job({ line_items: [{ name: 'Mounting of Dry Erase Board 4 x 6', line_total: 170 }] }), 'Kregg').flags.length, 0, 'clean custom-hour multiple -> no flag');
  // Custom line alongside a TV base: base + custom hours both pay.
  eq(computeJobPay(job({ line_items: [
    { name: '60"-69"', line_total: 119 },
    { name: 'Mounting of Dry Erase Board 4 x 6', line_total: 170 },
  ] }), 'Kregg').pay, 200, 'other 60-69 (70) + custom 2h (130) = 200');
  // Non-clean price flags the inferred hours but still pays.
  eq(computeJobPay(job({ line_items: [{ name: 'Custom mount job', line_total: 200 }] }), 'Kregg').flags.length, 1, 'non-clean custom price flags hours');
  // The Joseph job for TK (Doms, zip 80401 tier-3 travel $50): 3× 60-69 base
  // (210) + custom dry-erase 2h (130) + full-motion brackets ×3 ($0, not Juan) +
  // GDS sold ($0) + $50 travel = 390.
  eq(computeJobPay(job({ price: 1034, subtotal: 955, business_slug: 'doms', travel_payout: 50, line_items: [
    { name: 'Mounting of Dry Erase Board 4 x 6', line_total: 170 },
    { name: 'TV Size: 60–69 inch', quantity: 3, unit_price: 135, line_total: 405 },
    { name: 'Bracket: Full Motion', quantity: 3, unit_price: 115, line_total: 345 },
    { name: 'Fireplace: TV not over a fireplace', quantity: 3, line_total: 0 },
    { name: 'Wall Surface: Drywall', quantity: 3, line_total: 0 },
    { name: 'Dismount: Guaranteed Dismount Service', line_total: 35 },
    { name: 'Tax (8.25%)', line_total: 78.79, kind: 'fee' },
  ] }), 'TK').pay, 390, 'Joseph job TK = 210 base + 130 custom + 50 travel = 390');

  // Per-unit pay: 3 tilting brackets pay Juan 3 × $35 on top of the base.
  eq(computeJobPay(job({ line_items: [
    { name: '60"-69"', line_total: 119 },
    { name: 'Tilting (recommended)', line_total: 180, quantity: 3, unit_price: 60 },
  ] }), 'Juan').pay, 185, 'Juan 60-69 + 3× tilting = 80 + 105 = 185');
  // Count inferred when the quantity is folded into the price (qty unset, 2× unit).
  eq(computeJobPay(job({ line_items: [
    { name: '33"–59"', line_total: 109 },
    { name: 'Soundbar Installation', line_total: 70, unit_price: 35 },
  ] }), 'Zach').pay, 130, 'other 33-59 + 2× soundbar (inferred) = 60 + 70 = 130');

  // Brackets: Other $0, Juan paid.
  eq(computeJobPay(job({ line_items: [{ name: '32" or Less', line_total: 99 }, { name: 'Tilting (recommended)', line_total: 0 }] }), 'Zach').pay, 50, 'tilting Other adds 0');
  eq(computeJobPay(job({ line_items: [{ name: '32" or Less', line_total: 99 }, { name: 'Tilting (recommended)', line_total: 0 }] }), 'Juan').pay, 85, 'tilting Juan adds 35');

  // Wires (Juan vs other).
  eq(computeJobPay(job({ line_items: [{ name: '33"–59"', line_total: 109 }, { name: 'Hide wires BEHIND the wall', line_total: 60 }] }), 'Steve').pay, 95, 'behind-wall other = 60+35');
  eq(computeJobPay(job({ line_items: [{ name: '33"–59"', line_total: 109 }, { name: 'Hide wires BEHIND the wall', line_total: 60 }] }), 'Juan').pay, 105, 'behind-wall Juan = 60+45');

  // Handyman $65/hr, 2h min.
  eq(computeJobPay(job({ service_name: 'Handyman Services', subtotal: 255, line_items: [{ name: 'Handyman Labor', line_total: 255 }] }), 'Kregg').pay, 195, 'handyman 255 -> 3h*65=195');
  eq(computeJobPay(job({ service_name: 'Handyman Services', subtotal: 50, line_items: [] }), 'Kregg').pay, 130, 'handyman min 2h = 130');

  // Dismount (rate sheet §5): plain charge >$60 -> $60, <=$60 -> $50; Guaranteed
  // Dismount SOLD ($ line) -> $0, REDEEMED ($0 standalone) -> $60; xN multiplies.
  eq(computeJobPay(job({ line_items: [{ name: 'Dismount', line_total: 119 }] }), 'Zach').pay, 60, 'dismount >$60 -> 60');
  eq(computeJobPay(job({ line_items: [{ name: 'Dismount', line_total: 45 }] }), 'Zach').pay, 50, 'dismount <=$60 -> 50');
  eq(computeJobPay(job({ line_items: [{ name: 'Guaranteed Dismount Service', line_total: 35 }] }), 'Zach').pay, 0, 'GD sold -> 0');
  eq(computeJobPay(job({ price: 0, line_items: [{ name: 'Guaranteed Dismount Service', line_total: 0 }] }), 'Zach').pay, 60, 'GD redeemed -> 60');
  eq(computeJobPay(job({ line_items: [{ name: 'Dismount x3', line_total: 170 }] }), 'Zach').pay, 150, 'dismount x3 $170 -> 3x$50=150');
  // Declined dismount: a $0 "Dismount: No, I will handle" widget answer pays $0
  // (the customer didn't buy a dismount — must not score a phantom $50).
  eq(computeJobPay(job({ line_items: [{ name: 'Dismount: No, I will handle it myself', line_total: 0 }] }), 'Zach').pay, 0, 'declined dismount ($0) pays nothing');
  // Gregory's real job: TV Dismount ($129) + 60-69" base + handyman add-on, with
  // a separate declined-dismount $0 line that must NOT add $50. 60 + 70 + 65 = 195.
  eq(computeJobPay(job({ price: 378, subtotal: 349, business_slug: 'handy-andy', line_items: [
    { name: 'TV Dismount', line_total: 129 },
    { name: 'TV Size: 60–69 inch', line_total: 135 },
    { name: 'Bracket: I have my own mount', line_total: 0 },
    { name: 'Dismount: No, I will handle', line_total: 0 },
    { name: 'Add-ons: Handyman Labor', line_total: 85 },
    { name: 'Tax (8.25%)', line_total: 28.79, kind: 'fee' },
  ] }), 'Gregory').pay, 195, 'real dismount + base + handyman, declined $0 dismount ignored = 195');

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

  // Multi-tech: base split 50/50 + tips split 50/50 + $30 bonus.
  eq(computeJobPay(job({ tip: 20, line_items: [
    { name: '60"–69"', line_total: 119 },
    { name: 'Second Technician', line_total: 70 }
  ] }), 'Kregg').pay, 75, 'multi-tech (70/2 + 20/2 + 30 = 35 + 10 + 30)');

  // Multi-tech with "Lifting Help" variation (same logic).
  eq(computeJobPay(job({ line_items: [
    { name: '70"–84"', line_total: 169 },
    { name: 'Lifting Help', line_total: 70 }
  ] }), 'Kregg').pay, 70, 'multi-tech lifting help (80/2 + 30 = 40 + 30)');

  // Multi-tech without sufficient payment (< $70, no bonus).
  eq(computeJobPay(job({ line_items: [
    { name: '33"–59"', line_total: 109 },
    { name: 'Second Technician', line_total: 50 }
  ] }), 'Zach').pay, 30, 'multi-tech no bonus (60/2 = 30, no $30 bonus for <70)');

  // Juan is NEVER split (works two-person jobs with his wife, who isn't a paid
  // tech): full base + full tips + the WHOLE $60 two-person add-on (not the $30
  // half). 98"+ base 130 + tip 40 + 60 = 230.
  eq(computeJobPay(job({ tip: 40, line_items: [
    { name: '98"+', line_total: 229 },
    { name: 'Second Technician', line_total: 70 }
  ] }), 'Juan').pay, 230, 'Juan two-person NOT split (130 + 40 + 60)');
  // Same job for a normal tech still splits 50/50 + $30 half-bonus.
  eq(computeJobPay(job({ tip: 40, line_items: [
    { name: '98"+', line_total: 229 },
    { name: 'Second Technician', line_total: 70 }
  ] }), 'Kregg').pay, 115, 'Other tech two-person splits (130/2 + 40/2 + 30)');
  // TK, like Juan, brings his own helper — NEVER split, keeps the full $60. Uses
  // the standard rate column (not Juan's): 70-85 base 80 + full 60 = 140.
  eq(computeJobPay(job({ line_items: [
    { name: '70"-85"', line_total: 149 },
    { name: 'Second Technician', line_total: 70 },
  ] }), 'TK').pay, 140, 'TK two-person NOT split: 80 base + full 60 = 140');
  eq(computeJobPay(job({ line_items: [
    { name: '70"-85"', line_total: 149 },
    { name: 'Second Technician', line_total: 70 },
  ] }), 'Kregg').pay, 70, 'normal tech same job splits: 80/2 + 30 = 70');

  // Service-area surcharge → tech travel payout, derived from the surcharge line
  // (tiers 15/10, 65/50, 100/75) so the tech is paid even when the per-zip payout
  // was never configured. Not split between two techs.
  eq(computeJobPay(job({ line_items: [
    { name: '33"–59"', line_total: 109 },
    { name: 'Service area surcharge', line_total: 65 },
  ] }), 'Zach').pay, 110, 'surcharge $65 -> +$50 travel (60 base + 50)');
  eq(computeJobPay(job({ line_items: [
    { name: '33"–59"', line_total: 109 },
    { name: 'Service area surcharge', line_total: 15 },
  ] }), 'Zach').pay, 70, 'surcharge $15 -> +$10 travel');
  eq(computeJobPay(job({ line_items: [
    { name: '33"–59"', line_total: 109 },
    { name: 'Service area surcharge', line_total: 100 },
  ] }), 'Zach').pay, 135, 'surcharge $100 -> +$75 travel');
  // TK's two-TV job: 60-69 + 33-59 + brick + outside wires + soundbar + $65
  // surcharge. 70+60+25+15+35 = 205 labor + 50 travel = 255 (single tech, full).
  eq(computeJobPay(job({ price: 471, subtotal: 435, business_slug: 'handy-andy', line_items: [
    { name: '60"–69"', line_total: 135 },
    { name: '33"–59"', line_total: 125 },
    { name: 'Brick / Stone', line_total: 35 },
    { name: 'Yes, hide the wires OUTSIDE the wall', line_total: 25 },
    { name: 'Soundbar Installation', line_total: 50 },
    { name: 'Service area surcharge', line_total: 65 },
  ] }), 'TK').pay, 255, 'TK two-TV + $65 surcharge = 205 labor + 50 travel = 255');

  // After-hours 8 PM bonus (single tech).
  eq(computeJobPay(job({ line_items: [
    { name: '33"–59"', line_total: 109 },
    { name: 'After-Hours Service Fee (8 PM)', kind: 'fee', line_total: 75 }
  ] }), 'Kregg').pay, 135, '8pm single tech (60 + 75 bonus)');

  // After-hours 8 PM bonus (multi-tech).
  eq(computeJobPay(job({ line_items: [
    { name: '60"–69"', line_total: 119 },
    { name: 'After-Hours Service Fee (8 PM)', kind: 'fee', line_total: 75 },
    { name: 'Second Technician', line_total: 70 }
  ] }), 'Zach').pay, 140, '8pm multi-tech (70/2 + 30 + 75 = 35 + 30 + 75)');

  console.log(fails ? `\n${fails} FAILED` : '\nAll payroll self-tests passed');
  return fails;
}

// Self-tests run ONLY when explicitly requested:  PAYROLL_SELFTEST=1 node api/_lib/payroll.js
// They must NEVER auto-run on import. This module is imported by api/tech.js, which
// Vercel bundles into a serverless function; in that runtime an "if (process.argv[1]
// === import.meta.url) process.exit()" guard can evaluate TRUE at cold start and kill
// the lambda before the request handler runs (every /api/tech call -> hard 500). The
// env flag makes execution impossible in production while keeping the CLI ergonomic.
if (process.env.PAYROLL_SELFTEST === '1') {
  process.exit(runSelfTests() ? 1 : 0);
}
