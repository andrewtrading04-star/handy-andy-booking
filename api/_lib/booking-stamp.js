// "Deduct once" stamps on bookings.metadata (wire_plate_deducted_at,
// appletv_bracket_deducted_at). claimBookingStamp returns true to exactly one
// caller, so a double-tapped "Complete" can't subtract stock twice -- see
// migration 0150. Claim BEFORE subtracting; release if the subtraction throws.

export async function claimBookingStamp(db, bookingId, key) {
  const { data, error } = await db.rpc('claim_booking_stamp', { p_booking_id: bookingId, p_key: key });
  if (!error) return data === true;
  // Pre-0150 database: fall back to the old non-atomic re-read + merge.
  const { data: cur } = await db.from('bookings').select('metadata').eq('id', bookingId).maybeSingle();
  if (!cur || cur.metadata?.[key]) return false;
  await db.from('bookings')
    .update({ metadata: { ...(cur?.metadata || {}), [key]: new Date().toISOString() } })
    .eq('id', bookingId);
  return true;
}

export async function releaseBookingStamp(db, bookingId, key) {
  try {
    const { error } = await db.rpc('release_booking_stamp', { p_booking_id: bookingId, p_key: key });
    if (!error) return;
    const { data: cur } = await db.from('bookings').select('metadata').eq('id', bookingId).maybeSingle();
    if (!cur?.metadata) return;
    const { [key]: _drop, ...rest } = cur.metadata;
    await db.from('bookings').update({ metadata: rest }).eq('id', bookingId);
  } catch (_) { /* best-effort */ }
}
