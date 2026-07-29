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
  'handy-andy': { name: 'Handy Andy',            legalName: 'Handy Andy TV Mounting' },
  'mile-high':  { name: 'Mile High TV Mounting', legalName: 'Mile High TV Mounting' },
};

export const NATIVE_SLUGS = Object.keys(NATIVE_BUSINESS);

// Every business slug the /api/book.js dispatcher recognizes at all (native +
// Doms). Used by allowlist checks that don't care about the native/Doms split.
export const ALL_BUSINESS_SLUGS = [...NATIVE_SLUGS, 'doms'];
