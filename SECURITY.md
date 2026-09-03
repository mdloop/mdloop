# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability.

Instead, use [GitHub Security Advisories](../../security/advisories/new) to report it privately.
Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is ideal)
- The version/commit you tested against

We'll acknowledge the report and work with you on a fix and coordinated disclosure timeline.

## Scope

This covers the code in this repository: the review engine (`packages/domain`, `packages/app`),
the API/MCP transports, the web UI, the CLI, and `claude-plugin/`. Tenant isolation
(Postgres RLS), the storage-key derivation scheme, and authentication/session handling are the
highest-priority areas — see `CONSTITUTION.md` §1 and §4 for what this project treats as
non-negotiable on that front.

## Supported versions

This project does not yet have a formal LTS/backport policy — fixes land on the default branch.
Run the latest release (or `main`) for security fixes.
