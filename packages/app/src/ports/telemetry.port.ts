import type { Tier } from '@vorlyn/domain';

/**
 * Allowlisted fields for structured logs, spans and metrics — opaque IDs and
 * operational metadata only. CONSTITUTION.md Core Principle 3: document
 * content, titles, names, emails and comment text never appear in
 * telemetry. Because this is the only shape `log`/`startSpan` accept,
 * passing an entity string as an object literal is a compile error (excess
 * property check), not a runtime redaction pass.
 *
 * `orgId`/`userId` are opaque UUIDs, fine in a `log()` structured line (e.g.
 * `http_request` already carries both) — but `recordMetric`'s `fields`
 * become actual metric attributes/dimensions in the OTel adapter
 * (`toAttributes`, otel-telemetry.ts), so a high-cardinality field like
 * `userId`/`orgId` must never be passed there: it would blow up CloudWatch
 * custom-metric cardinality/cost (this module's own cost-control rule keeps
 * custom metrics under ~20). `tier` is the safe alternative for a
 * `recordMetric` call that needs to be broken down — a closed 3-value set.
 */
export interface TelemetryFields {
  readonly requestId?: string;
  readonly orgId?: string;
  readonly userId?: string;
  readonly documentId?: string;
  readonly versionId?: string;
  readonly projectId?: string;
  readonly commentId?: string;
  readonly keyId?: string;
  readonly route?: string;
  readonly method?: string;
  readonly tool?: string;
  readonly statusCode?: number;
  readonly latencyMs?: number;
  readonly outcome?: 'ok' | 'error' | 'processed' | 'duplicate' | 'unknown_org';
  readonly errorCode?: string;
  readonly count?: number;
  /** Fixed operational label for a compliance sweep run (e.g. 'version_purge') — a static code constant, never org data. */
  readonly sweep?: string;
  /** Org tier — a closed 3-value set, safe as a `recordMetric` dimension (rate-limiting redesign, 2026-08-11). */
  readonly tier?: Tier;
  /**
   * Static event label for an `ext.`-namespaced event — a code constant naming
   * *what kind* of thing happened, never payload content and never org data.
   * Same discipline as `sweep` above.
   */
  readonly eventType?: string;
}

/** Fixed event-name vocabulary — never a free-form or interpolated string. */
export type TelemetryEvent =
  | 'http_request'
  | 'mcp_tool_call'
  | 'db_query'
  | 'rls_violation_attempt'
  | 'quota_rejected'
  /** Process-level fault: uncaught exception, unhandled rejection, or a request handler that threw past its own error handling. `errorCode` carries a static error name/code only — never a message, which may embed user input. */
  | 'process_fault'
  /** One compliance-sweep run by the jobs scheduler (Phase 24.D): `sweep` names it, `outcome` is ok/error, `count` the rows/orgs it touched. Opaque operational metadata only. */
  | 'compliance_sweep'
  /**
   * A deployment's own event, from routes it mounted through `ServerExtension`
   * — the core cannot enumerate those names, and a self-hoster emitting
   * telemetry for their own surface should not have to fork this union or lose
   * type checking on the core names. The `ext.` prefix keeps them sortable and
   * unmistakable in a dashboard: anything not so prefixed is a core event this
   * union does check.
   */
  | ExtensionTelemetryEvent;

/** See `TelemetryEvent`'s last member. */
export type ExtensionTelemetryEvent = `ext.${string}`;

export interface TelemetrySpan {
  /** Attaches any final fields (e.g. outcome, latencyMs) and closes the span. */
  end(fields?: TelemetryFields): void;
}

/**
 * OTel traces + metrics plus structured request logging, behind one port
 * (ARCHITECTURE.md §9). Adapters: `OtelTelemetry` (persistence) for
 * production/dev; `NoopTelemetry` / `CapturingTelemetry` (test-support) for
 * tests.
 */
export interface TelemetryPort {
  log(event: TelemetryEvent, fields: TelemetryFields): void;
  startSpan(event: TelemetryEvent, fields?: TelemetryFields): TelemetrySpan;
  recordMetric(name: string, value: number, fields?: TelemetryFields): void;
}
