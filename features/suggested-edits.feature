Feature: Suggested edits
  A suggestion is a comment subtype carrying proposed replacement text for its
  anchored range (ADR 0002 C.1). Anyone who can comment can create one — a
  guest included, since creating a suggestion is just commenting.

  Accepting a suggestion is a metadata-only decision (ADR 0007): it flips the
  outcome to "accepted" and nothing else — no splice, no new version. It stays
  owner-or-org-admin only (unchanged gate, deliberately not loosened just
  because accept no longer mutates the document). Because accept no longer
  touches document content, it can never be refused for an unresolvable anchor
  — there is nothing to locate or splice at accept time.

  Materialization happens later and lazily: whenever the document's threads
  are next read, each accepted-but-unapplied suggestion is re-anchored against
  the current version (the same pipeline that re-anchors ordinary comments),
  and if the text at the resolved range now reads exactly as the proposed
  replacement, the suggestion is marked applied against that version. An
  inexact or absent match leaves it accepted and pending — never guessed
  (Core Principle 2).

  Accept and reject are valid only once, on an open suggestion.

  Background:
    Given an organization "Acme" with owner "alice" and a document "spec.md"

  Scenario: An owner accepts a suggestion — the outcome flips, the document is untouched
    When "alice" suggests replacing "draft" with "final" on "spec.md"
    And "alice" accepts that suggestion
    Then the suggestion's outcome is "accepted"
    And the suggestion is not yet applied to any version
    And "spec.md"'s current content still contains "draft"
    And "spec.md"'s current content does not contain "final"

  Scenario: An org admin can accept a suggestion they do not own
    Given "alice" granted "bob" comment access to "spec.md"
    And "bob" suggests replacing "draft" with "final" on "spec.md"
    When admin "alice" accepts that suggestion
    Then the suggestion's outcome is "accepted"

  Scenario: A guest can create a suggestion but cannot accept it
    Given "alice" granted guest "dana" comment access to "spec.md"
    When guest "dana" suggests replacing "draft" with "final" on "spec.md"
    Then the suggestion is created
    When guest "dana" tries to accept that suggestion
    Then the accept is refused with "forbidden"

  Scenario: A guest cannot reject a suggestion
    Given "alice" granted guest "dana" comment access to "spec.md"
    And "dana" suggests replacing "draft" with "final" on "spec.md"
    When guest "dana" tries to reject that suggestion
    Then the reject is refused with "forbidden"

  Scenario: A plain member (not owner or admin) cannot accept a suggestion
    Given "alice" granted "bob" comment access to "spec.md"
    And "bob" suggests replacing "draft" with "final" on "spec.md"
    When "bob" tries to accept that suggestion
    Then the accept is refused with "forbidden"

  Scenario: Accepting succeeds even when the anchored text has since changed — nothing is spliced, so nothing can be guessed
    When "alice" suggests replacing "draft" with "final" on "spec.md"
    And "alice" uploads a new version of "spec.md" that removes the anchored text
    And "alice" accepts that suggestion
    Then the suggestion's outcome is "accepted"
    And the suggestion is not yet applied to any version

  Scenario: A suggestion cannot be accepted twice (double-resolve)
    When "alice" suggests replacing "draft" with "final" on "spec.md"
    And "alice" accepts that suggestion
    And "alice" tries to accept that suggestion again
    Then the accept is refused with "suggestion_not_open"

  Scenario: A rejected suggestion is terminal and cannot then be accepted
    When "alice" suggests replacing "draft" with "final" on "spec.md"
    And "alice" rejects that suggestion
    Then the suggestion's outcome is "rejected"
    When "alice" tries to accept that suggestion
    Then the accept is refused with "suggestion_not_open"

  Scenario: Tenant isolation on suggestions
    Given "alice" suggests replacing "draft" with "final" on "spec.md"
    Then an actor in a different organization cannot accept or reject that suggestion

  Scenario: An accepted suggestion is marked applied once a matching real edit lands
    When "alice" suggests replacing "draft" with "final" on "spec.md"
    And "alice" accepts that suggestion
    And "alice" uploads a new version of "spec.md" that replaces "draft" with "final"
    And the document's threads are read
    Then the suggestion's outcome is "accepted"
    And the suggestion is applied to that new version

  Scenario: An accepted suggestion stays pending when a real edit doesn't match the proposal
    When "alice" suggests replacing "draft" with "final" on "spec.md"
    And "alice" accepts that suggestion
    And "alice" uploads a new version of "spec.md" that is unrelated to the suggestion
    And the document's threads are read
    Then the suggestion's outcome is "accepted"
    And the suggestion is not yet applied to any version
