-- Phase 21.A: version notes (ADR 0003 §B). An optional, human-written note on
-- each upload — "what changed" — surfaced later in the Compare header, the
-- viewing-old-leg banner, and version-chip tooltips. It is org content
-- (never in logs/telemetry; included in exportOrg).
--
-- document_versions is INSERT-only (the forbid_version_mutation trigger from
-- 0001 rejects every UPDATE), so a note is written once and is never editable —
-- consistent with immutable versions. No RLS change (the table is already
-- tenant-scoped) and no FK (the note is free text). Length CHECK mirrors the
-- 20k cap pattern from comments_proposed_text_len_ck (0016), bounding a hostile
-- or accidental paste. Nullable, no backfill: existing versions have no note.
alter table document_versions
  add column change_note text,
  add constraint document_versions_change_note_len_ck
    check (change_note is null or length(change_note) <= 20000);
