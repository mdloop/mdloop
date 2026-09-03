Feature: Erasure log, post-restore replay, and self-serve export
  Compliance-driven erasure and export (Phase 14). "Purged" means: gone from live
  systems immediately, out of all backups within 35 days. The erasure log
  records every purge as opaque ids + timestamps (Core Principle 3) and is
  replayed after any backup restore so purged data stays purged (GDPR
  Art. 17 pattern). Export (markdown + comments JSON) is the Art. 20 path —
  self-serve, every tier.

  Background:
    Given organization "Acme" with admin "alice" and a document with a comment

  Scenario: Every purge kind lands in the erasure log with opaque ids only
    When the document is purged immediately by the admin
    And an old version of another document is purged by the retention sweep
    Then the erasure log records a "document_purge" and a "version_purge"
    And log entries carry only ids, kinds and timestamps

  Scenario: The erasure log survives the org it describes
    Given a billing_events row references the organization
    When the organization is purged
    Then the erasure log records an "org_purge" for it
    And the log entry remains readable after the organization row is gone
    And the billing_events row survives with its org pointer nulled by the FK

  Scenario: Replay re-applies purges that a backup restore resurrected
    Given the document was purged and the purge was logged
    And a backup restore resurrected the document rows and blobs
    When the erasure replay runs
    Then the document rows and blobs are gone again

  Scenario: Replay re-tombstones resurrected versions
    Given a version was tombstoned by the retention sweep and logged
    And a backup restore resurrected the version row and blob
    When the erasure replay runs
    Then the version is a tombstone again and its blob is gone

  Scenario: Replay is idempotent
    Given the document was purged and the purge was logged
    When the erasure replay runs twice
    Then the second run reports the same events with nothing new purged

  Scenario: Admin exports the org as markdown plus comments JSON
    When "alice" requests the org export
    Then the export contains the document's markdown and its comment with replies
    And a member requesting the export is refused
