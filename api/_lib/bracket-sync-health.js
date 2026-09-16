// ============================================================================
// api/_lib/bracket-sync-health.js — health tracking + owner alerts for the
// Gmail → CRM email scan (scripts/bracket-email-sync.mjs on GitHub Actions).
//
// WHY THIS EXISTS: on 2026-09-12 the primary mailbox's Gmail App Password was
// revoked. The scan caught the IMAP auth error, logged it, scanned the other
// six inboxes and exited 0 — GitHub showed a green run every time while no
// Walmart bracket order synced for ten days. Nothing here can un-revoke a
// credential; the job is (1) a human hears about it within the hour and
// (2) the scan actually runs every 15 minutes (GitHub's own scheduler was
// firing it every 2–5 h).
//
// Two documents in app.system_flags (jsonb `value`; no migration needed):
//   bracket_sync:state     written ONLY by the ingest (action=bracket_sync_health)
//   bracket_sync:dispatch  written ONLY by the watchdog (action=bracket_sync_watchdog)
// Every timestamp used for "is it stale" math is THIS server's clock at the
// moment the report/tick was processed — a report may claim any time it likes.
//
// Texts go to OWNER_PHONE_NUMBER; the dashboard card (api/admin.js bad_reviews
// → public/admin.html #syncAlerts) always shows. Dedupe rules:
//   • a NEW red problem texts immediately, whatever the hour
//   • a CONTINUING problem re-texts once per alert-day (rolls 07:00 Denver) and
//     only ≥20 h after the previous text — never at midnight, never 12 min apart
//   • at most 3 texts per problem per alert-day; after that the card says
//     "texts paused for today - flapping"
//   • when every red key of a FAMILY (inbox:N, dispatch, or a single key) clears,
//     ONE "back to normal" text — only if that family was ever texted
//   • claimOnce (an atomic PK insert) is what stops two concurrent invocations
//     from both texting; a transport error releases the claim so the next tick
//     retries, a provider 4xx keeps it (one provider call per key per day)
//   • amber problems never text
//   • each writer texts only its own scope (INGEST_SCOPE / WATCHDOG_SCOPE)
// ============================================================================
import { claimOnce } from './owner-notify.js';
import { sendSMSResult } from './sms.js';

const STATE_KEY = 'bracket_sync:state';
const DISPATCH_KEY = 'bracket_sync:dispatch';
const STALE_RUN_MIN = 50;               // dispatcher live: three missed 15-min ticks
const STALE_RUN_MIN_UNCONFIGURED = 480;  // GitHub's own schedule alone fires every 1–5 h
const MAILBOX_STALE_MIN = 50;
const TICK_STALE_MIN = 50;
const UNREACHABLE_STREAK = 3;
const AUTH_STREAK = 2;                  // banner on the 1st failed scan, text on the 2nd in a row
const DISPATCH_HARD_STATUSES = [401, 403, 404, 422];
const DISPATCH_SOFT_STREAK = 2;
const REALERT_MIN_HOURS = 20;
const MAX_ALERTS_PER_KEY_PER_DAY = 3;
const SMS_MAX = 480;
const TZ = 'America/Denver';
const GITHUB_REPO = 'andrewtrading04-star/handy-andy-booking';
const WORKFLOW_FILE = 'bracket-tracker.yml';
const WORKFLOW_REF = 'main';
export const RUN_URL_PREFIX = `https://github.com/${GITHUB_REPO}/actions/runs/`;
const ACTIONS_URL = `https://github.com/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}`;
const SECRETS_URL = `https://github.com/${GITHUB_REPO}/settings/secrets/actions`;
const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';
const PAT_URL = 'https://github.com/settings/personal-access-tokens/new';
const VERCEL_ENV_URL = 'https://vercel.com/andrew-c-projects/handy-andy-booking/settings/environment-variables';
const DASHBOARD_URL = 'https://handy-andy-booking.vercel.app/admin.html';
export const INGEST_SCOPE = /^(mailbox:|config:|coverage:|data_|no_mailboxes$|sync_errors$|sync_rejected$|fatal_run$|tick_stale$|no_walmart_mail$)/;
export const WATCHDOG_SCOPE = /^(stale_run$|dispatch:)/;

// ── helpers ─────────────────────────────────────────────────────────────────
function denverDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); }
export function alertDay(now) { return denverDate(new Date(now.getTime() - 7 * 3600e3)); }
// A bad/missing stored timestamp reads as infinitely old — stale, never fresh.
function agoMin(iso, now) { const t = Date.parse(iso); return Number.isFinite(t) ? (now.getTime() - t) / 60000 : Infinity; }
function agoText(min) {
  if (!Number.isFinite(min)) return 'an unknown time';
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}
function fmtDenver(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  return new Date(t).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' Denver';
}
function familyOf(key) {
  const m = /^(?:mailbox|config):(\d+)/.exec(key);
  if (m) return `inbox:${m[1]}`;
  if (/^dispatch:/.test(key)) return 'dispatch';
  return key;
}
function userSecretFor(idx) { return Number(idx) === 1 ? 'GMAIL_USER' : `GMAIL_USER_${idx}`; }
function passSecretFor(idx) { return Number(idx) === 1 ? 'GMAIL_APP_PASSWORD' : `GMAIL_APP_PASSWORD_${idx}`; }
function isTransportError(msg) { return /abort|timeout|timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|\b5\d\d\b/i.test(String(msg || '')); }

// ── storage ─────────────────────────────────────────────────────────────────
const emptyState = () => ({ mailboxes: {}, misconfigured: [], problems: {}, flap: {}, alerts: [] });
const emptyDispatch = () => ({ configured: null, consecutive_failures: 0, problems: {}, flap: {}, alerts: [] });
async function readDoc(db, key, empty) {
  const { data, error } = await db.from('system_flags').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  const v = data && data.value && typeof data.value === 'object' ? data.value : {};
  return { ...empty(), ...v };
}
export const readState = (db) => readDoc(db, STATE_KEY, emptyState);
export const readDispatch = (db) => readDoc(db, DISPATCH_KEY, emptyDispatch);
async function writeDoc(db, key, value) {
  const { error } = await db.from('system_flags').upsert({ key, value }, { onConflict: 'key' });
  if (error) throw error;
}
const writeState = (db, v) => writeDoc(db, STATE_KEY, v);
const writeDispatch = (db, v) => writeDoc(db, DISPATCH_KEY, v);

// ── report sanitizer: coerce, truncate, never reject a future script's shape ─
const str = (x, n = 300) => (x == null ? null : String(x).slice(0, n));
const int = (x, d = 0) => (Number.isFinite(+x) ? Math.trunc(+x) : d);
const iso = (x) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null);
function numbersOnly(o, depth = 0) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (v && typeof v === 'object') { const n = numbersOnly(v, depth + 1); if (n) out[k] = n; }
  }
  return out;
}
function sanitizeError(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    kind: str(e.kind, 30) || 'other',
    message: str(e.message, 300) || '',
    code: str(e.code, 60),
    serverResponseCode: str(e.serverResponseCode, 60),
    responseText: str(e.responseText, 300),
    authenticationFailed: !!e.authenticationFailed,
  };
}
export function sanitizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('health report must be a JSON object'), { code: 'BAD_REPORT' });
  let size = 0;
  try { size = JSON.stringify(body).length; } catch (_) { size = Infinity; }
  if (size > 32768) throw Object.assign(new Error('health report too large'), { code: 'BAD_REPORT' });
  const run = body.run && typeof body.run === 'object' ? body.run : {};
  const id = str(run.id, 20);
  const arr = (x, n) => (Array.isArray(x) ? x : []).slice(0, n).filter(v => v && typeof v === 'object');
  return {
    run: {
      source: str(run.source, 20), id, attempt: str(run.attempt, 10), event: str(run.event, 40), trigger: str(run.trigger, 20),
      sha: str(run.sha, 40), node: str(run.node, 20), lookback_days: int(run.lookback_days, 45),
      started_at: iso(run.started_at), finished_at: iso(run.finished_at), duration_ms: int(run.duration_ms),
      // Built here from a numeric id, never taken from the report — it becomes an href.
      run_url: /^\d{1,20}$/.test(String(id)) ? RUN_URL_PREFIX + id : null,
    },
    mailboxes: arr(body.mailboxes, 20).map(m => ({
      idx: int(m.idx), user: str(m.user, 120) || '', role: str(m.role, 60) || '', ok: !!m.ok, stage: str(m.stage, 20) || 'connect',
      ms: int(m.ms), candidates: int(m.candidates), search_terms_failed: int(m.search_terms_failed), parsed: numbersOnly(m.parsed) || {},
      parse_failures:int(m.parse_failures), unparsed_walmart:int(m.unparsed_walmart),
      walmart_complete:m.walmart_complete === true,
      walmart_archive_coverage:m.walmart_archive_coverage === true,
      walmart_scanned_through:iso(m.walmart_scanned_through),
      coverage_issues:Array.isArray(m.coverage_issues) ? m.coverage_issues.slice(0,20).map(v=>str(v,100)) : [],
      error: m.ok ? null : (sanitizeError(m.error) || { kind: 'other', message: 'unknown error', code: null, serverResponseCode: null, responseText: null, authenticationFailed: false }),
    })),
    misconfigured: arr(body.misconfigured, 12).map(x => ({ idx: int(x.idx), missing: str(x.missing, 40) || 'both' })),
    totals: numbersOnly(body.totals),
    sync_errors: arr(body.sync_errors, 20).map(x => ({ action: str(x.action, 40) || '', key: str(x.key, 120) || '', status: int(x.status), message: str(x.message, 200) || '' })),
    sync_errors_dropped: int(body.sync_errors_dropped),
    fatal: sanitizeError(body.fatal),
    skipped: str(body.skipped, 20),
  };
}

// ── ingest: one report per run → per-mailbox streaks + last-run facts ───────
export async function ingestBracketSyncReport(db, body, now = new Date()) {
  const nowISO = now.toISOString();
  const r = sanitizeReport(body);
  const state = await readState(db);
  state.first_seen_at ||= nowISO;
  // A crashed or maintenance run is not a completed scan: it must not advance
  // last_run_at (stale_run keeps counting through a crash loop) and must not
  // prune mailbox history.
  const complete = !r.fatal && !r.skipped && r.mailboxes.length > 0;
  const walmartSaveFailed = r.sync_errors.some(e=>e.action === 'bracket_sync') || (r.totals?.walmart?.failed || 0)>0;
  const seen = new Set();
  for (const m of r.mailboxes) {
    const k = String(m.idx);
    seen.add(k);
    let prev = state.mailboxes[k] || {};
    if (prev.user && prev.user !== m.user) prev = {};   // slot re-pointed at another account
    state.mailboxes[k] = m.ok
      ? { ...prev, idx: m.idx, user: m.user, role: m.role, last_seen_at: nowISO, last_ok_at: nowISO, first_fail_at: null, consecutive_failures: 0, stage: 'done', error: null, seen_ok_ever: true }
      : { ...prev, idx: m.idx, user: m.user, role: m.role, last_seen_at: nowISO, last_fail_at: nowISO, first_fail_at: prev.first_fail_at || nowISO, consecutive_failures: (prev.consecutive_failures || 0) + 1, stage: m.stage, error: m.error };
    // Advance only after every discovered Walmart event was durably saved or
    // queued for review. The overlap can therefore recover through long outages.
    if (complete && m.ok && m.walmart_complete && m.walmart_archive_coverage && !walmartSaveFailed && m.walmart_scanned_through && Date.parse(m.walmart_scanned_through)<=now.getTime()) {
      state.mailboxes[k].walmart_scanned_through=m.walmart_scanned_through;
    }
  }
  if (complete) {
    // A slot that went blank keeps its history and is reported by config:<idx>,
    // never as "recovered".
    const mis = new Set(r.misconfigured.map(x => String(x.idx)));
    for (const k of Object.keys(state.mailboxes)) if (!seen.has(k) && !mis.has(k)) delete state.mailboxes[k];
  }
  if (complete || (r.totals && r.totals.mailboxes_configured === 0)) state.misconfigured = r.misconfigured;
  state.last_run = r;
  if (complete) state.last_run_at = nowISO;
  const dataIncomplete = r.mailboxes.some(m=>!m.walmart_complete || !m.walmart_archive_coverage || m.search_terms_failed || m.parse_failures || m.unparsed_walmart || m.coverage_issues.length)
    || (r.totals?.walmart?.review_required || 0)>0 || (r.totals?.walmart?.skipped_no_qty || 0)>0;
  if (complete && r.mailboxes.every(m => m.ok) && !r.sync_errors.length && !r.misconfigured.length && !dataIncomplete) state.last_ok_at = nowISO;
  if (complete) state.last_walmart_distinct = ((r.totals || {}).walmart || {}).distinct || 0;

  const dispatch = await readDispatch(db);
  const problems = evaluateBracketSyncHealth({ state, dispatch }, now);
  const out = await notifyBracketSyncProblems(db, problems, { now, scope: INGEST_SCOPE, doc: state });
  state.updated_at = nowISO;
  await writeState(db, state);
  return out;
}

// ── evaluator: PURE. Same function feeds the texts and the dashboard card ───
export function evaluateBracketSyncHealth({ state, dispatch }, now = new Date()) {
  state = state || emptyState();
  dispatch = dispatch || emptyDispatch();
  const P = [];
  const push = (p) => {
    const level = p.level || 'red';
    P.push({ ...p, level, notify: p.notify == null ? level === 'red' : p.notify, family: familyOf(p.key), links: p.links || [], since: p.since || null });
  };
  const configured = dispatch.configured === true;

  // No completed scan for too long — whatever the reason.
  const base = state.last_run_at || dispatch.first_tick_at;
  const thr = configured ? STALE_RUN_MIN : STALE_RUN_MIN_UNCONFIGURED;
  if (base && agoMin(base, now) > thr) {
    let detail = `Last fully successful scan: ${state.last_ok_at ? fmtDenver(state.last_ok_at) : 'never'}`;
    if (dispatch.last_fail_at && (!dispatch.last_ok_at || dispatch.last_fail_at > dispatch.last_ok_at)) detail += ` - Vercel's trigger is also failing (GitHub API ${dispatch.last_status})`;
    if (!configured) detail += " - auto-trigger not set up, scans depend on GitHub's slow schedule";
    const baseT = Date.parse(base);
    push({
      key: 'stale_run', title: `No email scan has completed in ${agoText(agoMin(base, now))}`, detail,
      fix: 'Open GitHub > Actions > Bracket inventory tracker: if it shows a "disabled" banner press Enable workflow, otherwise read the latest run log',
      links: [{ label: 'GitHub Actions', url: ACTIONS_URL }],
      since: Number.isFinite(baseT) ? new Date(baseT + thr * 60000).toISOString() : null,
    });
  }

  // Per-inbox login / reachability.
  const misIdx = new Set((state.misconfigured || []).map(x => String(x.idx)));
  for (const mb of Object.values(state.mailboxes || {})) {
    const idx = String(mb.idx);
    if (misIdx.has(idx)) continue;
    const fails = mb.consecutive_failures || 0;
    if (!fails) continue;
    const e = mb.error || {};
    const who = `${mb.user} (inbox ${idx}${mb.role ? ' - ' + mb.role : ''})`;
    if (e.kind === 'auth') {
      push({
        key: `mailbox:${idx}:auth`, notify: fails >= AUTH_STREAK,
        title: `Gmail login failed for ${who}${fails > 1 ? `, ${fails} scans in a row` : ''}`,
        detail: `Google says: ${String(e.responseText || 'Invalid credentials').replace(/\s+/g, ' ')}. Failing since ${fmtDenver(mb.first_fail_at)}. Walmart orders, plates, reviews and website leads from this inbox are NOT syncing`,
        fix: `New Google App Password for ${mb.user} > GitHub secret ${passSecretFor(idx)} (paste WITHOUT spaces; do not touch ${userSecretFor(idx)}) > press Scan now on the Brackets tab. If Google's message says IMAP is disabled, enable IMAP for that account instead`,
        links: [{ label: 'Google App Passwords', url: APP_PASSWORDS_URL }, { label: 'GitHub secrets', url: SECRETS_URL }],
        since: mb.first_fail_at,
      });
    } else if (fails >= UNREACHABLE_STREAK || (mb.first_fail_at && agoMin(mb.first_fail_at, now) > MAILBOX_STALE_MIN)) {
      // Gmail's transient NO ([UNAVAILABLE], too many connections), timeouts,
      // drops: only a streak or a persisting first failure is worth a card.
      push({
        key: `mailbox:${idx}:unreachable`,
        title: `Can't read ${who} for ${agoText(agoMin(mb.first_fail_at, now))}`,
        detail: `${e.kind || 'error'} at ${mb.stage || 'connect'}: ${e.message || ''}${e.responseText ? ` (${e.responseText})` : ''}`,
        fix: 'Usually transient (Gmail or GitHub network). If it persists past a few hours, sign in to that Google account and check for a security prompt',
        since: mb.first_fail_at,
      });
    }
  }

  // Secret pairs.
  for (const x of state.misconfigured || []) {
    if (String(x.missing).startsWith('required_order_inbox:')) push({
      key:'config:required_order_inbox',title:'The required Walmart confirmation inbox is not configured',
      detail:'No configured mailbox matches andrewtrading04@gmail.com.',fix:'Restore that Gmail account in the scanner configuration and verify its sign-in.',
      links:[{label:'GitHub secrets',url:SECRETS_URL}],
    });
    else if (x.missing === 'both') push({
      key: `config:${x.idx}`, level: 'amber', title: `Inbox ${x.idx} is not configured`,
      detail: 'The scan expects 7 inboxes and this slot is blank',
      fix: `Set GitHub secrets ${userSecretFor(x.idx)} + ${passSecretFor(x.idx)}, or ignore if this inbox was retired on purpose`,
      links: [{ label: 'GitHub secrets', url: SECRETS_URL }],
    });
    else push({
      key: `config:${x.idx}`, title: `Inbox ${x.idx} is only half configured (${x.missing} is blank)`,
      detail: 'The scan skips this slot entirely', fix: `Set GitHub secret ${x.missing}`,
      links: [{ label: 'GitHub secrets', url: SECRETS_URL }],
    });
  }

  // Last run's own findings.
  const lr = state.last_run || null;
  for (const m of (lr?.mailboxes || [])) {
    if (m.ok && (!m.walmart_complete || !m.walmart_archive_coverage || m.search_terms_failed || m.parse_failures || m.unparsed_walmart || (m.coverage_issues || []).length)) push({
      key:`coverage:${m.idx}`, title:`Order intake is incomplete for inbox ${m.idx}`,
      detail:`${m.search_terms_failed || 0} search failures; ${m.parse_failures || 0} unreadable messages; ${m.unparsed_walmart || 0} unrecognized order messages. ${!m.walmart_archive_coverage?'Archived mail coverage is unavailable. ':''}${(m.coverage_issues || []).join(', ')}`,
      fix:'Check the latest scan log and Gmail All Mail access. Resolve unreadable messages before advancing the scan checkpoint.',since:state.last_run_at,
    });
  }
  const wt=lr?.totals?.walmart || {};
  if (wt.review_required>0) push({key:'data_review',level:'amber',title:`${wt.review_required} supplier event(s) need inventory review`,detail:'Messages were saved, but ambiguous quantities, receipts, addresses or historical baselines need confirmation.',fix:'Open Bracket Inventory and review the affected orders.',since:state.last_run_at});
  if (wt.skipped_no_qty>0) push({key:'data_skipped',title:`${wt.skipped_no_qty} Walmart order(s) were skipped`,detail:'Missing quantities must be reviewed; the stock counts are not verified by this scan.',fix:'Open Bracket Inventory and inspect missing supplier order evidence.',since:state.last_run_at});
  if (wt.events>0 && (wt.synced || 0)+(wt.review_required || 0)+(wt.failed || 0)<wt.events) push({key:'data_unaccounted',title:'Some supplier messages have no saved outcome',detail:'Parsed events do not reconcile to saved, review or failed outcomes.',fix:'Inspect the latest scanner and receipt-operation logs.',since:state.last_run_at});
  if (lr && lr.totals && lr.totals.mailboxes_configured === 0) push({
    key: 'no_mailboxes', title: 'The email scan found NO configured inbox',
    detail: 'GMAIL_USER / GMAIL_APP_PASSWORD are not reaching the workflow', fix: 'Check the GMAIL_* secrets on GitHub',
    links: [{ label: 'GitHub secrets', url: SECRETS_URL }], since: state.last_run_at,
  });
  const errs = (lr && lr.sync_errors) || [];
  const hard = errs.filter(e => e.status === 0 || e.status >= 500);
  const rejected = errs.filter(e => e.status >= 400 && e.status < 500);
  const list = (a) => a.slice(0, 3).map(e => `${e.action} HTTP ${e.status} (${e.key})`).join('; ');
  if (hard.length) push({
    key: 'sync_errors', title: `${hard.length + ((lr && lr.sync_errors_dropped) || 0)} item(s) could not be saved to the CRM on the last scan`,
    detail: list(hard), fix: 'Check Vercel > Logs for /api/migrate', since: state.last_run_at,
  });
  if (rejected.length) push({
    key: 'sync_rejected', title: `${rejected.length} item(s) rejected by the CRM`,
    detail: list(rejected), fix: 'Review authorization or validation failures. The next scan retries from the last successful checkpoint.', since: state.last_run_at,
  });
  if (lr && lr.fatal) push({
    key: 'fatal_run', title: 'The email scan crashed before finishing', detail: lr.fatal.message || '',
    fix: 'Open the run log', links: lr.run && lr.run.run_url ? [{ label: 'Run log', url: lr.run.run_url }] : [], since: state.updated_at,
  });

  // The Vercel-side trigger.
  if (dispatch.configured === false) push({
    key: 'dispatch:not_configured', level: 'amber', title: 'Email-scan auto-trigger is not set up',
    detail: "Scans only run on GitHub's slow schedule (1-5 h gaps) until this is done",
    fix: 'Add GITHUB_DISPATCH_TOKEN to Vercel (recipe in .env.example), then redeploy',
    links: [{ label: 'Create token', url: PAT_URL }, { label: 'Vercel env vars', url: VERCEL_ENV_URL }],
  });
  else if (configured && dispatch.last_fail_at && (!dispatch.last_ok_at || dispatch.last_fail_at > dispatch.last_ok_at)) {
    const s = dispatch.last_status == null ? 0 : Number(dispatch.last_status);
    if (DISPATCH_HARD_STATUSES.includes(s) || (dispatch.consecutive_failures || 0) >= DISPATCH_SOFT_STREAK) {
      const why = s === 401 ? 'token invalid or expired'
        : (s === 403 || s === 422) ? 'the workflow is probably DISABLED (GitHub disables scheduled workflows in a public repo after 60 days without a commit) or the token lost Actions: write'
        : s === 404 ? 'repo/workflow not visible to the token'
        : s === 0 ? 'network/timeout to api.github.com'
        : s === 429 ? 'rate limited' : 'GitHub API down';
      const fix = (s === 403 || s === 422)
        ? 'Open GitHub > Actions > Bracket inventory tracker - if it shows a yellow "disabled" banner press Enable workflow. Only if it is enabled: new fine-grained token > Vercel env GITHUB_DISPATCH_TOKEN > redeploy'
        : (s === 401 || s === 404)
          ? 'New fine-grained token (repo handy-andy-booking, Actions: Read and write, no expiration) > Vercel env GITHUB_DISPATCH_TOKEN > redeploy'
          : 'Usually transient; if it persists check GitHub status and the Vercel logs';
      push({
        key: `dispatch:${s}`, title: `Vercel can't start the GitHub email scan (GitHub API ${s})`,
        detail: `${why}${dispatch.last_body ? ` - ${dispatch.last_body}` : ''}`, fix,
        links: [{ label: 'GitHub Actions', url: ACTIONS_URL }, { label: 'Create token', url: PAT_URL }, { label: 'Vercel env vars', url: VERCEL_ENV_URL }],
        since: dispatch.first_fail_at || dispatch.last_fail_at,
      });
    }
  }

  // Vercel's cron itself went quiet (only the GitHub backup schedule can tell us).
  const tickBase = dispatch.last_tick_at || state.first_seen_at;
  if (tickBase && agoMin(tickBase, now) > TICK_STALE_MIN) push({
    key: 'tick_stale', title: `Vercel's every-15-min email-scan trigger has not fired in ${agoText(agoMin(tickBase, now))}`,
    detail: "The scan is only running on GitHub's own slow schedule",
    fix: 'Vercel > handy-andy-booking > Settings > Cron Jobs - check bracket_sync_watchdog is listed and enabled', since: tickBase,
  });

  // Inbox 1 logs in fine but the whole 45-day window holds no Walmart order at
  // all: a forwarding rule / filter / Promotions-tab change on the ordering
  // account looks exactly like this. Amber — it is also what a quiet month looks like.
  const inbox1 = (state.mailboxes || {})['1'];
  if (inbox1 && inbox1.seen_ok_ever && !(inbox1.consecutive_failures > 0) && state.last_run_at && state.last_walmart_distinct === 0) push({
    key: 'no_walmart_mail', level: 'amber', title: `No Walmart order e-mail found in the scan window (${(lr && lr.run && lr.run.lookback_days) || 45} days)`,
    detail: 'Inbox 1 logs in fine, so if orders were placed the forwarding rule / filter on the ordering account may be off',
    fix: 'Check the Gmail forwarding rule on the Walmart-ordering account and that order e-mails land in INBOX (not archived/Promotions)',
  });

  return P.sort((a, b) => (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1));
}

// ── notifier ────────────────────────────────────────────────────────────────
function asciiOnly(s) { return String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\n]/g, '?'); }
function buildAlertSms(list) {
  const head = 'CRM ALERT (email sync):';
  const foot = `Dashboard: ${DASHBOARD_URL}`;
  const more = list.length > 3 ? `\n+${list.length - 3} more` : '';
  const top = list.slice(0, 3);
  const variants = [
    top.map(p => `- ${p.title}. ${p.detail ? p.detail + '. ' : ''}Fix: ${p.fix}`),
    top.map(p => `- ${p.title}. Fix: ${p.fix}`),
    top.map(p => `- ${p.title}`),
  ];
  for (const lines of variants) {
    const msg = `${head}\n${lines.join('\n')}${more}\n${foot}`;
    if (msg.length <= SMS_MAX) return msg;
  }
  return `${head}\n${variants[2].join('\n')}${more}\n${foot}`.slice(0, SMS_MAX);
}
async function sendOwnerText(msg) {
  const text = asciiOnly(msg).slice(0, SMS_MAX);
  const phone = process.env.OWNER_PHONE_NUMBER;
  if (!phone) { console.error('[bracket-sync-health] OWNER_PHONE_NUMBER unset - card only:', text); return { label: 'skipped:no_owner_phone' }; }
  let r;
  try { r = await sendSMSResult(phone, text); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r.ok) return { label: 'sent' };
  if (r.skipped) { console.error(`[bracket-sync-health] text not sent (${r.skipped}):`, text); return { label: `skipped:${r.skipped}` }; }
  console.error('[bracket-sync-health] text failed:', r.error, text);
  return { label: `error:${String(r.error).slice(0, 80)}`, transportError: isTransportError(r.error) };
}

export async function notifyBracketSyncProblems(db, problems, { now = new Date(), scope, doc }) {
  const nowISO = now.toISOString();
  const day = alertDay(now);
  doc.problems ||= {}; doc.flap ||= {}; doc.alerts ||= [];
  const mine = problems.filter(p => scope.test(p.key));
  const red = mine.filter(p => p.level === 'red');

  // 1. Which red keys are due for a text this cycle.
  const due = [];
  for (const p of red) {
    const entry = doc.problems[p.key];
    if (entry) entry.title = p.title;
    if (p.notify === false) { if (!entry) doc.problems[p.key] = { since: p.since || nowISO, title: p.title, notified: false }; continue; }
    if (!entry || !entry.notified) { due.push(p); continue; }
    if (entry.alert_day !== day && entry.last_alert_at && agoMin(entry.last_alert_at, now) >= REALERT_MIN_HOURS * 60) due.push(p);
  }

  // 2. Claim (atomic, per key per alert-day per attempt) with a flap bound.
  const prevFlap = JSON.parse(JSON.stringify(doc.flap));
  const claimed = [], claimKeys = [];
  for (const p of due) {
    const f = doc.flap[p.key];
    const n = (f && f.alert_day === day ? f.count : 0) + 1;
    if (n > MAX_ALERTS_PER_KEY_PER_DAY) {
      doc.problems[p.key] = { ...(doc.problems[p.key] || { since: p.since || nowISO, notified: false }), title: p.title, flapping: true };
      continue;
    }
    const ck = `bracket_sync_alert:${p.key}:${day}:${n}`;
    let ok = false;
    try { ok = await claimOnce(db, ck); } catch (_) { ok = false; }
    if (!ok) continue;   // another invocation is texting this one right now
    claimed.push(p); claimKeys.push(ck);
    doc.flap[p.key] = { alert_day: day, count: n };
  }

  // 3. One combined text. Awaited: Vercel freezes fire-and-forget work.
  let sms = null;
  if (claimed.length) {
    const r = await sendOwnerText(buildAlertSms(claimed));
    sms = r.label;
    if (r.transportError) {
      // Release the claims and the flap count so the next tick retries; do not
      // stamp last_alert_at. A provider 4xx (bad number, unsubscribed) keeps
      // them: one provider call per key per alert-day, not 96.
      for (const ck of claimKeys) { try { await db.from('system_flags').delete().eq('key', ck); } catch (_) {} }
      doc.flap = prevFlap;
      for (const p of claimed) {
        const e = doc.problems[p.key] || {};
        doc.problems[p.key] = { ...e, since: e.since || p.since || nowISO, title: p.title, notified: !!e.notified };
      }
    } else {
      for (const p of claimed) {
        const e = doc.problems[p.key] || {};
        doc.problems[p.key] = { since: e.since || p.since || nowISO, title: p.title, notified: true, last_alert_at: nowISO, alert_day: day };
      }
    }
    doc.alerts.push({ at: nowISO, kind: 'alert', keys: claimed.map(p => p.key), sms });
  }
  for (const p of red) if (!doc.problems[p.key]) doc.problems[p.key] = { since: p.since || nowISO, title: p.title, notified: false };

  // 4. Recovery, per family: only when EVERY red key of that family is gone
  // (auth → unreachable on the same inbox is not a recovery), and only if the
  // family was ever texted (a banner-only blip never earns a "back to normal").
  const curFam = new Set(red.map(p => p.family));
  const prevKeys = Object.keys(doc.problems).filter(k => scope.test(k));
  const recovered = [...new Set(prevKeys.map(familyOf))].filter(f => !curFam.has(f));
  for (const f of recovered) {
    const keys = prevKeys.filter(k => familyOf(k) === f);
    const titles = keys.map(k => doc.problems[k] && doc.problems[k].title).filter(Boolean);
    const wasTexted = keys.some(k => doc.problems[k] && doc.problems[k].notified);
    for (const k of keys) delete doc.problems[k];
    if (!wasTexted) continue;
    let ok = false;
    try { ok = await claimOnce(db, `bracket_sync_recovered:${f}:${day}`); } catch (_) { ok = false; }
    if (!ok) continue;
    const r = await sendOwnerText(`CRM OK (email sync): ${titles.join('; ') || f} - back to normal as of ${fmtDenver(nowISO)}.`);
    doc.alerts.push({ at: nowISO, kind: 'recovery', keys, sms: r.label });
  }
  doc.alerts = doc.alerts.slice(-20);
  return { problems: problems.map(p => p.key), alerted: claimed.map(p => p.key), recovered, sms };
}

// ── GitHub workflow_dispatch ─────────────────────────────────────────────────
// Never throws. No `inputs` in the body: every workflow input is optional and
// omitting them can never 422. The token is never logged.
export async function dispatchBracketScan(env = process.env, { timeoutMs = 10000 } = {}) {
  const at = new Date().toISOString();
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) return { configured: false, ok: false, status: null, body: null, at };
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'handy-andy-crm', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: WORKFLOW_REF }),
    });
    if (r.status === 204) return { configured: true, ok: true, status: 204, body: null, at };
    const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    return { configured: true, ok: false, status: r.status, body, at };
  } catch (e) {
    return { configured: true, ok: false, status: 0, body: String((e && e.message) || e).slice(0, 200), at };
  }
}

// ── watchdog: the every-15-min Vercel cron ──────────────────────────────────
export async function bracketSyncWatchdog(db, { now = new Date(), dry = false } = {}) {
  const nowISO = now.toISOString();
  const d = await readDispatch(db);
  let res = null;
  if (!dry) {
    d.first_tick_at ||= nowISO;
    d.last_tick_at = nowISO;
    res = await dispatchBracketScan();
    d.configured = res.configured;
    if (res.configured) {
      d.last_attempt_at = nowISO;
      if (res.ok) { d.last_ok_at = nowISO; d.last_status = 204; d.last_body = null; d.consecutive_failures = 0; d.first_fail_at = null; }
      else { d.last_fail_at = nowISO; d.first_fail_at ||= nowISO; d.last_status = res.status; d.last_body = res.body; d.consecutive_failures = (d.consecutive_failures || 0) + 1; }
    }
    // Written BEFORE any text so the streak survives an invocation killed mid-Twilio-call.
    await writeDispatch(db, d);
  }
  const state = await readState(db);
  const problems = evaluateBracketSyncHealth({ state, dispatch: d }, now);
  if (dry) return { problems: problems.map(p => p.key), dispatch: { configured: d.configured } };
  const out = await notifyBracketSyncProblems(db, problems, { now, scope: WATCHDOG_SCOPE, doc: d });
  await writeDispatch(db, d);
  await housekeeping(db, now);
  return { ...out, dispatch: { configured: d.configured, ok: res.ok, status: res.status }, stale: problems.some(p => p.key === 'stale_run') };
}

// Claim rows are one-shot markers; sweep the month-old ones once per alert-day.
async function housekeeping(db, now) {
  try {
    if (!(await claimOnce(db, `bracket_sync:housekeeping:${alertDay(now)}`))) return;
    const cutoff = new Date(now.getTime() - 30 * 86400e3).toISOString();
    for (const prefix of ['bracket_sync_alert:', 'bracket_sync_recovered:', 'bracket_sync:housekeeping:']) {
      await db.from('system_flags').delete().like('key', `${prefix}%`).lt('created_at', cutoff);
    }
  } catch (e) { console.warn('[bracket-sync-health] housekeeping:', e.message); }
}

// ── dashboard summary (owner only; api/admin.js bad_reviews) ────────────────
export function summarizeForDashboard({ state, dispatch }, now = new Date()) {
  state = state || emptyState();
  dispatch = dispatch || emptyDispatch();
  const problems = evaluateBracketSyncHealth({ state, dispatch }, now);
  const mbs = Object.values(state.mailboxes || {});
  const alerts = [...(state.alerts || []), ...(dispatch.alerts || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lr = state.last_run || null;
  const flapping = (k) => !!((state.problems || {})[k] || {}).flapping || !!((dispatch.problems || {})[k] || {}).flapping;
  return {
    ok: problems.length === 0,
    last_ok_at: state.last_ok_at || null,
    last_run_at: state.last_run_at || null,
    last_run_url: (lr && lr.run && lr.run.run_url) || null,
    last_run_trigger: (lr && lr.run && lr.run.trigger) || null,
    mailboxes_total: mbs.length + (state.misconfigured || []).length,
    mailboxes_ok: mbs.filter(m => !(m.consecutive_failures > 0)).length,
    dispatch_configured: dispatch.configured,
    problems: problems.map(p => ({ key: p.key, level: p.level, notify: p.notify, title: p.title, detail: p.detail, fix: p.fix, links: p.links, since: p.since, flapping: flapping(p.key) })),
    last_alert: alerts.length ? alerts[alerts.length - 1] : null,
    read_at: now.toISOString(),
  };
}
