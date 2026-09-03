import type * as OtelSdkNode from '@opentelemetry/sdk-node';
import type * as OtelSdkMetrics from '@opentelemetry/sdk-metrics';
import type * as OtelSdkTraceNode from '@opentelemetry/sdk-trace-node';
import type * as OtelExporterTraceOtlpHttp from '@opentelemetry/exporter-trace-otlp-http';
import type * as OtelExporterMetricsOtlpHttp from '@opentelemetry/exporter-metrics-otlp-http';
import type * as OtelResources from '@opentelemetry/resources';
import type * as OtelSemanticConventions from '@opentelemetry/semantic-conventions';

/**
 * A second, self-contained implementation of `setup.ts`'s `setupTelemetry` —
 * deliberately not a thin wrapper that calls it. `setup.ts` statically
 * imports `@opentelemetry/sdk-node` and six sibling packages; if this file
 * instead did `await import('./setup.js')`, esbuild's single-file bundling
 * (`splitting: false`, used to build the published `vorlyn` npm package)
 * would still hoist `setup.ts`'s *own* static imports to real top-level
 * `import` statements in the bundle output — proven empirically, not
 * assumed: a module reached only through a dynamic `import()` still has its
 * own static imports resolved eagerly by Node's ESM linker the moment the
 * bundle loads, because ESM `import` declarations are processed during
 * module linking, before any code executes, and single-file bundling
 * collapses "before that module's body runs" to the same moment as "when
 * the bundle loads." The only way to keep a package genuinely optional in
 * that bundle is a bare dynamic `import('@opentelemetry/...')` written
 * directly at the call site, with zero first-party indirection — which is
 * exactly what this file does, and exactly why it can't just call `setup.ts`.
 * `s3-storage.ts`'s `loadAwsSdk()` needs the identical property for the
 * identical reason; see its doc comment for the parallel case, including a
 * reproducible before/after esbuild example in the commit that introduced
 * both.
 *
 * Used only by the two embedded self-host composition roots
 * (`packages/api/src/selfhost-embedded-main.ts`,
 * `packages/mcp/src/selfhost-embedded-main.ts`) — the ones bundled into the
 * published package, where `@opentelemetry/sdk-node` and friends are
 * `optionalDependencies`. Every other entrypoint (`main.ts`, `dev-main.ts`,
 * `selfhost-main.ts`, `jobs/main.ts`) keeps calling `setup.ts`'s
 * `setupTelemetry` directly, unchanged — those never ship in a bundle where
 * the OTel SDK might be absent, so there's nothing for them to gain here.
 */
export async function setupTelemetryIfAvailable(serviceName: string): Promise<void> {
  let mods: [
    typeof OtelSdkNode,
    typeof OtelSdkMetrics,
    typeof OtelSdkTraceNode,
    typeof OtelExporterTraceOtlpHttp,
    typeof OtelExporterMetricsOtlpHttp,
    typeof OtelResources,
    typeof OtelSemanticConventions,
  ];
  try {
    mods = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);
  } catch (error) {
    if (!isModuleNotFoundError(error)) throw error;
    process.stderr.write(
      `[vorlyn] OpenTelemetry packages are not installed — telemetry disabled for ${serviceName}. ` +
        'Install the optional OTel dependencies to enable it.\n',
    );
    return;
  }
  const [
    { NodeSDK },
    { ConsoleMetricExporter, PeriodicExportingMetricReader },
    { ConsoleSpanExporter },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME },
  ] = mods;

  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: otlpEndpoint ? new OTLPTraceExporter() : new ConsoleSpanExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: otlpEndpoint ? new OTLPMetricExporter() : new ConsoleMetricExporter(),
      }),
    ],
  });
  sdk.start();
}

/** Exported for direct unit testing — the dynamic-import mechanics above are
 *  covered by `optional-setup.test.ts`'s subprocess fixture instead (OTel
 *  SDK state is process-global, same reasoning as `setup.test.ts`). */
export function isModuleNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
  );
}
