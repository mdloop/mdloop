Feature: Sign-off workflow ("pass the vorlyn")
  Version-pinned approvals: an owner or admin requests a reviewer, the
  reviewer approves or requests changes, and the document's status is always
  derived from active requests + approvals on the current version — never a
  status column that could drift from the versions it describes. Approvals
  are append-only; a new version never deletes them, it just changes what
  "the current version" means, so status recomputes honestly. Guests can be
  requested reviewers (a verdict is annotation, never a document mutation),
  but never request a review or accept a suggestion themselves.

  Background:
    Given an organization "Acme" with owner "alice" and a document "spec.md"

  Scenario: Owner requests a reviewer who has access, reviewer approves
    Given "alice" granted "bob" comment access to "spec.md"
    When "alice" requests "bob" as a reviewer on "spec.md"
    Then the document's review status is "in_review"
    When "bob" submits verdict "approved" on "spec.md"
    Then the document's review status is "approved"

  Scenario: A member without access cannot be requested
    When "alice" requests "carol" as a reviewer on "spec.md" without granting access
    Then the request is refused with "reviewer_has_no_access"

  Scenario: A plain member cannot request a reviewer
    Given "alice" granted "bob" comment access to "spec.md"
    When "bob" (a member, not owner or admin) requests "bob" as a reviewer on "spec.md"
    Then the request is refused with "forbidden"

  Scenario: A guest cannot request a reviewer
    When a guest "dana" requests a reviewer on "spec.md"
    Then the request is refused with "forbidden"

  Scenario: A guest with a comment grant can be a requested reviewer
    Given "alice" granted guest "dana" comment access to "spec.md"
    When "alice" requests guest "dana" as a reviewer on "spec.md"
    And "dana" submits verdict "changes_requested" on "spec.md"
    Then the document's review status is "changes_requested"

  Scenario: Submitting a verdict without an active request is refused
    When "alice" submits verdict "approved" on "spec.md" without being requested
    Then the verdict is refused with "not_a_reviewer"

  Scenario: A revoked request can no longer submit a verdict
    Given "alice" granted "bob" comment access to "spec.md"
    And "alice" requests "bob" as a reviewer on "spec.md"
    When "alice" revokes "bob"'s review request on "spec.md"
    Then "bob" submitting a verdict on "spec.md" is refused with "not_a_reviewer"

  Scenario: The hard gate blocks approval while comments are open
    Given the org's approval gate is "hard"
    And "alice" granted "bob" comment access to "spec.md"
    And "alice" requests "bob" as a reviewer on "spec.md"
    And "spec.md" has an open comment
    When "bob" submits verdict "approved" on "spec.md"
    Then the verdict is refused with "open_comments_block_approval"
    When the open comment on "spec.md" is resolved
    And "bob" submits verdict "approved" on "spec.md"
    Then the document's review status is "approved"

  Scenario: The soft gate allows approval with open comments
    Given the org's approval gate is "soft"
    And "alice" granted "bob" comment access to "spec.md"
    And "alice" requests "bob" as a reviewer on "spec.md"
    And "spec.md" has an open comment
    When "bob" submits verdict "approved" on "spec.md"
    Then the document's review status is "approved"

  Scenario: A new version drops the status back to in_review; approvals survive
    Given "alice" granted "bob" comment access to "spec.md"
    And "alice" requests "bob" as a reviewer on "spec.md"
    And "bob" submits verdict "approved" on "spec.md"
    When "alice" uploads a new version of "spec.md"
    Then the document's review status is "in_review"
    And "bob"'s approval on the previous version still exists

  Scenario: Changes requested dominates over another reviewer's approval
    Given "alice" granted "bob" comment access to "spec.md"
    And "alice" granted "carol" comment access to "spec.md"
    And "alice" requests "bob" and "carol" as reviewers on "spec.md"
    And "bob" submits verdict "approved" on "spec.md"
    When "carol" submits verdict "changes_requested" on "spec.md"
    Then the document's review status is "changes_requested"

  Scenario: Tenant isolation on review state
    Given "alice" granted "bob" comment access to "spec.md"
    And "alice" requests "bob" as a reviewer on "spec.md"
    Then an actor in a different organization cannot read or write "spec.md"'s review state
