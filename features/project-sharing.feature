Feature: Project-level share grants
  ADR 0014 (Phase 42): a grant on a project confers its permission on every
  document currently in that project — membership is resolved live at read
  time, never snapshotted at grant time. Deliberately ORG-ADMIN ONLY, unlike
  document sharing, never the project's own creator: a member could otherwise
  create an empty project, wait for someone else's document to land in it,
  then share the project and hand a third party access to a document they
  could never have shared directly — admin-only forecloses that escalation.
  Named-user grants only: never a link, never a guest above read/comment.

  Background:
    Given organization "Acme" with admin "amir", member "dev" and member "kim"
    And "dev" created a project "Runbooks"
    And "dev" filed a document "spec.md" in "Runbooks"

  Scenario: A project grant confers its permission on every document currently in the project
    When "amir" grants "kim" comment access to project "Runbooks"
    Then "kim" can comment on "spec.md"

  Scenario: Moving a document out of the project drops the access the project grant was providing
    Given "amir" granted "kim" comment access to project "Runbooks"
    When "dev" moves "spec.md" out of "Runbooks"
    Then "kim" cannot read, comment on or list "spec.md"

  Scenario: A document added to the project after the grant was created still picks it up
    Given "amir" granted "kim" comment access to project "Runbooks"
    When "dev" files a new document "notes.md" in "Runbooks"
    Then "kim" can comment on "notes.md"

  Scenario: Deleting the project removes the grant — no dangling row
    Given "amir" granted "kim" comment access to project "Runbooks"
    When "amir" deletes the project "Runbooks"
    Then the project grant no longer exists in the database

  Scenario: A non-admin org member cannot create, list, or revoke a project grant, not even the project's own creator
    Then "dev" cannot grant "kim" access to project "Runbooks"
    And "dev" cannot list the grants on project "Runbooks"
    And "dev" cannot revoke a grant on project "Runbooks"

  Scenario: A guest cannot receive a share or edit project grant; read and comment are still fine
    Then granting a guest edit access to project "Runbooks" is refused as guest edit forbidden
    And granting a guest share access to project "Runbooks" is refused as guest edit forbidden
    And granting a guest read access to project "Runbooks" succeeds

  Scenario: A project grant never appears on a document's own share list
    Given "amir" granted "kim" comment access to project "Runbooks"
    Then "spec.md"'s own share list is empty
