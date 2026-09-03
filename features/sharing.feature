Feature: Sharing and permissions
  CONSTITUTION.md §9 / ADR 0008: share grants carry read, comment or edit, but
  never edit for an external guest — that one stays refused by the schema
  itself. Links live behind hashed tokens shown exactly once, never cross the
  org boundary, and revocation cuts access immediately. Edit grants have their
  own money path in features/edit-grants.feature.

  Background:
    Given organization "Acme" in link mode with owner "alice", member "mia" and admin "amir"
    And organization "Globex" with user "bob"
    And "alice" owns a document "spec.md"

  Scenario: Without a grant, another member has no access at all
    Then "mia" cannot read, comment on or list "spec.md"

  Scenario: A read link grants reading and nothing more
    When "alice" creates a read link and "mia" redeems it
    Then "mia" can read "spec.md"
    But "mia" cannot comment on "spec.md"
    And "mia" cannot upload a new version of "spec.md"

  Scenario: A comment link grants commenting but never resolving
    When "alice" creates a comment link and "mia" redeems it
    Then "mia" can comment on "spec.md"
    But "mia" cannot resolve comments on "spec.md"

  Scenario: The org admin holds edit without any grant
    Then "amir" can read and comment on "spec.md"
    And "amir" can resolve comments on "spec.md"

  Scenario: Directory mode grants a chosen member directly
    Given the organization switches to directory mode
    When "alice" grants "mia" comment access
    Then "mia" can comment on "spec.md"
    And creating share links is refused

  Scenario: A link from Acme is useless inside Globex
    When "alice" creates a comment link
    Then "bob" cannot redeem the token
    And "bob" cannot read "spec.md"

  Scenario: Revocation cuts access immediately
    Given the organization switches to directory mode
    And "alice" granted "mia" comment access
    When "alice" revokes the grant
    Then "mia" cannot read, comment on or list "spec.md"

  Scenario: The schema itself refuses an edit grant to an external guest
    Then inserting a share grant with permission "edit" and a guest email fails at the database

  Scenario: A free-tier org cannot create a share link at all
    Given a free-tier organization "Frugal" in link mode with owner "owner" and a document "notes.md"
    Then creating a read link is refused with "sharing_requires_paid_tier"
