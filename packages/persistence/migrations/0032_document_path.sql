-- Phase 29: workspace paths — `documents.path`.
--
-- The sync CLI (Phase 20) mirrors a repo into a project, so a
-- document now records where it lived in that repo, e.g. `docs/specs/auth.md`.
-- Without it the mirror flattens `docs/specs/auth.md` and `docs/adr/0008-x.md`
-- into one undifferentiated list and the reader loses the structure they
-- navigate by. NULL = no repo origin (a manual web/MCP upload).
--
-- THIS COLUMN IS NOT A STORAGE KEY, and must never be mistaken for one.
-- Blobs are addressed exclusively by VersionKey{org_id, document_id, seq}
-- derived from tenant context, and no function anywhere accepts an
-- outside-supplied storage key or path (CONSTITUTION.md §3 — S3 isolation is
-- inherited from RLS via that rule). `path` is display and organisation
-- metadata: the workspace tree and the viewer breadcrumb read it, the storage
-- layer never does. Do not wire this column into a key, a prefix, or a
-- filesystem join.
--
-- Expand-only (Core Principle 6, ADR 0006). A nullable ADD COLUMN with no
-- default is additive: every row the previous app version writes leaves it
-- NULL, which both the CHECK and the partial index permit, so blue and green
-- run against this schema simultaneously. No contract step is needed or
-- scheduled — nothing is removed.
--
-- Blue-green window: the old app version never WRITES a path (no wire field
-- carries one) and never READS the column (`select *` widens harmlessly — the
-- row mapper ignores unknown columns), so a path written by green is invisible
-- to blue rather than an error.
alter table documents add column path text;

-- Structural backstop ONLY. `isValidDocumentPath` (packages/domain) is the
-- source of truth for path safety — traversal, backslashes, control
-- characters, whitespace — because every write goes through it. Replicating
-- that rule set in SQL would drift from the domain the first time either side
-- changed; these two are the ones worth having the database refuse outright,
-- and neither can ever legitimately loosen.
alter table documents
  add constraint documents_path_shape_ck
  check (path is null or (length(path) between 1 and 1024 and path not like '/%'));

-- Two LIVE documents at one repo path in one project is a sync bug, never a
-- legitimate state, so the database refuses it outright.
--
--   * Partial on `path is not null`: manual uploads (the NULL majority) are
--     exempt by construction and never collide with one another.
--   * Partial on `deleted_at is null`: a soft-deleted document is invisible to
--     every read path until the retention sweep purges it (ADR 0001), so its
--     old path must not squat on a name a new document wants — otherwise
--     deleting a file and re-pushing it would fail for `retention_days`.
--     Follows `org_invites_live_email_idx` (migration 0008), which scopes its
--     uniqueness to live rows the same way. Archived documents are NOT exempt:
--     an archived doc is still visible and still occupies its repo path.
--   * NULLS NOT DISTINCT so unfiled documents (`project_id is null`) collide
--     with each other on path exactly like filed ones do; the default
--     NULLS DISTINCT would silently exempt the whole unfiled lane.
create unique index documents_project_path_uniq
  on documents (org_id, project_id, path) nulls not distinct
  where path is not null and deleted_at is null;
