// Same call shape as adminApi() in api/analytics.js — the bridge is a
// separate process, so it reaches the CRM's pricing/scheduling/booking logic
// over plain HTTPS exactly like the v1 bot did, rather than duplicating any
// of that business logic here.
import { botToken } from './auth.js';

function publicBase() {
  const base = process.env.PUBLIC_URL;
  if (!base) throw new Error('PUBLIC_URL not set');
  return base.replace(/\/$/, '');
}

export async function adminApi(action, { method = 'GET', params = {}, body = null } = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const url = `${publicBase()}/api/admin?${qs}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${botToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch (_) { /* non-JSON error page */ }
  if (!r.ok) {
    const e = new Error(data.error || `admin ${action} failed (${r.status})`);
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}
