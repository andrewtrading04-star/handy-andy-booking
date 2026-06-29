// ============================================================================
// scripts/lib/google-review-parse.mjs — Parse a Google Business Profile review
// notification email into a payload.
// ============================================================================
// Pure functions (no I/O) so they can be unit-tested against real email text.
// Built against the actual "X left a review for <Business>" email from
// businessprofile-noreply@google.com:
//   Subject: "R Scott left a review for Doms TV Mounting Colorado"
//   Body:    "...you got a new 5-star review ... R Scott Dahms
//             Professional, experienced, good communication. Perfect.
//             Reply to review"
// ============================================================================

export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<img[^>]*\balt=["']([^"']*)["'][^>]*>/gi, ' $1 ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ');
}

// Map the business name in the email to our slug. Only the two we run.
function detectBusiness(text) {
  const s = (text || '').toLowerCase();
  if (/dom'?s\b|doms\b/.test(s)) return 'doms';
  if (/handy\s*andy/.test(s)) return 'handy-andy';
  return null;
}

// Parse a whole email into a Google-review payload, or null if it isn't an
// identifiable Google Business Profile review notification.
export function parseGoogleReviewEmail({ subject = '', text = '', html = '', emailDateISO } = {}) {
  const body = (text && text.trim()) ? text : stripHtml(html);
  const hay = `${subject}\n${body}`;

  // Must look like a Google review notification (and NOT a reply/other notice).
  if (!/left a review for|you got a new|new\s+\d\s*[-‑]?\s*star\s+review/i.test(hay)) return null;

  // Rating: "5-star review" / "5 star".
  const rm = hay.match(/(\d)\s*[-‑]?\s*star/i);
  const rating = rm ? parseInt(rm[1], 10) : null;
  if (!rating || rating < 1 || rating > 5) return null;

  // Business: from the subject "... left a review for <Business>", else anywhere.
  const bm = subject.match(/left a review for\s+(.+)$/i);
  const business = detectBusiness(bm ? bm[1] : hay);
  if (!business) return null;

  // Reviewer: subject "<reviewer> left a review …". Then upgrade to the fuller
  // name in the body if it starts with the same first token (e.g. subject
  // "R Scott" → body "R Scott Dahms").
  let reviewer = null;
  const nm = subject.match(/^\s*(.+?)\s+left a review/i);
  if (nm) reviewer = nm[1].trim();
  if (reviewer) {
    const esc = reviewer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Allow up to 3 extra name words (surname/middle), never crossing a period or
    // line break into the review text.
    const fuller = body.match(new RegExp('\\b(' + esc + "(?:[ '\\-][A-Za-z]+){0,3})", 'i'));
    if (fuller && fuller[1].trim().length > reviewer.length) {
      reviewer = fuller[1].trim().replace(/\s+/g, ' ');
    }
  }

  // Review text: between the reviewer's name and "Reply to review" (best-effort).
  let review_text = null;
  const replyIdx = body.search(/reply to (?:the )?review/i);
  if (replyIdx > 0 && reviewer) {
    const before = body.slice(0, replyIdx);
    const nameIdx = before.toLowerCase().lastIndexOf(reviewer.toLowerCase());
    if (nameIdx >= 0) {
      const t = before.slice(nameIdx + reviewer.length).replace(/\s+/g, ' ').trim();
      if (t && t.length <= 1200) review_text = t;
    }
  }

  const review_date = (emailDateISO || new Date().toISOString()).slice(0, 10);

  // Stable dedupe key so re-scanning the same email is idempotent (no review id
  // is exposed in the email, so key on business + reviewer + rating + a text
  // snippet).
  const snippet = (review_text || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  const google_key = `${business}:${(reviewer || '').toLowerCase()}:${rating}:${snippet}`;

  return { business, reviewer_name: reviewer, rating, review_text, review_date, google_key };
}
