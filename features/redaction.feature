Feature: No org data in telemetry
  Core Principle 3: logs, traces and metrics carry opaque IDs and
  operational metadata only. Document content, titles, names, emails and
  comment text must never appear in anything the telemetry port emits,
  whether the request came through the HTTP API or an MCP tool call.

  Scenario: Structured telemetry never contains document content or identity strings
    Given an organization with a user whose email is distinctive
    And that user uploads a document with a distinctive title and body secret
    And that user comments on the document with distinctive text
    And an MCP client searches for the document by its distinctive title
    Then no captured telemetry field contains the user's email
    And no captured telemetry field contains the document title
    And no captured telemetry field contains the document body secret
    And no captured telemetry field contains the comment text
