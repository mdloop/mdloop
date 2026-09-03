Feature: Organization usage against tier ceilings
  Phase 39.B: a read-only usage snapshot — active documents, seats, storage
  and external guests, each against the org's tier ceiling from
  `packages/domain/src/tier.ts`'s `TIER_PROFILES`. `null` means the tier has no ceiling for
  that dimension. This is a money path (quota, CONSTITUTION §8): the numbers
  must be exact and must never cross an organization boundary — the storage
  sum in particular is a new tenant-scoped `document_versions` read (RLS via
  `withTenant()`), not the operator directory's cross-org equivalent.

  Background:
    Given a team-tier organization "Acme" with admin "alice"
    And a team-tier organization "Globex" with admin "gina"

  Scenario: Usage counts documents, seats, storage and guests for the calling org only
    Given "alice" has uploaded 2 documents to "Acme"
    And "bob" has joined "Acme" as a member
    And "alice" has shared a document with external guest "carol@ext.test"
    And "gina" has uploaded 5 documents to "Globex"
    When "alice" reads org usage
    Then the usage shows 2 active documents against the team document ceiling
    And the usage shows 2 members against an unlimited seat ceiling
    And the usage shows the exact bytes uploaded as storage used
    And the usage shows 1 active external guest against the team guest ceiling

  Scenario: A free-tier organization reports finite, non-null ceilings
    Given a free-tier organization "Indie" with admin "sam"
    When "sam" reads org usage
    Then the usage shows the free-tier document, seat and guest ceilings
