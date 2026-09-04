---
name: mdloop-sync
description: Use when a significant change has been made to a markdown spec, PRD, design doc, plan, or ADR in a repo with a .mdloop/ directory — at meaningful mid-session checkpoints as well as when finishing a round of edits. Also use when asked to "push to mdloop", "sync the spec", "send this for review", or similar.
---

# Pushing an artifact to mdloop

## Overview

mdloop is where humans read, comment on, and sign off the artifacts an agent writes. `mdloop push` creates
a new **Leg** (version) of the document; the reviewer opens a Compare surface showing what moved between
the previous Leg and this one.

**By default nothing pushes until someone runs `git commit`** — that is the one trigger that works
regardless of which coding agent or editor made the edit. The consequence: between commits, mdloop goes
stale unless the agent pushes itself. A long session that rewrites a spec three times and commits at the
end leaves the reviewer looking at hours-old text the whole time. Pushing at meaningful checkpoints is not
a nicety under this default — it is the only thing keeping mdloop current mid-session.

(If `.mdloop/config.json` sets `"trigger": "agent-turn"`, a Stop hook also pushes at the end of every turn
— but with **no note at all**. The reviewer sees that something changed and has to reconstruct why from
the diff. Writing the note is the part no hook can do.)

## When to push

```bash
mdloop push --note "<what changed and why>"
```

from the repo root (the folder containing `.mdloop/`).

| Situation                                                         | Push?                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Finished a section or rewrite that changes what the document says | Yes                                                                             |
| Resolved a reviewer's comment or applied a suggestion             | Yes                                                                             |
| About to start something large — record the current state first   | Yes                                                                             |
| Wrapping up the session                                           | Yes                                                                             |
| Every individual file write                                       | No — wait for a checkpoint                                                      |
| Mid-refactor, artifact is in a half-written state                 | No — wait for the next checkpoint                                               |
| Nothing meaningful has changed since the last push                | No                                                                              |
| Change is to code, not a tracked markdown artifact                | No — mdloop tracks `*.md` only                                                  |
| No `.mdloop/` directory in the repo                               | Yes — see "Make sure there is somewhere to push to" below before the first push |

The bar is "a reviewer would want to see this," not "a file changed on disk." One push per meaningful
revision keeps version history readable and protects reviewer comments — comments re-anchor against the
new text on every push, and one that can't re-anchor with enough confidence is marked moved or orphaned.
A handful of pushes across a long session is right; one per edit degrades exactly the review quality this
exists to support.

`mdloop push` is safe to run at any time: unchanged files are skipped without a network call, and a push
that would clobber someone else's newer version refuses with a conflict instead (reconcile, then consider
`--force`). `mdloop status` shows what would push without pushing anything.

## Make sure there is somewhere to push to

A `SessionStart` hook normally already did this — it starts the local mdloop server if needed and links
the repo, so by the time you're pushing there is almost always already a `.mdloop/manifest.json`. Do it
yourself only when that hook didn't run or didn't finish: `MDLOOP_AUTO=0` disables it, or you moved into a
different repo mid-session (the hook only ran once, at session start, in whatever folder that was).

```bash
mdloop serve status || mdloop serve start
mdloop link
```

`mdloop serve status` exits 0 if a local server is already running, so `mdloop serve start` only runs
when it's genuinely needed. Then `mdloop link`:

- **Reuse before create.** With no `--project` flag, `mdloop link` first looks for an existing project
  whose name matches this folder and reuses it — it does not create a new project unless nothing matches.
  `mdloop projects list` shows every folder→project mapping this machine has ever made, so you can check
  what's linked to what before assuming a link is missing.
- **A human-provisioned project always wins.** If the user has already created or named a specific project,
  link to it explicitly with `mdloop link --project <id>` rather than letting auto-provisioning pick one.
  Never invent a project id, and never route around linking by calling `upload_document` directly just
  because `.mdloop/` doesn't exist yet — that desynchronizes the CLI's file→document mapping (see "Common
  mistakes" below).
- **Local only.** Auto-creating a project like this is restricted to a **local** mdloop server. Against a
  shared team instance, don't let `mdloop link` auto-provision — ask the human which existing project this
  repo should link to, and pass `--project <id>` yourself.

## Writing a good note

The note is one line of prose answering _what changed_ **and** _why_. The reviewer reads it before the
diff — it's the difference between reviewing a decision and reverse-engineering one.

Good:

- `"Split the auth section into SSO and API-key paths — SSO needs a JIT-provisioning step the old single flow hid"`
- `"Dropped the batch-import requirement; ops confirmed nobody has asked for it in 18 months"`
- `"Reworked the rollout plan around the migration freeze that lands 2026-08-01"`

Not good — these tell the reviewer nothing the diff doesn't already show:

- `"updated doc"` / `"changes"` / `"wip"`
- `"Edited PRD.md"` (names the file, not the change)
- `"Addressed feedback"` (which feedback, and how?)

If the work resolved a comment or applied a suggestion, say so — that tells the reviewer where to look
first.

## Making the artifact reviewable

Before pushing, the artifact should be something a human can review in one sitting:

- **State the decision, not just the exploration.** A reviewer signs off on a position. If a section is
  still open, say so explicitly rather than leaving it ambiguous.
- **Keep headings stable across revisions.** Anchored comments and the document outline both key off
  structure; renaming every heading turns a small edit into a document-wide re-anchor.
- **Put the change where a reader expects it** — in place, not appended as a "revisions" section that
  duplicates content already above.
- **No half-written placeholders** (`TODO: fill in`, lorem text) — finish the section, or say in prose
  that it's deliberately deferred.
- **Diagrams and tables are first-class.** mdloop renders mermaid, code fences, and callouts — structure
  for the rendered view, not the raw file.

## Common mistakes

Beyond the table above, a few failure modes are easy to fall into:

| Mistake                                                                        | Fix                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaning on the Stop hook instead of pushing explicitly                         | It only runs under `trigger: "agent-turn"`, and pushes with **no note** — write one yourself for anything worth reviewing                                                               |
| Saving every push for the very end of a long session                           | mdloop stays stale the whole session under the default trigger — push at checkpoints along the way                                                                                      |
| Told not to stop and sync mid-session ("we're on a deadline, just keep going") | That's a request not to interrupt the work, not a request to skip mdloop for the rest of the session — keep working uninterrupted, then push what accumulated the next time you do stop |
