import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const OTEL_PACKAGES = [
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/resources',
  '@opentelemetry/semantic-conventions',
];

// The compiled output, not the .ts source — same reason setup.test.ts's own
// comment gives: a plain source-mode subprocess can't resolve this fixture's
// relative-import specifiers under --experimental-strip-types. `pnpm verify`
// always runs `typecheck` (which builds dist) before `test`; run `pnpm
// --filter @vorlyn/persistence exec tsc --build` first for an ad hoc local run.
const compiledEntry = fileURLToPath(
  new URL('../../dist/telemetry/optional-setup.js', import.meta.url),
);

/**
 * `optional-setup.ts`'s entire reason for existing is a property that can
 * only be proven by actually bundling it and running the result somewhere
 * the OTel packages are genuinely unresolvable — a unit test mocking
 * `import()` would prove nothing about whether esbuild's real bundling
 * preserves the deferred-import property this file depends on (it does not,
 * for the naive "wrap a first-party module" approach — see this file's own
 * doc comment). So this test does the real thing: bundles the compiled
 * output with esbuild exactly as `scripts/release/build-dist.mjs` will
 * (`splitting: false`, the seven OTel packages `external`), then runs the
 * bundle from a temp directory outside this repo's `node_modules` tree,
 * where none of those seven packages resolve at all.
 */
describe('setupTelemetryIfAvailable — bundled, with the OTel SDK genuinely absent', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('survives and reports the no-op message instead of crashing at module load', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-optional-setup-'));
    await writeFile(path.join(tmpDir, 'package.json'), '{"type":"module"}\n', 'utf8');

    const entrySource = `
      import { setupTelemetryIfAvailable } from ${JSON.stringify(compiledEntry)};
      await setupTelemetryIfAvailable('probe-missing');
      console.log('SURVIVED');
    `;
    const entryPath = path.join(tmpDir, 'entry.mjs');
    await writeFile(entryPath, entrySource, 'utf8');

    const bundlePath = path.join(tmpDir, 'bundle.mjs');
    await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      splitting: false,
      outfile: bundlePath,
      external: OTEL_PACKAGES,
    });

    // cwd deliberately the temp dir, outside any ancestor node_modules that
    // has the OTel packages — this is what makes "genuinely unresolvable"
    // real rather than assumed.
    const { stdout, stderr } = await execFileAsync(process.execPath, [bundlePath], {
      cwd: tmpDir,
    });

    expect(stdout).toContain('SURVIVED');
    expect(stderr).toContain('OpenTelemetry packages are not installed');
    expect(stderr).toContain('probe-missing');
  }, 20_000);
});
