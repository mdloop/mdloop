Feature: Public Docs Hub publishing is home-org-admin-only; public reads need no session (ADR 0004)

  Publishing is the one deliberate bridge from the tenant model into the
  public store, gated on being an admin of the one configured home org — no
  new role concept, no self-serve for other orgs. Once published, a doc is
  reachable with no session, no tenant context, no actor at all. These are
  money paths (CONSTITUTION §3/§8.2: sharing rules + tenant isolation).

  Background:
    Given an organization "Acme" configured as the Public Docs Hub home org, with admin "alice"
    And "alice" uploaded a document "runbook.md" with content "Contains a rollback procedure for production deploys."

  Scenario: A home-org admin publishes a document to the public hub
    When "alice" publishes "runbook.md" as slug "deploy-runbook"
    Then the public hub has a doc at slug "deploy-runbook"

  Scenario: A member of the home org cannot publish
    Given a member "carol" in "Acme"
    When "carol" publishes "runbook.md" as slug "deploy-runbook"
    Then publishing is forbidden

  Scenario: An admin of a different org cannot publish
    Given an organization "Globex" with admin "dave"
    When "dave" publishes "runbook.md" as slug "deploy-runbook"
    Then publishing is forbidden

  Scenario: A guest cannot publish
    Given a guest "gina" in "Acme"
    When "gina" publishes "runbook.md" as slug "deploy-runbook"
    Then publishing is forbidden

  Scenario: A published doc is publicly readable with no session at all
    Given "alice" published "runbook.md" as slug "deploy-runbook"
    When an anonymous reader fetches the public doc "deploy-runbook"
    Then the public doc "deploy-runbook" is returned

  Scenario: A slug that was never published is not found
    When an anonymous reader fetches the public doc "never-published"
    Then the public doc is not found

  Scenario: An unpublished slug is not found
    Given "alice" published "runbook.md" as slug "deploy-runbook"
    And "alice" unpublishes "deploy-runbook"
    When an anonymous reader fetches the public doc "deploy-runbook"
    Then the public doc is not found

  Scenario: Re-publishing the same slug creates a new snapshot without changing the slug
    Given "alice" published "runbook.md" as slug "deploy-runbook"
    When "alice" republishes "runbook.md" as slug "deploy-runbook" with new content "Now with a canary rollout section."
    Then the public doc "deploy-runbook" keeps its id but gets a new seq and content

  Scenario: Unpublishing removes the doc from public read and public search
    Given "alice" published "runbook.md" as slug "deploy-runbook"
    When "alice" unpublishes "deploy-runbook"
    Then an anonymous reader fetching the public doc "deploy-runbook" gets not-found
    And searching the public hub for "rollback" returns nothing
