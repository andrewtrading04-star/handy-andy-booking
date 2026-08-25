// ============================================================================
// Which businesses each secretary can act on, beyond their own — the single
// source of truth for three previously-separate things that used to drift out
// of sync with each other every time the assignment changed:
//   1. Dashboard access (api/admin.js: login, session_status, View As,
//      bad-review alerts, resolveBusiness's business-scoped action gate)
//   2. The "which line rang" picker on the Take a Call greet card, and the
//      whole call list/history/business-name filter (api/admin.js: calls())
//   3. Who a voicemail alert or a late-job escalation text goes to
//      (api/admin.js: secretaryPhoneFor; api/_lib/tech-late.js)
//
// A secretary's token still carries ONE primary `scope` (their own company —
// every company-specific tool keys off it: Review Calls, Call Performance, My
// Availability, payroll, the greeting name). This map is the SECOND, wider
// list layered on top: other brands the same person also answers the phone
// for. Edit this map to change anyone's access — nothing else needs touching.
//
// Owner assignment, 2026-08-26 (replaces the earlier Joey-gets-all-eight
// split from the day before): Heather and Joey split the twelve non-Handy-
// Andy tracking numbers six and six. Handy Andy itself (incl. its LA tracking
// number) stays Heather's home business, implicit in her `scope` already.
export const SECRETARY_EXTRA_BUSINESSES = {
  doms: [
    'atxmountpros', 'austinmountingpros', 'houstontvinstallation', 'tvhanginghouston',
    'precision', 'tvmountingdenver',
  ],
  'handy-andy': [
    'atxtvmount', 'austintvinstall', 'houstonmounting', 'htvmounting',
    'austin', 'mile-high',
  ],
};

// Every business slug a token may act on: its primary scope plus any extras.
// Owner ('all') is unrestricted, and returns null meaning "apply no filter".
//
// The extras are derived from the LIVE map above, not only from the token:
// admin tokens are long-lived, and reading the token alone means an
// already-open dashboard keeps exactly its old access until the person logs
// out and back in — which reads as "none of the changes are showing" (this
// happened to Joey the day this was built). The token's own `allowed` list is
// still honoured too (union), so a View As session behaves identically either
// way.
export function allowedSlugsFor(auth) {
  if (!auth || auth.scope === 'all') return null;
  const fromScope = SECRETARY_EXTRA_BUSINESSES[auth.scope] || [];
  const fromToken = Array.isArray(auth.allowed) ? auth.allowed : [];
  return [auth.scope, ...new Set([...fromScope, ...fromToken])].filter(Boolean);
}

// The gate every business-scoped action goes through.
export function mayUseBusiness(auth, slug) {
  const allowed = allowedSlugsFor(auth);
  return allowed === null || allowed.includes(slug);
}
