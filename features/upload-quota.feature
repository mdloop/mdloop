Feature: Upload ingest policy
  CONSTITUTION.md §4: 500KB per file, content-policy validated (ADR 0011).
  This is the ingest-time gate only — size and content shape, checked before
  anything is written. The size/content check, version write and ledger
  entry commit in one transaction — there is no path around the ledger.

  Upload *velocity* (how many uploads per week/month) used to be a separate
  per-tier rolling weekly/monthly quota checked here. Retired in the
  rate-limiting redesign (2026-08-11): that job is now
  covered by the general per-user request budget — see
  features/rate-limit-parity.feature for its minute/day/month windows — plus
  the standing per-org/per-doc stock ceilings in features/tier-limits.feature,
  which cap the actual outcome (too many docs, too many versions) rather than
  a velocity proxy.

  Background:
    Given organization "Acme" with user "alice"

  Scenario: A file over 500KB is rejected
    When "alice" uploads a document of 512001 bytes
    Then the upload is rejected as too large
    And no version and no ledger entry exist

  Scenario: An empty file is rejected
    When "alice" uploads an empty document
    Then the upload is rejected as empty
    And no version and no ledger entry exist

  Scenario: Content containing control bytes is rejected
    When "alice" uploads a document containing a control byte
    Then the upload is rejected as not markdown
    And no version and no ledger entry exist

  Scenario: A renamed binary is rejected by its signature
    When "alice" uploads a document starting with a PDF signature
    Then the upload is rejected as a binary file
    And no version and no ledger entry exist

  Scenario: A successful upload consumes exactly one ledger entry
    When "alice" uploads a document
    Then the upload succeeds
    And the ledger records exactly 1 upload for "alice"

  Scenario: Re-pushing identical content is idempotent and free
    Given "alice" has uploaded a document with content "same bytes"
    When "alice" uploads content "same bytes" to the same document again
    Then no new version is created
    And the ledger still records exactly 1 upload for "alice"
