# ADR 0018 — The CLI may write a marker-guarded block into a file the repo owns

- Status: Accepted (2026-09-12 — approved directly by the product owner in the planning session
  that produced this change; not itself a CONSTITUTION §1–7 deviation, so §8.5's mandatory-ADR
  gate does not strictly apply, but the precedent is significant enough to record deliberately
  rather than let it stand only as a code comment)
- Date: 2026-09-12
- Deciders: Jasdeep (product)
- Relates to: `packages/cli/src/git-hook.ts` (the prior precedent this one extends),
  `packages/cli/src/mdloop-dir.ts` (the comment this ADR makes non-generally-true), CONSTITUTION.md
  Core Principle 2 (a stale doc/tool description is the same failure as a stale comment)

## Context

mdloop's entire premise is that a human signs off on agent-written markdown instead of an agent
approving its own plans and artifacts inline in a chat transcript. Nothing in this repository told
a coding agent to actually do that — the Claude Code plugin's skills auto-trigger, but that is
Claude-Code-only; Cursor, Codex CLI, and every other MCP client got tool registration and no
instructions at all. A repo-wide grep confirmed the gap directly: nothing here wrote or modified a
`CLAUDE.md`, `AGENTS.md`, or any other agent-instruction file, ever.

Every write this CLI has made until now stayed inside `.mdloop/` — a directory this CLI owns
outright — with one deliberate exception already: `mdloop link` installs `.git/hooks/post-commit`
(`git-hook.ts`). That file is untracked, though, invisible to teammates, never shown in a diff. A
`CLAUDE.md`/`AGENTS.md` block is different in kind: it is git-tracked, lands in every teammate's
`git diff`, and is exactly the kind of file `mdloop-dir.ts`'s own doc comment cited as the reason
`.mdloop/`'s `.gitignore` is nested rather than a root-level edit — "scoped correctly, and it never
touches a file the repo owns." This ADR is the deliberate exception to that boundary.

## Decision

`mdloop link` writes a marker-guarded instructions block into `CLAUDE.md` (if it already exists) or
`AGENTS.md` (created otherwise) at the repo root, by default, committed. `mdloop instructions
install|status|remove [--global]` (`packages/cli/src/agent-instructions.ts`) is the direct CLI
surface, and `install.sh` calls the `--global` form once per machine so every repo a person opens
is steered without per-repo setup.

The rule that makes this acceptable is the same one `git-hook.ts` already established, applied to a
harder case:

- A file (or, here, a _span_ inside a file) carrying mdloop's marker
  (`<!-- mdloop:begin — managed by mdloop; safe to regenerate, do not hand-edit -->` /
  `<!-- mdloop:end -->`) is ours to regenerate. A re-run replaces **only** that span, in place,
  byte-identical before and after.
- A file, or span, **without** the marker is never touched. `git-hook.ts` treats an unmarked hook
  script as foreign and refuses outright, because a hook is expected to be nothing but our content;
  a `CLAUDE.md` is expected to have other content, so the divergence here is that an unmarked file
  gets the block **appended**, never overwritten.
- A half-marked file (one marker present, or `end` before `begin`) is reported `'foreign'` and left
  alone — guessing the span in that state risks eating content that was never ours.
- `--no-agent-instructions` opts a `link`/`unlink` out, mirroring `--no-git-hook` exactly.

## Consequences

- Every linked repo's `CLAUDE.md`/`AGENTS.md` gains a small, honest section naming the real MCP
  tools (`upload_document`, `request_review`, `get_review_status`, `get_feedback_bundle`) and
  saying plainly that an agent's own summary is not sign-off. `claude-plugin/scripts/check-skill-
drift.sh` was extended to scan this template alongside the two `SKILL.md` files, so a renamed
  tool fails the guard instead of rotting silently in every future linked repo.
- A markdown file this feature creates or appends to is, by `walk.ts`'s own design ("not a full
  gitignore parser, just a reasonable ignore list" — no per-file exclusions exist for any markdown
  file, ever), itself eligible to be pushed to mdloop as a tracked document the next time `mdloop
push` runs. This is consistent with how every other markdown file in a linked repo is already
  treated, not a special case introduced here.
- A teammate on a repo who never opted into mdloop still sees this block in their `CLAUDE.md` once
  anyone runs `mdloop link` and commits it — a real departure from this repo's "a developer who
  never opted in sees no output, ever" philosophy for hooks (`mdloop-sync.sh`). The mitigating
  factors: the block is small, clearly marked as mdloop's, trivially removed
  (`mdloop unlink --no-agent-instructions` leaves it; deleting the marked span by hand or via
  `mdloop instructions remove` takes it out cleanly), and the person running `mdloop link` is
  already making the repo-wide decision to route review through mdloop — the same decision that
  installs the git hook every other teammate's commits will also trigger.
- `mdloop-dir.ts`'s "it never touches a file the repo owns" is no longer true of `mdloop link` as a
  whole; its doc comment was updated in the same change that introduced this ADR, pointing here.

## Alternatives considered

- **Opt-in only, via an explicit flag** (`mdloop link --agent-instructions`). Rejected: the entire
  point is that agents get steered without every user having to already know to ask for it — an
  opt-in flag only reaches people who read the CLI's help text first, which defeats the feature.
- **Ask on a TTY, skip silently otherwise.** Considered for `install.sh`'s global write and for
  `link`'s repo-scope write. Rejected for `link` specifically: it would mean the common non-
  interactive case (`mdloop-ensure.sh`'s bare `mdloop link` on `SessionStart`, or `install.sh`
  itself) never writes the block at all, leaving the feature effectively opt-in through the back
  door for most real installs.
- **Global-only, no repo-scope write.** Would satisfy "set it up once" but not "my teammates
  inherit it" — a teammate who never ran the installer themselves would see no steering at all on a
  repo someone else linked. Rejected in favor of writing at both scopes, each serving a different
  audience.
