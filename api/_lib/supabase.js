// Shared Supabase client for server-side (admin + technician) endpoints.
// Uses the SERVICE ROLE key, which bypasses RLS — NEVER expose this to a
// browser. Files under /api/_lib are ignored by Vercel's function builder.
import { createClient } from '@supabase/supabase-js';

let _client = null;

export function serviceClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  // All business-management tables live in the `app` schema (kept separate from
  // the analytics tables in `public`).
  _client = createClient(url, key, { auth: { persistSession: false }, db: { schema: 'app' } });
  return _client;
}

let _publicClient = null;

// Service-role client scoped to the `public` schema, where the funnel-analytics
// tables live (events, page_metrics). Same service key — bypasses RLS — so these
// server-only endpoints (log-event, analytics) keep working after RLS is FORCED
// on those tables. Never expose to a browser; the public anon key must not be
// able to read or write analytics data directly.
export function serviceClientPublic() {
  if (_publicClient) return _publicClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  _publicClient = createClient(url, key, { auth: { persistSession: false }, db: { schema: 'public' } });
  return _publicClient;
}
