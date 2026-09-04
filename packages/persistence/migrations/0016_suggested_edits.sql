-- Phase C: suggested edits (ADR 0002). A suggestion is a comment SUBTYPE, not a
-- new table — it inherits, unchanged: comments' RLS + tenant_isolation policy,
-- composite (id, org_id) FKs, JSONB anchor storage, threading/replies/upvotes,
-- soft delete, the per-document comment tier cap, and the feedback bundle. The
-- only real difference from a plain comment is the replacement text it carries
-- and the accept/reject verb. Accepting one re-anchors the suggestion against
-- the current version, splices proposed_text over the located range, and calls
-- uploadNewVersion UNCHANGED (owner/admin-gated) — so the external-guest hard
-- rule (never a document mutation) survives structurally, same choke point as
-- every other version upload.

alter table comments
  -- 'comment' (default) keeps every existing row a plain comment with no
  -- backfill. 'suggestion' carries proposed_text + an outcome.
  add column kind text not null default 'comment'
    check (kind in ('comment', 'suggestion')),
  -- The replacement text a suggestion proposes for its anchored range. An
  -- empty string is a legitimate "delete this" suggestion — the discriminator
  -- is null vs not-null, never emptiness.
  add column proposed_text text,
  -- Lifecycle of a suggestion: 'open' until an owner/admin accepts or rejects.
  -- Null for plain comments (see the iff constraint below).
  add column suggestion_outcome text
    check (suggestion_outcome in ('open', 'accepted', 'rejected')),
  -- The version minted when a suggestion was accepted; null otherwise.
  add column applied_version_id uuid,
  -- kind='suggestion' iff proposed_text is present: a suggestion always carries
  -- replacement text, a plain comment never does.
  add constraint comments_suggestion_text_ck
    check ((kind = 'suggestion') = (proposed_text is not null)),
  -- An outcome exists iff the row is a suggestion — plain comments never have one.
  add constraint comments_suggestion_outcome_ck
    check ((kind = 'suggestion') = (suggestion_outcome is not null)),
  -- applied_version_id is set only on an accepted suggestion.
  add constraint comments_applied_version_ck
    check (applied_version_id is null or suggestion_outcome = 'accepted'),
  -- Length guard, mirroring MAX_APPROVAL_NOTE_LENGTH's DB check — the comment
  -- count cap bounds how many suggestions exist, this bounds how big each is,
  -- so a hostile paste can't bloat a comments row (Core Principle abuse guard).
  add constraint comments_proposed_text_len_ck
    check (proposed_text is null or length(proposed_text) <= 20000),
  -- Composite (id, org_id) FK: a plain FK on version_id alone would leak across
  -- tenants (FK checks bypass RLS — CONSTITUTION.md hard rule).
  add constraint comments_applied_version_fk
    foreign key (applied_version_id, org_id) references document_versions (id, org_id);
