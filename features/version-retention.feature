Feature: Version auto-purge with tombstones
  ADR 0001 / `packages/domain/src/tier.ts`: old version blobs are purged once they are older
  than T days AND outside the last N versions. The version row is never
  deleted — it becomes a tombstone (purged_at set) so comments keep valid FKs
  and truthful quotes. The current version and versions pinned by open
  comments are never purged. The tier version cap counts live blobs only.

  Background:
    Given organization "Acme" with user "alice" and version retention of last 2 versions or 30 days

  Scenario: The sweep tombstones rows and deletes blobs past the rule
    Given "alice" has uploaded "spec.md" with 5 versions, all 60 days old
    When the version purge sweep runs today
    Then versions 1 to 3 are tombstones with their rows intact
    And the blobs of versions 1 to 3 are deleted
    And versions 4 and 5 keep their blobs

  Scenario: A version pinned by an open comment is never purged
    Given "alice" has uploaded "spec.md" with 1 version, 60 days old
    And "alice" commented on version 1
    And "alice" uploaded 3 more versions, all 50 days old
    When the version purge sweep runs today
    Then version 1 keeps its blob
    And version 2 is a tombstone while versions 3 and 4 are kept as the last two

  Scenario: Resolving the pinning comment makes the version purgeable
    Given "alice" has uploaded "spec.md" with 1 version, 60 days old
    And "alice" commented on version 1
    And "alice" uploaded 3 more versions, all 50 days old
    And the comment is resolved
    When the version purge sweep runs today
    Then version 1 is a tombstone

  Scenario: A comment pinned to a purged version keeps its quote and is not orphaned
    Given "alice" has uploaded "spec.md" with a paragraph that survives to the current version
    And "alice" commented on that paragraph
    And the comment was resolved, unpinning its version
    And the pinned version was purged by the sweep
    When "alice" lists the comment threads
    Then the comment still carries its quoted text
    And the comment re-anchors to the current version instead of orphaning

  Scenario: Young versions and the last N never purge
    Given "alice" has uploaded "spec.md" with 5 versions, all 5 days old
    When the version purge sweep runs today
    Then no version is purged

  Scenario: The version cap counts live blobs, so purge frees headroom
    Given the organization is on the free tier with version retention of last 1 version or 1 day
    And "alice" has uploaded "spec.md" with 100 versions, all 10 days old
    Then uploading another version is rejected with "version_cap_exceeded"
    When the version purge sweep runs today
    Then uploading another version succeeds

  Scenario: Org retention config cannot exceed the tier ceiling
    Given the organization is on the free tier
    Then setting version retention to last 500 versions is rejected with "version_retention_exceeds_tier_ceiling"
    And setting version retention to last 5 versions or 7 days is accepted
