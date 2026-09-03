Feature: Agent publish → review loop with no repo
  CONSTITUTION §5: the HTTP API and the MCP server are thin transports over the
  same application services, so a capability existing in one and not the other
  is a bug, not a roadmap item. Every other piece of framing in this repo — the
  sync CLI, the vorlyn-sync skill — describes an agent working inside a
  checkout, which makes it easy to assume a repo is load-bearing. It is not. An
  agent holding nothing but an API key can publish a document and drive the
  whole review loop: `UploadSource` has always included `mcp`, `Document.path`
  is optional display metadata (Phase 29) that no upload or review path
  requires, and sign-off keys off DocumentId + UserId alone. Prose companions:
  docs/ARCHITECTURE.md §9.1 and claude-plugin/skills/vorlyn-review/SKILL.md.

  Background:
    Given an organization "Acme" with human admin "alice" and agent user "atlas"
    And the agent holds only "atlas"'s API key — no repo, no checkout, no CLI

  Scenario: An agent with no local state publishes a fresh document
    When the agent uploads "policy.md" with no document id and no repo path
    Then the document exists with source "mcp"
    And the document carries no repo path
    And the version is attributed to the agent's API key

  Scenario: The agent drives publish, review, revision and sign-off over MCP alone
    Given the agent has published "policy.md"
    When the agent requests "alice" as a reviewer on "policy.md"
    Then the review status the agent polls is "in_review"
    When "alice" comments on "policy.md" and submits verdict "changes_requested"
    Then the agent's feedback bundle carries "alice"'s open comment and sign-off status "changes_requested"
    When the agent uploads a revision of "policy.md" by document id alone
    And the agent replies to "alice"'s comment and resolves the thread
    Then the review status the agent polls is back to "in_review"
    When "alice" submits verdict "approved" on "policy.md"
    Then the review status the agent polls is "approved"
    And every version of "policy.md" has source "mcp" and the document still has no repo path

  Scenario: Document identity is the document id, never a path
    Given the agent has published "policy.md"
    When the agent publishes a second document "runbook.md", also with no repo path
    Then both documents exist with distinct ids and no repo path
    And the agent reads each document's review state by id alone

  Scenario: Tenant isolation holds for an agent key from another organization
    Given the agent has published "policy.md"
    Then an agent key issued in a different organization cannot read or revise "policy.md"
