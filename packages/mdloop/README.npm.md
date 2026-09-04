# mdloop

Human-in-the-loop review for agent-written markdown.

An agent is good at writing a spec, a PRD, an ADR, a runbook — markdown a human needs to read,
mark up, and sign off on before anything downstream happens. mdloop is a small, purpose-built
surface for that one loop: publish, review, read feedback, revise, repeat — with the agent a
first-class participant on both ends.

## Quickstart

```sh
npx mdloop open ./my-project
```

Spins up an embedded Postgres (PGlite — a real Postgres wire-protocol socket server) entirely
inside this process, mints you an admin key, opens the app in your browser, and links the folder.
No account, no cloud service, nothing to sign up for. `mdloop serve start` runs the same thing
detached, so it survives closing the terminal.

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
repository, not this package — see [SELF_HOSTING.md](https://github.com/imjasdeepk/mdloop/blob/main/SELF_HOSTING.md).

## License

Apache-2.0. Source, issue tracker, and full documentation:
[github.com/imjasdeepk/mdloop](https://github.com/imjasdeepk/mdloop).
