# `mdloop-sync` — Claude Code plugin

Closes the agent's side of the mdloop flywheel, in **both** directions: **agent writes an artifact →
artifact lands in mdloop as a new Leg → human reviews and signs off → agent reads the feedback and
revises**. The bundle is named `mdloop-sync` after the half it shipped first, and that name is load-bearing
— it is the command namespace (`/mdloop-sync:mdloop-link`) — but it now carries a skill per direction:

- **Push** — `skills/mdloop-sync`: get the artifact into mdloop, with a change note worth reading.
- **Read** — `skills/mdloop-review`: pull the human's feedback back out and turn it into a revision.

Without the push half, that second step depends on someone remembering to run `mdloop push`. With it, the
push happens on its own.

**The default push trigger is `git commit`, and it is not part of this plugin.** `mdloop link` installs a
`.git/hooks/post-commit` hook that pushes after every commit — a git hook fires whichever tool made the
edit (Claude Code, Codex, Cursor, VS Code, opencode, or a human in vim), so that is the one trigger that
works everywhere without a per-harness adapter. See "Triggers" below.

The layers this bundle ships:

| Layer                          | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/mdloop-sync`           | **Push quality.** Teaches the agent what a reviewable artifact looks like, and to push at meaningful checkpoints with `mdloop push --note "<what changed, why>"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `skills/mdloop-review`         | **The read half.** Turns a reviewed document back into a revision: read the feedback (`get_feedback_bundle`), tell a suggested edit from an ordinary comment, apply and upload **once**, reply then resolve, then handle sign-off. Runs over the mdloop **MCP tools alone** — no repo, CLI, or `.mdloop/` needed, so it works for a hosted agent with no checkout. In a repo that _does_ have `.mdloop/`, it hands the upload step back to `mdloop push`.                                                                                                                                                                                                                                                                                                                                               |
| `hooks/mdloop-sync.sh`         | **Per-turn guarantee, opt-in.** A `Stop` hook that runs `mdloop push --quiet` at the end of every agent turn. Stands down unless the repo is on `trigger: "agent-turn"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hooks/mdloop-ensure.sh`       | **Zero-touch provisioning.** A `SessionStart` hook: starts the local mdloop server if it isn't already running, links the current repo (auto-provisioning a project named after the folder) if it isn't already linked, and registers the running instance with Claude Code's own MCP client (`claude mcp add`, `--scope local`) so `mdloop-review`'s tools are actually reachable, not just documented as if they were — a fast existence check makes every session after the first free. This is what makes "install the plugin, never type `mdloop open`" true — see "Usage" below. Opt out with `MDLOOP_AUTO=0`. Never touches a repo already linked to a non-local server; MCP registration is local-only for the same reason (a remote endpoint's MCP URL isn't derivable from anything on disk). |
| `commands/mdloop-link.md`      | `/mdloop-sync:mdloop-link` — wraps `mdloop link` to bind the repo to a mdloop project. For the explicit case (a human-chosen project, or a remote server) — the automatic local path needs no command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/check-skill-drift.sh` | **Drift guard.** Both skills name MCP tools by hand; this fails, naming names, if either references a tool `packages/mcp/src/server.ts` no longer registers. Outside `pnpm verify` — see "Tests".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The note is the difference between the two push layers: a hook pushes with no note rather than not pushing
at all; the skill is what gets a good note onto the version. Hooks can only run shell commands — they
cannot call MCP tools — which is the whole reason `packages/cli` exists. The read half has the opposite
shape: the skill itself is MCP-only and needs no shell at all — but the _tools it depends on_ still needed
a shell to become reachable in the first place, which is exactly what `hooks/mdloop-ensure.sh`'s
registration step is for. (An earlier version of this paragraph reasoned "so needs no hook" from the first
half alone, and missed that: a hook can't _call_ an MCP tool, but it can still _register_ one — a plain
CLI/config operation, no different in kind from starting the server or linking the folder above it.)

One push per unit of work is deliberate and coarse, whichever trigger you use. Comments in mdloop are
re-anchored against the new text on every push, so push frequency directly trades against review quality.
There is no per-file-save mode and there will not be one.

## Prerequisites

The `mdloop` CLI must be reachable on `PATH`. Easiest path — install the published package:

```bash
npm install -g mdloop
```

Working inside this monorepo itself (contributing to `packages/cli`, or running ahead of what's
published), build from source instead:

```bash
pnpm install && pnpm build   # tsc --build + the web SPA's vite build; produces packages/cli/dist/main.js
```

`pnpm typecheck` alone is **not enough** here, even though it does produce `packages/cli/dist/main.js`:
`packages/web`'s `tsconfig.json` sets `emitDeclarationOnly`, so `tsc --build` alone never emits the actual
web bundle. Skip the `pnpm build` step above and `hooks/mdloop-ensure.sh`'s `SessionStart` hook will start
a local instance that boots cleanly and then throws `No built web SPA at .../packages/web/dist (no
index.html)` the moment anything tries to open it in a browser — see `SELF_HOSTING.md` for the same
gotcha spelled out in more detail.

Then make it reachable in one of these ways:

- symlink it onto `PATH`: `ln -s "$PWD/packages/cli/dist/main.js" /usr/local/bin/mdloop`
- or export `MDLOOP_CLI_PATH=/absolute/path/to/packages/cli/dist/main.js` — both the Stop hook and the
  installed git post-commit hook fall back to this when `mdloop` is not on `PATH`

`pnpm --filter @mdloop/cli exec mdloop` does **not** work: pnpm does not link a workspace package's own bin
into `node_modules/.bin` unless something depends on it.

Each developer also needs their own API key, minted from their own mdloop account:

```bash
export MDLOOP_API_KEY=mdloop_...
```

(or `.mdloop/credentials` containing `{"apiKey": "mdloop_..."}`, mode 0600. `mdloop link` writes a
`.mdloop/.gitignore` covering it, so it cannot be committed by accident.)

## Install

The plugin bundle lives in the `claude-plugin/` **subdirectory** of this repo, not at the repo root.

**Install from this repo** — the simplest path, and the one to reach for. This repo is its own
marketplace: `.claude-plugin/marketplace.json` **at the repo root** (a different directory from
`claude-plugin/.claude-plugin/plugin.json`, which describes the plugin itself) advertises the bundle, so
no third party has to host anything.

```bash
claude plugin marketplace add /path/to/mdloop
```

then, inside Claude Code:

```
/plugin install mdloop-sync@mdloop
```

`mdloop` is the **marketplace** name and `mdloop-sync` is the **plugin** name — the `name` fields of the two
manifests above, respectively. The marketplace entry points at the bundle with a relative source,
`"source": "./claude-plugin"`, rather than a `git-subdir` URL: a relative source resolves against whatever
the marketplace was added from, so the same manifest works for a local path today **and** for a git URL
the day this repo gets a remote, with no URL to keep in sync. (`marketplace add` also takes a git URL or
an `owner/repo` shorthand once one exists.)

**Try it without installing** — no marketplace at all:

```bash
claude --plugin-dir /path/to/mdloop/claude-plugin
```

**Publish it through someone else's marketplace**, if a team already curates one. The `git-subdir` source
type exists exactly for a bundle that is not at a repo root — Claude Code sparse-clones just that
subdirectory. Add an entry like this to that marketplace's `.claude-plugin/marketplace.json`:

```json
{
  "name": "mdloop-sync",
  "source": {
    "source": "git-subdir",
    "url": "mdloop/mdloop",
    "path": "claude-plugin"
  },
  "description": "Keeps repo markdown specs in sync with mdloop"
}
```

`url` also accepts a full HTTPS or SSH git URL, and `ref`/`sha` pin to a branch, tag, or commit. Users
then add that marketplace (`/plugin marketplace add ...`) and install `mdloop-sync` from it.

## Usage

Two paths, depending on what you're pointed at — they differ because only a local instance can
auto-provision both the API key and the project; a shared one genuinely needs a human for each.

### Local, zero-setup

The default once the plugin is installed and `mdloop` is on `PATH` (or `$MDLOOP_CLI_PATH`). Nothing
else to do:

1. Open Claude Code in a repo. The `SessionStart` hook (`hooks/mdloop-ensure.sh`) starts the local
   mdloop server if it isn't already running (`mdloop serve start`, detached — it survives closing
   the terminal), links the repo if it isn't already linked (`mdloop link` with no `--project`,
   which auto-provisions a project named after the folder, reusing one if it already exists), and
   registers the running instance with Claude Code's own MCP client (`claude mcp add ... --scope
local`) so `mdloop-review`'s tools are actually reachable — not just documented as if they were.
2. That's it. From here on this is the same loop as the shared-instance path below — commits push, the
   agent pushes at checkpoints, `mdloop-review`'s skill reads feedback back. The one honest caveat:
   MCP registration happens on the session that runs the very first `mdloop link` for a repo, and
   Claude Code's own docs don't guarantee a hook-registered server is reachable in that same
   session — so the read half may need one fresh session to activate the first time a repo is
   opened. Every session after that already has a working registration sitting in `~/.claude.json`,
   checked with one cheap `claude mcp list` call and nothing else — the admin key doesn't rotate,
   so there's nothing left to redo. `claude mcp list` / `claude mcp get mdloop` shows the live
   registration at any point. Local only, deliberately: a shared instance's MCP URL isn't derivable
   from anything `mdloop link` writes to disk (see "A real shared instance" below), so that path
   still ends with one manual `claude mcp add` — same as any other MCP client.
3. `mdloop serve status` / `mdloop serve stop` to inspect or stop the background server;
   `mdloop projects list` to see every folder this machine has ever auto-linked, and to what.
4. `MDLOOP_AUTO=0` disables the auto-start/auto-link entirely, if you'd rather do both by hand.

### A real shared instance

For a team sharing one deployment (`SELF_HOSTING.md`) — this still needs a human for the two things a
local instance mints on its own:

1. **Once per project** — an org admin creates the project in mdloop web and copies its id.
2. **Once per repo** — the first developer runs `/mdloop-sync:mdloop-link` (or `mdloop link --project <id>`).
   That writes `.mdloop/manifest.json` and `.mdloop/config.json`, both of which **are committed**: they hold
   no credentials, and the server resolves the org from the API key via RLS, never from anything the
   client sends. Teammates inherit the link on clone. It also installs `.git/hooks/post-commit` for
   whoever ran it (git never tracks its own hooks, so each developer's `mdloop link` — or a manual copy —
   installs their own).
3. **Once per machine, per developer** — `export MDLOOP_API_KEY=...`, then run `mdloop link` once to get
   the post-commit hook onto that machine. Nothing else.
4. From then on, every `git commit` pushes tracked `*.md` files, with the commit subject as the change
   note. On `trigger: "agent-turn"` the plugin's Stop hook does it per agent turn instead.

An agent should still push explicitly with a note at meaningful checkpoints — see
`skills/mdloop-sync/SKILL.md`. Under the commit-anchored default that is what keeps mdloop fresh between
commits, not just a nicety.

## Triggers

This section is about push _cadence_ only — `hooks/mdloop-ensure.sh`'s `SessionStart` provisioning
(starting the server, linking the repo) is a separate, orthogonal concern and runs regardless of which
trigger a repo is on.

`.mdloop/config.json` at the repo root decides which event owns the push:

```json
{ "trigger": "commit" }
```

| `trigger`            | Who pushes                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"commit"` (default) | `.git/hooks/post-commit`, installed by `mdloop link`. This plugin stands down.                                                                                         |
| `"agent-turn"`       | This plugin's `Stop` hook, once per agent turn. The git hook is still installed and still fires on commits, so a repo on `agent-turn` gets both — set it deliberately. |

`"commit"` is also what an absent file, or an absent `trigger` field, now means. That default flipped on
2026-07-30 (it used to be `"agent-turn"`), so a repo linked before then picks up the new behaviour too —
an intentional migration, so behaviour never depends on when a repo happened to be linked. To get the old
per-turn behaviour back, re-run `mdloop link --trigger agent-turn` on a repo with no config, or hand-edit
the file.

**Why commit is the default.** Every coding agent worth supporting has some turn-completion hook, but
each has its own exit-code contract, its own fail-open/fail-closed default, and its own packaging — four
adapters to build and keep working, for something that is not fundamentally any harness's problem. A git
hook has none of that: it fires the same way whoever or whatever made the edit. The Stop hook here stays
shipped and supported, as the opt-in enhancement for people who specifically want per-turn freshness
inside Claude Code.

### The git hook is auto-installed, and that is safe

`mdloop link` writes `.git/hooks/post-commit` itself; the old copy-the-template-yourself step is gone (and
so is the template). Writing an executable that fires on every future `git commit` deserves care, so:

- The script carries a **marker comment** on the line after its shebang identifying it as mdloop-managed.
- **No hook present** → written fresh, mode `0755`.
- **A hook present with our marker** → ours, overwritten with the current version. This is how re-running
  `mdloop link` upgrades an installed hook when its logic changes.
- **A hook present without our marker** (Husky, lint-staged, your own script) → left **completely
  untouched**, byte for byte. `mdloop link` prints the exact one-line command to paste into it instead —
  graceful degradation to the old manual flow, never silent, never destructive.
- **Not a git repo** → nothing is written and nothing is said; it simply does not apply.
- Every outcome that changed something, or that needs you to act, is **printed explicitly**. This is not
  terse-success territory: it changes what `git commit` does from here on.
- `mdloop link --no-git-hook` skips the whole thing.

The commit subject becomes the change note (`mdloop push --note "$(git log -1 --pretty=%s)"`), so commit
subjects show up verbatim in mdloop's Compare surface. Write them accordingly.

## What the repo trusts, and what it doesn't

`.mdloop/manifest.json` is committed and shared — that is the point, it is how teammates inherit the link
on clone. But it means the manifest's `endpoint` field is whatever the last commit to it said, and the
CLI sends your API key there as a bearer token. A poisoned commit to a shared manifest would otherwise
redirect every teammate's next `mdloop push` to an attacker's host. Two guards close that:

- **Scheme guard.** Plain `http://` is refused outright unless the host is loopback (`localhost`,
  `127.0.0.1`, `[::1]`, any port), which stays allowed because that is the local-dev workflow. Everything
  else must be `https://`. The refusal happens before a socket is opened.
- **Trust on first use.** The first successful connect from a folder pins the endpoint's origin
  (scheme + host + port) to `.mdloop/endpoint-trust.json` — local, gitignored, never committed. Every later
  `link`/`push`/`status` compares against that pin and **refuses** if it has changed, printing both
  origins and exiting non-zero. It does not connect to the new origin even once; that is the whole point.
  `--force` does not override it (that flag is for version conflicts, a different question entirely).

If the change is legitimate — your team really did move mdloop to a new host — delete
`.mdloop/endpoint-trust.json` and run the command again. Requiring a deliberate manual step for something
this rare is the intended UX, not an oversight. It is the same model as SSH host keys.

Everything local in `.mdloop/` is kept out of git by a nested `.mdloop/.gitignore`, written automatically by
every command that touches the directory: `credentials`, `.lock`, and `endpoint-trust.json`.
`manifest.json` and `config.json` are committed, deliberately.

## Behaviour when things are missing

The Stop hook is a background convenience, never a gate, so it **never exits 2** — exit code 2 from a
`Stop` hook is a blocking decision that would force the conversation to continue, which a failed sync must
never do. It uses exit **1** for genuine problems instead: Claude Code treats 1 as a non-blocking error
and surfaces the first stderr line as a hook-error notice in the transcript, whereas **stderr from a hook
that exits 0 is discarded entirely**. Exit 0 is therefore reserved for true no-ops. It stays silent unless
something actually happened:

| Situation                                                                            | Behaviour                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Not a git repo                                                                       | silent, exit 0                                          |
| No `.mdloop/manifest.json` (never linked)                                            | silent, exit 0                                          |
| `trigger: "commit"` — **including the default when the field or the file is absent** | silent, exit 0 (the git post-commit hook owns the push) |
| Linked, but no API key                                                               | silent, exit 0                                          |
| Linked + has a key, but no `mdloop` on `PATH`                                        | one stderr line, **exit 1** (visible in the transcript) |
| Push conflicts or fails                                                              | the CLI's stderr, then a summary line, **exit 1**       |
| Push succeeds                                                                        | silent, exit 0                                          |

The no-API-key case is silent on purpose, and the hook duplicates a check the CLI already does to keep it
that way: `.mdloop/` is committed, so every teammate on a linked repo runs this hook, and the ones who
never minted a key would otherwise get a visible hook error on every single turn, forever. A missing key
is a non-adoption, not a misconfiguration — there is no advice the hook could give that the person hasn't
already declined. Run `mdloop push` by hand to get that diagnosis. The credential check runs **before** the
CLI lookup for the same reason: someone with neither a key nor the CLI gets silence, not a nag about a CLI
they have no use for.

The hook runs with `"async": true`, so the turn never waits on a network round trip (the CLI has no
network timeout of its own, and the hook's own 60s ceiling was the turn's worst case). One tradeoff worth
knowing: the docs specify stderr surfacing for synchronous hooks and are silent about async ones, so
transcript visibility of the exit-1 diagnostics above is best-effort under `async: true` — the debug log
always has them. Flip `async` to `false` in `hooks/hooks.json` if you would rather have guaranteed
visibility than a never-blocked turn.

`hooks/mdloop-ensure.sh` (the `SessionStart` hook) follows the same never-exit-2 contract, with its own
never-linked-before case flipped from silent to active — this is the one hook whose whole job is to fix
that case rather than defer to a human:

| Situation                                      | Behaviour                                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Not a git repo                                 | silent, exit 0                                                                                |
| `MDLOOP_AUTO=0`                                | silent, exit 0                                                                                |
| `mdloop` not on `PATH`/`$MDLOOP_CLI_PATH`      | silent, exit 0 (no nag before anyone has opted in)                                            |
| Already linked to a non-local endpoint         | silent, exit 0 (never autostart a local daemon for a team server)                             |
| Local server not running                       | starts it (`mdloop serve start`); a failure to start is one stderr line, **exit 1**           |
| Repo not yet linked                            | links it (`mdloop link`, auto-provisioning); a failure to link is one stderr line, **exit 1** |
| Server already running and repo already linked | silent, exit 0                                                                                |

## Tests

```bash
bash claude-plugin/hooks/mdloop-sync.test.sh
bash claude-plugin/hooks/mdloop-ensure.test.sh
bash claude-plugin/scripts/check-skill-drift.sh       # the guard itself
bash claude-plugin/scripts/check-skill-drift.test.sh  # and its own tests
```

Plain bash with a stub `mdloop` on `PATH` — this bundle is JSON, Markdown, and shell, so it sits outside
`packages/` and is not covered by `pnpm verify`'s vitest/dependency-cruiser/coverage pipeline.

`check-skill-drift.sh` is the one that guards content rather than behaviour. Both skills name MCP tools as
plain prose (`get_feedback_bundle`, `accept_suggestion`, `upload_document`, …), and nothing links those
strings to `packages/mcp/src/server.ts` — so a rename there would leave a skill confidently instructing
the agent to call something that no longer exists, discovered mid-review in front of the human whose
feedback it was fetching. The guard extracts every backticked `snake_case` tool reference from the two
`SKILL.md` files, checks each against the `server.registerTool('…')` registrations, and exits non-zero
listing any that are missing with the file and line that mention them. It is one-directional on purpose: a
newly registered tool that no skill mentions is not drift, and most of the server's tools are not — and
should not be — named in a skill. Its own test suite drives it against throwaway fixtures rather than
editing the real skills, and covers the case that matters most for a guard like this: a server it cannot
parse is a hard failure, never a silent pass.
