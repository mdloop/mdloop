# mdloop

Human-in-the-loop review for agent-written markdown.

An agent is good at writing a spec, a PRD, an ADR, a runbook — markdown a human needs to read,
mark up, and sign off on before anything downstream happens. mdloop is a small, purpose-built
surface for that one loop: publish, review, read feedback, revise, repeat — with the agent a
first-class participant on both ends.

## Quickstart

```sh
curl -fsSL https://raw.githubusercontent.com/mdloop/mdloop/main/install.sh | sh
```

Installs the CLI, links the current folder, and writes mdloop's review-loop instructions into
every coding agent's config it finds on this machine. Then `mdloop open .` spins up an embedded
Postgres (PGlite — a real Postgres wire-protocol socket server) entirely inside this process,
mints you an admin key, and opens the app in your browser. No account, no cloud service, nothing to
sign up for.

Since you're already here on npm: `npx mdloop open ./my-project` does the same thing in one step,
for a single project, without the global install or the review-loop instructions above.
`mdloop serve start` runs either path's server detached, so it survives closing the terminal.

To remove it again, run the matching uninstaller rather than a plain `npm uninstall -g mdloop` —
the plain form leaves every linked repo's `.mdloop/` and instructions block behind, since npm
runs no cleanup script on a global uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/mdloop/mdloop/main/uninstall.sh | sh
```

> This package covers the local, single-user path — `mdloop open`/`mdloop serve` only.

## What you get

- **Feedback lands on the exact sentence, every version.** Comments re-anchor with a confidence
  score rather than being silently guessed onto the nearest similar text.
- **Review prose like prose.** A reading UI with inline comments, suggested edits and sign-off —
  not a code diff.
- **Your agent participates, it doesn't wait.** MCP tools cover the whole loop, so it publishes,
  polls, reads structured feedback and revises with nobody relaying anything by hand.
- **Nothing is overwritten.** Every upload is a new immutable version; retention can purge a blob
  but the version row survives as a visible tombstone.
- **You can leave.** Full version history and comments export as plain JSON — no proprietary
  format to reverse-engineer.

## Beyond the local path

This package is the zero-install local experience. Running mdloop for a team, against a real
Postgres, with SSO, S3-compatible storage, or a Docker deployment is documented in the source
repository, not this package — see [SELF_HOSTING.md](https://github.com/mdloop/mdloop/blob/main/SELF_HOSTING.md).

## License

Apache-2.0. Source, issue tracker, and full documentation:
[github.com/mdloop/mdloop](https://github.com/mdloop/mdloop).
