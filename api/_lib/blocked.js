// One sitewide block list. A number in app.blocked_numbers is a scammer: the
// owner's rule (2026-09-21) is that a block applies to EVERY business, never one
// brand only. It is already enforced on every Twilio tracking line (voice and
// texts, api/analytics.js). This helper carries the same block to the public
// forms and the booking endpoints, so a blocked number cannot get around it by
// filling in a quote, an estimate or a booking instead of calling.
//
// Fails OPEN on purpose: if the lookup itself errors, a real customer must
// never be turned away because of a database hiccup.
import { serviceClient } from './supabase.js';

export async function isBlockedPhone(raw) {
  try {
    const d = String(raw || '').replace(/\D/g, '').slice(-10);
    if (d.length !== 10) return false;
    const { data } = await serviceClient().from('blocked_numbers').select('id').eq('phone', d).limit(1);
    return !!(data && data.length);
  } catch {
    return false;
  }
}
