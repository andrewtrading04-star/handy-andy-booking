// Pure/helpers shared with offline intake tests. No network or process effects.
export const WALMART_SEARCH_TERMS = [{from:'walmart.com'},{body:'walmart'}];
export function gmailAuthenticationResults(parsed) {
  // Use the first Google receiver result, never embedded/forwarded headers.
  return (parsed.headerLines || []).find(h => String(h.key).toLowerCase() === 'authentication-results' && /^authentication-results:\s*mx\.google\.com\s*;/i.test(h.line || ''))?.line || '';
}
export function walmartScanSince(checkpoint,lookbackDays = 45,now = new Date()) {
  const normal = now.getTime() - lookbackDays * 86400000;
  const stamp = Date.parse(checkpoint);
  const start = Number.isFinite(stamp) && stamp <= now.getTime() ? Math.min(normal,stamp - 2 * 86400000) : normal;
  return new Date(start);
}
export function orderedWalmartEvents(events) {
  const unique = new Map();
  for (const event of events) {
    if (!event?.event_id) throw new Error('Supplier event missing durable identity');
    const previous = unique.get(event.event_id);
    if (!previous || (!previous.provenance?.trusted && event.provenance?.trusted)) unique.set(event.event_id,event);
    else if (previous.provenance?.trusted === event.provenance?.trusted && JSON.stringify(previous.ordered) !== JSON.stringify(event.ordered)) {
      unique.set(event.event_id,{...previous,ordered:null,received:null,receipt_verified:false,review_reason:'duplicate_source_quantity_conflict'});
    }
  }
  return [...unique.values()].sort((a,b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')) || a.event_id.localeCompare(b.event_id));
}
export async function searchMailboxUids(client,since,terms) {
  const all = new Set(), failed = [];
  for (const term of terms) {
    try {
      const uids = await client.search({since,...term},{uid:true});
      if (!Array.isArray(uids)) throw new Error('Search did not return message identifiers');
      for (const uid of uids) all.add(uid);
    } catch (_) { failed.push(Object.keys(term)[0] + ':' + Object.values(term)[0]); }
  }
  if (failed.length === terms.length) throw Object.assign(new Error('Every requested mailbox search failed'),{code:'SEARCH_FAILED'});
  return {uids:[...all],failed_terms:failed.length,failed_searches:failed};
}
