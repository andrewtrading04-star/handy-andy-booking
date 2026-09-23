-- Pipeline (migration 0141): the spans a card sat CLOSED -- marked Lost or Not
-- a lead -- before a Reopen or a fresh mark replaced that decision (review
-- 2026-09-24). pipeline_marks only keeps the latest lost_at / reopened_at, so
-- a card marked Lost, reopened, then marked Lost again later looked open
-- during its first Lost, and a customer's call from that span quietly joined
-- it instead of keeping its own card. api/_lib/pipeline.js pipelineOp appends
-- [{ "from": <closed at>, "to": <reopened / re-marked at> }] and canJoin keeps
-- any touch inside a span off the card. Until this runs, the op still saves
-- the decision without the span (the old behaviour).
alter table app.pipeline_marks add column if not exists closed_windows jsonb not null default '[]';
