Feature: Grantable edit rights
  ADR 0008: share grants carry read, comment or edit. An `edit` grant buys
  uploading new versions and nothing else — never delete, re-share, resolve or
  suggestion accept/reject, never by share link, and never for an external
  guest whatever the grant says.

  Background:
    Given organization "Acme" in directory mode with owner "alice", member "dev" and admin "amir"
    And "alice" owns a document "spec.md"

  Scenario: A member granted edit can push a new version
    When "alice" grants "dev" edit access
    Then "dev" can upload a new version of "spec.md"

  Scenario: A comment grant never buys a push
    When "alice" grants "dev" comment access
    Then "dev" cannot upload a new version of "spec.md"

  Scenario: Revoking the edit grant cuts the push immediately
    Given "alice" granted "dev" edit access
    When "alice" revokes the grant
    Then "dev" cannot upload a new version of "spec.md"

  Scenario: Edit stops at new versions — management stays with the owner
    Given "alice" granted "dev" edit access
    Then "dev" cannot resolve comments on "spec.md"
    # ADR 0014: edit inherits share, and delegation caps a grantor at their own
    # held level — an edit holder is uncapped, so "dev" may re-share up to and
    # including edit itself. Management (resolve/delete/review/suggestions)
    # stays owner-or-admin regardless.
    And "dev" can grant "amir" edit access to "spec.md"

  Scenario: An external guest is refused an edit grant outright
    When "alice" tries to grant guest "ext@partner.test" edit access
    Then the grant is refused as guest edit forbidden

  Scenario: The database refuses an edit grant carrying a guest email
    Then inserting a share grant with permission "edit" and a grantee email fails at the database

  Scenario: A guest with a forged edit grant still cannot push
    Given guest "ext@partner.test" holds a forged edit grant on "spec.md"
    Then the guest cannot upload a new version of "spec.md"
    And the guest's reported permission on "spec.md" is not edit
    And the guest's reported permission on "spec.md" is never edit

  Scenario: A link never confers edit, even when the row says so
    Given a link grant on "spec.md" carrying permission "edit"
    When "dev" redeems that link
    Then the redemption is refused
    And "dev" cannot upload a new version of "spec.md"
