// ============================================================================
// Shared line-item rules: canonical ticket order, tax recalculation, and the
// li_rev optimistic lock that makes concurrent edits collide loudly instead of
// silently overwriting each other.
//
// Born from the Throckmorton job (2026-08-21): the office and the tech edited
// the same ticket at the same time from two stale copies. Both editors did a
// full replace (read rows -> insert posted set -> delete old), so each save
// resurrected the other's already-replaced view. Five saves in four minutes
// left the ticket with BOTH a "Tilting (recommended) ×3" and a hand-typed
// "Tilting Mounts ×3" ($198 double charge), dropped the $75 wire concealment
// line entirely, kept a stale tax amount, and auto-deducted 6 tilting brackets
// from inventory for a 3-bracket job. Every rule in this module closes one leg
// of that incident.
// ============================================================================

// ── Canonical ticket order (owner rule, 2026-08-24) ─────────────────────────
// Every job's line items read in this order, on every ticket, forever:
//
//   TV size lines, smallest size first
//   everything else (work, add-ons, fees typed by the office), stable order
//   travel fee / service-area surcharge / after-hours fee
//   discounts & coupons
//   tip
//   tax, always the very last line
//
// Enforced at every WRITE (widget mirror, office create, estimate approval,
// office edit, tech edit) by rewriting sort_order — display paths just read
// sort_order back, so no reader needs to know the rule.

// TV-size bands, smallest first. Tests mirror public/admin.html TV_SIZES and
// payroll.js matchSize — including the strict 32" test (a bare "under"
// anywhere must NOT read as a size; see the phantom-32" dropdown bug).
const TV_SIZE_TESTS = [
  /(?:32|thirty.?two).*(?:less|under|below)|under.*32|32"?\s*or\s*less/i, // 32" & under
  /33.*59/,                                                              // 33"-59"
  /60.*69/,                                                              // 60"-69"
  /70.*8[45]/,                                                           // 70"-84"
  /8[456].*(?:9[0-9]|100)/,                                              // 85"-97" / 85"-100"
  /(?:^|\D)98|9[0-9]"?\s*\+/,                                            // 98"+ (incl. legacy '90"+' labels — payroll.js matches these too)
];

// Which size band a line-item label is, or -1 if it isn't a TV-size line.
// Same exclusions as admin.html tvSizeIndex: lifting-help answers embed a size
// range but aren't a size selection, and a line that describes WORK (or a
// bracket, which carries a size suffix on Dom's XL options) is never a TV.
export function tvSizeRank(name) {
  const n = String(name || '').toLowerCase();
  if (/my tv is|\b(?:lift|help|larger|technicians?)\b/.test(n)) return -1;
  if (/\b(?:install|shelf|hang|wire|hiding|conceal(?:ment)?|correction|bracket|mount|soundbar|dismount|fireplace|surcharge|coupon|tax|tip|handyman|recycle|swap|remount)\b/.test(n)) return -1;
  // Bracket TYPE options are never TVs either — Dom's XL variants carry a size
  // suffix ('Tilting (recommended) — 85"–100"') that would otherwise match.
  if (/tilt|full\s*motion|\bflat\b|mantel/.test(n)) return -1;
  for (let i = 0; i < TV_SIZE_TESTS.length; i++) if (TV_SIZE_TESTS[i].test(n)) return i;
  const bare = n.match(/^\s*(\d{2,3})\s*(?:"|inch(?:es)?|in|”|″)?\s*$/);
  if (bare) {
    const v = parseInt(bare[1], 10);
    if (v <= 32) return 0; if (v <= 59) return 1; if (v <= 69) return 2;
    if (v <= 84) return 3; if (v <= 97) return 4; return 5;
  }
  return -1;
}

// How many TVs a ticket's size lines add up to. Used to sanity-bound the
// bracket inventory deduction — a job can never consume more brackets than it
// has TVs, no matter what duplicate lines an edit war left on the ticket.
//
// Deliberately LOOSER than tvSizeRank: it mirrors payroll.js matchSize, which
// is the code that already pays base rates on real-world size labels like
// "TV Install 33-59\"" or "Correction of Previous Job - 60 - 69\"" — labels
// tvSizeRank's display-safety word list rejects. Undercounting TVs here would
// wrongly trim a legitimate bracket deduction, so only two exclusions apply:
// the lifting-help answers and bracket-type lines (which carry size suffixes).
export function countTvUnits(lineItems) {
  let n = 0;
  for (const li of lineItems || []) {
    const name = String((li && li.name) || '').toLowerCase();
    if (!name) continue;
    if (/my tv is|\b(?:lift|help|larger|technicians?)\b/.test(name)) continue;
    if (/tilt|full\s*motion|\bflat\b|mantel|bracket/.test(name)) continue;
    let hit = TV_SIZE_TESTS.some(t => t.test(name));
    if (!hit) {
      const bare = name.match(/^\s*(\d{2,3})\s*(?:"|inch(?:es)?|in|”|″)?\s*$/);
      hit = !!bare;
    }
    if (hit) n += Math.max(1, Math.round(Number(li.quantity) || 1));
  }
  return n;
}

export const BOOKING_TAX_RATE = 0.0825;
export const isTaxLine = (it) => /^\s*tax\b/i.test(String((it && it.name) || ''));

const isTravelLine = (it) => {
  const n = String((it && it.name) || '');
  // Bare "Travel" (the current label), "Travel Fee" (pre-2026-08 tickets),
  // the widget's "Service area surcharge", the per-zip "Location-based
  // pricing" flat fee, and the after-hours fee all live in the travel band.
  // "Second Technician" (kind fee) deliberately does NOT — it's work, so it
  // stays with the other work lines.
  return /surcharge|travel\s*fee|^\s*travel\s*$|after[\s-]?hours|service\s*minimum|location.?based/i.test(n);
};
const isDiscountLine = (it) =>
  ((it && it.kind) === 'coupon') || /\b(?:discount|coupon)\b/i.test(String((it && it.name) || ''))
  || (Number(it && it.line_total) || 0) < 0;
const isTipLine = (it) => ((it && it.kind) === 'tip') || /^\s*tip\b/i.test(String((it && it.name) || ''));

// Band number for one line. Lower sorts first; ties keep their given order.
function lineBand(it) {
  if (isTaxLine(it)) return 900;                 // tax: always the very bottom
  if (isTipLine(it)) return 800;
  if (isDiscountLine(it)) return 700;
  if (isTravelLine(it)) return 600;
  const size = tvSizeRank(it && it.name);
  if (size >= 0) return 100 + size;              // TVs first, smallest first
  return 300;                                    // everything else, stable
}

// Rewrite an item array into canonical order. Stable within each band, so the
// office's drag order among the "everything else" lines still round-trips.
export function canonicalizeLineItems(items) {
  return (Array.isArray(items) ? items.slice() : []).sort((a, b) => lineBand(a) - lineBand(b));
}

// Recompute a ticket's tax line from the lines it is actually made of. Only an
// EXISTING tax line is recalculated — a ticket that legitimately has no tax
// line (tax-exempt work, cash) never has one invented. Collapses multiple tax
// rows into one at the end. (Moved here from api/admin.js so the tech-side
// save can finally apply the same rule — the stale-tax leg of Throckmorton.)
export function recalcTaxLine(items) {
  if (!items.some(isTaxLine)) return items;
  const body = items.filter(it => !isTaxLine(it));
  const base = body.reduce((t, it) => t + (it.taxable === false ? 0 : it.line_total), 0);
  const tax = Math.round(base * BOOKING_TAX_RATE * 100) / 100;
  return [...body, {
    name: `Tax (${(BOOKING_TAX_RATE * 100).toFixed(2).replace(/\.?0+$/, '')}%)`,
    quantity: 1, unit_price: tax, line_total: tax, kind: 'fee', taxable: false,
  }];
}

// ── Bracket-deduction sanity bound ──────────────────────────────────────────
// detectBracketQtys() substring-matches bracket words, so a ticket carrying
// BOTH "Tilting (recommended) ×3" and a hand-typed "Tilting Mounts ×3" counts
// 6 tilting brackets. Physically a job can never use more brackets than it has
// TVs — clamp to the ticket's TV count, trimming the biggest category first
// (the duplicated one is by construction the biggest). No TV lines on the
// ticket (handyman/Assurion) → nothing to bound against, leave it alone.
export function clampBracketQtysToTvCount(qtys, lineItems) {
  const tvUnits = countTvUnits(lineItems);
  if (!tvUnits) return false;
  let total = (qtys.flat || 0) + (qtys.tilting || 0) + (qtys.full_motion || 0);
  if (total <= tvUnits) return false;
  // Only trim when there's an actual DUPLICATE signal: the Throckmorton shape
  // is a widget SELECTION line ("Tilting (recommended)") sharing a category
  // with a hand-typed hardware line ("Tilting Mounts"). Two selection lines in
  // one category are a legitimate widget output (Dom's regular + XL variants
  // of the same bracket style), and "more brackets than TVs" with no
  // duplicate usually means a TV line the counter didn't recognize — trimming
  // a CORRECT deduction is worse than the drift the usage-log already
  // records, so in both of those cases warn and stand down.
  const isSelectionLabel = (n) => {
    // Widget option labels, all variants both businesses ship:
    //   'Flat' / 'Tilting (recommended)' / 'Full Motion'          (standard)
    //   'Tilting (recommended) — 85"–100"'                        (Dom's XL)
    //   '85"-100" TV Tilting Bracket'                             (Handy Andy XL)
    //   'Bracket: Tilting' (some paths prefix the option group)
    const core = n.replace(/^\s*bracket\s*:\s*/, '')
      .replace(/\s*[—–-]+\s*8[45].*$/, '')                     // Dom's XL suffix
      .replace(/^\s*8[45]"?\s*[—–-]+\s*100"?\s*tv\s*/, '')     // Handy Andy XL prefix
      .replace(/\s*bracket\s*$/, '').trim();
    return /^(?:flat|tilting\s*(?:\(recommended\))?|full\s*motion)\s*(?:[×✕✖]\s*\d+)?\s*$/.test(core);
  };
  const lineCounts = { flat: 0, tilting: 0, full_motion: 0 };
  const nonSelection = { flat: 0, tilting: 0, full_motion: 0 };
  for (const li of lineItems || []) {
    const name = String((li && li.name) || '').toLowerCase();
    if (/customer.?supplied/.test(name)) continue;
    let key = null;
    if (/full.?motion/.test(name)) key = 'full_motion';
    else if (/tilt/.test(name)) key = 'tilting';
    else if (/\bflat\b|fixed/.test(name)) key = 'flat';
    if (!key) continue;
    lineCounts[key]++;
    if (!isSelectionLabel(name)) nonSelection[key]++;
  }
  const dup = ['full_motion', 'tilting', 'flat']
    .filter(k => lineCounts[k] >= 2 && nonSelection[k] >= 1);
  if (!dup.length) {
    console.warn(`[bracket] detected more brackets than recognized TVs (${JSON.stringify(qtys)} vs ${tvUnits} TVs) but no duplicate bracket line — a TV line may be unrecognized; NOT clamping.`);
    return false;
  }
  const before = { ...qtys };
  while (total > tvUnits) {
    const key = dup.reduce((max, k) => ((qtys[k] || 0) > (qtys[max] || 0) ? k : max), dup[0]);
    if (!(qtys[key] > 0)) break;                 // duplicated categories exhausted — stop
    qtys[key] -= 1; total -= 1;
  }
  console.warn(`[bracket] duplicate bracket line detected — clamped deduction ${JSON.stringify(before)} to ${JSON.stringify(qtys)} (${tvUnits} TVs on the ticket).`);
  return true;
}

// ── li_rev: optimistic lock on a booking's line items ───────────────────────
// Every editor loads the booking's li_rev and sends it back on save. Every
// writer bumps it. A save whose li_rev no longer matches means the ticket
// changed under the editor — the save is refused with a 409 instead of
// silently replacing rows the editor never saw (the exact both-sides-blind
// overwrite that double-charged Throckmorton).
//
// The bump is a compare-and-swap: the UPDATE only matches while li_rev still
// holds the value the caller read, so two concurrent savers can't both pass —
// the second one matches zero rows and gets ok:false. extraPatch lets the
// caller fold its snapshot (li_backups) into the same single metadata write.
//
// Known residual: this writes the WHOLE metadata object, guarded only on
// li_rev — an unrelated key stamped by another handler between the caller's
// read and this write (e.g. review_sms_sent_at) can be lost. That read-modify-
// write pattern is codebase-wide and pre-dates this lock; callers keep the
// window small by reading metadata immediately before calling.
export async function casBumpLiRev(db, bookingId, meta, extraPatch = {}) {
  const cur = Number(meta && meta.li_rev) || 0;
  const newMeta = { ...(meta || {}), ...extraPatch, li_rev: cur + 1 };
  let q = db.from('bookings').update({ metadata: newMeta }).eq('id', bookingId);
  // jsonb ->> yields text; a booking that has never been edited has no li_rev
  // key at all (or a literal 0), so rev 0 must match both shapes.
  q = cur > 0 ? q.eq('metadata->>li_rev', String(cur))
              : q.or('metadata->>li_rev.is.null,metadata->>li_rev.eq.0');
  const { data, error } = await q.select('id');
  if (error) throw error;
  return { ok: !!(data && data.length), rev: cur + 1, newMeta };
}

// Fire-and-forget bump for paths that APPEND or STRIP lines outside an editor
// (GDS upsell add, cash-payment tax strip, widget re-mirror). They don't need
// conflict detection themselves — they just have to invalidate any editor
// that's currently open on the ticket, so ITS save 409s instead of silently
// undoing them. Best-effort by design: never blocks the caller.
//
// Uses the same CAS as the editors, retried: a blind read-then-write here
// could land ON TOP of a concurrent editor CAS and set li_rev to the exact
// value that editor was just handed — un-invalidating it and reverting its
// li_backups snapshot. With the CAS, an interleaved write just makes this
// retry from the fresh value.
export async function bumpLiRev(db, bookingId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await db.from('bookings').select('metadata').eq('id', bookingId).maybeSingle();
      if (!data) return;
      const cas = await casBumpLiRev(db, bookingId, data.metadata);
      if (cas.ok) return;
      // Someone else bumped between our read and write — re-read and retry.
    } catch (e) {
      console.warn('[li_rev] bump failed (non-fatal):', e.message);
      return;
    }
  }
  console.warn(`[li_rev] bump for booking ${bookingId} lost the CAS race 3 times — giving up (non-fatal).`);
}

// The 409 every conflicting save returns. One shared code so both clients can
// key their "reload the ticket" handling off it.
export const LI_CONFLICT_CODE = 'li_conflict';

// ── Self-tests:  LINE_ITEMS_SELFTEST=1 node api/_lib/line-items.js ──────────
// Same pattern as payroll.js: env-gated so it can never run in a lambda.
function runSelfTests() {
  let fails = 0;
  const eq = (got, want, label) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { fails++; console.error(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
    else console.log(`ok   ${label}`);
  };
  const names = (items) => items.map(i => i.name);

  // The user's exact spec: small tv, big tv, random items, travel, discount, tax.
  eq(names(canonicalizeLineItems([
    { name: 'Tax (8.25%)', kind: 'fee', line_total: 91.16 },
    { name: 'Multi-TV discount', kind: 'coupon', line_total: -78 },
    { name: '98"+', kind: 'service', line_total: 250 },
    { name: 'Service area surcharge', kind: 'fee', line_total: 65 },
    { name: 'Soundbar Installation (you supply the mounting bracket)', line_total: 50 },
    { name: '33"–59"', kind: 'service', line_total: 220 },
    { name: 'Tilting (recommended)', line_total: 180 },
    { name: '60"–69"', kind: 'service', line_total: 125 },
  ])), ['33"–59"', '60"–69"', '98"+', 'Soundbar Installation (you supply the mounting bracket)',
        'Tilting (recommended)', 'Service area surcharge', 'Multi-TV discount', 'Tax (8.25%)'],
     'canonical order: sizes ascending, work, travel, discount, tax');

  eq(tvSizeRank('Tilting (recommended) — 85"–100"'), -1, 'XL bracket line is not a TV size');
  eq(tvSizeRank('I have 1 TV above a fireplace'), -1, 'fireplace answer is not a TV size');
  eq(tvSizeRank('75"'), 3, 'bare-inch maps into its band');
  eq(tvSizeRank('90"+'), 5, 'legacy 90"+ label bands as the largest size');
  eq(tvSizeRank('Install shelf under TV'), -1, 'strict 32" test (phantom-dropdown bug)');
  eq(countTvUnits([{ name: '33"–59"', quantity: 2 }, { name: '98"+', quantity: 1 },
    { name: 'Tilting Mounts', quantity: 3 }]), 3, 'TV count ignores bracket lines');
  // The loose counter mirrors payroll matchSize: real-world phrasings that the
  // display-safe tvSizeRank rejects still count as TVs here.
  eq(countTvUnits([{ name: 'TV Install 33-59"', quantity: 1 },
    { name: 'Correction of Previous Job - 60 - 69"', quantity: 1 },
    { name: '90"+', quantity: 1 }]), 3, 'work-word TV phrasings still count as TV units');
  eq(countTvUnits([{ name: 'My TV is 85 inches or larger and I can help lift', quantity: 1 }]), 0,
     'lifting-help answer never counts as a TV');

  // The Throckmorton inventory leg: 4 TVs, DUPLICATE tilting lines (selection +
  // hand-typed hardware) detected as 6 -> clamp to the 4 TVs on the ticket.
  const throck = [
    { name: '98"+', quantity: 1 }, { name: '60"–69"', quantity: 1 }, { name: '33"–59"', quantity: 2 },
    { name: 'Tilting (recommended)', quantity: 3 }, { name: 'Tilting Mounts', quantity: 3 }];
  const q = { flat: 0, tilting: 6, full_motion: 0 };
  eq([clampBracketQtysToTvCount(q, throck), q.tilting], [true, 4], 'duplicate bracket line clamps to TV count');
  const q2 = { flat: 1, tilting: 2, full_motion: 0 };
  eq([clampBracketQtysToTvCount(q2, [{ name: '33"–59"', quantity: 3 },
    { name: 'Flat', quantity: 1 }, { name: 'Tilting (recommended)', quantity: 2 }]), q2.tilting],
     [false, 2], 'legit ticket untouched');
  const q3 = { flat: 0, tilting: 2, full_motion: 0 };
  eq([clampBracketQtysToTvCount(q3, [{ name: 'Handyman hourly', quantity: 3 }]), q3.tilting],
     [false, 2], 'no TV lines -> no clamp');
  // Over TV count but only ONE bracket line -> a TV line probably went
  // unrecognized; never trim a possibly-correct deduction without a duplicate.
  const q4 = { flat: 0, tilting: 2, full_motion: 0 };
  eq([clampBracketQtysToTvCount(q4, [{ name: '60"–69"', quantity: 1 },
    { name: 'Tilting (recommended)', quantity: 2 }]), q4.tilting],
     [false, 2], 'no duplicate signal -> no clamp');
  // Two SELECTION lines in one category are a legit widget shape (standard +
  // XL variants of the same style) — even alongside an unrecognized TV line
  // they are not a duplicate signal.
  const q5 = { flat: 0, tilting: 2, full_motion: 0 };
  eq([clampBracketQtysToTvCount(q5, [{ name: '60"–69"', quantity: 1 },
    { name: 'Mounting a 98 inch TV on brick', quantity: 1 },
    { name: 'Tilting (recommended)', quantity: 1 },
    { name: '85"-100" TV Tilting Bracket', quantity: 1 }]), q5.tilting],
     [false, 2], 'standard + XL selection pair is not a duplicate');
  const q6 = { flat: 0, tilting: 2, full_motion: 0 };
  eq([clampBracketQtysToTvCount(q6, [{ name: '60"–69"', quantity: 1 },
    { name: 'Tilting (recommended)', quantity: 1 },
    { name: 'Tilting Mounts', quantity: 1 }]), q6.tilting],
     [true, 1], 'selection + hand-typed hardware IS a duplicate -> clamp');
  eq(names(canonicalizeLineItems([
    { name: 'Location-based pricing', kind: 'fee', line_total: 25 },
    { name: 'Second Technician', kind: 'fee', line_total: 70 },
    { name: '33"–59"', kind: 'service', line_total: 109 },
  ])), ['33"–59"', 'Second Technician', 'Location-based pricing'],
     'location fee sits in the travel band, second tech stays with work');

  eq(names(recalcTaxLine([
    { name: '33"–59"', line_total: 220, taxable: true },
    { name: 'Tax (8.25%)', line_total: 1, taxable: false },
  ])), ['33"–59"', 'Tax (8.25%)'], 'tax recalc keeps tax last');
  eq(recalcTaxLine([
    { name: '33"–59"', line_total: 200, taxable: true },
    { name: 'Tax (8.25%)', line_total: 1, taxable: false },
  ])[1].line_total, 16.5, 'tax recomputed from the lines');
  eq(names(recalcTaxLine([{ name: 'Handyman', line_total: 100 }])), ['Handyman'],
     'no tax line -> none invented');

  console.log(fails ? `\n${fails} FAILED` : '\nAll line-items self-tests passed');
  return fails;
}
if (process.env.LINE_ITEMS_SELFTEST === '1') {
  process.exit(runSelfTests() ? 1 : 0);
}
