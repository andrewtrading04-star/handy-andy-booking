// /api/_lib/broker-pricing.js
// The markup rule for subcontractor-brokered jobs, in ONE place so the office
// UI, the server validation and the reporting all agree to the penny.
//
// Owner's rule (Aug 2026): the cut is a MINIMUM of 20 percent, and the
// minimum sell price rounds UP to a whole dollar. Owner's worked example: a
// sub quotes 543, so 543 x 1.20 = 651.60, and rounding up gives 652. (The
// owner originally wrote 651 in the spec and then explicitly chose round-up,
// so 652 is correct and intentional.)
//
// Why integer cents instead of Math.ceil(sub * 1.20): binary floating point
// makes that expression overcharge by a FULL DOLLAR on 2000 of the first
// 500k cent values. A $1.67 sub gives 1.67 * 1.20 = 2.004 in float, and
// ceil() turns that into a $3 minimum instead of $2 -- a 50 percent error on
// a rounding artifact. Normalizing to cents first, then rounding up to
// dollars, removes the artifact. Whole-dollar sub prices are unaffected
// either way; this only protects the cents cases.

export const MARKUP_NUMERATOR = 12;   // 1.20 as an exact integer ratio,
export const MARKUP_DENOMINATOR = 10; // so no 1.2 float ever enters the math.

// Parses a money input from a form. Returns null for blank/garbage/negative
// rather than 0, so "not filled in yet" stays distinguishable from "free".
export function parseMoney(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

// The lowest price we will sell a brokered job for. Whole dollars, rounded up.
// Returns null when there is no usable sub price, so callers never compare
// against a bogus 0 minimum.
export function minSellPrice(subPrice) {
  const sub = parseMoney(subPrice);
  if (sub === null) return null;
  const cents = Math.round(sub * 100);
  const markedUpCents = Math.round((cents * MARKUP_NUMERATOR) / MARKUP_DENOMINATOR);
  return Math.ceil(markedUpCents / 100);
}

// What we actually make. Kept here so the UI preview and the server agree,
// but note the DATABASE owns the stored spread (estimates.broker_spread is a
// generated column), so this can never silently persist a wrong number.
export function spread(subPrice, sellPrice) {
  const sub = parseMoney(subPrice);
  const sell = parseMoney(sellPrice);
  if (sub === null || sell === null) return null;
  return Math.round((sell - sub) * 100) / 100;
}

// Guard for the save path. belowMin is only ever allowed through when a human
// ticked the override, and we report it so the estimate can record the fact.
export function checkSellPrice(subPrice, sellPrice, override) {
  const sub = parseMoney(subPrice);
  const sell = parseMoney(sellPrice);
  const min = minSellPrice(sub);
  if (sub === null) return { ok: false, error: 'Enter the subcontractor price first.' };
  if (sell === null) return { ok: false, error: 'Enter a sell price.' };
  const belowMin = sell < min;
  if (belowMin && !override) {
    return { ok: false, belowMin: true, min, error: `Sell price is below the $${min} minimum (20 percent over the $${sub} sub price). Tick the override to save it anyway.` };
  }
  return { ok: true, belowMin, min, sub, sell, spread: spread(sub, sell) };
}
