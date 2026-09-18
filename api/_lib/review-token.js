// Review-link token for a booking.
//
// The "How did we do?" email/text sent on completion (api/tech.js status
// change, api/admin.js bookingUpdate) and the Reviews-tab resend buttons all
// build their link from bookings.review_token. A booking without one is
// silently skipped by every one of those paths — which is exactly what
// happened to every estimate-approved job (admin.js autoBookFromEstimate
// inserted the row without minting a token, unlike bookingCreate) until
// 2026-09-06: the customer never got a review request and the resend button
// refused with "This job has no review link yet."
//
// One definition, used by every booking-creation path AND healed on demand at
// the moment a token is actually needed, so no creation path can ever quietly
// opt a customer out of review requests again.
import { signToken, verifyToken } from './auth.js';
import { compactReviewToken } from './review-code.js';

export const REVIEW_TOKEN_TTL = 2592000; // 30 days, same as bookingCreate always used

export function mintReviewToken(bookingId) {
  return signToken({ kind: 'review', booking_id: bookingId }, REVIEW_TOKEN_TTL);
}

// A stored token is only usable if it still verifies: the 30-day TTL starts at
// BOOKING time but the link is only used at COMPLETION, so a job booked 31+
// days out (estimate approval offers 45) reaches completion holding a token
// that already 401s on review.html. Treat that the same as missing.
function tokenUsable(token, bookingId) {
  if (!token) return false;
  try {
    const payload = verifyToken(token);
    return !!(payload && payload.booking_id === bookingId && (!payload.kind || payload.kind === 'review'));
  } catch { return false; }
}

// Returns a usable review_token for the booking, minting and persisting a
// fresh one if the stored one is missing or expired. `booking` is mutated in
// place (booking.review_token) so callers that already hold a row can keep
// using it without a re-read. Re-minting is safe: every consumer (review.html
// check/submit, the review_click redirect, the Twilio status callback) verifies
// the HMAC and looks the booking up by the token's booking_id — none compares
// against the stored string — so a link already sent keeps working until its
// own expiry. Never throws — a failed mint is logged and returns null so the
// caller falls through to its existing "no review link" handling instead of
// failing the status change itself.
export async function ensureReviewToken(db, booking) {
  if (!booking || !booking.id) return null;
  if (tokenUsable(booking.review_token, booking.id)) return booking.review_token;
  const why = booking.review_token ? 'expired' : 'missing';
  try {
    const token = mintReviewToken(booking.id);
    const { error } = await db.from('bookings').update({ review_token: token }).eq('id', booking.id);
    if (error) throw error;
    booking.review_token = token;
    console.log(`[review] minted ${why} review_token for booking ${booking.id}`);
    return token;
  } catch (e) {
    // Senders inspect the mutated booking. Do not leave an unusable token in
    // place when persistence fails, or they will send a broken review link.
    booking.review_token = null;
    console.error(`[review] could not mint review_token for booking ${booking.id}:`, e.message);
    return null;
  }
}

// Every brand's OWN short link for a review request text, as a URL prefix —
// the token is appended directly, no encoding surprises to remember at the
// call site. Carriers want a message link to sit on the sender's own domain
// (not a third-party booking-app URL), and a bare "brandname.com/r/<token>"
// reads as a real business, short enough to not get flagged, and doesn't
// leak "handy-andy" into a Dom's or a lead-gen customer's text the way the
// raw booking-app URL (…handy-andy-booking.vercel.app/api/book?action=
// review_click&token=<huge blob>&ch=sms) did until 2026-09-15.
//
// Every prefix ends up pointing at a tiny redirect that 302s to the booking
// app's own review_click endpoint (which does the actual click-tracking and
// hands the customer on to review.html):
//   - 14 brands run a /r/[token] route inside their own Next.js site repo
//     (same file in every one).
//   - 'precision': precisiontvinstallation.com is a static export, not a
//     Next.js app this codebase can add a route to. Its DNS is on Vercel's
//     own nameservers, so instead of touching that deployment at all, a
//     dedicated subdomain (r.precisiontvinstallation.com) points at its own
//     tiny standalone Vercel project (precision-review-link) doing the exact
//     same redirect at its root path — no /r/ prefix needed since the
//     subdomain itself is the "r".
// Exported as BRAND_SHORT_LINK_PREFIX too: the /r/<code> redirect on each of
// these domains is generic (see estimate-code.js) — any brand with a review
// short-link also gets one for estimate-approval texts, same domain map.
export const REVIEW_LINK_PREFIX = {
  'handy-andy': 'https://www.ihandyandy.com/r/',
  'doms': 'https://www.domstvmounting.com/r/',
  'mile-high': 'https://www.milehightvmounting.com/r/',
  'austin': 'https://www.austinmounting.com/r/',
  'tvmountingdenver': 'https://www.tvmountingdenver.com/r/',
  'houstonmounting': 'https://houstonmounting.com/r/',
  'houstontvinstallation': 'https://houstontvinstallation.com/r/',
  'tvhanginghouston': 'https://tvhanginghouston.com/r/',
  'htvmounting': 'https://htvmounting.com/r/',
  'houstontvmountingpros': 'https://www.houstontvmountingpros.com/r/',
  'houstonperfectviewtvmounting': 'https://houstonperfectviewtvmounting.com/r/',
  'atxmountpros': 'https://atxmountpros.com/r/',
  'atxtvmount': 'https://atxtvmount.com/r/',
  'austinmountingpros': 'https://austinmountingpros.com/r/',
  'austintvinstall': 'https://austintvinstall.com/r/',
  'precision': 'https://r.precisiontvinstallation.com/',
};

// The customer-facing review-request text. One template for all three
// senders (tech app completion in api/tech.js; dashboard completion and the
// Reviews-tab resend in api/admin.js), so the wording cannot drift between
// senders. Review requests deliberately omit the business name: after service,
// the customer only needs one clear action and the review link.
export function reviewRequestSms({ slug, name, token, clickUrl }) {
  const prefix = REVIEW_LINK_PREFIX[slug];
  const code = token ? compactReviewToken(token) : null;
  const link = prefix && code ? `${prefix}${encodeURIComponent(code)}` : clickUrl;
  return `How did we do? You can leave your technician a review here:\n\n${link}`;
}
