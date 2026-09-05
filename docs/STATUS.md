# Status

What exists in this repository, what is deliberately absent, and where the seams are. This is the
document to read before concluding something is missing — in an open core, a gap and a decision look
identical from the outside, and most of what is not here is not here on purpose.

Companion to `docs/RISKS.md` (what could bite) and `CONSTITUTION.md` §7 (the boundary rule that
decides what belongs here at all).

Last reviewed: 2026-09-04.

## Shape

Nine packages, all core. `shared` (DTOs) → `domain` (pure logic, zero framework imports) → `app`
(use-cases + ports) ← `persistence` (Postgres repositories, migrations, storage/telemetry adapters);
`api`, `mcp`, `cli` and `web` are transports over `app`; `jobs` is a standalone scheduler process.
`docs/ARCHITECTURE.md` has the diagram and the data model.

- **33 migrations** (`0001`–`0033`), expand-only and forward-only (ADR 0006). Never renumber one —
  a prior migration is presumed already applied somewhere.
- **20 MCP tools**, generated into `docs/reference/mcp-reference.md` by `pnpm gen:mcp`; `pnpm docs:check`
  fails if the committed output drifts from the server source. `create_project` (any org member,
  names not unique — callers should `list_projects` first to reuse rather than duplicate) is the
  newest: `mdloop link`/`mdloop open` use it to give each folder its own auto-provisioned
  project against a local instance instead of sharing one machine-wide default.
- **`mdloop serve start|stop|status`** — a detached, persistent local instance (survives closing
  the terminal that started it), so multiple folders/projects on one machine share a single
  embedded Postgres + server instead of each `mdloop open` fighting over the same ports.
  `mdloop open` attaches to one that's already running instead of starting a second. Both the API
  and MCP embedded children default to a fixed port pair (`packages/cli/src/local-instance.ts`'s
  `DEFAULT_API_PORT`/`DEFAULT_MCP_PORT`, not 3000/3001 — too common a dev-server default to
  hardcode, but still the same two ports every restart, so a document link stays valid across one
  — overridable via `PORT`/`MCP_PORT` if that pair is ever taken); every command that talks to a
  local endpoint re-resolves the live port from `<data dir>/instance.json` rather than trusting a
  value that could go stale across a restart. The Claude Code plugin (`claude-plugin/`) drives all of this on its own via a
  `SessionStart` hook (`mdloop-ensure.sh`) — installing the plugin is the opt-in, `MDLOOP_AUTO=0`
  the opt-out. The hook also registers the running instance with Claude Code's own MCP client
  (`claude mcp add`, `--scope local`), local endpoints only — until this, installing the plugin
  alone never made `get_feedback_bundle` and the rest of the MCP tool set reachable at all, despite
  `mdloop-review`'s skill assuming they were.
- **23 Gherkin feature files** in `features/`, covering the money paths CONSTITUTION §3 requires:
  tenant isolation, quota, retention, permissions, sharing, guest sharing, rate-limit parity,
  redaction, comment search, agent publish→review.
- **13 ADRs** in `docs/adr/` (numbers are stable identifiers, not a dense sequence — retired ADRs
  are removed, not renumbered).

## Verified, with real coverage floors

`pnpm verify` runs lint, format, typecheck, dependency-cruiser boundaries, `pnpm audit`, the test
suite with per-package coverage thresholds, a brand check, and a generated-docs drift check
(`pnpm docs:check` — MCP/CLI reference docs stay in sync with the server source they're generated
from). The floors are not aspirational — the run fails below them:

| Package                        | Floor (lines/branches/functions/statements) |
| ------------------------------ | ------------------------------------------- |
| `domain`, `app`                | 95 / 95 / 95 / 95 (CONSTITUTION §3)         |
| `api`                          | 85 / 78 / 88 / 85                           |
| `persistence`                  | 72 / 84 / 82 / 72                           |
| `mcp`                          | 80 / 62 / 80 / 80                           |
| `web`, `cli`, `jobs`, `shared` | unfloored — see below                       |

The non-95 floors are each that package's measured actual minus a ~4–6 point margin, chosen so the
gate bites, not so it passes. Ratchet them up as coverage improves; re-measure with
`pnpm exec vitest run --coverage --coverage.include='packages/<pkg>/src/**' --coverage.reporter=text-summary`.

`web`, `cli`, `jobs` and `shared` carry no floor. That is an open question rather than a claim of
quality: `web` leans on Playwright, `cli`/`jobs` are thin process wiring, and no convention has been
settled for how much of them is meaningfully unit-testable. Tracked in `docs/RISKS.md`.

## Deliberately absent

None of this is a gap. Adding any of it back needs an argument against CONSTITUTION §7 first.

| Absent                                    | Why                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Billing, payment providers, subscriptions | Not a port, not a stub, not a null object — the concept simply does not appear (CONSTITUTION §7).    |
| Cross-org operator/staff console          | A self-hoster runs one org and has no staff to give cross-tenant reach.                              |
| Cloud IaC, deploy and DR scripting        | A deployment brings its own. This repo ships a Dockerfile and a compose file, not a cloud account.   |
| Marketing site                            | Not a concept the core needs.                                                                        |
| Prices, tiers-as-money                    | The tier **lattice** is core and real (`packages/domain/src/tier.ts`); attaching money to it is not. |
| A production-readiness checklist          | This repo ships a core, not a running service (CONSTITUTION §8.6). The operator owns that gate.      |

One further exception, not residue from a removed feature but a genuine gray area on the §7 test:

- **`docs/authkit/` (two SVGs + a CSS file) and `docs/authkit-branding.md`** are the version-controlled
  record of what to paste into the WorkOS Dashboard's AuthKit branding editor — logo, colors, custom
  CSS — because the dashboard itself has no history or diff. Not consumed by any build; nothing in
  `packages/` reads these paths. Kept rather than moved out because, unlike `website/`/`infra/`, this
  genuinely documents a step in this core's own auth story (CONSTITUTION §2 pins hosted AuthKit) —
  it just happens to live in a dashboard instead of code. Revisit if a second hosted-auth branding
  target is ever added and this stops being a one-off.

Two known, deliberate exceptions where residue from a removed feature is still visible, both
because migrations are never renumbered:

- `Organization.subscriptionStatus` / `billingCustomerId` columns from `0006_billing.sql`. Inert
  here; nothing reads them.
- `0027_operator_admin.sql` creates `operators` and `operator_audit_log`, and `0028`/`0029` add an
  index and grants for the same feature. A self-hosted instance provisions two tables it will never
  use. Documented rather than removed — see `docs/RISKS.md`.

## Seams a deployment extends through

These are public API. Changing one is a breaking change to a contract someone has pinned.

- **`ServerExtension`** (`packages/api/src/server-extension.ts`) — three registration positions
  differing in which core guards have already run: `registerPublic` (inside `/api`, sessionless —
  provider webhooks, alternate logins), `registerAuthenticated` (inside the customer session scope,
  `req.actor` populated), `registerIsolated` (its own encapsulated scope, for a surface that
  authenticates itself against a different identity). The core owns placement deliberately: an
  extension cannot accidentally register outside the session guard when it meant to be inside it.
  `ExtensionContext` is an enumerated subset of `ServerDeps`, not `ServerDeps` itself, so adding a
  core dependency cannot silently widen a public contract.
- **`SeatSyncPort`** (`packages/app/src/ports/seat-sync.port.ts`) — `onSeatsChanged(org,
humanMemberCount)`, defaulting to `NoopSeatSync`. The core states a headcount fact and stops.
- **`ExtraSweep`** (`packages/jobs`) — a deployment-supplied job run inside the core's own sweep
  wrapper, so it inherits the same telemetry event and the same fault isolation. A failing extra
  sweep cannot take the GDPR sweeps down.
- **Adapter ports** — `StoragePort` (filesystem, S3, S3-compatible), `AuthPort`, `EmailPort`
  (logging noop, SMTP), `TelemetryPort`, `RateLimiterPort` (in-process, Redis), `BlobUrlPort`,
  `OAuthVerifierPort`, `ErasureLogPort`, `OrganizationLifecyclePort`.
- **Composition-root exports** — `configFromEnv`, `jobsEnvFromEnv`, the request helpers
  `requireAdmin`/`actorOf`, and the api test-support session codec, so a deployment writes its own
  entrypoint without re-implementing an authorization check or a second env parser.

## Known incomplete

Honest state, not a roadmap commitment.

- **MCP OAuth (ADR 0013)** is code-complete but inert until a deployment registers a Resource
  Indicator with its identity provider. API keys are the working path.
- **`mdloop serve`'s liveness check has no positive identity signal.** It confirms a recorded pid
  is alive and something answers `/readyz` on the recorded port, but not that the two are the same
  process a squatter couldn't imitate. Real on a single-user local machine only in the sense that
  nothing else there is likely to be listening on that exact ephemeral port; a `/healthz` returning
  an instance id would close this properly and hasn't been built yet.
- **`BlobUrlPort`** has two adapters and no production caller — the API proxies blob bytes directly.
- **No cross-instance connection pooling.** `instances × DB_POOL_MAX` does not hold past a handful
  of replicas; a transaction-mode pooler is needed in front for real scale-out.
- **Non-markdown artifacts** are out of scope by decision, not oversight.
- **Notifications/webhooks** are absent by decision. `EmailPort`'s only wired use is org invites,
  and its default adapter is a logging noop.
