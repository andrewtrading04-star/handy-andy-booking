-- Lets the owner permanently remove a Google review from the Reviews tab list
-- once they've seen it (a separate action from the New/Past "seen" split,
-- which just changes which group a review sits in — this hides it entirely).
set search_path = app, public, extensions;

alter table google_reviews
add column if not exists dismissed_at timestamptz;
