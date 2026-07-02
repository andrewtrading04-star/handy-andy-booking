// ============================================================================
// scripts/lib/gmb-locations.mjs — Google Business Profile locations registry
// ============================================================================
// SINGLE SOURCE OF TRUTH for every Google Business Profile (GBP / "Google
// Business") listing we run, across both businesses. "Hard saved" here so it
// survives context/chat and is the one place to update when a listing changes.
//
// Each listing records:
//   name          human label for the location
//   business      our slug: 'handy-andy' | 'doms'
//   metro         routing metro used by review-request routing (admin.js)
//   cid           the Google place CID — the token in the g.page short link
//                 (https://g.page/r/<CID>/review). This is the review-WRITE link
//                 customers use; it is NOT the same as the review-notification
//                 email that Google sends the owner.
//   reviewUrl     the full customer "leave a review" short link
//   notifyEmail   the Gmail account that RECEIVES the "you just received a
//                 Google review" notification email for this listing. This is
//                 the mailbox the tracker must scan to ingest new reviews.
//   mailboxEnv    which GMAIL_USER[_N] env slot in the tracker scans notifyEmail
//                 (see scripts/bracket-email-sync.mjs + bracket-tracker.yml).
//
// NOTE on Houston: both Houston listings send their review notifications to the
// SAME inbox (houstonmainbusiness@gmail.com), so one mailbox slot covers both.
//
// NOTE on ingest granularity: the google_reviews table (migration 0042) keys on
// business_id only — it has no per-location column yet. So today every HA review
// lands under business 'handy-andy' regardless of which of the 5 listings it was
// left on (parity with how Dom's is tracked as a single feed). Per-location
// tagging is a future enhancement; the `cid` + `metro` here are what a later
// migration would use to attribute a review to a specific listing.
// ============================================================================

export const GMB_LOCATIONS = [
  {
    name: 'Handy Andy — Houston #1',
    business: 'handy-andy',
    metro: 'houston',
    cid: 'CdizxHwpwcE0EBM',
    reviewUrl: 'https://g.page/r/CdizxHwpwcE0EBM/review',
    notifyEmail: 'houstonmainbusiness@gmail.com',
    mailboxEnv: 'GMAIL_USER_4',
  },
  {
    name: 'Handy Andy — Houston #2',
    business: 'handy-andy',
    metro: 'houston',
    cid: 'CeA7fWzbLgO8EBM',
    reviewUrl: 'https://g.page/r/CeA7fWzbLgO8EBM/review',
    notifyEmail: 'houstonmainbusiness@gmail.com',
    mailboxEnv: 'GMAIL_USER_4',
  },
  {
    name: 'Handy Andy — Denver #1',
    business: 'handy-andy',
    metro: 'denver',
    cid: 'Ccj-ZjdeLtzfEBM',
    reviewUrl: 'https://g.page/r/Ccj-ZjdeLtzfEBM/review',
    notifyEmail: 'denvermainbusiness@gmail.com',
    mailboxEnv: 'GMAIL_USER_5',
  },
  {
    name: 'Handy Andy — Denver #2',
    business: 'handy-andy',
    metro: 'denver',
    cid: 'CWcIi45TvszbEBM',
    reviewUrl: 'https://g.page/r/CWcIi45TvszbEBM/review',
    notifyEmail: 'denverinstallpros@gmail.com',
    mailboxEnv: 'GMAIL_USER_6',
  },
  {
    name: 'Handy Andy — Austin',
    business: 'handy-andy',
    metro: 'austin',
    cid: 'CYE7aX6tVMnkEBM',
    reviewUrl: 'https://g.page/r/CYE7aX6tVMnkEBM/review',
    notifyEmail: 'austinmainbusiness@gmail.com',
    mailboxEnv: 'GMAIL_USER_7',
  },
  {
    name: "Dom's TV Mounting Colorado",
    business: 'doms',
    metro: 'denver',
    cid: 'Cffr7Tp2DSNOEBM',
    reviewUrl: 'https://g.page/r/Cffr7Tp2DSNOEBM/review',
    notifyEmail: 'domstvmounting@gmail.com',
    mailboxEnv: 'GMAIL_USER_2',
  },
];

// Distinct notification inboxes → the mailbox env slot that must scan them.
// Handy: what to wire up in GitHub Actions secrets.
export function notificationMailboxes() {
  const seen = new Map();
  for (const l of GMB_LOCATIONS) {
    if (!seen.has(l.notifyEmail)) {
      seen.set(l.notifyEmail, { email: l.notifyEmail, env: l.mailboxEnv, locations: [] });
    }
    seen.get(l.notifyEmail).locations.push(l.name);
  }
  return [...seen.values()];
}
