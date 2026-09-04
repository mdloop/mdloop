Feature: Tier caps and rate limits
  `packages/domain/src/tier.ts`: a tier is a ceiling profile enforced in the domain layer.
  Free: 100 active docs, 100 comments per doc, 60 requests/min (Phase 33).
  Team: 5,000 docs fair-use, unlimited comments, 600 requests/min. Caps block
  the action with a typed error — they never delete anything. Rate limits
  return the identical typed error over HTTP (429 + Retry-After) and MCP
  (parity).

  Background:
    Given organization "Acme" with user "alice"

  Scenario: The free tier blocks the 101st active document
    Given the organization is on the free tier
    And "alice" has 100 active documents
    Then uploading a new document is rejected with "doc_cap_exceeded"
    When "alice" deletes one document
    Then uploading a new document succeeds

  Scenario: The team tier is not bound by the free doc cap
    Given the organization is on the team tier
    And "alice" has 10 active documents
    Then uploading a new document succeeds

  Scenario: The per-project cap blocks independently of the org-wide cap
    Given the organization is on the team tier
    And "alice" has a project "Big Project" with 500 active documents
    Then uploading a new document into "Big Project" is rejected with "project_doc_cap_exceeded"
    But uploading a new document outside any project succeeds

  Scenario: The free tier blocks the 101st comment on a document
    Given the organization is on the free tier
    And "alice" has a document with 100 comments
    Then commenting again is rejected with "comment_cap_exceeded"

  Scenario: Paid tiers never cap comments
    Given the organization is on the team tier
    And "alice" has a document with 100 comments
    Then commenting again succeeds

  Scenario: The version cap blocks the append past the live-version ceiling
    Given the organization is on the free tier
    And "alice" has a document at the free live-version ceiling
    Then uploading a new version is rejected with "version_cap_exceeded"

  Scenario: A downgrade never deletes anything, it only blocks new creates
    Given the organization is on the team tier
    And "alice" has 101 active documents
    When the organization is downgraded to the free tier
    Then all 101 documents are still readable
    And uploading a new document is rejected with "doc_cap_exceeded"

  Scenario: Two concurrent creates at the ceiling admit exactly one
    Given the organization is on the free tier
    And "alice" has a document with 99 comments
    When two comments race for the last free slot
    Then exactly one comment is accepted and one is rejected with "comment_cap_exceeded"

  Scenario: HTTP requests beyond the per-minute budget get 429 with Retry-After
    Given the organization is on the free tier
    When "alice" sends requests past the free per-minute budget over HTTP
    Then the API responds 429 with a Retry-After header and error "rate_limited"

