Feature: Comment full-text search is permission-scoped (ADR 0003 §C)

  Comment search replicates the owner/grant/admin predicate document search
  already uses — RLS is only the backstop. A hit reaches a searcher only if
  they own the document, hold a grant on it, or are an org admin, and never
  after the comment is soft-deleted. These are money paths (CONSTITUTION §3/§8.2).

  Background:
    Given an organization "Acme" with owner "alice" and a document "spec.md"
    And "alice" left a comment "the rollback path is unclear" on "spec.md"

  Scenario: The owner finds their own comment by its body
    When "alice" searches comments for "rollback"
    Then the comment on "spec.md" is in the results

  Scenario: A comment never leaks to another organization
    When a searcher in a different organization searches comments for "rollback"
    Then the search returns nothing

  Scenario: A same-org member without a grant cannot find the comment, but an admin can
    Given a member "carol" in "Acme" with no grant on "spec.md"
    When "carol" searches comments for "rollback"
    Then the search returns nothing
    When admin "dave" searches comments for "rollback"
    Then admin "dave" sees the comment on "spec.md"
    When "alice" grants "carol" comment access to "spec.md"
    Then "carol" can now find the comment on "spec.md"

  Scenario: A soft-deleted comment drops out of search
    When "alice" deletes that comment
    And "alice" searches comments for "rollback"
    Then the search returns nothing
