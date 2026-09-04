import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { CapturingTelemetry } from '@mdloop/app/test-support';
import { logPoolFaults } from './pool-fault-logging.js';

describe('logPoolFaults', () => {
  it('logs a process_fault with the error name and outcome error, never the message', () => {
    const pool = new Pool({ connectionString: 'postgres://localhost:1/nope' });
    const telemetry = new CapturingTelemetry();
    logPoolFaults(pool, telemetry);

    const err = Object.assign(new Error('connection terminated unexpectedly'), {
      name: 'ECONNRESET',
    });
    pool.emit('error', err);

    expect(telemetry.logs).toEqual([
      { event: 'process_fault', fields: { errorCode: 'ECONNRESET', outcome: 'error' } },
    ]);
  });

  it('does not throw on an idle-client error once attached (the bug this fixes)', () => {
    const pool = new Pool({ connectionString: 'postgres://localhost:1/nope' });
    logPoolFaults(pool, new CapturingTelemetry());

    expect(() => {
      pool.emit('error', new Error('boom'));
    }).not.toThrow();
  });

  it('without attaching, an unlistened pool error throws (proves the failure mode is real)', () => {
    const pool = new Pool({ connectionString: 'postgres://localhost:1/nope' });

    expect(() => {
      pool.emit('error', new Error('boom'));
    }).toThrow();
  });

  it('logs every error on repeated faults, not just the first', () => {
    const pool = new Pool({ connectionString: 'postgres://localhost:1/nope' });
    const telemetry = new CapturingTelemetry();
    logPoolFaults(pool, telemetry);

    pool.emit('error', Object.assign(new Error('a'), { name: 'ECONNRESET' }));
    pool.emit('error', Object.assign(new Error('b'), { name: 'EPIPE' }));

    expect(telemetry.logs.map((l) => l.fields.errorCode)).toEqual(['ECONNRESET', 'EPIPE']);
  });
});
