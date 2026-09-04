#!/usr/bin/env node
/**
 * The real-registry + real-plugin smoke test — proves that a genuinely
 * published `vorlyn` npm version, combined with the real `vorlyn-sync`
 * Claude Code plugin (from whatever marketplace source is configured on
 * this machine), can carry a document all the way through publish -> human
 * feedback -> agent revision -> resolution. Where `smoke-install.mjs` tests
 * "does the tarball we're about to publish work", this tests "does the
 * thing we already published, plus the plugin around it, actually work" —
 * complementary, not redundant, and meant to run AFTER a publish, not
 * before one.
 *
 * Manual, not CI: needs the real `claude` CLI (skips gracefully if absent —
 * see below) and mutates a small, fully-cleaned-up slice of this machine's
 * real `~/.claude.json` (the plugin's SessionStart hook does that for
 * real, on purpose — this test exercises the real hook script, not a
 * simulation of it). That's a reasonable ask of a maintainer's own machine
 * after a release; it is not something to hand to a shared CI runner.
 *
 * Usage:
 *   pnpm smoke:plugin-loop [dist-tag-or-version]   # default: latest
 *
 * What it does NOT test: the actual human-in-a-browser review experience.
 * The "reviewer" here is this script, calling the same MCP tools a human's
 * browser session would trigger — it proves the mechanics (push, comment,
 * read feedback, revise, resolve, plugin hook, MCP registration) work, not
 * that the web UI looks right. See SELF_HOSTING.md / the release plan for
 * the separate, occasional, real-human walkthrough.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const execFileAsync = promisify(execFile);
const OVERALL_TIMEOUT_MS = 300_000;
const target = process.argv[2] ?? 'latest';

let step = '(not started)';
const cleanup = [];

async function main() {
  const startedAt = Date.now();

  step = 'preflight: claude CLI present';
  const claudeBin = await which('claude');
  if (!claudeBin) {
    log(
      'no "claude" CLI on PATH — this test exercises the real Claude Code plugin hook, which ' +
        'needs it. Skipping (exit 0), not failing: a machine without Claude Code installed is a ' +
        "valid environment, just not one this test can run on. Run this by hand on a maintainer's " +
        'own machine after a publish.',
    );
    return;
  }

  step = 'preflight: vorlyn marketplace registered';
  const { stdout: marketplaces } = await execFileAsync(claudeBin, [
    'plugin',
    'marketplace',
    'list',
  ]);
  if (!/vorlyn/.test(marketplaces)) {
    fail(
      'no "vorlyn" marketplace configured (claude plugin marketplace list). Add one first — ' +
        '`claude plugin marketplace add imjasdeepk/vorlyn` for the real distribution path — ' +
        'this test does not add it for you, since that is a one-time developer-machine setup ' +
        'step, not something to redo on every run.',
    );
  }

  step = `npm install vorlyn@${target} into an isolated prefix`;
  const npmPrefix = await mkdtempTracked('vorlyn-smoke-plugin-npm-');
  execFileSync(
    'npm',
    ['install', '-g', `vorlyn@${target}`, '--prefix', npmPrefix, '--no-audit', '--no-fund'],
    {
      stdio: 'inherit',
    },
  );
  const vorlynBin = path.join(npmPrefix, 'bin', 'vorlyn');
  const versionResult = await execFileAsync(vorlynBin, ['--help']);
  assertContains(versionResult.stdout, 'Usage:', 'vorlyn --help stdout');
  log(`installed from the real registry at tag/version "${target}", isolated at ${npmPrefix}`);

  step = 'set up an isolated git project';
  const projectDir = await mkdtempTracked('vorlyn-smoke-plugin-project-');
  const dataDir = await mkdtempTracked('vorlyn-smoke-plugin-data-');
  await execFileAsync('git', ['init', '-q'], { cwd: projectDir });
  await execFileAsync('git', ['config', 'user.email', 'smoke-test@example.com'], {
    cwd: projectDir,
  });
  await execFileAsync('git', ['config', 'user.name', 'Smoke Test'], { cwd: projectDir });
  const docPath = path.join(projectDir, 'design-note.md');
  const originalContent =
    '# Dark mode toggle\n\nA fictional feature used only to exercise the real review loop.\n' +
    '\n## Open questions\n\n- Where does the toggle live in the nav?\n';
  await writeFile(docPath, originalContent, 'utf8');
  await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });

  step = 'run the real SessionStart hook (vorlyn-ensure.sh)';
  const hookPath = await resolveHookScript(claudeBin);
  const port = 59401;
  const mcpPort = 59402;
  const hookEnv = {
    ...process.env,
    VORLYN_CLI_PATH: vorlynBin,
    VORLYN_DATA_DIR: dataDir,
    PORT: String(port),
    MCP_PORT: String(mcpPort),
    // Isolated bin dir FIRST, not a wiped PATH — the hook's own `command -v
    // vorlyn` must resolve to this isolated install, not this machine's
    // real global one (or a dev symlink), but git/sh/node still need the
    // rest of the real PATH to work at all (the hook's first line is
    // `git rev-parse --show-toplevel`).
    PATH: `${path.dirname(vorlynBin)}:${process.env.PATH ?? ''}`,
  };
  cleanup.push(() => stopServeGracefully(vorlynBin, dataDir));
  await execFileAsync(hookPath, [], { cwd: projectDir, env: hookEnv });

  step = 'assert the hook actually started a fresh instance and linked the folder';
  await assertOk(await fetch(`http://127.0.0.1:${port}/readyz`), 'api /readyz');
  const manifestPath = path.join(projectDir, '.vorlyn', 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest.endpoint?.includes(String(mcpPort))) {
    fail(`manifest.json's endpoint (${manifest.endpoint}) doesn't point at this test's mcp port.`);
  }
  log('hook confirmed: fresh instance up on isolated ports, folder linked.');

  step = 'assert the hook registered the real Claude Code MCP client (claude mcp list)';
  const mcpListBefore = await execFileAsync(claudeBin, ['mcp', 'list'], { cwd: projectDir });
  if (!new RegExp(`vorlyn:.*${mcpPort}`).test(mcpListBefore.stdout)) {
    fail(
      `"claude mcp list" (run from the test project dir) doesn't show a vorlyn entry on port ${mcpPort}:\n${mcpListBefore.stdout}`,
    );
  }
  // Registered for cleanup immediately: if a later step fails, this must
  // still not leak a stale project-scoped entry into ~/.claude.json.
  cleanup.push(() => removeMcpRegistration(claudeBin, projectDir));
  log(
    'hook confirmed: real MCP registration present in the real ~/.claude.json, scoped to this test project only.',
  );

  step = "push the doc (vorlyn-sync skill's own command)";
  await execFileAsync(vorlynBin, ['push', projectDir, '--note', 'Initial design note'], {
    env: hookEnv,
  });
  const manifestAfterPush = JSON.parse(await readFile(manifestPath, 'utf8'));
  const documentId = manifestAfterPush.files?.['design-note.md']?.documentId;
  if (!documentId)
    fail('vorlyn push did not record a documentId for design-note.md in the manifest.');
  log(`pushed — document ${documentId}`);

  step = 'connect over real MCP (same client the vorlyn-review skill uses)';
  const apiKey = JSON.parse(
    await readFile(path.join(projectDir, '.vorlyn', 'credentials'), 'utf8'),
  ).apiKey;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const mcp = new Client({ name: 'vorlyn-smoke-plugin-loop', version: '0.0.1' });
  cleanup.push(() => mcp.close().catch(() => undefined));
  await mcp.connect(transport);

  step = 'simulate the human reviewer: leave a whole-document comment';
  const commentResult = await callTool(mcp, 'create_comment', {
    document_id: documentId,
    body: 'Please spell out where the toggle lives in the nav before this ships.',
  });
  const commentId = commentResult.comment_id ?? commentResult.commentId;
  if (!commentId)
    fail(`create_comment returned no comment id. Got: ${JSON.stringify(commentResult)}`);
  log(`comment ${commentId} left, simulating a human review.`);

  step = 'agent reads the feedback back (get_feedback_bundle)';
  const bundle = await callTool(mcp, 'get_feedback_bundle', { document_id: documentId });
  if (!bundle.items?.some((item) => item.commentId === commentId && item.body.includes('nav'))) {
    fail(
      `get_feedback_bundle doesn't surface the comment just left. Got: ${JSON.stringify(bundle)}`,
    );
  }
  log('feedback bundle round trip confirmed: the human comment reached the agent.');

  step = 'agent revises and pushes again';
  const revisedContent = originalContent.replace(
    '- Where does the toggle live in the nav?',
    '- Toggle lives in the user menu, next to "Sign out" — resolved 2026.',
  );
  await writeFile(docPath, revisedContent, 'utf8');
  await execFileAsync(
    vorlynBin,
    ['push', projectDir, '--note', 'Answered nav placement question'],
    {
      env: hookEnv,
    },
  );
  const status = await callTool(mcp, 'get_document_status', { document_id: documentId });
  if ((status.version_seq ?? 0) < 2) {
    fail(`expected the revision to create version_seq >= 2. Got: ${JSON.stringify(status)}`);
  }
  log('revision pushed as a real new version.');

  step = 'agent resolves the comment thread';
  await callTool(mcp, 'resolve_comment', { comment_id: commentId });
  const bundleAfter = await callTool(mcp, 'get_feedback_bundle', { document_id: documentId });
  if (bundleAfter.items?.some((item) => item.commentId === commentId)) {
    fail(
      `resolved comment still appears in get_feedback_bundle (which only lists UNRESOLVED items). Got: ${JSON.stringify(bundleAfter)}`,
    );
  }
  log('comment resolved — the full publish -> review -> revise -> resolve loop closed for real.');

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`\nsmoke-published-plugin: ALL GREEN in ${elapsed}s against vorlyn@${target}.`);
}

// ---- helpers ---------------------------------------------------------------

async function callTool(mcp, name, args) {
  const result = await mcp.callTool({ name, arguments: args });
  if (result.isError) fail(`MCP tool "${name}" returned an error: ${JSON.stringify(result)}`);
  // get_feedback_bundle is the one tool that returns BOTH a prose text block
  // (content[0].text — a prompt-ready summary, not JSON) and real structured
  // data (structuredContent) — every other tool's text block IS its JSON.
  // Preferring structuredContent when present covers both correctly.
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string')
    fail(`MCP tool "${name}" returned no text content: ${JSON.stringify(result)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The hook lives inside `~/.claude/plugins/cache/<marketplace>/<plugin>/
 * <version>/hooks/vorlyn-ensure.sh` — a versioned cache of what got
 * installed, not this working tree. Resolving it from there (rather than
 * hardcoding `claude-plugin/hooks/vorlyn-ensure.sh` relative to this
 * script) is what makes this test exercise the exact artifact a real
 * install pulled down, not this developer's possibly-ahead-of-published
 * local copy. The version comes from `claude plugin list`, not just "newest
 * cached dir" — multiple versions can sit in cache at once (e.g. after an
 * update before a restart), and only the one actually enabled matters here.
 */
async function resolveHookScript(claudeBin) {
  const { stdout: listOutput } = await execFileAsync(claudeBin, ['plugin', 'list']);
  const versionMatch = listOutput.match(/vorlyn-sync@vorlyn\s*\n\s*Version:\s*(\S+)/);
  if (!versionMatch) {
    fail(
      `could not find "vorlyn-sync@vorlyn"'s installed version from "claude plugin list". Output:\n${listOutput}`,
    );
  }
  const hookPath = path.join(
    process.env.HOME ?? '',
    '.claude',
    'plugins',
    'cache',
    'vorlyn',
    'vorlyn-sync',
    versionMatch[1],
    'hooks',
    'vorlyn-ensure.sh',
  );
  await execFileAsync('test', ['-x', hookPath]).catch(() => {
    fail(`resolved hook path is not an executable file: ${hookPath}`);
  });
  return hookPath;
}

async function removeMcpRegistration(claudeBin, projectDir) {
  await execFileAsync(claudeBin, ['mcp', 'remove', 'vorlyn', '--scope', 'local'], {
    cwd: projectDir,
  }).catch(() => undefined);
}

async function stopServeGracefully(vorlynBin, dataDir) {
  await execFileAsync(vorlynBin, ['serve', 'stop'], {
    env: { ...process.env, VORLYN_DATA_DIR: dataDir },
    timeout: 20_000,
  }).catch(() => undefined);
}

async function which(bin) {
  try {
    const { stdout } = await execFileAsync('command', ['-v', bin], { shell: '/bin/bash' });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function log(message) {
  console.log(`smoke-published-plugin: ${message}`);
}

function fail(message) {
  console.error(`\nsmoke-published-plugin: FAILED at step "${step}"\n  ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle)) fail(`${label} does not contain ${JSON.stringify(needle)}.`);
}

async function assertOk(response, label) {
  if (!response.ok) fail(`${label} returned ${response.status}`);
}

async function mkdtempTracked(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---- entry ------------------------------------------------------------------

const overallTimeout = setTimeout(() => {
  console.error(
    `\nsmoke-published-plugin: FAILED — overall ${OVERALL_TIMEOUT_MS / 1000}s timeout exceeded at step "${step}"`,
  );
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
overallTimeout.unref();

try {
  await main();
} catch (error) {
  if (process.exitCode === undefined) process.exitCode = 1;
  console.error(error instanceof Error ? error.stack : error);
} finally {
  clearTimeout(overallTimeout);
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      // best-effort cleanup
    }
  }
}
