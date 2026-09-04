---
description: Link this folder to a mdloop project
allowed-tools: Bash
---

Link the current repository to an existing mdloop project so its markdown artifacts get pushed
automatically. Argument (optional): a mdloop project id, passed as `$ARGUMENTS`.

**This command is for the explicit case** — linking to a project a human already created, or linking to a
shared/remote server at all. Against a **local** `mdloop serve` instance, the automatic path needs no
command: the plugin's `SessionStart` hook (or the `mdloop-sync` skill, if the hook didn't run) already runs
bare `mdloop link`, which auto-provisions a project named after the folder with no human step. Reach for
this command when the user wants to name a specific project, or point at a server that isn't local.

Do this:

1. **Find the repo root** with `git rev-parse --show-toplevel` and run everything below from there.
   `mdloop link` defaults to the current working directory, so the cwd matters.

2. **Check the CLI is reachable**: `command -v mdloop`. If it is not found, stop and tell the user how to
   get it (see "If `mdloop` is missing" below) — do not try to work around it.

3. **Check for an API key**: `mdloop link` needs one and will not create one. It reads `MDLOOP_API_KEY`
   from the environment, else `.mdloop/credentials` in the folder being linked. If neither exists, stop
   and tell the user to mint an API key in mdloop and `export MDLOOP_API_KEY=mdloop_...` (or write
   `.mdloop/credentials` as `{"apiKey": "mdloop_..."}`, chmod 600 — it must stay gitignored).

   **Against a local `mdloop serve` instance, skip this step** — the key already exists. The server mints
   an admin API key on its own first boot and stores it in the data directory's `bootstrap.json`; the CLI
   reads it from there automatically. There is no human action needed here for a local server, only for a
   remote/shared one.

4. **Run the link.**

   - If the user gave a project id: `mdloop link --project <id>`
   - If not: run `mdloop link` with no `--project`.
     - **Against a non-local endpoint**, you are not a TTY, so instead of showing an interactive picker it
       will print the list of available projects (`<id>  <name>`) to stderr and exit 1. **That is not a
       failure** — relay the list to the user, ask which project they want, then re-run with
       `mdloop link --project <id>`.
     - **Against a local endpoint**, bare `mdloop link` auto-provisions instead: it reuses an existing
       project matching the folder, or creates one named after the folder, and succeeds outright — no
       picker, no exit 1, no human input needed.

   Add `--endpoint <url>` only if the user asks for a non-default server. Resolution order is
   `--endpoint`, then the endpoint already in `.mdloop/manifest.json`, then `$MDLOOP_MCP_URL`, then
   `http://localhost:3001/mcp`.

   Two more flags, only when the user asks for them:

   - `--trigger commit|agent-turn` (default `commit`) — writes `.mdloop/config.json`. `commit` means a
     git post-commit hook owns the push; `agent-turn` means this plugin's Stop hook does, once per agent
     turn. **Only written if `.mdloop/config.json` does not already exist** — an existing config is never
     rewritten, so passing `--trigger` on a repo that already has one does nothing. Say so if that
     happens rather than retrying.
   - `--no-git-hook` — skip installing the git post-commit hook entirely.

5. **Report the result.** On success it prints `Linked <folder> to project <id> (<endpoint>)`, writes
   `.mdloop/manifest.json` and `.mdloop/config.json`, and installs `.git/hooks/post-commit` unless
   `--no-git-hook` was passed. **Relay the hook lines it printed verbatim** — they say what will now
   happen on every `git commit`. Three outcomes are possible:

   - `Installed a git post-commit hook …` — from now on every commit pushes tracked files.
   - `Updated the git post-commit hook …` — an older mdloop-managed hook was refreshed.
   - `A git post-commit hook already exists and was left untouched …` followed by a one-line command.
     The repo has a foreign hook (Husky, lint-staged, a custom script); nothing was overwritten. Offer
     to append that exact line to `.git/hooks/post-commit`, but do not do it without asking.

   Silence about the hook means either nothing changed (a relink with the hook already current) or the
   folder is not a git repo — neither is a problem.

   Also tell the user:

   - `.mdloop/manifest.json` and `.mdloop/config.json` **should be committed** — they carry no credentials,
     and teammates inherit the link on clone. `.mdloop/credentials`, `.mdloop/.lock`, and
     `.mdloop/endpoint-trust.json` must **not** be; `mdloop link` writes a `.mdloop/.gitignore` covering
     them automatically.
   - Every other developer on the repo needs their own `MDLOOP_API_KEY`, plus one `mdloop link` run on
     their machine to get the post-commit hook (git never tracks `.git/hooks/`, so it cannot arrive by
     clone).

   Relinking is idempotent: it overwrites the project id and endpoint, preserves the per-file tracking
   entries already in the manifest, leaves an existing `.mdloop/config.json` alone, and refreshes the git
   hook only if it is one mdloop wrote.

6. **If it fails**, relay the CLI's message verbatim rather than guessing. `project_not_found: <id>`
   means the key's org cannot see that project; `Could not connect to <endpoint>` means the mdloop MCP
   server is unreachable at that URL.

## If `mdloop` is missing

It is not published to any registry yet — today it is built from this monorepo:

```bash
pnpm install && pnpm typecheck   # tsc --build; produces packages/cli/dist/main.js
```

`packages/cli/dist/main.js` is executable and carries a `#!/usr/bin/env node` shebang, so any of these
makes it reachable:

- symlink it onto PATH: `ln -s "$PWD/packages/cli/dist/main.js" /usr/local/bin/mdloop`
- or export `MDLOOP_CLI_PATH=/absolute/path/to/packages/cli/dist/main.js`, which both the Stop hook and
  the installed git post-commit hook honour as a fallback when `mdloop` is not on PATH
- or just run `node packages/cli/dist/main.js ...` directly for a one-off

Note that `pnpm --filter @mdloop/cli exec mdloop` does **not** work: pnpm does not link a workspace
package's own bin into `node_modules/.bin` unless something depends on it.
