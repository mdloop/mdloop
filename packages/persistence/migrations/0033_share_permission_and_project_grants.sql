-- Phase 42 / ADR 0014: a `share` rung between `comment` and `edit`, and real
-- project-level share grants (the `subject_type = 'project'` arm has existed
-- in the CHECK since 0001 but nothing has ever written or read one until now).
--
-- Expand-only (Core Principle 6, ADR 0006). Widening the permission CHECK is
-- additive: every row the previous app version can write still satisfies the
-- new constraint, so old and new code run against this schema simultaneously.
-- No contract step is needed or scheduled.
--
-- Blue-green window: the old app version never WRITES 'share' (its wire
-- schema enums it out) and on READ only passes the string through to a
-- display label, so a row written 'share' by green and read by blue degrades
-- to an unfamiliar label, never an error.
alter table share_grants drop constraint share_grants_permission_check;
alter table share_grants
  add constraint share_grants_permission_check
  check (permission in ('read', 'comment', 'share', 'edit'));

-- The external-guest cap is re-expressed as an ALLOWLIST rather than the old
-- "not edit" denylist (`share_grants_no_guest_edit`), which would have
-- silently admitted 'share' onto a guest row the moment the enum above grew.
-- Every guest grant carries grantee_email by construction (migration 0011),
-- so this stays a database guarantee, not app discipline (CONSTITUTION §9,
-- ADR 0008 decision 3 layer (a), ADR 0014). Safe to apply: no existing row
-- can violate the new, narrower constraint — the constraint it replaces
-- already forbade the only value outside the allowlist ('edit') on any row
-- carrying a grantee_email, and 'share' did not exist as a value until the
-- statement above. Also covers the guest re-share path, which UPDATEs
-- permission in place (`extendGuestGrant`).
alter table share_grants drop constraint share_grants_no_guest_edit;
alter table share_grants
  add constraint share_grants_guest_read_comment_only
  check (permission in ('read', 'comment') or grantee_email is null);
