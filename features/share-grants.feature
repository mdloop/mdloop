Feature: Grantable share rights
  ADR 0014: a new `share` rung sits between `comment` and `edit` on the
  permission lattice, and `edit` inherits it. `share` buys creating,
  listing and revoking grants on the document — nothing else: never
  uploading a new version, never resolving, never delete/archive/move,
  never review requests, never suggestion accept/reject, which all stay
  owner-or-org-admin exactly as before. Delegation is capped at the
  grantor's own held level (`canDelegate`) unless the grantor is the owner
  or an org admin, who are uncapped. Edit grants have their own money path
  in features/edit-grants.feature; this feature is share's.

  Background:
    Given organization "Acme" in directory mode with owner "alice", member "dev" and admin "amir"
    And "alice" owns a document "spec.md"

  Scenario: A share holder can grant read, comment, and share to others
    Given "alice" granted "dev" share access
    Then "dev" can grant "amir" read access to "spec.md"
    And "dev" can grant "amir" comment access to "spec.md"
    And "dev" can grant "amir" share access to "spec.md"

  Scenario: A share holder cannot grant edit — delegation is capped at the grantor's own level
    Given "alice" granted "dev" share access
    Then "dev" cannot grant "amir" edit access to "spec.md"
    And the refusal is "grant_exceeds_own_permission"

  Scenario: An edit holder can grant share and can grant edit — edit inherits share and is uncapped
    Given "alice" granted "dev" edit access
    Then "dev" can grant "amir" share access to "spec.md"
    And "dev" can grant "amir" edit access to "spec.md"

  Scenario: A share holder can revoke a grant they themselves created
    Given "alice" granted "dev" share access
    And "dev" granted "amir" read access to "spec.md"
    When "dev" revokes the grant they created
    Then the revoke succeeds

  Scenario: A share holder cannot revoke a grant someone else created, including the owner's own grant to a third party
    Given "alice" granted "dev" share access
    And "alice" granted "amir" read access to "spec.md"
    When "dev" attempts to revoke "alice"'s grant to "amir"
    Then the revoke is refused as forbidden

  Scenario: Share buys no upload
    Given "alice" granted "dev" share access
    Then "dev" cannot upload a new version of "spec.md"

  Scenario: Share stops at grant management — resolving comments stays with the owner
    Given "alice" granted "dev" share access
    Then "dev" cannot resolve comments on "spec.md"

  Scenario: The database refuses a share grant carrying a guest email
    Then inserting a share grant with permission "share" and a grantee email fails at the database

  Scenario: A link never confers share, even when the row says so
    Given a link grant on "spec.md" carrying permission "share"
    When "dev" redeems that link
    Then the redemption is refused
    And "dev" cannot upload a new version of "spec.md"
