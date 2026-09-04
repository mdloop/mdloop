#!/usr/bin/env node
/**
 * The packaging smoke test — proves the published `mdloop` npm package
 * actually works when installed from a real tarball into a directory with
 * no relationship to this repo. Not a vitest file: this is a build-artifact
 * test, not a unit test — it shells out to `npm`, writes outside the repo,
 * and takes minutes, which would slow down `pnpm verify`'s fast local loop
 * if it lived there. Invoked via `pnpm smoke:package`, itself part of the
 * separate `pnpm verify:release` gate (Phase 4/5 of the release plan).
 *
 * Requires `pnpm build && pnpm build:package` to have already run — this
 * script never builds anything itself, so a failure here is never "the
 * build was stale," only "the published artifact is genuinely broken."
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const mdloopPkgDir = path.join(repoRoot, 'packages', 'mdloop');

const STALE_IDENTIFIERS = ['chevron', 'baton', 'vorlyn']; // brand-check:allow — searched for, not used as branding
const OVERALL_TIMEOUT_MS = 180_000;

let step = '(not started)';
const cleanup = [];

async function main() {
  const startedAt = Date.now();

  step = 'assert prior build exists';
  for (const rel of [
    'dist/cli/main.js',
    'dist/api/selfhost-embedded-main.js',
    'dist/mcp/selfhost-embedded-main.js',
    'dist/web/index.html',
  ]) {
    const p = path.join(mdloopPkgDir, rel);
    if (!existsSync(p)) {
      fail(
        `missing ${p} — run "pnpm build && pnpm build:package" first, this script builds nothing itself.`,
      );
    }
  }

  step = 'npm pack';
  const packTmpDir = await mkdtempTracked('mdloop-smoke-pack-');
  const packResult = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', packTmpDir], {
      cwd: mdloopPkgDir,
      encoding: 'utf8',
    }),
  );
  const tarballName = packResult[0].filename;
  const tarballPath = path.join(packTmpDir, tarballName);
  log(`tarball: ${tarballPath} (${(packResult[0].size / 1024).toFixed(0)} KiB)`);

  step = 'tarball content assertions';
  const entries = await listTarEntries(tarballPath);
  await assertTarballContents(tarballPath, entries);
  await assertNoBrandOrPathLeaks(tarballPath, entries);

  step = 'set up install + project dirs';
  const installDir = await mkdtempTracked('mdloop-smoke-install-');
  const projectDir = await mkdtempTracked('mdloop-smoke-project-');
  const dataDir = await mkdtempTracked('mdloop-smoke-data-');
  await writeFile(
    path.join(installDir, 'package.json'),
    '{"name":"smoke","private":true}\n',
    'utf8',
  );
  await writeFile(path.join(projectDir, 'notes.md'), '# Smoke test doc\n\nHello.\n', 'utf8');

  step = 'npm install the tarball (default, with optionalDependencies)';
  const installStart = Date.now();
  execFileSync('npm', ['install', tarballPath, '--no-audit', '--no-fund'], {
    cwd: installDir,
    stdio: 'inherit',
  });
  log(`npm install took ${((Date.now() - installStart) / 1000).toFixed(1)}s`);
  const installedSizeKb = await duKb(path.join(installDir, 'node_modules'));
  log(`installed node_modules size: ${installedSizeKb} KiB`);

  const bin = path.join(installDir, 'node_modules', '.bin', 'mdloop');
  if (!existsSync(bin)) fail(`no bin at ${bin} after install.`);

  step = 'mdloop --help';
  const helpResult = await execFileAsync(bin, ['--help']);
  assertContains(helpResult.stdout, 'Usage:', '--help stdout');

  step = 'mdloop open (own mode)';
  const openEnv = {
    ...process.env,
    MDLOOP_DATA_DIR: dataDir,
    PORT: '59921',
    MCP_PORT: '59922',
  };
  const openChild = spawn(bin, ['open', projectDir, '--no-browser'], { env: openEnv });
  const openOutput = { out: '', err: '' };
  openChild.stdout.on('data', (d) => (openOutput.out += d.toString()));
  openChild.stderr.on('data', (d) => (openOutput.err += d.toString()));

  /**
   * SIGINT first (what `mdloop open`'s own signal handler listens for —
   * `packages/cli/src/open.ts`), only escalating to SIGKILL if it doesn't
   * exit within the grace period. This isn't just politeness: `mdloop
   * open`'s own graceful-shutdown path is what stops its api/mcp
   * *grandchildren* — a bare SIGKILL on this process alone does not
   * cascade to processes IT spawned, so a first version of this script
   * that SIGKILLed unconditionally in its error-path cleanup left two
   * orphaned `selfhost-embedded-main.js` processes running indefinitely
   * after every failed run (found by actually running it and checking
   * `ps` afterward, not anticipated in advance).
   */
  async function stopOpenChildGracefully(assertCleanExit) {
    if (openChild.exitCode !== null || openChild.killed) return;
    const exitPromise = new Promise((resolve) => openChild.once('exit', (code) => resolve(code)));
    openChild.kill('SIGINT');
    const graceful = await Promise.race([
      exitPromise.then(() => true),
      delay(15_000).then(() => false),
    ]);
    if (!graceful) {
      log('mdloop open did not exit within 15s of SIGINT — escalating to SIGKILL.');
      openChild.kill('SIGKILL');
      await Promise.race([exitPromise, delay(5_000)]);
      if (assertCleanExit) fail('mdloop open did not exit gracefully within 15s of SIGINT.');
      return;
    }
    const code = await exitPromise;
    if (assertCleanExit) assertEqual(code, 0, 'mdloop open exit code after SIGINT');
  }
  cleanup.push(() => stopOpenChildGracefully(false));

  await waitFor(
    () => openOutput.out.includes('mdloop is running at'),
    30_000,
    'waiting for "mdloop is running at" from mdloop open',
    () => `stdout so far:\n${openOutput.out}\nstderr so far:\n${openOutput.err}`,
  );

  const rootUrl = `http://127.0.0.1:${openEnv.PORT}`;
  const mcpEndpoint = `http://127.0.0.1:${openEnv.MCP_PORT}/mcp`;

  step = 'readyz on both children';
  await assertOk(await fetch(`${rootUrl}/readyz`), `${rootUrl}/readyz`);
  await assertOk(await fetch(`http://127.0.0.1:${openEnv.MCP_PORT}/readyz`), 'mcp readyz');

  step = 'the SPA actually served from the installed tarball';
  const indexRes = await fetch(`${rootUrl}/`);
  assertEqual(indexRes.status, 200, 'GET / status');
  const indexHtml = await indexRes.text();
  const scriptMatch = indexHtml.match(/<script[^>]+type="module"[^>]+src="([^"]+)"/);
  if (!scriptMatch)
    fail('index.html has no <script type="module" src="..."> tag — is this really the built SPA?');
  const assetUrl = new URL(scriptMatch[1], rootUrl).toString();
  const assetRes = await fetch(assetUrl);
  assertEqual(assetRes.status, 200, `GET ${assetUrl} status`);
  const assetContentType = assetRes.headers.get('content-type') ?? '';
  if (!/javascript/.test(assetContentType)) {
    fail(`expected a JS content-type for ${assetUrl}, got "${assetContentType}"`);
  }
  log(
    'SPA confirmed served from the installed package — this is the one thing nothing else verifies.',
  );

  step = 'pgdata is real and non-empty';
  const pgdataDir = path.join(dataDir, 'pgdata');
  const pgdataFiles = await statOrEmpty(pgdataDir);
  if (pgdataFiles === 0) fail(`${pgdataDir} is empty — embedded Postgres never really booted.`);

  step = 'real MCP round trip: initialize, tools/list, list_documents';
  const apiKey = await readMdloopApiKey(projectDir);
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  });
  const mcpClient = new Client({ name: 'mdloop-smoke-test', version: '0.0.1' });
  // Registered for cleanup immediately, not only after a successful round
  // trip — an open StreamableHTTP connection keeps Node's event loop alive
  // indefinitely otherwise, which left an earlier version of this script
  // hanging well past its own overall timeout when this step failed before
  // ever reaching a close() call (found by running it, not anticipated).
  cleanup.push(() => mcpClient.close().catch(() => undefined));
  await mcpClient.connect(transport);
  const toolsResult = await mcpClient.listTools();
  const toolNames = toolsResult.tools.map((t) => t.name);
  for (const expected of ['list_projects', 'list_documents', 'upload_document']) {
    if (!toolNames.includes(expected)) {
      fail(`tools/list is missing "${expected}" — got: ${toolNames.join(', ')}`);
    }
  }
  const docsResult = await mcpClient.callTool({ name: 'list_documents', arguments: {} });
  // `docsResult.content[0].text` is itself a JSON string (MCP wraps tool
  // results as text blocks) — parse it rather than substring-matching the
  // outer envelope, which double-escapes its quotes under JSON.stringify
  // and silently never matches a bare `"notes"` pattern (found by running
  // this and seeing a real doc get misreported as missing).
  const docsList = JSON.parse(docsResult.content?.[0]?.text ?? '[]');
  // The server strips the extension for `title` ("notes.md" -> "notes").
  if (!Array.isArray(docsList) || !docsList.some((d) => d.title === 'notes')) {
    fail(
      `list_documents didn't return the pushed "notes" doc — "mdloop open" push may not have worked. Got: ${JSON.stringify(docsResult)}`,
    );
  }
  log(
    'MCP round trip proved: migrations ran, RLS worked, project auto-provisioned, doc pushed and listed.',
  );

  step = 'SIGINT shuts mdloop open down cleanly';
  await stopOpenChildGracefully(true);
  await assertPortDead(openEnv.PORT);
  await assertPortDead(openEnv.MCP_PORT);
  await assertNoSurvivingChildren(installDir);

  step = 'second phase: mdloop serve start / status / stop';
  const serveDataDir = await mkdtempTracked('mdloop-smoke-serve-data-');
  const serveEnv = {
    ...process.env,
    MDLOOP_DATA_DIR: serveDataDir,
    PORT: '59931',
    MCP_PORT: '59932',
  };
  await execFileAsync(bin, ['serve', 'start'], { env: serveEnv, timeout: 60_000 });
  const statusResult = await execFileAsync(bin, ['serve', 'status', '--json'], { env: serveEnv });
  const status = JSON.parse(statusResult.stdout);
  if (status.state !== 'running')
    fail(`"serve status --json" reported state "${status.state}", expected "running".`);
  await execFileAsync(bin, ['serve', 'stop'], { env: serveEnv, timeout: 30_000 });
  await assertPortDead(serveEnv.PORT);
  await assertPortDead(serveEnv.MCP_PORT);
  await assertNoSurvivingChildren(installDir);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`\nsmoke-install: ALL GREEN in ${elapsed}s. Installed size: ${installedSizeKb} KiB.`);
}

// ---- tarball inspection --------------------------------------------------

/**
 * `tar -tzf` (no `-v`) — a bare, one-name-per-line listing, not the verbose
 * `-tv` column format. Deliberately not parsing `-tv` output: GNU tar
 * (ubuntu-latest, what CI actually runs on) and BSD/libarchive tar (macOS,
 * what this was developed and passed on locally) format that listing
 * differently — different column layout for the owner field, different
 * date format — and a regex tuned against one silently mis-parses the
 * other. `-tzf`'s plain name-per-line output has no such divergence, so
 * there's nothing version/platform-specific left to get subtly wrong.
 */
async function listTarEntries(tarballPath) {
  const { stdout } = await execFileAsync('tar', ['-tzf', tarballPath]);
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((name) => ({ name }));
}

/** Whether `entryName` has the executable bit set inside the tarball —
 *  extracts just that one file to a temp dir and checks its real mode via
 *  `fs.statSync`, rather than parsing tar's own permission-column text
 *  (see `listTarEntries`'s doc comment for why that's the wrong layer to
 *  parse portably). */
async function isExecutableInTarball(tarballPath, entryName) {
  const extractDir = await mkdtempTracked('mdloop-smoke-exec-check-');
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir, entryName]);
  const mode = statSync(path.join(extractDir, entryName)).mode;
  return (mode & 0o111) !== 0;
}

async function assertTarballContents(tarballPath, entries) {
  const names = new Set(entries.map((e) => e.name));
  const mustExist = [
    'package/dist/cli/main.js',
    'package/dist/api/selfhost-embedded-main.js',
    'package/dist/mcp/selfhost-embedded-main.js',
    'package/dist/web/index.html',
    'package/LICENSE',
    'package/NOTICE',
  ];
  for (const name of mustExist) {
    if (!names.has(name)) fail(`tarball is missing ${name}`);
  }
  if (![...names].some((n) => n.startsWith('package/dist/web/assets/'))) {
    fail('tarball has no package/dist/web/assets/* files.');
  }
  const migrationCount = [...names].filter(
    (n) => n.startsWith('package/dist/migrations/') && n.endsWith('.sql'),
  ).length;
  if (migrationCount !== 33) {
    fail(`expected exactly 33 migrations in the tarball, found ${migrationCount}.`);
  }

  if (!(await isExecutableInTarball(tarballPath, 'package/dist/cli/main.js'))) {
    fail('package/dist/cli/main.js is not executable in the tarball.');
  }

  const forbidden = [...names].filter(
    (n) =>
      n.endsWith('.test.js') ||
      n.includes('/src/') ||
      n.includes('node_modules/') ||
      n.endsWith('.tsbuildinfo') ||
      /\.env(\.|$)/.test(path.basename(n)),
  );
  if (forbidden.length > 0) {
    fail(`tarball contains files it shouldn't:\n${forbidden.map((f) => `  - ${f}`).join('\n')}`);
  }

  log(
    `tarball contents OK — ${names.size} entries, ${migrationCount} migrations, bin is executable.`,
  );
}

/**
 * Word-boundary-aware, same idiom as scripts/dev/check-rename-consistency.mjs
 * (`${word}(?![a-zA-Z])`) — a bare substring grep produces real false
 * positives here: cytoscape.esm-*.js (a vendored graphing library bundled
 * into the SPA) contains the literal string "chevron" as a generic (brand-check:allow)
 * UI/arrowhead-shape term, unrelated to this project's retired name, and
 * packages/web/src/components/mdloop-mark.tsx carries a legitimate,
 * already-`brand-check:allow`-marked comment mentioning "baton" as design
 * history. Scoped to this project's own bundled JS (dist/cli, dist/api,
 * dist/mcp) rather than the vendored dist/web/assets/* bundle — the brand
 * leak this check cares about is in code this project authored, not a
 * third-party library it happens to depend on. Also checks for absolute-path
 * leaks and stray session/porting metadata across the same files.
 */
async function assertNoBrandOrPathLeaks(tarballPath, entries) {
  const targets = entries
    .map((e) => e.name)
    .filter(
      (n) =>
        (n.startsWith('package/dist/cli/') ||
          n.startsWith('package/dist/api/') ||
          n.startsWith('package/dist/mcp/')) &&
        (n.endsWith('.js') || n.endsWith('.js.map')),
    );
  if (targets.length === 0) fail('no cli/api/mcp .js or .js.map files found to content-scan.');

  const extractDir = await mkdtempTracked('mdloop-smoke-extract-');
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractDir, ...targets]);

  const patterns = [
    ...STALE_IDENTIFIERS.map((word) => ({
      re: new RegExp(`${word}(?![a-zA-Z])`, 'i'),
      label: `retired identifier "${word}"`,
    })),
    { re: /\/Users\//, label: 'absolute macOS home path' },
    { re: /\/home\//, label: 'absolute Linux home path' },
    { re: /claude\.ai\/code\/session/, label: 'Claude session URL' },
    { re: /Ported-from:/, label: 'internal porting metadata' },
  ];

  const hits = [];
  for (const name of targets) {
    const content = await readFile(path.join(extractDir, name), 'utf8');
    for (const { re, label } of patterns) {
      if (re.test(content)) hits.push(`${name}: ${label}`);
    }
  }
  if (hits.length > 0) {
    fail(`content leak(s) found in the bundled output:\n${hits.map((h) => `  - ${h}`).join('\n')}`);
  }
  log(`content-scanned ${targets.length} first-party bundle file(s) — clean.`);
}

// ---- process / network assertions ---------------------------------------

async function readMdloopApiKey(projectDir) {
  const credsPath = path.join(projectDir, '.mdloop', 'credentials');
  const raw = await readFile(credsPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.apiKey !== 'string') fail(`${credsPath} has no string apiKey field.`);
  return parsed.apiKey;
}

async function assertPortDead(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
    fail(`port ${port} is still answering after shutdown.`);
  } catch {
    // Expected — connection refused / timeout means it's actually down.
  }
}

/**
 * Scoped to `installDir`, not a bare "selfhost-embedded-main" match — this
 * machine may genuinely have an unrelated, pre-existing `mdloop serve`
 * daemon running (dogfooding, a developer's own local instance), whose
 * `selfhost-embedded-main.js` processes run from this *repo's* `packages/`
 * tree, not from this test's temp install directory. A blind grep treats
 * that daemon as an orphan from this run and fails a test that actually
 * passed (found by running this against a machine with exactly such a
 * daemon already running, not anticipated in advance).
 */
async function assertNoSurvivingChildren(installDir) {
  const { stdout } = await execFileAsync('sh', [
    '-c',
    `ps aux | grep selfhost-embedded-main | grep ${JSON.stringify(installDir)} | grep -v grep || true`,
  ]);
  if (stdout.trim().length > 0) {
    fail(`orphaned selfhost-embedded-main process(es) survived shutdown:\n${stdout}`);
  }
}

async function statOrEmpty(dir) {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

async function duKb(dir) {
  try {
    const { stdout } = await execFileAsync('du', ['-sk', dir]);
    return Number.parseInt(stdout.split('\t')[0], 10);
  } catch {
    return -1;
  }
}

// ---- small helpers --------------------------------------------------------

function log(message) {
  console.log(`smoke-install: ${message}`);
}

function fail(message) {
  console.error(`\nsmoke-install: FAILED at step "${step}"\n  ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected)
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertContains(haystack, needle, label) {
  if (!haystack.includes(needle))
    fail(`${label} does not contain ${JSON.stringify(needle)}. Got:\n${haystack}`);
}

async function assertOk(response, label) {
  if (!response.ok) fail(`${label} returned ${response.status}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label, describeState) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(200);
  }
  fail(`timed out ${label}.\n${describeState ? describeState() : ''}`);
}

async function mkdtempTracked(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ---- entry ----------------------------------------------------------------

const overallTimeout = setTimeout(() => {
  console.error(
    `\nsmoke-install: FAILED — overall ${OVERALL_TIMEOUT_MS / 1000}s timeout exceeded at step "${step}"`,
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
