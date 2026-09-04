import { describe, expect, it } from 'vitest';
import { CapturingTelemetry } from '../test-support/fakes.js';

describe('TelemetryFields allowlist', () => {
  it('accepts allowlisted opaque-id and operational fields', () => {
    const telemetry = new CapturingTelemetry();
    telemetry.log('http_request', { requestId: 'r1', route: '/documents', outcome: 'ok' });
    expect(telemetry.logs).toHaveLength(1);
  });

  it('rejects an entity string as a compile error, not a runtime check', () => {
    const telemetry = new CapturingTelemetry();
    // @ts-expect-error - `title` is not an allowlisted TelemetryFields key;
    // a document title can never compile into a log call.
    telemetry.log('http_request', { title: 'My Secret Document.md' });
    // @ts-expect-error - same for comment/email-shaped free text.
    telemetry.log('http_request', { comment: 'the deploy key is 123' });
  });
});
