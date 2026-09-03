Feature: Tenant isolation
  Core Principle 1: no code path may return another organization's data.
  Isolation is enforced by Postgres row-level security, not app discipline.

  Background:
    Given organization "Acme" with user "alice"
    And organization "Globex" with user "bob"
    And "alice" has uploaded a document "runbook.md"

  Scenario: A user cannot read a document belonging to another organization
    When "bob" requests the document "runbook.md" by its id
    Then the document is not found

  Scenario: Listing documents never crosses the organization boundary
    When "bob" lists all documents
    Then the list does not contain "runbook.md"

  Scenario: A user cannot delete a document belonging to another organization
    When "bob" attempts to delete the document "runbook.md"
    Then the deletion is refused
    And "alice" still sees "runbook.md" intact

  Scenario: A user cannot attach comments to another organization's document
    When "bob" attempts to comment on the document "runbook.md"
    Then the comment is rejected by the database

  Scenario: A query without a tenant context fails closed
    When a query runs with no organization bound to the session
    Then the database returns an error instead of any rows

  Scenario: A user cannot tombstone another organization's version
    When "bob" attempts to purge the version of "runbook.md"
    Then the tombstone is refused
    And "alice" still sees the version live

  Scenario: An edit grantee cannot reach another organization's document
    Given "bob" holds an edit grant on a document in his own organization
    When "bob" attempts to upload a new version of "runbook.md"
    Then the upload is refused as if the document did not exist
    And a forged edit grant naming "runbook.md" still gives "bob" nothing

  Scenario: A project grantee cannot reach another organization's document
    Given "alice" filed "runbook.md" into a project of her own
    And "bob" holds an edit grant on a project in his own organization
    When "bob" attempts to upload a new version of "runbook.md"
    Then the upload is refused as if the document did not exist
    And a forged project grant naming alice's project still gives "bob" nothing

  Scenario: A user cannot change another organization's retention settings
    When "bob" attempts to set his organization's version retention
    Then "Acme" retention settings are untouched
