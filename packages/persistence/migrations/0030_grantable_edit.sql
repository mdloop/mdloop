-- Phase 28 / ADR 0008: `edit` becomes a grantable share permission.
--
-- Expand-only (Core Principle 6, ADR 0006). Widening a CHECK is additive:
-- every row the previous app version can write still satisfies the new
-- constraint, so old and new code run against this schema simultaneously. No
-- contract step is needed or scheduled — nothing is removed.
--
-- Blue-green window: the old app version never WRITES 'edit' (its wire schema
-- enums it out) and on READ only passes the string through to a display
-- label, so a row written 'edit' by green and read by blue degrades to an
-- unfamiliar label, never an error.
alter table share_grants drop constraint share_grants_permission_check;
alter table share_grants
  add constraint share_grants_permission_check
  check (permission in ('read', 'comment', 'edit'));

-- The external-guest cap stays enforced BY SCHEMA where it can be. Every
-- guest grant carries grantee_email by construction (migration 0011), so this
-- makes "external guests never hold edit" a database guarantee rather than
-- app discipline (CONSTITUTION §9, ADR 0008 decision 3, layer (a)). No
-- existing row can violate it — 'edit' was unwritable until the statement
-- above. Also covers the guest re-share path, which UPDATEs permission in
-- place (`extendGuestGrant`).
alter table share_grants
  add constraint share_grants_no_guest_edit
  check (permission <> 'edit' or grantee_email is null);
