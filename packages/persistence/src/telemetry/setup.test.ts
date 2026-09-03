import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
// The compiled output, not the .ts source: `--experimental-strip-types`
// doesn't rewrite `.js`-suffixed relative-import specifiers back to sibling
// `.ts` files on the installed Node version (verified directly, not
// assumed), so a plain source-mode subprocess can't resolve this fixture's
// own imports. `pnpm verify` always runs `typecheck` (which builds dist)
// before `test`, so dist is guaranteed fresh in CI; run `pnpm --filter
// @vorlyn/persistence exec tsc --build` first for an ad hoc local run.
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(packageRoot, 'dist', 'telemetry', 'probe-noop-fixture.js');

/**
 * With no OTEL_EXPORTER_OTLP_ENDPOINT, setupTelemetry() must not dominate
 * the log bill by defaulting to noisy console exporters in a context where
 * nothing is meant to be exported at all (jobs, or any process with no OTel
 * collector reachable). OTEL_SDK_DISABLED=true is a standard OTel var,
 * verified against the installed @opentelemetry/sdk-node source to make
 * every span/metric call a true no-op — this proves that end-to-end via a
 * real subprocess (OTel SDK state is process-global, so an in-process test
 * would pollute/be polluted by other tests in the same vitest worker).
 */
describe('setupTelemetry OTEL_SDK_DISABLED', () => {
  it('positive control: the default console exporter path actually prints to stdout', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [fixture], {
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: '', OTEL_SDK_DISABLED: '' },
    });
    // ConsoleSpanExporter/ConsoleMetricExporter both use console.dir (stdout) —
    // confirmed against the installed package source, not assumed.
    expect(stdout).toContain('http_request');
    // Our own one-line structured log (OtelTelemetry.log, ARCHITECTURE.md §9)
    // is a separate, always-on, stderr concern — not what this var disables.
    expect(stderr).toContain('"event":"http_request"');
  }, 15_000);

  it('OTEL_SDK_DISABLED=true: zero console span/metric output, but our structured log line still fires', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [fixture], {
      env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: '', OTEL_SDK_DISABLED: 'true' },
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('"event":"http_request"');
  }, 15_000);
});
