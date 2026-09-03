import { parseArgs } from 'node:util';
import type { Trigger } from './vorlyn-config.js';
import { resolveDataDir } from './data-dir.js';
import { listFolderProjects } from './folder-projects.js';
import { runLink } from './link.js';
import { runOpen } from './open.js';
import type { Io } from './output.js';
import { stdio } from './output.js';
import { runPush } from './push.js';
import { runServe } from './serve.js';
import { runStatus } from './status.js';
import { runUnlink } from './unlink.js';
import { DEFAULT_DEBOUNCE_MS, runWatch } from './watch.js';

const DEFAULT_CONCURRENCY = 3;

export const USAGE = `Vorlyn sync CLI — push local markdown files to Vorlyn documents.

Usage:
  vorlyn link [folder] [--project <id>] [--endpoint <url>] [--trigger <mode>] [--no-git-hook]
  vorlyn unlink [folder] [--no-git-hook]
  vorlyn push [folder] [--note <text>] [--force] [--quiet] [--concurrency <n>]
  vorlyn status [folder] [--concurrency <n>]
  vorlyn watch [folder] [--debounce <ms>]
  vorlyn open [folder] [--no-browser]
  vorlyn serve start [--foreground]
  vorlyn serve stop
  vorlyn serve status [--json]
  vorlyn projects list
  vorlyn --help

Link options:
  --project <id>    Link to this existing project explicitly — always wins outright over
                    auto-provisioning below, no matter what.
  --trigger <mode>  commit (default) or agent-turn — written to .vorlyn/config.json
                    on first link only; an existing config is never rewritten
  --no-git-hook     Do not install .git/hooks/post-commit. Without this, link
                    installs a post-commit hook that pushes after every commit
                    (an existing non-Vorlyn hook is never touched or replaced)

  With no --project, against a local endpoint only: derives a project name from
  the folder and reuses an existing project matching it, or creates one if none
  matches — never prompts, never fails for lack of a TTY. Records the folder to
  project mapping in the data directory ("vorlyn projects list" to inspect it).
  Against a non-local endpoint, --project is required on a non-TTY, or an
  interactive picker is shown on one — unchanged from before auto-provisioning
  existed.

Unlink options:
  --no-git-hook     Leave an installed post-commit hook in place instead of
                    removing it. A foreign hook (not installed by "vorlyn link")
                    is always left alone regardless of this flag.

Push options:
  --note <text>   "What changed" note recorded on every version this run creates
  --force         Push even when the server has moved past the tracked version
  --quiet         Print only conflicts and failures (for hooks); same exit code

Watch options:
  --debounce <ms>   Idle window (per file) before a settled change triggers a
                     push. Default 15000 — real editor testing found this the
                     shortest window that collapses autosave bursts and
                     preserves genuinely separate sessions without fragmenting
                     sustained writing into spurious versions; shorter windows
                     do fragment it. Watches until Ctrl-C; refuses to start on
                     an unlinked folder.

"vorlyn open" — the zero-install local experience: links the folder if
needed (auto-provisioning a project named after it, reusing one if it
already exists), pushes it once, and opens your browser to it. If a local
Vorlyn instance is already running (started by an earlier "vorlyn open",
or by "vorlyn serve start"), attaches to it instead of starting a second
one — Ctrl-C then just exits, the server keeps running for whatever else is
using it. Otherwise starts an embedded Postgres + local Vorlyn server in
the platform data directory first, and Ctrl-C stops both cleanly. No
--project or --endpoint needed — everything is local and auto-provisioned
on first run. --no-browser skips launching a browser (headless/SSH/CI use —
the URL is still printed).

"vorlyn serve" — a detached, persistent local Vorlyn server: "start"
returns as soon as it's up (or immediately, if one is already running) and
survives closing the terminal; "stop" shuts it down; "status" reports
whether one is running, exiting 0 if so and 1 if not (so "vorlyn serve
status || vorlyn serve start" is a correct one-liner). Multiple folders on
one machine share one "vorlyn serve" instance, each with its own
auto-provisioned project. Both embedded children default to a fixed port
pair (58743/58744 — well outside 3000/3001 and any other common dev-server
default, chosen so a document link stays valid across a restart instead of
moving every time); "vorlyn serve status" reports whatever it actually
landed on, and every command that needs to reach it resolves the current
port itself rather than trusting a value that could go stale. If that pair
is already taken by something else on the machine, set PORT/MCP_PORT to
pick different ones.

"vorlyn projects list" — every folder this machine has ever auto-linked,
and which project each one maps to. The visible half of auto-provisioning:
"vorlyn unlink" then "vorlyn link --project <id>" is still the way to
point a folder at a different project than what was auto-picked.

Environment:
  VORLYN_API_KEY   API key for the linked folder (else .vorlyn/credentials)
  VORLYN_MCP_URL   Default MCP endpoint when linking (else http://localhost:3001/mcp)
  VORLYN_DATA_DIR  Overrides the platform application-data directory ("vorlyn
                   open"/"vorlyn serve"'s embedded Postgres, blobs, and
                   instance state) — else the OS default (macOS: ~/Library/
                   Application Support/vorlyn; Linux: $XDG_DATA_HOME/vorlyn
                   or ~/.local/share/vorlyn; Windows: %APPDATA%\\vorlyn)

Files in .vorlyn/ (committed):
  manifest.json         endpoint, project id, per-file tracking state
  config.json           trigger mode (+ include globs read by the plugin hooks);
                        seeded by the first link, never rewritten after that
  .gitignore            keeps the three files below out of git; written automatically

Files in .vorlyn/ (local only, never committed):
  credentials           {"apiKey": "vorlyn_..."}, mode 0600
  .lock                 held for the duration of a push
  endpoint-trust.json   the endpoint origin this folder trusts

vorlyn unlink removes .vorlyn/ entirely (everything listed above) and, by
default, the git hook "vorlyn link" installed.

A folder links to one project at a time: relinking to a different project id
is refused. To switch, run "vorlyn unlink" here first, then "vorlyn link
--project <new id>".

Endpoint trust: manifest.json is committed and shared, so its endpoint is
whatever the last commit said. The CLI refuses plain http:// to anything but
localhost, pins the endpoint's origin on first successful use, and refuses to
connect if it later changes — delete .vorlyn/endpoint-trust.json to re-trust.
--force does not override this.`;

/** Entry point shared by `main.ts` and tests — parses argv, dispatches, returns an exit code. */
export async function run(argv: string[], io: Io = stdio): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h') {
    io.println(USAGE);
    return 0;
  }

  try {
    switch (command) {
      case 'link':
        return await runLinkCommand(rest, io);
      case 'unlink':
        return await runUnlinkCommand(rest, io);
      case 'push':
        return await runPushCommand(rest, io);
      case 'status':
        return await runStatusCommand(rest, io);
      case 'watch':
        return await runWatchCommand(rest, io);
      case 'open':
        return await runOpenCommand(rest, io);
      case 'serve':
        return await runServeCommand(rest, io);
      case 'projects':
        return await runProjectsCommand(rest, io);
      default:
        io.errln(`Unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    io.errln((error as Error).message);
    return 1;
  }
}

const TRIGGERS: readonly Trigger[] = ['commit', 'agent-turn'];

function isTrigger(value: string): value is Trigger {
  return (TRIGGERS as readonly string[]).includes(value);
}

async function runLinkCommand(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      endpoint: { type: 'string' },
      trigger: { type: 'string' },
      // `parseArgs` has no automatic negation, so the opt-out is its own
      // boolean flag rather than a `--git-hook` that nobody would ever pass.
      'no-git-hook': { type: 'boolean', default: false },
    },
  });
  const trigger = values.trigger;
  if (trigger !== undefined && !isTrigger(trigger)) {
    io.errln(`--trigger must be one of: ${TRIGGERS.join(', ')}`);
    return 1;
  }
  const folder = positionals[0] ?? process.cwd();
  return runLink(
    {
      folder,
      installGitHook: !values['no-git-hook'],
      // Auto-provision (reuse-or-create a project named after the folder)
      // only when the caller didn't name one explicitly — an explicit
      // --project always wins outright, this flag is never consulted when
      // it's set (see LinkOptions.autoProvision's doc comment).
      autoProvision: !values.project,
      ...(values.project ? { projectId: values.project } : {}),
      ...(values.endpoint ? { endpoint: values.endpoint } : {}),
      ...(trigger === undefined ? {} : { trigger }),
    },
    io,
  );
}

async function runUnlinkCommand(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      // Same negation pattern as link's --no-git-hook: `parseArgs` has no
      // automatic negation, so the opt-out is its own boolean flag.
      'no-git-hook': { type: 'boolean', default: false },
    },
  });
  const folder = positionals[0] ?? process.cwd();
  return runUnlink({ folder, removeGitHook: !values['no-git-hook'] }, io);
}

/** Shared by push and status — both take an optional folder and --concurrency. */
function parseConcurrency(raw: string | undefined, io: Io): number | undefined {
  const concurrency = raw ? Number.parseInt(raw, 10) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    io.errln('--concurrency must be a positive integer');
    return undefined;
  }
  return concurrency;
}

async function runPushCommand(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      force: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
      note: { type: 'string' },
      concurrency: { type: 'string' },
    },
  });
  const folder = positionals[0] ?? process.cwd();
  const concurrency = parseConcurrency(values.concurrency, io);
  if (concurrency === undefined) return 1;
  return runPush(
    {
      folder,
      force: values.force,
      quiet: values.quiet,
      concurrency,
      ...(values.note === undefined ? {} : { note: values.note }),
    },
    io,
  );
}

async function runStatusCommand(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { concurrency: { type: 'string' } },
  });
  const folder = positionals[0] ?? process.cwd();
  const concurrency = parseConcurrency(values.concurrency, io);
  if (concurrency === undefined) return 1;
  return runStatus({ folder, concurrency }, io);
}

async function runWatchCommand(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { debounce: { type: 'string' } },
  });
  const folder = positionals[0] ?? process.cwd();
  const debounceMs = values.debounce ? Number.parseInt(values.debounce, 10) : DEFAULT_DEBOUNCE_MS;
  if (!Number.isInteger(debounceMs) || debounceMs < 0) {
    io.errln('--debounce must be a non-negative integer (milliseconds)');
    return 1;
  }
  return runWatch({ folder, debounceMs }, io);
}

async function runOpenCommand(rest: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { 'no-browser': { type: 'boolean', default: false } },
  });
  const folder = positionals[0] ?? process.cwd();
  return runOpen({ folder, noBrowser: values['no-browser'] }, io);
}

async function runServeCommand(rest: string[], io: Io): Promise<number> {
  const [subcommand, ...flags] = rest;
  const { values } = parseArgs({
    args: flags,
    allowPositionals: false,
    options: {
      foreground: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  return runServe(subcommand, { foreground: values.foreground, json: values.json }, io);
}

async function runProjectsCommand(rest: string[], io: Io): Promise<number> {
  const [subcommand] = rest;
  if (subcommand !== 'list') {
    io.errln(
      `Unknown "vorlyn projects" subcommand: ${subcommand ?? '(none)'}. Use "vorlyn projects list".`,
    );
    return 1;
  }
  const entries = await listFolderProjects(resolveDataDir());
  if (entries.length === 0) {
    io.println('No folders have been auto-linked on this machine yet.');
    return 0;
  }
  io.println('folder\tproject id\tproject name\tlinked at');
  for (const entry of entries) {
    io.println(`${entry.folder}\t${entry.projectId}\t${entry.projectName}\t${entry.linkedAt}`);
  }
  return 0;
}
