Feature: MCP rate-limit parity
  Agents act as their owning user and draw from the same
  request budget; a rate-limited MCP tool call returns the identical typed
  error the HTTP API sends as 429 + Retry-After. A capability or error shape
  existing in one transport and not the other is a bug (CONSTITUTION §5).

  Three independent, AND'd windows — minute, day, month (2026-08-11 redesign)
  — replace the old minute+day pair and also absorb what used to be a
  separate upload-count quota (features/upload-quota.feature): month is sized
  to bound worst-case monthly cost against monthly billing, and day is
  deliberately retuned to stay below month (day = month/3 at every tier) so
  it remains a reachable, distinct circuit breaker for a single bad day
  rather than becoming dead code once month exists.

  Scenario: MCP tool calls beyond the budget return the identical typed error
    Given organization "Acme" on the free tier with an agent acting as "alice"
    When the agent calls tools past the free per-minute budget
    Then the tool result is the typed error "rate_limited" with a retry hint
    And tool calls succeed again once the budget refills

  Scenario: The budget is shared across replicas, not per-process
    Given organization "Acme" on the free tier with an agent acting as "bob"
    And two simulated MCP replicas, each with its own RateLimiterPort backed by the same Valkey store
    When "bob" calls tools on replica one until the budget is exhausted
    Then a call on replica two for the same user is also rate-limited
    And a call on replica two for a different user still succeeds

  Scenario: The daily cap still fires on its own, with the monthly budget untouched
    Given organization "Acme" on the free tier with an agent acting as "carol"
    And "carol" has already used her full daily budget but almost none of her monthly budget
    When the agent calls a tool
    Then the tool result is the typed error "rate_limited" with a retry hint under 24 hours

  Scenario: The monthly cap fires even with a fresh day and a full minute bucket
    Given organization "Acme" on the free tier with an agent acting as "dana"
    And "dana" has already used her full monthly budget but her daily budget just reset
    When the agent calls a tool
    Then the tool result is the typed error "rate_limited" with a retry hint near 30 days
