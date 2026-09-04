import { createInterface } from 'node:readline/promises';
import type { Trigger } from './mdloop-config.js';
import { ensureMdloopConfig, readMdloopConfig } from './mdloop-config.js';
import { ensureMdloopDir } from './mdloop-dir.js';
import { readLocalBootstrapApiKey, resolveApiKey, writeCredentials } from './credentials.js';
import { resolveDataDir } from './data-dir.js';
import { EndpointRefusedError, endpointOrigin, isLocalEndpoint } from './endpoint-trust.js';
import { GIT_HOOK_PUSH_LINE, installGitPostCommitHook } from './git-hook.js';
import { liveInstance } from './instance-record.js';
import { connectTrustedMcpClient } from './mcp-client.js';
import type { Manifest } from './manifest.js';
import { readManifest, writeManifest } from './manifest.js';
import type { Io } from './output.js';
import { resolveProjectForFolder } from './project-resolution.js';

export const DEFAULT_ENDPOINT = 'http://localhost:3001/mcp';

export interface LinkOptions {
  folder: string;
  projectId?: string;
  endpoint?: string;
  /**
   * Trigger recorded in `.mdloop/config.json`. Defaults to `'commit'` (the
   * harness-agnostic git hook); the caller in `cli.ts` maps `--trigger`.
   * Ignored when the repo already has a config — see `ensureMdloopConfig`.
   */
  trigger?: Trigger;
  /** `false` for `mdloop link --no-git-hook`. Defaults to installing. */
  installGitHook?: boolean;
  /**
   * Reuse-or-create a project named after the folder instead of prompting
   * (`--project` always wins regardless of this — see the check below).
   * Only takes effect against a local endpoint (`isLocalEndpoint`):
   * auto-creating a project on a shared team server because someone
   * mistyped a directory name is the one genuinely bad outcome here, so a
   * remote endpoint falls through to the TTY-picker/non-TTY-error behavior
   * unconditionally, exactly as if this were unset.
   */
  autoProvision?: boolean;
  /**
   * Overrides where `autoProvision`'s folder→project mapping is read/
   * written (`resolveDataDir()` by default — the real, per-machine data
   * directory). Exists purely so tests can point it at a throwaway temp
   * directory instead of touching the developer's actual data directory;
   * no CLI flag ever sets this, and no real caller should either.
   */
  dataDir?: string;
}

/** Injectable so tests never touch a real TTY/stdin. */
export interface LinkPrompt {
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
}

const realPrompt: LinkPrompt = {
  isTTY: process.stdout.isTTY,
  async ask(question: string) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

/**
 * `mdloop link` — binds a local folder to an existing mdloop project.
 * Idempotent: relinking overwrites
 * projectId/endpoint but preserves any already-tracked file entries.
 *
 * This is also the trust-on-first-use moment for the endpoint: the first
 * successful connect pins its origin to the (gitignored) trust file, and
 * every later `link`/`push`/`status` refuses a manifest that has been
 * repointed since — see `endpoint-trust.ts`.
 */
export async function runLink(
  options: LinkOptions,
  io: Io,
  prompt: LinkPrompt = realPrompt,
): Promise<number> {
  // Before anything else, so a folder can never hold a credentials file
  // without the .gitignore that keeps it out of git.
  await ensureMdloopDir(options.folder);

  const dataDir = options.dataDir ?? resolveDataDir();
  const existing = await readManifest(options.folder);
  let endpoint = options.endpoint ?? existing?.endpoint ?? process.env.MDLOOP_MCP_URL;
  if (!endpoint) {
    // No explicit source named one — before falling all the way back to the
    // fixed `DEFAULT_ENDPOINT`, check whether a local instance is actually
    // running right now and use *its* real endpoint instead. This matters
    // because `DEFAULT_ENDPOINT` names a fixed port (3001) that stopped
    // meaning anything the moment ports became OS-assigned: a bare
    // `mdloop link` (this is exactly what `mdloop-ensure.sh` and a human
    // typing the bare command both do) would otherwise reliably fail to
    // connect to whatever random port the real running daemon actually
    // landed on. `DEFAULT_ENDPOINT` itself is kept as the final fallback for
    // the genuinely-nothing-running case, so the resulting connection
    // failure still names a concrete, meaningful address rather than
    // "undefined".
    const live = await liveInstance(dataDir);
    endpoint = live?.mcpEndpoint ?? DEFAULT_ENDPOINT;
  }

  let apiKey = await resolveApiKey(options.folder);
  if (!apiKey && options.autoProvision && isLocalEndpoint(endpoint)) {
    // Same bootstrap key `mdloop open` reads to complete its own first
    // link, reached from here too: against a local endpoint, with
    // auto-provisioning on, "link does not create one" would otherwise mean
    // a folder that was never `mdloop open`ed by hand can never link at
    // all — exactly the case `mdloop-ensure.sh`'s bare `mdloop link` hits
    // for a brand-new repo. Persisted via `writeCredentials` so this only
    // ever happens once per folder, same as any other link.
    const bootstrapKey = await readLocalBootstrapApiKey(dataDir);
    if (bootstrapKey) {
      await writeCredentials(options.folder, { apiKey: bootstrapKey });
      apiKey = bootstrapKey;
    }
  }
  if (!apiKey) {
    io.errln(
      'No API key found. Set MDLOOP_API_KEY or create .mdloop/credentials in the linked folder — link does not create one.',
    );
    return 1;
  }

  let client;
  try {
    client = await connectTrustedMcpClient(options.folder, endpoint, apiKey);
  } catch (error) {
    if (error instanceof EndpointRefusedError) io.errln(error.message);
    else io.errln(`Could not connect to ${endpoint}: ${(error as Error).message}`);
    return 1;
  }

  try {
    const projects = await client.listProjects();
    if (!projects.ok) {
      io.errln(`Could not list projects: ${projects.error.code}`);
      return 1;
    }
    const list = projects.value;

    let projectId = options.projectId;
    if (projectId) {
      if (!list.some((p) => p.id === projectId)) {
        io.errln(`project_not_found: ${projectId}`);
        return 1;
      }
    } else if (options.autoProvision && isLocalEndpoint(endpoint)) {
      if (existing) {
        // Relinking without an explicit --project: keep whatever this
        // folder is already linked to — a stronger signal than anything
        // resolveProjectForFolder could reconstruct, and this is also what
        // keeps the "already linked to a different project" refusal below
        // from ever firing on this path.
        projectId = existing.projectId;
      } else {
        const resolved = await resolveProjectForFolder(
          {
            folder: options.folder,
            dataDir,
            endpointOrigin: endpointOrigin(endpoint),
            projects: list,
            createProject: (name, color) => client.createProject(name, color),
          },
          io,
        );
        if (!resolved.ok) {
          io.errln(`Could not create a project for this folder: ${resolved.error}`);
          return 1;
        }
        projectId = resolved.value;
      }
    } else if (prompt.isTTY) {
      list.forEach((p, i) => {
        io.println(`${String(i + 1)}. ${p.name} (${p.id})`);
      });
      const answer = await prompt.ask('Select a project (number): ');
      const index = Number.parseInt(answer, 10) - 1;
      const selected = list[index];
      if (!Number.isInteger(index) || !selected) {
        io.errln('Invalid selection.');
        return 1;
      }
      projectId = selected.id;
    } else {
      io.errln('Not a TTY — pass --project <id>. Available projects:');
      list.forEach((p) => {
        io.errln(`  ${p.id}  ${p.name}`);
      });
      return 1;
    }

    // A folder links to exactly one project, ever. Repointing projectId in
    // place while leaving `files` keyed against the old project would keep
    // silently pushing already-tracked files into the old project forever —
    // see the Fix 1 writeup. "mdloop unlink" then a fresh link is the only
    // sanctioned way to switch a folder to a different project.
    if (existing && existing.projectId !== projectId) {
      io.errln(
        `This folder is already linked to project ${existing.projectId}. A folder links to one project at a time — run "mdloop unlink" here first, then "mdloop link --project ${projectId}" to switch.`,
      );
      return 1;
    }

    const manifest: Manifest = {
      endpoint,
      projectId,
      files: existing?.files ?? {},
    };
    await writeManifest(options.folder, manifest);
    io.println(`Linked ${options.folder} to project ${projectId} (${endpoint})`);

    // Only once the project and the connection are known good: a link that
    // failed validation should leave no trigger behind.
    await ensureMdloopConfig(options.folder, options.trigger ?? 'commit');
    // Read back the *resolved* trigger rather than trusting `options.trigger`:
    // on a relink where config.json already exists, `ensureMdloopConfig` is a
    // no-op and the options-level value can be stale or simply wrong — the
    // file on disk is the source of truth.
    const resolvedTrigger = (await readMdloopConfig(options.folder))?.trigger ?? 'commit';
    if (options.installGitHook !== false) {
      await reportGitHookInstall(options.folder, resolvedTrigger, io);
    }
    return 0;
  } finally {
    await client.close();
  }
}

/**
 * Installing the hook changes what an ordinary `git commit` does from here on,
 * so this is deliberately not terse success output — every outcome that
 * changed something, or that the user needs to act on, says so in full.
 */
async function reportGitHookInstall(folder: string, trigger: Trigger, io: Io): Promise<void> {
  const result = await installGitPostCommitHook(folder);
  switch (result) {
    case 'installed':
      io.println(
        'Installed a git post-commit hook — every commit will now push tracked files to mdloop automatically.',
      );
      io.println(
        'Skip this next time with --no-git-hook; delete .git/hooks/post-commit to turn it off.',
      );
      break;
    case 'updated':
      io.println('Updated the git post-commit hook to the latest version.');
      break;
    case 'foreign':
      io.println(
        'A git post-commit hook already exists and was left untouched. To enable commit-triggered sync, add this line to .git/hooks/post-commit:',
      );
      io.println(`  ${GIT_HOOK_PUSH_LINE}`);
      break;
    case 'unchanged':
      // Already correct — a routine relink should not narrate a no-op.
      break;
    case 'not_a_git_repo':
      // Not an error: linking a folder outside git is fine, it just cannot
      // have a commit trigger yet. Under `agent-turn` the Stop hook covers
      // sync regardless, so there is genuinely nothing to say. Under the
      // default `commit` trigger, though, silence here is exactly the gap
      // `trigger-drift.ts` exists to close later — better to say so now,
      // while the fix ("git init", then relink) is one step instead of a
      // mystery.
      if (trigger === 'commit') {
        io.println(
          'Not inside a git repo yet, so the commit-trigger hook was not installed. Once this ' +
            'becomes a git repo, re-run "mdloop link" to install it — until then, nothing pushes ' +
            'automatically except a manual "mdloop push" or the agent pushing proactively.',
        );
      }
      break;
  }
}
