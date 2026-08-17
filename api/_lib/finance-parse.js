// ============================================================================
// Finance statement parsing + auto-categorization. Pure functions -- no DB, no
// network -- so they're testable against a real statement's extracted text
// without touching Supabase or Stripe. api/finance.js is the only caller.
//
// Statement text extraction (PDF -> raw text) happens in api/finance.js via
// pdf-parse; this file starts from that raw text.
// ============================================================================
import { createHash } from 'crypto';

// One row before it's been assigned an account or hashed: { date: 'YYYY-MM-DD',
// description: string, amount: number (signed, dollars) }.

// ---------------------------------------------------------------------------
// De-dupe key. Re-uploading the same statement (or a month that overlaps the
// previous one by a few days, which several banks' PDFs do at the boundary)
// must not double-import a row. Hashing date+amount+description (not the
// account -- the DB unique constraint already scopes per-account) means the
// exact same charge appearing twice for a genuinely different reason (e.g.
// two identical $45 gas fill-ups on the same day) still gets two rows, since
// their position in the statement text differs enough to change nothing here
// -- this is intentional: banks don't give a stable row id, so "identical
// date+amount+description" IS the definition of "the same transaction" this
// tool can use. A real duplicate transaction is rare enough, and a silently
// dropped real charge is worse than an occasional harmless duplicate a human
// will notice on the ledger and can delete.
// ---------------------------------------------------------------------------
export function financeImportHash(row) {
  const key = `${row.date}|${row.amount.toFixed(2)}|${(row.description || '').trim().toLowerCase()}`;
  return createHash('sha256').update(key).digest('hex');
}

// ---------------------------------------------------------------------------
// Parsers. Each takes raw pdf-parse text and returns rows. Bank statement
// PDFs vary a lot in exact layout, so these match on the general shape every
// mainstream bank/card statement shares (a date, a description, a dollar
// amount, per line) rather than one bank's exact column positions -- pdf-parse
// flattens columns to plain text, so column alignment can't be relied on
// anyway. MM/DD or MM/DD/YYYY at the start of a line, then a description,
// then a trailing dollar amount (optionally parenthesized/negative/with a
// trailing minus, all of which mean a debit).
// ---------------------------------------------------------------------------

// Pull the statement year from anywhere in the text (e.g. a "Statement Period
// MM/DD/2026 - MM/DD/2026" header) so a bare "MM/DD" transaction line can be
// turned into a real date. Falls back to the current year rather than
// throwing -- a wrong year is visible and fixable in the upload preview; a
// hard failure blocks the whole statement over one missing header line.
function guessStatementYear(text) {
  const m = text.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : new Date().getFullYear();
}

const MONEY = /\(?-?\$?[\d,]+\.\d{2}\)?-?/;
// A transaction line: leading MM/DD(/YYYY), a description, a trailing amount.
// Greedy description then a MONEY token anchored to the end of the line is
// what lets "PAYMENT 4/15 THANK YOU $500.00" (a description that itself
// contains what looks like a date) still parse correctly -- only the FIRST
// date-shaped token on the line is ever read as the transaction date.
const LINE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.+?)\s+(\(?-?\$?[\d,]+\.\d{2}\)?-?)\s*$/;

function parseMoney(tok) {
  const neg = /^\(/.test(tok) || /\)$/.test(tok) || /^-/.test(tok) || /-$/.test(tok);
  const n = Number(tok.replace(/[()$,\-]/g, ''));
  return neg ? -n : n;
}

function parseGenericLines(text, { year, invertSign = false, skipIf = null } = {}) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, mm, dd, yy, desc, amtTok] = m;
    if (skipIf && skipIf(desc)) continue;
    const yr = yy ? (yy.length === 2 ? 2000 + Number(yy) : Number(yy)) : year;
    const mmN = Number(mm), ddN = Number(dd);
    if (mmN < 1 || mmN > 12 || ddN < 1 || ddN > 31) continue;
    let amount = parseMoney(amtTok);
    if (invertSign) amount = -amount;
    out.push({
      date: `${yr}-${String(mmN).padStart(2, '0')}-${String(ddN).padStart(2, '0')}`,
      description: desc.replace(/\s+/g, ' ').trim(),
      amount,
    });
  }
  return out;
}

// Bank statement (checking/savings): deposits are positive in the statement
// text already (no sign flip needed); the running-balance column, if present,
// gets swept up by LINE_RE's greedy description group and just becomes noise
// at the end of the description -- harmless, since nothing parses the
// description for meaning, only the categorizer's keyword match below, and a
// trailing number there doesn't match any category keyword.
export function parseBankStatementText(text) {
  const year = guessStatementYear(text);
  return parseGenericLines(text, {
    year,
    // Statement boilerplate lines that happen to contain a date+amount shape
    // (a "Fees charged this period $0.00" summary line, an APY disclosure
    // line quoting a rate as if it were money) -- excluded by description
    // rather than position, since position varies by bank.
    skipIf: (desc) => /^(beginning balance|ending balance|total (deposits|withdrawals|fees)|annual percentage yield|interest rate|fees charged)/i.test(desc.trim()),
  });
}

// Credit card statement: a PURCHASE is a debit (money the business owes MORE
// of) and a PAYMENT/CREDIT is money paid down. This tool's sign convention is
// "positive = money in to this account" for every account including the
// card, so a payment (which reduces what's owed, i.e. is "money in" to the
// card account the same way a deposit is money in to a bank account) is
// positive, and a purchase is negative. Most card statements print purchases
// as a plain positive dollar figure and payments/credits with a trailing or
// leading minus -- the OPPOSITE of the sign this tool wants -- so every parsed
// amount gets inverted, then a payment (which the statement showed negative)
// becomes positive, and a purchase (shown positive) becomes negative.
export function parseCreditCardStatementText(text) {
  const year = guessStatementYear(text);
  return parseGenericLines(text, {
    year,
    invertSign: true,
    skipIf: (desc) => /^(previous balance|new balance|minimum payment|total (interest|fees) charged|interest charge calculation)/i.test(desc.trim()),
  });
}

// ---------------------------------------------------------------------------
// Categorization. Ordered rules, first match wins. Keyword matching against
// the raw description, case-insensitive. This is intentionally simple (no
// ML, no external lookup) so every categorization is explainable by which
// rule fired -- important for money the owner is trusting sight-unseen.
// ---------------------------------------------------------------------------
const CATEGORY_RULES = [
  // Income: anything landing as a deposit that names Stripe (the only inbound
  // revenue channel both businesses use) or an explicit payout/deposit label.
  { category: 'income', test: (d, amt) => amt > 0 && /stripe|payout|deposit.*(handy|doms|dom's)|merchant.*deposit/i.test(d) },
  { category: 'tech_payroll', test: (d) => /payroll|direct dep.*(tech|kregg|steve|zach|juan|heather|joey)|zelle.*(tech|kregg|steve|zach|juan)/i.test(d) },
  { category: 'materials', test: (d) => /home depot|lowe'?s|ace hardware|menards|bracket|hardware store/i.test(d) },
  { category: 'fuel_vehicle', test: (d) => /shell|chevron|exxon|mobil|conoco|texaco|circle k|fuel|gas station|auto ?zone|discount tire|jiffy lube|valvoline/i.test(d) },
  { category: 'marketing', test: (d) => /google ads|facebook ads|meta ads|adwords|yelp ads|angi|thumbtack|nextdoor ads|landingsite/i.test(d) },
  { category: 'software', test: (d) => /vercel|supabase|twilio|resend|openai|anthropic|stripe fee|zoom|microsoft 365|google workspace|godaddy|namecheap|adobe|quickbooks|grasshopper/i.test(d) },
  { category: 'insurance', test: (d) => /insurance|geico|progressive|state farm|allstate|liability ins/i.test(d) },
  { category: 'fees_interest', test: (d) => /overdraft|maintenance fee|service charge|interest charge|late fee|annual fee|nsf fee/i.test(d) },
  { category: 'tax_set_aside', test: (d) => /irs|estimated tax|eftps|tax payment/i.test(d) },
];

// Returns { category, category_locked:false } -- callers set category_locked
// only when a human picks it, never here.
export function categorize(description) {
  const d = (description || '');
  for (const rule of CATEGORY_RULES) {
    if (rule.test(d, 0)) return rule.category;
  }
  return 'uncategorized';
}
// Amount-aware variant for the one rule (income) that also checks sign.
export function categorizeRow(row) {
  const d = row.description || '';
  for (const rule of CATEGORY_RULES) {
    if (rule.test(d, row.amount)) return rule.category;
  }
  return 'uncategorized';
}

// ---------------------------------------------------------------------------
// Transfer detection. Given ALL transactions across ALL of the owner's
// accounts (already in the DB, freshly inserted rows included), find pairs
// that are really one movement of money between two of his own accounts: an
// outflow on account A and an inflow on account B, same magnitude, within a
// few days of each other (bank/card posting dates rarely match to the day).
// Matched pairs are excluded from spend/profit -- see api/finance.js -- but
// stay visible in each account's own register.
//
// Greedy nearest-date matching, not a full bipartite optimum: for the volume
// one owner's personal accounts produce (dozens of rows a month, not
// thousands), a same-amount collision within the match window is rare enough
// that greedy-by-date-proximity gives the same pairing an optimal matcher
// would, at a fraction of the complexity. A same-amount collision that DOES
// happen still produces a real, visible pair -- worst case it's the "wrong"
// one of two identical-amount transfers, which nets to the same dollar effect
// either way.
// ---------------------------------------------------------------------------
const TRANSFER_MATCH_WINDOW_DAYS = 4;

export function detectTransfers(transactions) {
  // transactions: [{ id, account_id, posted_date, amount, is_transfer }]
  const outflows = transactions.filter(t => t.amount < 0 && !t.is_transfer);
  const inflows = transactions.filter(t => t.amount > 0 && !t.is_transfer);
  const usedInflow = new Set();
  const pairs = [];
  for (const out of outflows) {
    const outMs = Date.parse(out.posted_date + 'T00:00:00Z');
    let best = null, bestDiff = Infinity;
    for (const inf of inflows) {
      if (usedInflow.has(inf.id)) continue;
      if (inf.account_id === out.account_id) continue;          // must be a DIFFERENT account
      if (Math.abs(inf.amount + out.amount) > 0.005) continue;    // same magnitude, opposite sign
      const diffDays = Math.abs(Date.parse(inf.posted_date + 'T00:00:00Z') - outMs) / 86400000;
      if (diffDays > TRANSFER_MATCH_WINDOW_DAYS) continue;
      if (diffDays < bestDiff) { bestDiff = diffDays; best = inf; }
    }
    if (best) {
      usedInflow.add(best.id);
      pairs.push([out.id, best.id]);
    }
  }
  return pairs; // [[outflowId, inflowId], ...]
}
