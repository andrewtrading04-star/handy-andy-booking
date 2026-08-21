// api/_lib/native-businesses.js
// The single source of truth for which business slugs run the native, zip-driven
// CRM path (api/book.js's bookNative) as opposed to Doms' single-metro path or
// the legacy Zenbooker path. Every place that needs to recognize "is this a
// real business slug" (slots.js, estimate.js, log-event.js, analytics.js,
// admin.js allowlists) imports this instead of keeping its own copy — a slug
// list duplicated six times drifts silently; this doesn't.
//
// Doms is deliberately NOT here — it predates bookNative and keeps its own
// single-metro handler (bookDoms), so it's allowlisted separately wherever
// that distinction matters.
//
//   name      what a technician sees on the job card / assignment text
//   legalName the full trading name, used in owner alerts and email subjects
export const NATIVE_BUSINESS = {
  'handy-andy': { name: 'Handy Andy',                    legalName: 'Handy Andy TV Mounting' },
  'mile-high':  { name: 'Mile High TV Mounting',         legalName: 'Mile High TV Mounting' },
  // Austin-only micro-brand (austinmounting.com), same shape as Mile High: no
  // techs of its own, borrows Handy Andy's Austin roster (see PARTNER_SLUG in
  // availability.js), fully separate customer-facing identity.
  'austin':     { name: 'TV Mounting & Handyman Austin', legalName: 'TV Mounting & Handyman Austin' },
  // Houston-only micro-brand (precisiontvinstallation.com), same shape again:
  // no techs of its own, borrows Handy Andy's Houston roster (Juan).
  'precision':  { name: 'Precision TV Installation',     legalName: 'Precision TV Installation' },
  // Denver-only micro-brand (tvmountingdenver.com), same shape as Mile High:
  // no techs of its own, borrows Handy Andy's Denver roster. Booking-only
  // brand: it publishes NO phone number anywhere.
  'tvmountingdenver': { name: 'TV Mounting Denver',      legalName: 'TV Mounting Denver' },
  // Houston lead-gen micro-brands, same shape as Precision: no techs of their
  // own, all borrow Handy Andy's Houston roster (Juan). Share one Stripe
  // account (houstonmounting.com's) — see LEGACY_SLUG_ACCOUNT in stripe.js.
  'houstonmounting':      { name: 'Houston Mounting',           legalName: 'Houston Mounting' },
  'houstontvinstallation': { name: 'Houston TV Installation',   legalName: 'Houston TV Installation' },
  'tvhanginghouston':     { name: 'TV Hanging Houston',         legalName: 'TV Hanging Houston' },
  'htvmounting':          { name: 'HTV Mounting',                legalName: 'HTV Mounting' },
};

export const NATIVE_SLUGS = Object.keys(NATIVE_BUSINESS);

// Every business slug the /api/book.js dispatcher recognizes at all (native +
// Doms). Used by allowlist checks that don't care about the native/Doms split.
export const ALL_BUSINESS_SLUGS = [...NATIVE_SLUGS, 'doms'];
