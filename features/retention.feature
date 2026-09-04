Feature: Deletion and retention
  CONSTITUTION.md §6: soft-deleted documents are retained for the org's
  retention window (default 30 days) and then purged permanently — rows and
  blobs. An org may opt into immediate purge. Purging never refunds quota.

  Background:
    Given organization "Acme" with user "alice" and retention of 10 days

  Scenario: Soft delete stamps the purge deadline from org retention
    Given "alice" has uploaded a document "notes.md"
    When "alice" deletes the document on "2026-07-10"
    Then the document is soft-deleted with purge date "2026-07-20"
    And the document no longer appears in any listing
    And the blob is still stored

  Scenario: Immediate purge removes rows and blobs at once
    Given the organization purges immediately
    And "alice" has uploaded a document "burn.md"
    When "alice" deletes the document
    Then the document row, its versions and its blobs are gone
    And the ledger still records the upload

  Scenario: The retention sweep purges only documents past their deadline
    Given "alice" has uploaded documents "old.md" and "fresh.md"
    And "old.md" was deleted with purge date "2026-07-01"
    And "fresh.md" was deleted with purge date "2026-08-01"
    When the retention sweep runs on "2026-07-10"
    Then "old.md" is fully purged, blobs included
    And "fresh.md" is still retained
