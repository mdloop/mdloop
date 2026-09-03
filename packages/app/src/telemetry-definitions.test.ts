import { describe, expect, it } from 'vitest';
import { ALARM_DEFINITIONS, METRIC_NAMES } from './telemetry-definitions.js';

describe('telemetry definitions', () => {
  it('every alarm references a known metric name or event', () => {
    const knownMetrics = new Set([...Object.values(METRIC_NAMES), 'http_request']);
    for (const alarm of ALARM_DEFINITIONS) {
      expect(knownMetrics.has(alarm.metric)).toBe(true);
      expect(alarm.evaluationPeriods).toBeGreaterThan(0);
    }
  });

  it('includes an RLS violation alarm (Core Principle 1 security signal)', () => {
    expect(ALARM_DEFINITIONS.some((a) => a.metric === METRIC_NAMES.rlsViolationAttempt)).toBe(true);
  });
});
