// ============================================================================
// Database migration helper for applying pending migrations
// Call with: GET /api/migrate?action=status
//            GET /api/migrate?action=apply&migration=0014_sms_consent
// ============================================================================
import { serviceClient } from './_lib/supabase.js';
import { verifyToken, getBearer, applyCors } from './_lib/auth.js';
import { runDomsImport } from './_lib/doms-import.js';
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

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = (req.query.action || '').toString();

  // One-time Doms Zenbooker import. Secured by IMPORT_SECRET (so it can be
  // triggered from a browser URL), NOT the admin bearer token. Optional
  // &phase=customers|jobs lets the work be split across two requests if needed.
  if (action === 'import_doms') {
    const secret = process.env.IMPORT_SECRET;
    if (!secret) return res.status(400).json({ error: 'IMPORT_SECRET env var not set. Add it in Vercel first.' });
    if (req.query.secret !== secret) return res.status(401).json({ error: 'Unauthorized. Pass ?secret=YOUR_IMPORT_SECRET' });
    const zbk = process.env.ZENBOOKER_API_KEY;
    if (!zbk) return res.status(400).json({ error: 'ZENBOOKER_API_KEY env var not set' });
    try {
      const phase = (req.query.phase || 'all').toString();
      const out = await runDomsImport(serviceClient(), zbk, { phase });
      return res.status(200).json(out);
    } catch (e) {
      console.error('[import_doms]', e);
      return res.status(500).json({ error: e.message });
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
