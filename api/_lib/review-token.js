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

export const REVIEW_TOKEN_TTL = 2592000; // 30 days, same as bookingCreate always used

export function mintReviewToken(bookingId) {
  return signToken({ kind: 'review', booking_id: bookingId }, REVIEW_TOKEN_TTL);
}

// A stored token is only usable if it still verifies: the 30-day TTL starts at
// BOOKING time but the link is only used at COMPLETION, so a job booked 31+
// days out (estimate approval offers 45) reaches completion holding a token
// that already 401s on review.html. Treat that the same as missing.
function tokenUsable(token) {
  if (!token) return false;
  try { return !!verifyToken(token); } catch { return false; }
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
  if (tokenUsable(booking.review_token)) return booking.review_token;
  const why = booking.review_token ? 'expired' : 'missing';
  try {
    const token = mintReviewToken(booking.id);
    const { error } = await db.from('bookings').update({ review_token: token }).eq('id', booking.id);
    if (error) throw error;
    booking.review_token = token;
    console.log(`[review] minted ${why} review_token for booking ${booking.id}`);
    return token;
  } catch (e) {
    console.error(`[review] could not mint review_token for booking ${booking.id}:`, e.message);
    return null;
  }
}
