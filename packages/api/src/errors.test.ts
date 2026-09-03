import { describe, expect, it } from 'vitest';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { CapturingTelemetry } from '@vorlyn/app/test-support';
import { makeFaultHandler } from './errors.js';

/** Captures the status + JSON body the handler sends, standing in for a FastifyReply. */
function fakeReply(): { reply: FastifyReply; sent: { status?: number; payload?: unknown } } {
  const sent: { status?: number; payload?: unknown } = {};
  const reply = {
    code(c: number): FastifyReply {
      sent.status = c;
      return reply;
    },
    send(p: unknown): FastifyReply {
      sent.payload = p;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

const req = {
  id: 'req-1',
  url: '/documents/abc/comments',
  method: 'POST',
  routeOptions: { url: '/documents/:id/comments' },
} as unknown as FastifyRequest;

describe('makeFaultHandler', () => {
  it('returns a bare 500 {error:internal} for an unexpected throw, never the message', () => {
    const telemetry = new CapturingTelemetry();
    const { reply, sent } = fakeReply();
    const err = {
      name: 'Error',
      // A pg constraint message embedding user data — exactly what must not leak.
      message: 'duplicate key value violates unique constraint: email=secret@corp.example',
    } as FastifyError;

    makeFaultHandler(telemetry)(err, req, reply);

    expect(sent.status).toBe(500);
    expect(sent.payload).toEqual({ error: 'internal' });
    // Body carries no message/stack.
    expect(JSON.stringify(sent.payload)).not.toContain('secret@corp.example');
  });

  it('preserves a 4xx validation status but drops the message for a generic code', () => {
    const telemetry = new CapturingTelemetry();
    const { reply, sent } = fakeReply();
    const err = {
      name: 'FastifyError',
      code: 'FST_ERR_VALIDATION',
      statusCode: 400,
      message: 'body/email must match format "email", got \'attacker@evil.example\'',
      validation: [],
    } as unknown as FastifyError;

    makeFaultHandler(telemetry)(err, req, reply);

    expect(sent.status).toBe(400);
    expect(sent.payload).toEqual({ error: 'invalid_request' });
    expect(JSON.stringify(sent.payload)).not.toContain('attacker@evil.example');
  });

  it('logs an opaque process_fault event — static code only, no message or user data', () => {
    const telemetry = new CapturingTelemetry();
    const { reply } = fakeReply();
    const err = {
      name: 'Error',
      code: '23505',
      statusCode: 500,
      message: 'row for org=00000000 doc=title-Secret-Roadmap failed',
    } as unknown as FastifyError;

    makeFaultHandler(telemetry)(err, req, reply);

    const log = telemetry.logs.find((l) => l.event === 'process_fault');
    expect(log).toBeDefined();
    expect(log?.fields).toMatchObject({
      requestId: 'req-1',
      route: '/documents/:id/comments',
      method: 'POST',
      statusCode: 500,
      errorCode: '23505',
      outcome: 'error',
    });
    // No captured string anywhere embeds the message / user data.
    for (const s of telemetry.allStrings()) {
      expect(s).not.toContain('Secret-Roadmap');
      expect(s).not.toContain('failed');
    }
  });
});
