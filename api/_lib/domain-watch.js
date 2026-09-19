// api/_lib/domain-watch.js
// Daily "is this domain buyable yet?" check for the owner's watch list.
//
// How a domain is judged, in order of trust:
//   1. RDAP (the registries' own lookup service; the IANA bootstrap file says
//      which server answers for each TLD). 404 = not registered = AVAILABLE.
//      200 = registered; its status flags say whether it is about to drop
//      ("pending delete") or in its paid grace window ("redemption period").
//   2. For a TLD with no RDAP server, a DNS lookup: NXDOMAIN means nothing is
//      delegated, reported as LIKELY available (a registered-but-unused domain
//      can also have no DNS, so this one is never called a sure thing).
// The check never buys anything. It only tells the owner, by text.
import { sendSMS } from './sms.js';
import { sendEmail } from './email.js';

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const FETCH_TIMEOUT_MS = 9000;
const CONCURRENCY = 6;

// A domain worth an alert: sure-thing available, or about to drop.
export const ALERT_STATUSES = new Set(['available', 'pending_delete', 'likely_available']);

// "https://www.Example.com/path" -> "example.com"; null when it is not a domain.
export function cleanDomain(raw) {
  let d = String(raw || '').trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '').replace(/[.,;]+$/, '');
  if (d.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  return d;
}

// Split a pasted blob (newlines, commas, spaces) into unique clean domains.
export function parseDomainList(text) {
  const seen = new Set(); const good = []; const bad = [];
  for (const tok of String(text || '').split(/[\s,;]+/)) {
    if (!tok.trim()) continue;
    const d = cleanDomain(tok);
    if (!d) { bad.push(tok.trim()); continue; }
    if (!seen.has(d)) { seen.add(d); good.push(d); }
  }
  return { good, bad };
}

let _bootstrap = null;
async function rdapBaseFor(tld) {
  if (!_bootstrap) {
    const r = await fetchTimeout(BOOTSTRAP_URL);
    if (!r.ok) throw new Error('Could not load the registry directory (IANA)');
    const j = await r.json();
    const map = new Map();
    for (const [tlds, urls] of (j.services || [])) for (const t of tlds) map.set(String(t).toLowerCase(), urls[0]);
    _bootstrap = map;
  }
  const base = _bootstrap.get(tld);
  return base ? base.replace(/\/?$/, '/') : null;
}

async function fetchTimeout(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { accept: 'application/rdap+json, application/json', ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

async function dnsSaysUnregistered(domain) {
  const r = await fetchTimeout(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, { headers: { accept: 'application/dns-json' } });
  if (!r.ok) throw new Error(`DNS lookup failed (${r.status})`);
  const j = await r.json();
  return j.Status === 3;   // NXDOMAIN
}

// -> { status, expires_at, registrar, error }
export async function checkDomain(domain) {
  const tld = domain.split('.').pop();
  try {
    const base = await rdapBaseFor(tld);
    if (!base) {
      const gone = await dnsSaysUnregistered(domain);
      return { status: gone ? 'likely_available' : 'unsupported', error: gone ? null : `.${tld} has no public lookup; DNS shows it in use` };
    }
    const r = await fetchTimeout(`${base}domain/${encodeURIComponent(domain)}`);
    if (r.status === 404) return { status: 'available' };
    if (r.status === 429) return { status: 'error', error: 'The registry asked us to slow down (rate limited). Will retry tomorrow.' };
    if (!r.ok) return { status: 'error', error: `Registry answered ${r.status}` };
    const j = await r.json();
    const flags = (j.status || []).map(s => String(s).toLowerCase());
    const exp = (j.events || []).find(e => /expiration/i.test(e.eventAction || ''));
    const registrar = ((j.entities || []).find(e => (e.roles || []).includes('registrar')) || {}).vcardArray;
    const regName = registrar && Array.isArray(registrar[1]) ? ((registrar[1].find(x => x[0] === 'fn') || [])[3] || null) : null;
    let status = 'taken';
    if (flags.some(f => f.includes('pending delete'))) status = 'pending_delete';
    else if (flags.some(f => f.includes('redemption'))) status = 'redemption';
    return { status, expires_at: exp ? new Date(exp.eventDate).toISOString() : null, registrar: regName };
  } catch (e) {
    return { status: 'error', error: String((e && e.name === 'AbortError') ? 'Timed out' : (e && e.message) || e).slice(0, 200) };
  }
}

function alertSubject(status) {
  return status === 'available' ? 'Domain available' : status === 'pending_delete' ? 'Domain dropping soon' : 'Domain likely available';
}

function alertText(row, res) {
  const d = row.domain;
  if (res.status === 'available') return `DOMAIN AVAILABLE: ${d} is registrable right now. Buy it before someone else does.`;
  if (res.status === 'likely_available') return `DOMAIN LIKELY AVAILABLE: ${d} has no DNS and no public registry record. Check it and buy it if it is free.`;
  if (res.status === 'pending_delete') return `DOMAIN DROPPING SOON: ${d} is in pending delete. It should be released within about 5 days. Get ready to grab it.`;
  return null;
}

// Check every watched domain (or just `onlyIds`), save the results, and text
// the owner about anything newly alert-worthy. Returns a summary.
export async function runDomainWatch(db, { onlyIds = null, sendAlerts = true } = {}) {
  let q = db.from('domain_watch').select('*').order('created_at');
  if (onlyIds) q = q.in('id', onlyIds);
  const { data: rows, error } = await q;
  if (error) throw error;
  const list = rows || [];
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (next < list.length) { const i = next++; results[i] = await checkDomain(list[i].domain); }
  }));

  const alerts = []; const nowISO = new Date().toISOString();
  for (let i = 0; i < list.length; i++) {
    const row = list[i], res = results[i];
    const changed = res.status !== row.status;
    const patch = {
      status: res.status, last_checked_at: nowISO, last_error: res.error || null,
      expires_at: res.expires_at !== undefined ? res.expires_at : row.expires_at,
      registrar: res.registrar !== undefined ? res.registrar : row.registrar,
    };
    if (changed && res.status !== 'error') { patch.status_since = nowISO; patch.alert_dismissed_status = null; }
    // A transient lookup error keeps the last real answer, so one bad day
    // never turns "taken" into "unknown" or re-arms an alert.
    if (res.status === 'error') { patch.status = row.status === 'unchecked' ? 'error' : row.status; delete patch.status_since; }
    const eff = patch.status;
    if (ALERT_STATUSES.has(eff) && row.notified_status !== eff) {
      const msg = alertText(row, { status: eff });
      if (msg) alerts.push({ id: row.id, domain: row.domain, status: eff, msg, subject: alertSubject(eff) });
    }
    // Anything that fell back to a non-alert state re-arms future alerts.
    if (!ALERT_STATUSES.has(eff) && row.notified_status && res.status !== 'error') { patch.notified_status = null; }
    const { error: uErr } = await db.from('domain_watch').update(patch).eq('id', row.id);
    if (uErr) console.warn('[domain_watch] save failed for', row.domain, uErr.message);
  }

  // Alert everywhere the owner can be reached: a text, an email, and (because
  // the row is now in an alert state and not dismissed) a banner on the
  // dashboard. Each channel is best-effort on its own; the row counts as
  // notified as soon as ONE of them got through, so a dead channel never
  // makes the other two repeat themselves every day.
  let texted = 0, emailed = 0;
  const phone = process.env.OWNER_PHONE_NUMBER;
  const ownerEmail = process.env.OWNER_EMAIL || 'andrewtrading04@gmail.com';
  if (sendAlerts) {
    for (const a of alerts) {
      let ok = false;
      if (phone) {
        try { await sendSMS(phone, a.msg); texted++; ok = true; }
        catch (e) { console.warn('[domain_watch] alert text failed for', a.domain, e.message); }
      }
      try {
        const r = await sendEmail({
          slug: 'handy-andy', to: ownerEmail, subject: `${a.subject}: ${a.domain}`,
          html: `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5"><h2 style="margin:0 0 8px">${a.subject}: ${a.domain}</h2><p>${a.msg}</p><p style="color:#666;font-size:13px">From your Domain watch list in the CRM (Other &gt; Domain watch).</p></div>`,
        });
        if (r && r.sent) { emailed++; ok = true; }
      } catch (e) { console.warn('[domain_watch] alert email failed for', a.domain, e.message); }
      if (ok) await db.from('domain_watch').update({ notified_status: a.status, notified_at: new Date().toISOString() }).eq('id', a.id);
    }
  }
  const tally = {}; for (const r of results) tally[r.status] = (tally[r.status] || 0) + 1;
  return { checked: list.length, tally, alerts: alerts.map(a => ({ domain: a.domain, status: a.status })), texted, emailed, owner_phone_set: !!phone };
}
