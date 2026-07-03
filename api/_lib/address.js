// ============================================================================
// api/_lib/address.js — build a clean single-line display address.
// ----------------------------------------------------------------------------
// Some bookings store the WHOLE formatted address in address_line1 (the widget,
// book.js, saves the Google-autocomplete string there) AND keep city/state/zip
// as separate columns. Naively joining [line1, city, state, zip] then duplicated
// the tail: "4408 Logan Ridge Dr, Austin, TX 78613, Austin, TX 78613". The
// mangled string also broke Street View / geocoding.
//
// formatAddress only appends the parts that aren't ALREADY present in line1, so
// both "full address in line1" and "clean street in line1" render correctly.
// ============================================================================

export function formatAddress(b) {
  if (!b) return '';
  const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const l1 = String(b.address_line1 || '').trim();
  const l2 = String(b.address_line2 || '').trim();
  const city = String(b.city || '').trim();
  const st = String(b.state || '').trim();
  const zip = String(b.postal_code || '').trim();
  // Word-boundary match so a street like "Austin Ave" in another city doesn't
  // falsely count as containing the city/state.
  const inL1 = (part) => !!part && new RegExp('\\b' + esc(part) + '\\b', 'i').test(l1);

  const parts = [];
  if (l1) parts.push(l1);
  if (l2) parts.push(l2);
  if (inL1(city) && inL1(st)) {
    // line1 already carries city + state — only add the zip if it's missing.
    if (zip && !inL1(zip)) parts.push(zip);
  } else {
    const tail = [city, [st, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (tail) parts.push(tail);
  }
  return parts.join(', ');
}
