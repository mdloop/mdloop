# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## A note on versioning

`mdloop` — the CLI's local, single-user path (`mdloop open`/`mdloop serve`) — is the npm package
for that half; self-hosting a real team instance, the extension seams, and running the API/MCP
servers standalone aren't npm-packaged, so **a commit SHA is still the unit of consumption** there.
This file tracks notable changes since the repository's own history began, so there is one place to
read "what changed" regardless of how you consume it.

## [Unreleased]

## [0.1.0] - 2026-09-04

### Added

- `ServerExtension` (`packages/api/src/server-extension.ts`): the designed seam a deployment uses
  to register its own routes at one of three positions relative to the core's session guard —
  `registerPublic`, `registerAuthenticated`, `registerIsolated`. `ExtensionContext` is an enumerated
  subset of `ServerDeps`, not `ServerDeps` itself.
- `SeatSyncPort` (`packages/app/src/ports/seat-sync.port.ts`): `onSeatsChanged(org,
humanMemberCount)`, defaulting to a no-op. The core's one billing-free way to state a headcount
  fact to a deployment, without a billing concept anywhere in the core.
- `ExtraSweep` seam in `packages/jobs`, plus a DB-aware extensions factory in api test-support, so a
  deployment-supplied job runs inside the core's own sweep wrapper and inherits its telemetry and
  fault isolation.
- A deployment can now name its own telemetry events, and export the organizations row mapper, as
  further extension seams for a composition root built outside this repository.
- `create_project` MCP tool (`packages/mcp/src/server.ts`) — any org member, project names are not
  unique at any layer, so callers should `list_projects` first to reuse rather than duplicate.
- `mdloop serve start|stop|status`: a detached, persistent local instance (survives closing the
  terminal that started it), so multiple folders on one machine share one embedded Postgres +
  server instead of each `mdloop open` fighting over the same ports. `mdloop open` attaches to
  one that's already running instead of starting a second. Both embedded children default to a
  fixed port pair (`packages/cli/src/local-instance.ts`'s `DEFAULT_API_PORT`/`DEFAULT_MCP_PORT`) —
  never 3000/3001, too common a dev-server default to hardcode, but still fixed rather than
  freshly OS-assigned per boot, so a document link stays valid across a restart instead of moving
  with each one; `PORT`/`MCP_PORT` override it if that pair is ever taken by something else —
  and every command re-resolves the live port from `<data dir>/instance.json` rather than trusting
  a value that could go stale across a restart.
- `mdloop link`/`mdloop open` auto-provision a project named after the folder (reusing one that
  already exists by name, or via a persisted folder→project mapping) instead of sharing one
  machine-wide default project — `mdloop projects list` shows the mapping. An explicit `--project`
  always overrides. The Claude Code plugin drives all of this on its own via a new `SessionStart`
  hook (`mdloop-ensure.sh`) — installing the plugin is the opt-in, `MDLOOP_AUTO=0` the opt-out.
- `upload_document`/`request_review` responses now carry a `url` straight to the document, so an
  agent can hand the reviewer a live link instead of leaving them to find it. Present whenever a
  `WEB_APP_URL` is known — configured directly for a real deployment (`packages/mcp/src/main.ts`,
  `stdio-main.ts`), or discovered automatically for `mdloop open`/`mdloop serve`'s embedded MCP
  process from its sibling API child's announced port. Omitted, never guessed, when neither applies.
  On that same local/embedded instance, `request_review` also opens the reviewer's browser straight
  to the document — a single local user IS the reviewer there, so this is the zero-click default,
  not an opt-in; `MDLOOP_AUTO_OPEN_REVIEW=0` turns it off. Deliberately scoped to `request_review`
  only, never `upload_document`, so an ordinary editing session doesn't pop a tab per revision.

### Fixed

- The Claude Code plugin (`claude-plugin/`, now `0.3.0`) never actually registered an MCP server:
  `hooks/mdloop-ensure.sh` started the local server and linked the folder, but nothing ever told
  Claude Code's own MCP client an endpoint existed, so `mdloop-review`'s tools were unreachable
  despite the skill and plugin docs describing them as available with "nothing else to do." The
  hook now runs `claude mcp add` itself (`--scope local`, so the token lands in `~/.claude.json`,
  never a committed `.mcp.json`), gated behind a cheap existence check so every session after the
  first repo link costs one read-only `claude mcp list` call and nothing else. Local endpoints
  only — a remote/team instance's MCP URL isn't derivable from anything `mdloop link` writes to
  disk, so that path still ends in one manual `claude mcp add`. See `docs/RISKS.md`.
- `mdloop open` — the zero-install path — never actually worked before this history begins: a
  PGlite socket cap and a 404 on the SPA route on a fresh clone are both fixed. (At the time this
  was fixed, nothing here was published to npm yet, so verification was via
  `node packages/cli/dist/main.js open`, built from source. `npx mdloop open` is the real command
  now — see `README.md`/`SELF_HOSTING.md`.)
- The org write lock had a gap: `uploadNewDocument` was not covered by it.
- Three MCP tool descriptions had dropped `org_read_only` from their returned shape; restored.
- CI had never run a single job in this repository's history: `ci.yml` used
  `github.event.pull_request.commits + 1`, and the GitHub Actions expression language has no
  arithmetic operators, so the workflow failed to parse on every run. Fixed, and `pnpm verify`'s CI
  job was given a Valkey service so the rate-limiter tests can actually run there.
