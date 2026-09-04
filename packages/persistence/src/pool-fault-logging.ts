import type { Pool } from 'pg';
import type { TelemetryPort } from '@mdloop/app';

/**
 * A dropped idle connection (network blip, DB restart, load-balancer reset)
 * emits 'error' on the Pool itself, not on any in-flight query. An
 * EventEmitter 'error' with no listener throws synchronously and becomes an
 * uncaughtException, which every production entrypoint's fault handler
 * treats as crash-only and exits — killing the whole process over one bad
 * idle connection instead of letting the pool evict and reconnect. Attach
 * this in every production entrypoint (api/mcp/jobs/stdio main.ts).
 */
export function logPoolFaults(pool: Pool, telemetry: TelemetryPort): void {
  pool.on('error', (err: Error) => {
    telemetry.log('process_fault', { errorCode: err.name, outcome: 'error' });
  });
}
