-- Owner can move a pipeline card forward by hand (2026-09-28).
alter table app.pipeline_marks add column if not exists manual_stage text, add column if not exists manual_stage_at timestamptz, add column if not exists manual_stage_by text;
