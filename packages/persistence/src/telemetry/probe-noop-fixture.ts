import { OtelTelemetry } from './otel-telemetry.js';
import { setupTelemetry } from './setup.js';

/**
 * Test fixture only (setup.test.ts spawns this as a subprocess) — not
 * exported from the package. OTel SDK state is process-global, so this has
 * to run out-of-process to get a clean measurement per scenario rather than
 * polluting vitest's shared process with repeated global-provider
 * registration. `sdk.shutdown()` forces the default BatchSpanProcessor to
 * flush synchronously before exit — without it, a real bug (exporters
 * wrongly left enabled) could still show empty stdout just because nothing
 * flushed in time, which would make the test's "enabled" control useless.
 */
const sdk = setupTelemetry('probe');
const telemetry = new OtelTelemetry();
const span = telemetry.startSpan('http_request', { outcome: 'ok' });
telemetry.recordMetric('probe_metric', 1);
span.end();
await sdk.shutdown();
