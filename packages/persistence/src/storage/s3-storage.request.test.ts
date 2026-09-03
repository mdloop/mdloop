import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { VersionKey } from '@vorlyn/app';
import type { DocumentId, OrgId } from '@vorlyn/shared';
import { S3Storage } from './s3-storage.js';

/**
 * Request-construction unit tests: the real `@aws-sdk/client-s3` client,
 * transport mocked only at the HTTP boundary (a scripted `requestHandler`),
 * per docs/adr/0005-*.md — this proves S3Storage builds the right request
 * (the conditional PUT actually carries `If-None-Match: *`, the 412 fallback
 * actually issues a GetObject and compares bytes) without hitting a real S3
 * bucket or faking S3's server-side behavior. Different from mocking
 * `StoragePort` itself — this is one class's request-construction logic,
 * same category of test as any other SDK-wrapping adapter in this repo.
 */

interface CapturedRequest {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly path: string;
}

interface ScriptedResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

/** Hands back one scripted response per call, in order; records every
 * request it saw so tests can assert on headers actually sent over the
 * wire. */
class ScriptedTransport {
  readonly requests: CapturedRequest[] = [];
  private readonly responses: ScriptedResponse[];

  constructor(responses: ScriptedResponse[]) {
    this.responses = [...responses];
  }

  handle(request: CapturedRequest): Promise<{ response: ScriptedResponse }> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('ScriptedTransport: ran out of scripted responses');
    return Promise.resolve({ response });
  }
}

function xmlBody(xml: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(xml, 'utf8')]);
}

function bytesBody(raw: Uint8Array): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(raw)]);
}

const key: VersionKey = { orgId: 'org-a' as OrgId, documentId: 'doc-1' as DocumentId, seq: 1 };
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const match = Object.entries(headers).find(([k]) => k.toLowerCase() === lower);
  return match?.[1];
}

// SigV4 signing runs before a request ever reaches `requestHandler` — the
// scripted transport below never sees a real network, but the client still
// needs *some* credentials to sign with. Fake static ones only; never real
// AWS credentials in a test file.
const fakeCredentials = { accessKeyId: 'test', secretAccessKey: 'test' };

describe('S3Storage — conditional PUT request shape', () => {
  it('sends If-None-Match: * on every put (write-once via conditional write)', async () => {
    const transport = new ScriptedTransport([{ statusCode: 200, headers: {}, body: undefined }]);
    const client = new S3Client({
      region: 'us-east-1',
      requestHandler: transport,
      credentials: fakeCredentials,
    });
    const storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', client });

    await storage.put(key, bytes('hello'));

    expect(transport.requests).toHaveLength(1);
    const [req] = transport.requests;
    expect(req?.method).toBe('PUT');
    expect(findHeader(req?.headers ?? {}, 'if-none-match')).toBe('*');
  });

  it('on a 412 (existing, identical bytes) falls back to GetObject and resolves silently', async () => {
    const transport = new ScriptedTransport([
      {
        statusCode: 412,
        headers: { 'content-type': 'application/xml' },
        body: xmlBody(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold.</Message></Error>',
        ),
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'text/markdown' },
        body: bytesBody(bytes('hello')),
      },
    ]);
    const client = new S3Client({
      region: 'us-east-1',
      requestHandler: transport,
      credentials: fakeCredentials,
    });
    const storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', client });

    await expect(storage.put(key, bytes('hello'))).resolves.toBeUndefined();
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.method).toBe('GET');
  });

  it('on a 412 (existing, different bytes) throws the shared write-once error shape', async () => {
    const transport = new ScriptedTransport([
      {
        statusCode: 412,
        headers: { 'content-type': 'application/xml' },
        body: xmlBody(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold.</Message></Error>',
        ),
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'text/markdown' },
        body: bytesBody(bytes('existing-different-bytes')),
      },
    ]);
    const client = new S3Client({
      region: 'us-east-1',
      requestHandler: transport,
      credentials: fakeCredentials,
    });
    const storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', client });

    await expect(storage.put(key, bytes('hello'))).rejects.toThrow(/exists with different content/);
  });

  it('propagates a non-412 PutObject failure without attempting the fallback read', async () => {
    const transport = new ScriptedTransport([
      {
        statusCode: 403,
        headers: { 'content-type': 'application/xml' },
        body: xmlBody(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
        ),
      },
    ]);
    const client = new S3Client({
      region: 'us-east-1',
      requestHandler: transport,
      credentials: fakeCredentials,
    });
    const storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1', client });

    await expect(storage.put(key, bytes('hello'))).rejects.toThrow();
    // Only the failed PUT — no fallback GetObject for a non-412 failure.
    expect(transport.requests).toHaveLength(1);
  });
});

/**
 * `endpoint`/`forcePathStyle` (S3-compatible self-host backends — MinIO/R2)
 * are only meaningful when `S3Storage` builds its own `S3Client` (the
 * `config.client` escape hatch bypasses them entirely, by design — see that
 * field's doc comment). These tests reach into the constructed client's own
 * `.config` to prove the two fields were actually threaded through, rather
 * than exercising a live request — no MinIO/R2 endpoint is available in this
 * test environment.
 */
describe('S3Storage — endpoint / forcePathStyle config', () => {
  /**
   * `S3Storage` builds its `S3Client` lazily, the first time any method
   * needs it (`s3-storage.ts`'s doc comment) — reaching into the private
   * `getClient()` seam and awaiting it is what these tests need to inspect
   * the client the class actually builds, without issuing a real request.
   */
  async function internalClient(storage: S3Storage): Promise<S3Client> {
    return (storage as unknown as { getClient(): Promise<S3Client> }).getClient();
  }

  it('threads a custom endpoint and forcePathStyle into the constructed S3Client', async () => {
    const storage = new S3Storage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
    });
    const client = await internalClient(storage);

    expect(client.config.forcePathStyle).toBe(true);
    const resolvedEndpoint = await client.config.endpoint?.();
    expect(resolvedEndpoint).toMatchObject({
      hostname: 'localhost',
      port: 9000,
      protocol: 'http:',
    });
  });

  it('leaves the default AWS endpoint resolution and path style untouched when omitted', async () => {
    const storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1' });
    const client = await internalClient(storage);

    expect(client.config.forcePathStyle).toBe(false);
    expect(client.config.endpoint).toBeUndefined();
  });

  it('does not apply endpoint/forcePathStyle when a client is injected (the test escape hatch)', async () => {
    const injected = new S3Client({ region: 'us-east-1', credentials: fakeCredentials });
    const storage = new S3Storage({
      bucket: 'test-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      client: injected,
    });

    // Same instance — S3Storage never re-constructs a client around the
    // injected one, so endpoint/forcePathStyle are simply not applied.
    expect(await internalClient(storage)).toBe(injected);
  });
});
