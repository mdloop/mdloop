import { SpanStatusCode, metrics, trace } from '@opentelemetry/api';
import type { Counter, Span as OtelSpan } from '@opentelemetry/api';
import type { TelemetryEvent, TelemetryFields, TelemetryPort, TelemetrySpan } from '@vorlyn/app';

function toAttributes(fields: TelemetryFields): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const entries = Object.entries(fields) as [string, string | number | undefined][];
  for (const [key, value] of entries) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * TelemetryPort over the OTel SDK (ARCHITECTURE.md §9): spans + metrics via
 * the global tracer/meter providers (wired by `setupTelemetry`), and one
 * structured JSON log line per event — the fixed TelemetryFields shape is
 * the entire log record, so nothing outside the allowlist can reach stdout.
 */
export class OtelTelemetry implements TelemetryPort {
  private readonly tracer = trace.getTracer('vorlyn');
  private readonly meter = metrics.getMeter('vorlyn');
  private readonly counters = new Map<string, Counter>();

  log(event: TelemetryEvent, fields: TelemetryFields): void {
    // stderr, never stdout: the MCP stdio transport uses stdout for the
    // JSON-RPC protocol itself — logging there would corrupt every message.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ event, ...fields, ts: new Date().toISOString() }));
  }

  startSpan(event: TelemetryEvent, fields: TelemetryFields = {}): TelemetrySpan {
    const span: OtelSpan = this.tracer.startSpan(event, { attributes: toAttributes(fields) });
    return {
      end: (extra) => {
        const merged = { ...fields, ...extra };
        if (extra) span.setAttributes(toAttributes(extra));
        if (merged.outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        this.log(event, merged);
      },
    };
  }

  recordMetric(name: string, value: number, fields: TelemetryFields = {}): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, toAttributes(fields));
  }
}
