// ============================================================================
// Loan tracker -- Andrew's personal loan to Catie (owner 2026-10-07). Its own
// file, like finance.js, so nothing in admin.js can leak it to staff.
//
// Two ways in, checked before any action runs:
//   * owner admin token  -> every action, every loan
//   * ?k=<share_key>     -> Catie's private link: read her loan + log a payment
//
//   GET  get            [?k=]            -> { loan, payments }
//   POST log_payment    { amount, paid_on, method, note } (+k)
//   POST save_terms     owner: { borrower_name, principal, apr, monthly_payment, start_date, first_due_date, terms }
//   POST delete_payment owner: { id }
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { verifyToken, getBearer, applyCors } from './_lib/auth.js';

const money = (v) => Math.round(Number(v) * 100) / 100;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const body = req.body || {};
  const action = String(req.query.action || body.action || '');
  const key = String(req.query.k || body.k || '');

  try {
    const db = serviceClient();
    const auth = verifyToken(getBearer(req));
    const isOwner = !!(auth && auth.kind === 'admin' && auth.role === 'owner');

    let loan = null;
    if (key) {
      const { data } = await db.from('loans').select('*').eq('share_key', key).maybeSingle();
      loan = data;
      if (!loan) return res.status(404).json({ error: 'Link not found' });
    } else if (isOwner) {
      const { data } = await db.from('loans').select('*').order('created_at').limit(1).maybeSingle();
      loan = data;
    } else {
      return res.status(403).json({ error: 'Not allowed' });
    }

    if (action === 'get') {
      if (!loan) return res.json({ loan: null, payments: [], owner: isOwner });
      const { data: payments, error } = await db.from('loan_payments').select('*')
        .eq('loan_id', loan.id).is('deleted_at', null).order('paid_on').order('created_at');
      if (error) throw error;
      const out = { ...loan };
      if (!isOwner) delete out.share_key;
      return res.json({ loan: out, payments: payments || [], owner: isOwner });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    if (action === 'log_payment') {
      if (!loan) return res.status(400).json({ error: 'Set up the loan first' });
      const amount = money(body.amount);
      if (!(amount > 0) || amount > 1e6) return res.status(400).json({ error: 'Enter an amount' });
      const paid_on = isDate(body.paid_on) ? body.paid_on : new Date().toISOString().slice(0, 10);
      const { data, error } = await db.from('loan_payments').insert({
        loan_id: loan.id, amount, paid_on,
        method: String(body.method || '').slice(0, 40) || null,
        note: String(body.note || '').slice(0, 300) || null,
        logged_by: isOwner && !key ? 'Andrew' : loan.borrower_name,
      }).select().single();
      if (error) throw error;
      return res.json({ ok: true, payment: data });
    }

    if (!isOwner) return res.status(403).json({ error: 'Owner only' });

    if (action === 'save_terms') {
      const row = {
        borrower_name: String(body.borrower_name || 'Catie').slice(0, 60),
        principal: money(body.principal),
        apr: Math.max(0, Number(body.apr) || 0),
        monthly_payment: money(body.monthly_payment || 200),
        start_date: isDate(body.start_date) ? body.start_date : new Date().toISOString().slice(0, 10),
        first_due_date: isDate(body.first_due_date) ? body.first_due_date : null,
        terms: String(body.terms || '').slice(0, 4000) || null,
      };
      if (!(row.principal > 0)) return res.status(400).json({ error: 'Enter the loan amount' });
      if (!row.first_due_date) return res.status(400).json({ error: 'Enter the first due date' });
      const q = loan ? db.from('loans').update(row).eq('id', loan.id) : db.from('loans').insert(row);
      const { data, error } = await q.select().single();
      if (error) throw error;
      return res.json({ ok: true, loan: data });
    }

    if (action === 'delete_payment') {
      const { error } = await db.from('loan_payments').update({ deleted_at: new Date().toISOString() })
        .eq('id', body.id).eq('loan_id', loan.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('loan', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
