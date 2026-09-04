Feature: External guest sharing
  Phase 18: a doc owner emails time-limited read/comment access to someone
  outside the org. A guest is a users row with role 'guest' behind an
  ordinary expiring grant, so tenant isolation and the read|comment schema
  cap apply unchanged. Expiry bites at permission-check time — no sweep.

  Background:
    Given a team-tier organization "Acme" with owner "alice" and a document "design.md"

  Scenario: A guest share grants access until it expires
    When "alice" shares "design.md" with guest "ext@client.test" for 7 days
    Then the guest token redeems to a guest identity for "design.md"
    And after the expiry passes the guest grant no longer grants access

  Scenario: Turning external sharing off blocks creating and redeeming
    Given "alice" shared "design.md" with guest "ext@client.test" for 7 days
    When the org turns external sharing off
    Then sharing to another guest is refused with "external_sharing_disabled"
    And redeeming the existing guest token is refused

  Scenario: Free tier refuses guest sharing outright
    Given a free-tier organization "Frugal" with owner "owner" and a document "notes.md"
    When "owner" shares "notes.md" with guest "first@client.test" for 7 days
    Then guest sharing is refused with "guest_cap_exceeded"

  Scenario: Re-sharing to the same email extends expiry instead of erroring
    Given "alice" shared "design.md" with 3 distinct guests
    When "alice" re-shares "design.md" with the first guest for 7 days
    Then the share succeeds and the guest count stays 3

  Scenario: A guest sees only the granted document
    Given a second document "secret.md" in "Acme"
    And "alice" shared "design.md" with guest "ext@client.test" for 7 days
    Then the guest can list exactly one document, "design.md"

  Scenario: A guest can never hold more than comment permission
    Given "alice" shared "design.md" with guest "ext@client.test" for 7 days
    Then the guest's effective permission on "design.md" is "comment"

  Scenario: A guest can never hold an agent surface
    Given "alice" shared "design.md" with guest "ext@client.test" for 7 days
    Then the guest cannot create an API key
    And a key whose owner became a guest resolves to no MCP actor
    And a guest identity cannot resolve via an OAuth token either
