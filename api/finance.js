// ============================================================================
// Finances API -- Andrew's personal + business bank/card accounts. Owner
// ONLY, and deliberately its own file, not an action bolted onto
// api/admin.js. Same reasoning api/audit.js documents for the call auditor:
// admin.js has ~65+ actions and a huge shared surface used by both the owner
// AND secretaries (role checked per-action, scattered through the file); one
// missed `if (auth.role !== 'owner')` on a future edit there would leak
// financial data to Heather or Joey's login. Here there is nothing to miss --
// the very first thing this handler does after verifying the token is check
// role==='owner', before ANY action runs, so a bug in one action's own logic
// still can't expose this to anyone else. Techs and secretaries have no path
// to this file at all: it isn't imported by api/tech.js or api/admin.js, and
// public/tech.html never calls it.
//
//   GET  accounts                                    -> the 4 (or more) accounts
//   GET  transactions   ?account_id=&category=&q=     -> ledger, filterable
//   POST transaction_update  { id, category }         -> re-file one row (locks it)
//   POST statement_preview   { account_id, file_base64, source_label } -> parsed rows, NOT saved
//   POST statement_commit    { account_id, source_label, rows }        -> saves the previewed rows
//   POST transactions_delete { ids: [] }               -> remove rows (e.g. a bad import)
//   GET  overview        ?months=6                     -> cash totals, monthly trend, category breakdown
//   GET  reconciliation  ?weeks=8                       -> payroll + Stripe cross-check
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { signToken, verifyToken, getBearer, applyCors } from './_lib/auth.js';
import { listPayouts } from './_lib/stripe.js';
import {
  financeImportHash, parseBankStatementText, parseCreditCardStatementText,
  categorizeRow, detectTransfers,
} from './_lib/finance-parse.js';

const CATEGORIES = [
  'income', 'tech_payroll', 'materials', 'marketing', 'software', 'insurance',
  'fuel_vehicle', 'tax_set_aside', 'personal_draw', 'fees_interest',
  'internal_transfer', 'other', 'uncategorized',
];

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || (req.body && req.body.action) || '').toString();
  const body = req.body || {};

  try {
    // The one choke point. Every action below runs only after this passes --
    // there is no action-specific auth check anywhere else in this file on
    // purpose, so there is nothing for a future edit to forget.
    const auth = verifyToken(getBearer(req));
    if (!auth || auth.kind !== 'admin' || auth.role !== 'owner') {
      return res.status(403).json({ error: 'Owner only' });
    }

    const db = serviceClient();
    switch (action) {
      case 'accounts':            return await accounts(req, res, db);
      case 'transactions':        return await transactions(req, res, db);
      case 'transaction_update':  return await transactionUpdate(req, res, db, body);
      case 'transactions_delete': return await transactionsDelete(req, res, db, body);
      case 'statement_preview':   return await statementPreview(req, res, db, body);
      case 'statement_commit':    return await statementCommit(req, res, db, body);
      case 'overview':            return await overview(req, res, db);
      case 'reconciliation':      return await reconciliation(req, res, db);
      default:                    return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    console.error('[finance]', action, e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}

async function accounts(req, res, db) {
  const { data, error } = await db.from('finance_accounts')
    .select('id, name, account_type, last4, display_order, archived')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return res.status(200).json({ accounts: data || [] });
}

async function transactions(req, res, db) {
  const { account_id, category, q } = req.query;
  let query = db.from('finance_transactions')
    .select('id, account_id, posted_date, description, amount, category, category_locked, is_transfer, transfer_pair_id, source_label')
    .order('posted_date', { ascending: false })
    .limit(2000);
  if (account_id) query = query.eq('account_id', String(account_id));
  if (category) query = query.eq('category', String(category));
  if (q) query = query.ilike('description', `%${String(q)}%`);
  const { data, error } = await query;
  if (error) throw error;
  return res.status(200).json({ transactions: data || [] });
}

async function transactionUpdate(req, res, db, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!body.id) return res.status(400).json({ error: 'id required' });
  const category = (body.category || '').toString();
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
  // A human re-filing a row is exactly what locks it against a future
  // auto-categorize re-run -- see the column comment in the migration.
  const { data, error } = await db.from('finance_transactions')
    .update({ category, category_locked: true, is_transfer: category === 'internal_transfer', updated_at: new Date().toISOString() })
    .eq('id', body.id).select('id, category').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Transaction not found' });
  return res.status(200).json({ ok: true });
}

async function transactionsDelete(req, res, db, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const { error } = await db.from('finance_transactions').delete().in('id', ids);
  if (error) throw error;
  return res.status(200).json({ ok: true, deleted: ids.length });
}

// ── Statement upload: preview first, commit second ──────────────────────────
// Two-step on purpose. A bank's PDF layout can drift (a new statement
// template, a reformatted month) and this tool's parser is regex-based, not a
// real PDF table reader -- silently importing whatever it manages to match
// would be exactly how a mis-parsed row (wrong sign, wrong date, a
// half-matched description) enters the ledger unnoticed. Preview returns
// parsed rows and does NOT touch the database; commit takes back the (or an
// edited) row set and actually inserts.
async function extractPdfText(base64) {
  const buf = Buffer.from(base64, 'base64');
  // Import from the lib entry point, not the package root -- the package root
  // (pdf-parse/index.js) runs a debug harness on require in some versions
  // that tries to read a local test fixture off disk, which throws in a
  // serverless function where that file doesn't exist. The lib path is the
  // actual parser with none of that.
  const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
  const out = await pdfParse(buf);
  return out.text || '';
}

async function statementPreview(req, res, db, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!body.account_id) return res.status(400).json({ error: 'account_id required' });
  if (!body.file_base64) return res.status(400).json({ error: 'file_base64 required' });

  const { data: acct } = await db.from('finance_accounts').select('id, account_type').eq('id', body.account_id).maybeSingle();
  if (!acct) return res.status(404).json({ error: 'Account not found' });

  let text;
  try { text = await extractPdfText(body.file_base64); }
  catch (e) { return res.status(400).json({ error: `Could not read that PDF: ${e.message}` }); }
  if (!text.trim()) return res.status(400).json({ error: 'No text could be extracted from that PDF (it may be a scanned image, not a real PDF).' });

  const parseFn = acct.account_type === 'credit_card' ? parseCreditCardStatementText : parseBankStatementText;
  const rows = parseFn(text).map(r => ({ ...r, category: categorizeRow(r) }));

  if (!rows.length) {
    return res.status(200).json({
      rows: [],
      warning: 'No transaction lines were recognized in this statement. The layout may not match what this parser expects -- nothing was imported.',
    });
  }

  // Flag which rows already exist (would be skipped on commit) so the
  // preview honestly shows what will actually change.
  const hashes = rows.map(r => financeImportHash(r));
  const { data: existing } = await db.from('finance_transactions')
    .select('import_hash').eq('account_id', body.account_id).in('import_hash', hashes);
  const existingSet = new Set((existing || []).map(r => r.import_hash));
  const withStatus = rows.map((r, i) => ({ ...r, already_imported: existingSet.has(hashes[i]) }));

  return res.status(200).json({
    rows: withStatus,
    new_count: withStatus.filter(r => !r.already_imported).length,
    duplicate_count: withStatus.filter(r => r.already_imported).length,
  });
}

async function statementCommit(req, res, db, body) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!body.account_id) return res.status(400).json({ error: 'account_id required' });
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'rows required' });

  const inserts = rows.map(r => {
    const amount = Number(r.amount);
    return {
      account_id: body.account_id,
      posted_date: r.date,
      description: String(r.description || '').slice(0, 500),
      amount,
      category: CATEGORIES.includes(r.category) ? r.category : categorizeRow({ description: r.description, amount }),
      source_label: (body.source_label || '').toString().slice(0, 40) || null,
      import_hash: financeImportHash({ date: r.date, description: r.description, amount }),
    };
  });

  // Duplicates (same account_id + import_hash) are silently skipped, not
  // errored -- that's the whole point of the hash, so re-uploading a
  // statement that overlaps a previous one is always safe to just do again.
  const { data: inserted, error } = await db.from('finance_transactions')
    .upsert(inserts, { onConflict: 'account_id,import_hash', ignoreDuplicates: true })
    .select('id');
  if (error) throw error;

  // Re-run transfer detection across ALL accounts, not just this one -- a
  // transfer's other leg may already be sitting in a different account from
  // an earlier import.
  await recomputeTransfers(db);

  return res.status(200).json({ ok: true, inserted: (inserted || []).length, skipped_duplicates: inserts.length - (inserted || []).length });
}

async function recomputeTransfers(db) {
  const { data: rows } = await db.from('finance_transactions')
    .select('id, account_id, posted_date, amount, is_transfer, category_locked')
    .order('posted_date', { ascending: true })
    .limit(5000);
  const candidates = (rows || []).filter(r => !r.category_locked); // never re-pair a human-filed row
  const pairs = detectTransfers(candidates);
  for (const [outId, inId] of pairs) {
    await db.from('finance_transactions').update({ is_transfer: true, category: 'internal_transfer', transfer_pair_id: inId }).eq('id', outId);
    await db.from('finance_transactions').update({ is_transfer: true, category: 'internal_transfer', transfer_pair_id: outId }).eq('id', inId);
  }
}

// ── Overview: cash totals, monthly trend, category breakdown ────────────────
async function overview(req, res, db) {
  const months = Math.min(24, Math.max(1, parseInt(req.query.months, 10) || 6));
  const since = new Date(); since.setUTCMonth(since.getUTCMonth() - months); since.setUTCDate(1);
  const sinceStr = since.toISOString().slice(0, 10);

  const [{ data: acctRows }, { data: txRows }] = await Promise.all([
    db.from('finance_accounts').select('id, name, account_type, last4').order('display_order', { ascending: true }),
    db.from('finance_transactions')
      .select('account_id, posted_date, amount, category, is_transfer')
      .gte('posted_date', sinceStr)
      .limit(20000),
  ]);

  // Current balance per account = sum of every transaction ever on that
  // account (transfers included -- a transfer genuinely does move the
  // account's own balance, it's only EXCLUDED from spend/profit, never from
  // the account's own running total). Fetched separately, unbounded by the
  // months window, since "current cash" must reflect the account's whole
  // history, not just the trend window.
  const { data: allTx } = await db.from('finance_transactions').select('account_id, amount').limit(50000);
  const balanceByAccount = {};
  for (const t of (allTx || [])) balanceByAccount[t.account_id] = (balanceByAccount[t.account_id] || 0) + Number(t.amount);

  const accountsOut = (acctRows || []).map(a => ({ ...a, balance: Math.round((balanceByAccount[a.id] || 0) * 100) / 100 }));
  const totalCash = accountsOut.reduce((s, a) => s + a.balance, 0);

  // Monthly income/expense trend + category breakdown, transfers excluded.
  const spendable = (txRows || []).filter(t => !t.is_transfer);
  const monthly = {};
  const byCategory = {};
  for (const t of spendable) {
    const ym = t.posted_date.slice(0, 7);
    const m = monthly[ym] || (monthly[ym] = { month: ym, income: 0, expense: 0 });
    if (t.amount > 0) m.income += Number(t.amount); else m.expense += -Number(t.amount);
    if (t.amount < 0) byCategory[t.category] = (byCategory[t.category] || 0) + -Number(t.amount);
  }
  const monthlyTrend = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ ...m, income: Math.round(m.income * 100) / 100, expense: Math.round(m.expense * 100) / 100, profit: Math.round((m.income - m.expense) * 100) / 100 }));
  const categoryBreakdown = Object.entries(byCategory)
    .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  return res.status(200).json({ accounts: accountsOut, total_cash: Math.round(totalCash * 100) / 100, monthly_trend: monthlyTrend, category_breakdown: categoryBreakdown });
}

// ── Reconciliation: bank reality vs. what the CRM's own payroll/Stripe data
// says SHOULD be there. ─────────────────────────────────────────────────────
async function reconciliation(req, res, db) {
  const weeks = Math.min(26, Math.max(1, parseInt(req.query.weeks, 10) || 8));

  const [payrollFlags, stripeFlags] = await Promise.all([
    reconcilePayroll(db, weeks),
    reconcileStripe(db, weeks),
  ]);
  return res.status(200).json({ payroll: payrollFlags, income: stripeFlags });
}

// Compares this week's ACTUAL "tech_payroll"-categorized outflows (summed
// across ALL finance accounts -- payroll could in principle be paid from more
// than one) against the computed payroll total for that week, reusing the
// EXISTING, already-tested payroll_combined action rather than re-implementing
// payroll math here. Called as a real HTTP request to this deployment's own
// admin API with a short-lived, owner-scoped, server-minted token -- this file
// never imports anything from api/admin.js, so there is no way a change here
// can affect the payroll screen, and no way admin.js's ~65 actions can affect
// this file either.
async function fetchPayrollCombined(weekStartStr) {
  const baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  if (!baseUrl) return null;
  const internalToken = signToken({ kind: 'admin', role: 'owner', scope: 'all', name: 'Finance (internal)' }, 60);
  try {
    const r = await fetch(`${baseUrl}/api/admin?action=payroll_combined&week_start=${weekStartStr}`, {
      headers: { Authorization: `Bearer ${internalToken}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('[finance] payroll_combined fetch failed:', e.message);
    return null;
  }
}

function mondayOfWeek(d) {
  // Weeks are tracked Sun-Sat elsewhere in this app (see payroll-week-sun-sat
  // convention) -- align to that same Sunday start.
  const day = d.getUTCDay();
  const sun = new Date(d); sun.setUTCDate(d.getUTCDate() - day);
  return sun.toISOString().slice(0, 10);
}

async function reconcilePayroll(db, weeks) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < weeks; i++) {
    const weekDate = new Date(today); weekDate.setUTCDate(today.getUTCDate() - i * 7);
    const weekStart = mondayOfWeek(weekDate);
    const payroll = await fetchPayrollCombined(weekStart);
    if (!payroll) continue;
    const payDate = payroll.pay_date;
    if (!payDate) continue;
    // Bank posting can land a day or two either side of the intended pay
    // date -- a 3-day window each direction absorbs a weekend/holiday shift
    // without also absorbing a genuinely different week's payroll run.
    const windowStart = new Date(payDate); windowStart.setUTCDate(windowStart.getUTCDate() - 3);
    const windowEnd = new Date(payDate); windowEnd.setUTCDate(windowEnd.getUTCDate() + 3);
    const { data: rows } = await db.from('finance_transactions')
      .select('amount')
      .eq('category', 'tech_payroll')
      .gte('posted_date', windowStart.toISOString().slice(0, 10))
      .lte('posted_date', windowEnd.toISOString().slice(0, 10));
    const actualPaid = (rows || []).reduce((s, r) => s + -Number(r.amount), 0); // outflows are negative; report as positive dollars paid
    const expected = Number(payroll.total) || 0;
    const diff = Math.round((actualPaid - expected) * 100) / 100;
    out.push({
      week_start: weekStart, pay_date: payDate,
      expected: Math.round(expected * 100) / 100,
      actual: Math.round(actualPaid * 100) / 100,
      diff,
      flagged: Math.abs(diff) > 5,   // small rounding/timing drift is normal; anything past $5 is worth a look
    });
  }
  return out;
}

// Compares actual Stripe payouts (real, landed amounts) against Business
// Savings deposits categorized as 'income' in the same window.
async function reconcileStripe(db, weeks) {
  const sinceUnix = Math.floor(Date.now() / 1000) - weeks * 7 * 86400;
  const [haPayouts, domsPayouts] = await Promise.all([
    listPayouts('handy-andy', { sinceUnix }),
    listPayouts('doms', { sinceUnix }),
  ]);
  const allPayouts = [...haPayouts, ...domsPayouts];
  if (!allPayouts.length) return [];

  const sinceStr = new Date(sinceUnix * 1000).toISOString().slice(0, 10);
  const { data: incomeRows } = await db.from('finance_transactions')
    .select('posted_date, amount')
    .eq('category', 'income')
    .gte('posted_date', sinceStr);

  const out = [];
  const usedTx = new Set();
  for (const p of allPayouts) {
    const target = p.arrival_date;
    const windowStart = new Date(target); windowStart.setUTCDate(windowStart.getUTCDate() - 3);
    const windowEnd = new Date(target); windowEnd.setUTCDate(windowEnd.getUTCDate() + 3);
    const match = (incomeRows || []).find((r, idx) =>
      !usedTx.has(idx) &&
      r.posted_date >= windowStart.toISOString().slice(0, 10) &&
      r.posted_date <= windowEnd.toISOString().slice(0, 10) &&
      Math.abs(Number(r.amount) - p.amount) < 1);
    if (match) usedTx.add((incomeRows || []).indexOf(match));
    out.push({
      payout_id: p.id, arrival_date: p.arrival_date, expected: p.amount,
      matched: !!match, actual: match ? Number(match.amount) : null,
      flagged: !match,
    });
  }
  return out;
}
