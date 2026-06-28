// ============================================================================
// Database migration helper for applying pending migrations
// Call with: GET /api/migrate?action=status
//            GET /api/migrate?action=apply&migration=0014_sms_consent
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { verifyToken, getBearer, applyCors } from './_lib/auth.js';
import { runDomsImport, runDomsImportChunk, domsDiag } from './_lib/doms-import.js';
import { sendAppointmentReminders } from './_lib/reminders.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Allow the long-running Doms import to use the full Hobby-plan budget.
export const config = { maxDuration: 60 };

const __dir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dir, '../supabase/migrations');

// List of critical migrations that must be applied
const REQUIRED_MIGRATIONS = [
  '0014_sms_consent.sql',
];

async function checkSmsConsentColumn() {
  const db = serviceClient();
  try {
    // Try to query the bookings table and check if sms_consent column exists
    const { data, error } = await db.from('bookings')
      .select('id, sms_consent')
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.message?.includes('sms_consent')) {
        return { exists: false, error: error.message };
      }
      // Some other error, but column might exist
      return { exists: 'unknown', error: error.message };
    }

    return { exists: true };
  } catch (e) {
    return { exists: 'unknown', error: e.message };
  }
}

async function applyMigration(filename) {
  const filePath = path.join(migrationsDir, filename);

  if (!fs.existsSync(filePath)) {
    return { error: `Migration file not found: ${filename}` };
  }

  const sql = fs.readFileSync(filePath, 'utf-8');
  const db = serviceClient();

  try {
    // Use rpc with a custom function if available, or directly query
    // Note: This is a workaround. The Supabase JS client doesn't have direct SQL execution.
    // In production, these should be applied via the Supabase dashboard or CLI.
    const result = await db.rpc('exec_sql', { sql_text: sql });
    return { success: true, result };
  } catch (e) {
    // If rpc doesn't work, we'll need to use the dashboard or CLI
    return {
      error: `Could not apply migration via RPC: ${e.message}. Please apply migrations manually via Supabase dashboard or CLI.`,
      helpText: `To apply ${filename}, run: supabase db push`
    };
  }
}

// Status ladder for bracket purchases — sync only ever upgrades a row's status
// (ordered → delivered), never moves it backwards.
const BRACKET_STATUS_RANK = { ordered: 0, delivered: 1, canceled: 2 };

// Upsert one Walmart order into bracket_purchases for every active business.
// Auth/method are checked by the caller (the bracket_sync action). Returns the
// HTTP response with a per-business result list.
async function bracketSync(req, res) {
  const body = req.body || {};
  const walmart_order_num = (body.walmart_order_num || '').toString().trim();
  if (!walmart_order_num) return res.status(400).json({ error: 'walmart_order_num required' });

  const flat_qty        = Math.max(0, parseInt(body.flat_qty)        || 0);
  const tilting_qty     = Math.max(0, parseInt(body.tilting_qty)     || 0);
  const full_motion_qty = Math.max(0, parseInt(body.full_motion_qty) || 0);
  const totalQty        = flat_qty + tilting_qty + full_motion_qty;
  const rawStatus       = (body.status || 'ordered').toString();
  const status          = Object.prototype.hasOwnProperty.call(BRACKET_STATUS_RANK, rawStatus) ? rawStatus : 'ordered';
  const order_date      = body.order_date     || null;
  const delivered_date  = body.delivered_date || null;
  const order_url       = body.order_url      || null;

  const db = serviceClient();
  const { data: businesses, error: bizErr } = await db.from('businesses')
    .select('id, slug').eq('active', true);
  if (bizErr) return res.status(500).json({ error: bizErr.message });

  const results = [];
  for (const biz of (businesses || [])) {
    const { data: existing } = await db.from('bracket_purchases')
      .select('id, status, flat_qty, tilting_qty, full_motion_qty, order_url')
      .eq('business_id', biz.id)
      .eq('walmart_order_num', walmart_order_num)
      .maybeSingle();

    if (existing) {
      const currentRank = BRACKET_STATUS_RANK[existing.status] ?? 0;
      const newRank     = BRACKET_STATUS_RANK[status] ?? 0;
      const patch = {};
      if (newRank > currentRank) {
        patch.status = status;
        if (status === 'delivered' && delivered_date) patch.delivered_date = delivered_date;
      }
      if (order_url && !existing.order_url) patch.order_url = order_url;
      // Backfill quantities if the existing row was a bare delivery-only insert.
      if (totalQty > 0 && (existing.flat_qty + existing.tilting_qty + existing.full_motion_qty) === 0) {
        patch.flat_qty = flat_qty; patch.tilting_qty = tilting_qty; patch.full_motion_qty = full_motion_qty;
      }
      if (Object.keys(patch).length === 0) { results.push({ business: biz.slug, action: 'unchanged', status: existing.status }); continue; }
      const { error: upErr } = await db.from('bracket_purchases').update(patch).eq('id', existing.id);
      results.push({ business: biz.slug, action: upErr ? 'update_failed' : 'updated', patch, error: upErr?.message });
    } else {
      if (totalQty === 0) { results.push({ business: biz.slug, action: 'skipped', reason: 'no_qty_for_new_order' }); continue; }
      const { error: insErr } = await db.from('bracket_purchases').insert({
        business_id: biz.id, technician_id: null, walmart_order_num,
        flat_qty, tilting_qty, full_motion_qty, status, order_date, delivered_date, order_url,
      });
      results.push({ business: biz.slug, action: insErr ? 'insert_failed' : 'created', error: insErr?.message });
    }
  }

  console.log('[bracket_sync]', walmart_order_num, results.map(r => `${r.business}:${r.action}`).join(', '));
  return res.status(200).json({ ok: true, order: walmart_order_num, results });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || '').toString();

  // One-time Doms Zenbooker import. Secured by IMPORT_SECRET (so it can be
  // triggered from a browser URL), NOT the admin bearer token.
  //
  // RESUMABLE by default: each call processes a few pages of one phase and
  // returns { done, nextCursor }. The driver page (/import-doms.html) loops
  // until done so the work never exceeds the 60s serverless budget. Params:
  //   &phase=customers|jobs   which list to page through (default customers)
  //   &cursor=<token>         continue from a previous call's nextCursor
  //   &maxPages=N             pages per request (default 3)
  //   &mode=all               legacy single-shot run (may time out on big data)
  if (action === 'import_doms') {
    const debug = req.query.debug === '1';
    try {
      const secret = process.env.IMPORT_SECRET;
      if (!secret) return res.status(400).json({ error: 'IMPORT_SECRET env var not set. Add it in Vercel first.' });
      if (req.query.secret !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=YOUR_IMPORT_SECRET' });

      const step = (req.query.step || '').toString();

      // Diagnostic ladder — each rung adds one dependency so we can see exactly
      // which layer fails. ping touches nothing; db touches Supabase; zbk touches
      // Zenbooker. All return readable JSON (domsDiag never throws).
      if (step === 'ping') {
        return res.status(200).json({
          ok: true, step: 'ping', node: process.version,
          env: {
            SUPABASE_URL: !!process.env.SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
            ZENBOOKER_API_KEY: !!process.env.ZENBOOKER_API_KEY,
            IMPORT_SECRET: !!process.env.IMPORT_SECRET,
          },
        });
      }

      const zbk = process.env.ZENBOOKER_API_KEY;
      if (!zbk) return res.status(400).json({ error: 'ZENBOOKER_API_KEY env var not set' });

      if (step === 'db' || step === 'zbk') {
        return res.status(200).json(await domsDiag(serviceClient(), zbk, step));
      }

      if ((req.query.mode || '').toString() === 'all') {
        const phase = (req.query.phase || 'all').toString();
        const out = await runDomsImport(serviceClient(), zbk, { phase });
        return res.status(200).json(out);
      }
      const phase = (req.query.phase || 'customers').toString();
      const cursor = req.query.cursor ? req.query.cursor.toString() : null;
      const maxPages = req.query.maxPages ? Number(req.query.maxPages) : undefined;
      const out = await runDomsImportChunk(serviceClient(), zbk, { phase, cursor, maxPages });
      return res.status(200).json(out);
    } catch (e) {
      console.error('[import_doms]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e), stack: debug ? String((e && e.stack) || '') : undefined });
    }
  }

  // 24-hour appointment reminders. Secured by CRON_SECRET (NOT the admin bearer)
  // so a scheduled trigger (Vercel Cron / GitHub Actions hourly) can call it.
  // Vercel Cron auto-sends "Authorization: Bearer <CRON_SECRET>"; GitHub Actions
  // and manual tests can pass it as ?secret=... or the same Bearer header.
  //   &dry=1   find + report eligible bookings without sending anything
  if (action === 'send_reminders') {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      const dryRun = req.query.dry === '1' || req.query.dry === 'true';
      const summary = await sendAppointmentReminders({ dryRun });
      return res.status(200).json({ ok: true, ...summary });
    } catch (e) {
      console.error('[send_reminders]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  // Walmart bracket order sync. Called by the bracket-tracker GitHub Action
  // after it parses order emails from Gmail. Upserts bracket_purchases for
  // EVERY active business so both dashboards show the same orders. Secured by
  // CRON_SECRET (same as send_reminders, NOT the admin bearer). Status only
  // ever upgrades (ordered → delivered), never downgrades. POST JSON body:
  //   { walmart_order_num, flat_qty, tilting_qty, full_motion_qty,
  //     status, order_date, delivered_date, order_url }
  if (action === 'bracket_sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(400).json({ error: 'CRON_SECRET env var not set. Add it in Vercel first.' });
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided = (req.query.secret || '').toString() || bearer;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=CRON_SECRET or Authorization: Bearer.' });
    try {
      return await bracketSync(req, res);
    } catch (e) {
      console.error('[bracket_sync]', (e && e.stack) || e);
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  const auth = verifyToken(getBearer(req));

  // Require admin auth for any migration action
  if (!auth || auth.kind !== 'admin') {
    return res.status(401).json({ error: 'Admin authorization required' });
  }

  try {
    if (action === 'status') {
      const smsColumn = await checkSmsConsentColumn();
      return res.json({
        sms_consent_column: smsColumn,
        migrations: REQUIRED_MIGRATIONS,
      });
    }

    if (action === 'apply') {
      const migration = (req.query.migration || '').toString();
      if (!migration) {
        return res.status(400).json({ error: 'migration parameter required' });
      }
      const result = await applyMigration(migration);
      return res.json(result);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    console.error('[migrate]', e);
    return res.status(500).json({ error: e.message });
  }
}
