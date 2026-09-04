import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { TelemetryPort } from '@mdloop/app';

/**
 * The unhandled-fault handler for `setErrorHandler` (Phase 24.E). Without a
 * custom handler Fastify serializes a thrown Error verbatim — a pg constraint
 * message, a stack, or an internal object shape reaches the client. This is
 * the backstop for the *unhandled* case: almost every route returns typed
 * error codes with its own status and never arrives here.
 *
 * Two invariants:
 *  - Telemetry gets only opaque, static fields (CONSTITUTION §3) — `errorCode`
 *    is `err.code`/`err.name` (e.g. 'FST_ERR_VALIDATION', a pg SQLSTATE, an
 *    Error subclass name), never `err.message`, which can quote request data.
 *  - The client gets a sanitized envelope: a tagged client fault (schema
 *    validation, body-too-large — any sub-500 status) keeps its status but
 *    drops the message for a generic code; anything else is a bare 500
 *    `internal`. No message, no stack, ever.
 */
export function makeFaultHandler(
  telemetry: TelemetryPort,
): (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => FastifyReply {
  return (err, req, reply) => {
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    telemetry.log('process_fault', {
      requestId: req.id,
      route: req.routeOptions.url ?? req.url,
      method: req.method,
      statusCode,
      // `code` is typed as always-present, but a plain thrown Error normalized
      // by Fastify carries none at runtime — fall back to the (static) name.
      errorCode: err.code || err.name,
      outcome: 'error',
    });
    if (statusCode < 500) return reply.code(statusCode).send({ error: 'invalid_request' });
    return reply.code(500).send({ error: 'internal' });
  };
}
