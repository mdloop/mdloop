Feature: Org invite/join flow
  Phase 15: joining an existing org happens two ways — an
  admin-sent invite (Free/Team) or enterprise SSO JIT provisioning
  (open/allowlist). Both enforce the seat ceiling (TierCeilings.maxCollaborators)
  the same way, deny-with-message on cap, never silent overage.

  Background:
    Given a team-tier organization "Acme" with admin "alice"

  Scenario: Sending an invite returns a token shown exactly once
    When "alice" invites "new@acme.test" as "member"
    Then the invite is pending for "new@acme.test"
    And the invite token hashes to the stored invite

  Scenario: Accepting a live invite joins the inviting org with its pre-set role
    Given "alice" invited "new@acme.test" as "admin"
    When the invitee signs in with that invite token
    Then they join "Acme" with role "admin"
    And the invite is marked accepted

  Scenario: An expired invite is rejected honestly
    Given "alice" invited "new@acme.test" as "member" that already expired
    When the invitee signs in with that invite token
    Then sign-in is refused with "invite_expired"

  Scenario: A revoked invite is rejected honestly
    Given "alice" invited "new@acme.test" as "member"
    And "alice" revokes that invite
    When the invitee signs in with that invite token
    Then sign-in is refused with "invite_revoked"

  Scenario: An already-accepted invite cannot be redeemed twice
    Given "alice" invited "new@acme.test" as "member"
    And the invitee already accepted that invite
    When a second sign-in attempts the same invite token
    Then sign-in is refused with "invite_already_used"

  Scenario: The free-tier seat ceiling blocks sending a new invite
    Given a free-tier organization "Frugal" with admin "owner"
    When "owner" invites "another@frugal.test" as "member"
    Then the invite send is refused with "seat_cap_reached"

  Scenario: Enterprise open mode auto-joins any verified SSO login
    Given an enterprise organization "Globex" in open provisioning mode with an SSO connection
    When "anyone@globex.test" signs in through that SSO connection
    Then they join "Globex" with role "member"

  Scenario: Enterprise allowlist mode rejects a non-listed email
    Given an enterprise organization "Initech" in allowlist provisioning mode with an SSO connection
    When "stranger@initech.test" signs in through that SSO connection
    Then sign-in is refused with "not_allowlisted"

  Scenario: Enterprise allowlist mode admits a listed email
    Given an enterprise organization "Initech" in allowlist provisioning mode with an SSO connection
    And "listed@initech.test" is on the allowlist
    When "listed@initech.test" signs in through that SSO connection
    Then they join "Initech" with role "member"

  Scenario: JIT auto-join on a free-tier org is blocked by the SSO tier gate, not the seat ceiling
    # Phase 33: SSO is Enterprise-only, enforced in code. The tier gate is
    # checked first in canJitJoin, before allowlist or seat-ceiling logic —
    # a free-tier org's JIT attempt refuses this way even when the seat
    # ceiling is ALSO already exhausted, proving which check actually wins.
    Given a free-tier organization "Bootstrap" in open provisioning mode with an SSO connection
    And "Bootstrap" already has 1 seat occupied by a member
    When "second@bootstrap.test" signs in through that SSO connection
    Then sign-in is refused with "sso_requires_enterprise_tier"
