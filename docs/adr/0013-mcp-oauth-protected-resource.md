# ADR 0013 — MCP OAuth: protected resource only, no authorization server

- Status: Accepted (2026-08-09, per CONSTITUTION §8.5 — reverses the original Phase 11 spec's
  framing, so it gets a written "why" for future readers)
- Date: 2026-08-09
- Deciders: Jasdeep (product)
- Relates to: `packages/app/src/ports/auth.port.ts` (the same
  provider-seam discipline); ADR 0002 (session-vs-key `Actor` shape); ADR 0008 (grantable
  `edit` — same "guest never gets an agent surface" containment reused here)

## Context

MCP OAuth for interactive clients (Claude Desktop and similar, as opposed to the existing headless
per-user API keys) was deferred indefinitely 2026-07-14: "API keys cover every agent surface, OAuth
only removes key-copying friction." It was un-deferred 2026-08-09 once WorkOS was configured for
real against staging and interactive-client demand became concrete. The original spec (written back
in July, pre-2026-08-09) assumed Vorlyn would have to build its own OAuth 2.1 authorization server
on top of `packages/mcp`'s HTTP
transport: new `/authorize` and `/token` endpoints, dynamic client registration, refresh-token
issuance and rotation — a full AS, hand-rolled.

Re-checking WorkOS's current AuthKit-for-MCP docs while picking this phase back up found that
assumption is now stale. **AuthKit can act as the complete MCP OAuth 2.1 authorization server
directly** once a Resource Indicator is configured on the WorkOS dashboard: DCR, the newer
CIMD client-registration flow, `/authorize`, `/token`, and refresh-token handling are all
WorkOS's problem, not ours. What `packages/mcp` actually needs to become is a **protected
resource** (RFC 9728): serve metadata pointing at AuthKit as the authorization server, and
validate the JWTs AuthKit issues. That is a materially smaller and safer build than the
original spec — fewer secrets to hold, no token-issuance code to get subtly wrong, no refresh-
token storage to protect — and is what this ADR adopts.

## Decision

**No new authorization server is built, now or as a later phase of this work.** `packages/mcp`
gains a second Bearer-token verification path alongside the existing per-user API key path,
dispatched by token shape:

- `vorlyn_`-prefixed → the existing `actorForApiKey` path, completely unchanged. This stays
  the primary path for headless/agent use (Claude Code, cron jobs, scripts) — Phase 11 does
  not touch it.
- anything else → a new `actorForOAuthToken` path: verify the token as a WorkOS AuthKit-issued
  OAuth access token (signature via AuthKit's live JWKS, issuer, audience, expiry, algorithm
  restricted to an explicit allowlist), then resolve its `sub` claim to a Vorlyn user via the
  same `DirectoryRepository` the rest of the identity layer already uses.

Both paths resolve to the exact same `Actor` shape and flow into the exact same
`buildMcpServer(deps, actor)` — no MCP tool changes at all. An OAuth-authenticated actor never
carries an `apiKeyId` (it is a human at an interactive client, not an API key), matching ADR
0002's existing rule that a session-authenticated actor's `apiKeyId` is always absent.

The seam is a new seven-line port, `OAuthTokenVerifierPort`, mirroring `AuthPort`'s "provider
types never leak past this shape" discipline. `packages/mcp` implements it against AuthKit's
JWKS (`WorkosJwtVerifier`, built on `jose`); nothing about WorkOS specifically — client
libraries, response shapes, error codes — is visible anywhere above that one adapter.

`packages/mcp` serves `GET /.well-known/oauth-protected-resource` (RFC 9728) pointing at
AuthKit as the `authorization_servers` entry, and sends a `WWW-Authenticate` challenge header
on a 401 so a compliant MCP client can discover where to authenticate. Four new env vars,
optional as a group (`WORKOS_CLIENT_ID`, `WORKOS_AUTHKIT_ISSUER`, `WORKOS_JWKS_URL` with a
computed default, `MCP_RESOURCE_INDICATOR`), gate whether this path is active at all — unset
means MCP OAuth is simply off and only the API-key path works, the same degrade-gracefully
convention this codebase already uses for `REDIS_URL`.

Two things are deliberately **not** part of this decision's build, tracked as fast-follows:
enabling CIMD/DCR and registering the Resource Indicator on the WorkOS dashboard (a manual
step, like the existing WorkOS API key setup), and a deployment wiring the new env vars to
wherever it runs `packages/mcp`. Both need the code shipped first to have anything to point at.

## Consequences

- **Smaller, safer surface.** No token-issuance secrets, no refresh-token storage, no
  authorization-code or PKCE handling anywhere in this codebase. The only new cryptographic
  operation is verifying a signature against a JWKS `packages/mcp` doesn't control the private
  half of — the same trust shape as `CloudFrontSignedBlobUrl` in reverse (there we hold the
  private key; here we hold no key at all, only the public JWKS).
- **Guest containment gets a second, independent enforcement point.** `actorForOAuthToken`
  refuses a guest exactly like `actorForApiKey` does, sharing one helper (`isAgentSurfaceRole`)
  so the refusal has a single source of truth rather than two copies that could drift.
- **AuthKit is now a hard dependency for the interactive-client path.** If AuthKit's JWKS
  endpoint is unreachable, `WorkosJwtVerifier.verify` fails closed (returns `undefined`,
  never throws) — an outage there degrades to "OAuth clients can't authenticate," not to a
  security hole. The API-key path is entirely unaffected, since it never touches AuthKit.
- **Two more manual/infra steps remain before this is live in any real environment**: the
  WorkOS dashboard configuration and a deployment's own env-var wiring. Until both land, the code is
  correct and tested but inert — `WORKOS_CLIENT_ID` etc. stay unset in every deployed
  environment, so every request still resolves through the API-key path only.

## Alternatives considered

- **Build the full authorization server as originally spec'd.** Rejected: strictly more code,
  more secrets, more attack surface, and solves a problem (client registration, token
  issuance) WorkOS already solves for us once a Resource Indicator exists. Nothing about
  Vorlyn's own requirements needs Vorlyn to be the AS.
- **Add `@workos-inc/node` to `packages/mcp` for its `getJwksUrl(clientId)` helper.** Rejected:
  that method is a one-line string template
  (`` `${baseURL}/sso/jwks/${clientId}` ``, confirmed in the SDK's own source) — not worth a
  whole dependency when `env-config.ts` can compute the same default directly.
- **Put `WorkosJwtVerifier` in `packages/persistence` instead of `packages/mcp`.**
  Rejected: `packages/persistence` has zero auth-related code today, and nothing but
  `packages/mcp` will ever consume this adapter — mirrors how `packages/api` hosts
  `WorkosAuthAdapter` locally for the same reason.
