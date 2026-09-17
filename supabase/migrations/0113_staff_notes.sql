-- ============================================================================
-- Migration 0113: owner -> secretary notes
-- ----------------------------------------------------------------------------
-- api/admin.js notesActive / notesRead / notesList / notesAdd / notesDelete
-- shipped (commit 6d38b32) without the tables behind them, so posting a note
-- failed with "Could not find the table 'app.staff_notes' in the schema cache".
--
-- staff_notes: one row per note. target_slug null = every business;
-- mode today | two_days | until_read; show_from is the Denver date it was
-- written. Soft-deleted via deleted_at so read history survives.
-- staff_note_reads: one row per (note, reader) tick-off, so a note aimed at
-- both secretaries is cleared by each independently.
-- Service-role only, like the rest of app.
-- ============================================================================

create table if not exists app.staff_notes (
  id          uuid primary key default gen_random_uuid(),
  body        text not null check (length(body) between 1 and 2000),
  target_slug text,
  mode        text not null default 'today' check (mode in ('today', 'two_days', 'until_read')),
  show_from   date not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists staff_notes_live_idx on app.staff_notes (created_at) where deleted_at is null;

create table if not exists app.staff_note_reads (
  note_id uuid not null references app.staff_notes(id) on delete cascade,
  reader  text not null,
  read_at timestamptz not null default now(),
  primary key (note_id, reader)
);

alter table app.staff_notes enable row level security;
alter table app.staff_note_reads enable row level security;
revoke all on app.staff_notes, app.staff_note_reads from anon, authenticated;
grant all on app.staff_notes, app.staff_note_reads to service_role;

notify pgrst, 'reload schema';
