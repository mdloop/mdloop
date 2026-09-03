/**
 * Metric names and alarm thresholds as data (ARCHITECTURE.md §9) — Phase 10
 * CDK reads this to provision the actual CloudWatch alarm resources. Kept
 * here, next to TelemetryPort, so metric names and their alarms can't drift
 * apart in two different packages.
 */
export const METRIC_NAMES = {
  requestLatencyMs: 'vorlyn_request_latency_ms',
  rlsViolationAttempt: 'vorlyn_rls_violation_attempt_total',
  quotaRejected: 'vorlyn_quota_rejected_total',
} as const;

export interface AlarmDefinition {
  readonly name: string;
  readonly metric: string;
  readonly description: string;
  readonly threshold: number;
  readonly comparison: 'greater_than' | 'less_than';
  /** Consecutive evaluation periods past `threshold` before the alarm fires. */
  readonly evaluationPeriods: number;
}

export const ALARM_DEFINITIONS: readonly AlarmDefinition[] = [
  {
    name: 'api-p95-latency-high',
    metric: METRIC_NAMES.requestLatencyMs,
    description: 'p95 request latency exceeds 2s for 3 consecutive periods.',
    threshold: 2000,
    comparison: 'greater_than',
    evaluationPeriods: 3,
  },
  {
    name: 'api-5xx-rate-high',
    metric: 'http_request',
    description: '5xx response rate (outcome=error on http_request) exceeds 1% over 5 periods.',
    threshold: 0.01,
    comparison: 'greater_than',
    evaluationPeriods: 5,
  },
  {
    name: 'rls-violation-attempt-detected',
    metric: METRIC_NAMES.rlsViolationAttempt,
    description: 'Any RLS policy violation attempt — a security signal, not just an error rate.',
    threshold: 0,
    comparison: 'greater_than',
    evaluationPeriods: 1,
  },
  {
    name: 'quota-rejection-spike',
    metric: METRIC_NAMES.quotaRejected,
    description: 'Quota rejections spike beyond normal background rate over 5 periods.',
    threshold: 20,
    comparison: 'greater_than',
    evaluationPeriods: 5,
  },
] as const;
