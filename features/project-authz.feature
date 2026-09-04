Feature: Project authorization
  Projects are org-shared containers, but mutating one is not a free-for-all
  (Phase 24): renaming, archiving, and deleting require being the project's
  creator or an org admin. Projects created before ownership existed have no
  recorded creator and are deliberately admin-only. Creation stays open to any
  member; guests never touch projects at all.

  Background:
    Given an organization "acme" with admin "alice" and members "bob" and "carol"

  Scenario: A member manages their own project
    Given "bob" created a project "runbooks"
    When "bob" renames "runbooks" to "ops-runbooks"
    Then the rename succeeds

  Scenario: A member cannot mutate another member's project
    Given "bob" created a project "runbooks"
    When "carol" tries to rename "runbooks" to "mine-now"
    Then the rename is refused as forbidden
    When "carol" tries to delete "runbooks"
    Then the delete is refused as forbidden

  Scenario: An admin can manage any project
    Given "bob" created a project "runbooks"
    When "alice" deletes "runbooks"
    Then the project is gone and its documents are unfiled

  Scenario: A project with no recorded creator is admin-only
    Given a project "legacy" with no recorded creator
    When "bob" tries to rename "legacy" to "claimed"
    Then the request is refused as forbidden
    When "alice" renames "legacy" to "migrated"
    Then the rename succeeds
