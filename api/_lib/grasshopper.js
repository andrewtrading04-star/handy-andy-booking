// ============================================================================
// Grasshopper — line directory + phone helpers
// ----------------------------------------------------------------------------
// The automatic voicemail-email ingestion this module used to do (a Google
// Apps Script forwarding Grasshopper's notification emails to api/admin.js's
// call_ingest action) was retired 2026-08-26 — owner call: stop tracking
// Grasshopper calls entirely. That parser, its timestamp/transcript helpers,
// and its self-tests are gone.
//
// What's left is still live: GRASSHOPPER_LINES is the line directory the
// separate call-AUDIT tool (api/audit.js, public/audit.html) uses — a human
// auditor opens each number in Grasshopper's own app, counts the calls, and
// logs the count here. That's a manual verification workflow, not automatic
// tracking, and the owner's request didn't touch it. digitsOf/prettyPhone are
// generic phone helpers used well beyond Grasshopper.
// ============================================================================

// ── Which phone line is which market ────────────────────────────────────────
// Keyed by the 10 digits of the Grasshopper number. Read by api/audit.js to
// build the list of lines the auditor counts against.
export const GRASSHOPPER_LINES = {
  '7206373707': { market: 'Denver',  business: 'handy-andy' },
  '7205418180': { market: 'Denver',  business: 'handy-andy' },
  '7208006095': { market: 'Denver',  business: 'doms' },
  '2816388419': { market: 'Houston', business: 'handy-andy' },
  '2816265853': { market: 'Houston', business: 'handy-andy' },
  '7138769032': { market: 'Houston', business: 'handy-andy' },
  '5126686643': { market: 'Austin',  business: 'handy-andy' },
};

// ── Helpers ─────────────────────────────────────────────────────────────────
export function digitsOf(s) {
  const d = String(s || '').replace(/\D/g, '');
  // Strip a leading US country code so "+1 (720) 637-3707" and "7206373707"
  // are the same key everywhere (map lookups, customer matching, dedupe).
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
export function prettyPhone(s) {
  const d = digitsOf(s);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(s || '').trim();
}
