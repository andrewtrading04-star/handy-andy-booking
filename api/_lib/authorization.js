// ============================================================================
// Signed-authorization / chargeback-evidence helpers (Handy Andy + Dom's).
// ----------------------------------------------------------------------------
// Two jobs:
//   1. saveAuthorization() — after a successful signed charge, freeze the
//      signature + amount + tip + line items + accepted terms + signing
//      provenance (IP / device / time) into booking_authorizations. Best-effort:
//      it must NEVER throw back into the charge path — the money already moved.
//   2. buildDisputeEvidence() — assemble the text evidence + a human narrative
//      for a Stripe dispute from a stored authorization, mapped to Stripe's real
//      dispute-evidence fields. File uploads (signature image, job photos) are
//      attached by the caller, which has the Stripe account key.
//
// Pure-ish: only touches Supabase (storage + one insert) and never Stripe.
// ============================================================================
import { uploadImage } from './storage.js';

export const TERMS_VERSION = '2026-07-01';

// The authorization language the customer agrees to when they sign. The tech app
// renders the same text (with the live amounts) so what they see IS what we
// store. Kept here so the server can reconstruct it if the client omits it.
export function authorizationText({ businessName, customerName, cardLast4, ticketAmount, tip, total }) {
  const card = cardLast4 ? `ending ••${cardLast4}` : 'on file';
  const fmt = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  return (
    `I, ${customerName || 'the customer'}, authorize ${businessName || 'the company'} to charge my card ${card} ` +
    `${fmt(total)} for the services listed above (${fmt(ticketAmount)} service` +
    `${Number(tip) > 0 ? ` + ${fmt(tip)} tip` : ''}). ` +
    `I confirm the work was completed to my satisfaction, and I have read and agree to the ` +
    `Terms of Service and Refund Policy.`
  );
}

// First hop of X-Forwarded-For (the real client), falling back to the socket.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

// Persist a signed authorization. `ctx`:
//   { businessId, total, ticketAmount, tip, card:{brand,last4}, pi, chargeId, body }
// `body` is the client request (signature dataURL, customer_name, terms_text,
// terms_version, snapshot.line_items). Returns the inserted row id, or null on
// any failure — the caller ignores the result so the charge is never undone.
export async function saveAuthorization(db, req, booking, ctx) {
  try {
    const { businessId, total, ticketAmount, tip, card = {}, pi, chargeId, body = {} } = ctx;

    // Upload the signature image (best-effort — a missing signature must not
    // block storing the rest of the evidence).
    let sig = { path: null, url: null };
    if (body.signature) {
      try { sig = await uploadImage(body.signature, `authorizations/${booking.id}`); }
      catch (_) { /* keep going without the image */ }
    }

    const row = {
      business_id: businessId,
      booking_id: booking.id,
      signature_path: sig.path,
      signature_url: sig.url,
      customer_name: (body.customer_name || booking.customer?.name || '').toString().slice(0, 120) || null,
      card_brand: card.brand || null,
      card_last4: card.last4 || null,
      amount: total,
      ticket_amount: ticketAmount,
      tip: tip || 0,
      line_items: (body.snapshot && Array.isArray(body.snapshot.line_items)) ? body.snapshot.line_items : null,
      terms_text: body.terms_text || null,
      terms_version: body.terms_version || TERMS_VERSION,
      signed_ip: clientIp(req),
      signed_user_agent: req.headers['user-agent'] || null,
      stripe_payment_intent_id: pi?.id || null,
      stripe_charge_id: chargeId || null,
    };
    const { data, error } = await db.from('booking_authorizations').insert(row).select('id').single();
    if (error) return null;
    return data?.id || null;
  } catch (_) {
    return null;
  }
}

// Build the TEXT half of a Stripe dispute-evidence packet from a stored
// authorization. The caller uploads the signature + photos to Stripe Files and
// injects the resulting file ids (customer_signature, service_documentation).
// Returns { evidence, narrative } where `evidence` is ready for
// POST /v1/disputes/:id { evidence[...] }.
export function buildDisputeEvidence({ booking, auth, customer }) {
  const fmt = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  const lines = Array.isArray(auth?.line_items) ? auth.line_items : (booking?.line_items || []);
  const itemList = lines
    .filter((li) => Number(li.line_total) !== 0)
    .map((li) => `${li.name}${li.quantity > 1 ? ` ×${li.quantity}` : ''} — ${fmt(li.line_total)}`)
    .join('; ');

  const signedAt = auth?.signed_at ? new Date(auth.signed_at).toISOString() : null;
  const narrative = [
    `The customer authorized this charge in person at the completion of service and signed for it on the technician's device.`,
    auth?.customer_name ? `Signed by: ${auth.customer_name}.` : null,
    signedAt ? `Signed at: ${signedAt}.` : null,
    auth?.signed_ip ? `Signing IP address: ${auth.signed_ip}.` : null,
    auth?.card_last4 ? `Card charged: ${auth.card_brand || 'card'} ending ${auth.card_last4}.` : null,
    (auth?.amount != null) ? `Total authorized: ${fmt(auth.amount)}${Number(auth.tip) > 0 ? ` (includes ${fmt(auth.tip)} tip)` : ''}.` : null,
    itemList ? `Services rendered: ${itemList}.` : null,
    auth?.terms_text ? `Accepted terms: "${auth.terms_text}"` : null,
  ].filter(Boolean).join(' ');

  const evidence = {
    customer_name: auth?.customer_name || customer?.name || undefined,
    customer_email_address: customer?.email || undefined,
    customer_purchase_ip: auth?.signed_ip || undefined,
    billing_address: [booking?.address_line1, booking?.city, booking?.state, booking?.postal_code].filter(Boolean).join(', ') || undefined,
    product_description: itemList ? `In-home service: ${itemList}` : 'In-home TV mounting / handyman service',
    service_date: booking?.scheduled_at ? new Date(booking.scheduled_at).toISOString().slice(0, 10) : undefined,
    uncategorized_text: narrative,
  };

  return { evidence, narrative };
}
