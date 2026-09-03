Feature: Comments never lie
  Core Principle 2: a comment either points at the text it was written about,
  or it honestly says it cannot. Re-anchoring runs the exact → context →
  fuzzy pipeline and orphans anything below confidence 0.6 — it never guesses.
  Resolutions are cached per (comment, version).

  Background:
    Given organization "Acme" with user "alice"
    And "alice" has uploaded "design.md" containing a retry paragraph, a balances paragraph and a duplicated backoff line

  Scenario: A comment on unchanged text that moved sections re-anchors exactly
    Given "alice" commented on the balances paragraph
    When a new version moves the balances paragraph to the top
    Then the comment re-anchors with method "exact" and confidence 1

  Scenario: A comment on lightly edited text re-anchors fuzzily with honest confidence
    Given "alice" commented on the retry paragraph
    When a new version rewords the retry paragraph
    Then the comment re-anchors with method "fuzzy"
    And the confidence is at least 0.6 and below 1
    And the resolved range covers the reworded paragraph

  Scenario: A comment on deleted text becomes an orphan, never a guess
    Given "alice" commented on the retry paragraph
    When a new version deletes the retry paragraph entirely
    Then the comment resolves as an orphan with confidence below 0.6
    And the orphan has no resolved range

  Scenario: A comment on the second copy of a duplicated line re-anchors by context
    Given "alice" commented on the second backoff line
    When a new version keeps both backoff lines but edits around them
    Then the comment re-anchors with method "context"
    And the resolved range is the second backoff line

  Scenario: Resolutions are computed once and served from the cache
    Given "alice" commented on the retry paragraph
    And a new version rewords the retry paragraph
    When the threads are listed twice
    Then the resolution is cached in comment_anchor_resolutions after the first listing
    And the second listing does not recompute it
