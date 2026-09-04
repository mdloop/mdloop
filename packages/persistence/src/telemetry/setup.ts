import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Vendor-neutral OTel bootstrap (ARCHITECTURE.md §9): OTLP exporter when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set (staging/prod, CloudWatch/X-Ray via
 * an OTel collector — Phase 10), console exporter otherwise (local dev).
 * Call once per process before constructing `OtelTelemetry`.
 */
export function setupTelemetry(serviceName: string): NodeSDK {
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
  return sdk;
}
