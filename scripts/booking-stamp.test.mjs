// node scripts/booking-stamp.test.mjs -- claimBookingStamp lets exactly one caller deduct.
import assert from 'node:assert/strict';
import { claimBookingStamp, releaseBookingStamp } from '../api/_lib/booking-stamp.js';

// In-memory stand-in for the two paths the helper uses: the 0150 RPCs, and the
// pre-0150 fallback (select/update on bookings).
function fakeDb({ rpcAvailable }) {
  const bookings = { b1: { id: 'b1', metadata: { li_rev: 3 } } };
  return {
    bookings,
    async rpc(name, { p_booking_id, p_key }) {
      if (!rpcAvailable) return { data: null, error: { message: `function ${name} does not exist` } };
      const row = bookings[p_booking_id];
      if (name === 'claim_booking_stamp') {
        if (!row || row.metadata[p_key]) return { data: false, error: null };
        row.metadata = { ...row.metadata, [p_key]: 'now' };
        return { data: true, error: null };
      }
      if (name === 'release_booking_stamp') {
        if (row) { const { [p_key]: _d, ...rest } = row.metadata; row.metadata = rest; }
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from() {
      let id;
      const q = {
        select() { return q; },
        eq(_col, v) { id = v; return q; },
        async maybeSingle() { return { data: bookings[id] || null, error: null }; },
        update(patch) {
          return { eq: async (_col, v) => { if (bookings[v]) Object.assign(bookings[v], patch); return { error: null }; } };
        },
      };
      return q;
    },
  };
}

for (const rpcAvailable of [true, false]) {
  const db = fakeDb({ rpcAvailable });
  const key = 'wire_plate_deducted_at';
  assert.equal(await claimBookingStamp(db, 'b1', key), true, `first claim wins (rpc=${rpcAvailable})`);
  assert.equal(await claimBookingStamp(db, 'b1', key), false, `double-tap loses (rpc=${rpcAvailable})`);
  assert.equal(db.bookings.b1.metadata.li_rev, 3, `other metadata kept (rpc=${rpcAvailable})`);
  await releaseBookingStamp(db, 'b1', key);
  assert.equal(db.bookings.b1.metadata[key], undefined, `release clears the stamp (rpc=${rpcAvailable})`);
  assert.equal(await claimBookingStamp(db, 'b1', key), true, `claim works again after release (rpc=${rpcAvailable})`);
  assert.equal(await claimBookingStamp(db, 'missing', key), false, `unknown booking never claims (rpc=${rpcAvailable})`);
}
console.log('booking-stamp: all tests passed');
