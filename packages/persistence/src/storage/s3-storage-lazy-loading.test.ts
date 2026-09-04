import { describe, expect, it, vi } from 'vitest';
import { contractPublicKey, contractVersionKey } from './storage-contract.js';

/**
 * Covers the lazy-SDK-loading behavior added to `s3-storage.ts` — kept in a
 * separate file from `s3-storage.test.ts` on purpose: that file's only
 * suite is the real-bucket contract test (`describe.skipIf(!bucket)`) and
 * needs the *real* `@aws-sdk/client-s3` statically imported to talk to an
 * actual bucket. `vi.mock` below replaces that module for every test in
 * *this* file; mixing the two styles in one file would make the real-bucket
 * suite's imports resolve to this file's fakes instead of the real SDK.
 *
 * `vi.mock` intercepts both static and dynamic `import()`s of the given
 * specifier, so it exercises the exact same `loadAwsSdk()` path
 * `S3Storage`'s methods use in production — this is not a weaker/different
 * code path than the real one, just a fake implementation behind it.
 */
const { constructorCalls, sendCalls, sendImpl } = vi.hoisted(() => {
  return {
    constructorCalls: [] as unknown[],
    sendCalls: [] as unknown[],
    sendImpl: { current: (_command: unknown): Promise<unknown> => Promise.resolve({}) },
  };
});

vi.mock('@aws-sdk/client-s3', () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  class FakeS3Client {
    constructor(config: unknown) {
      constructorCalls.push(config);
    }
    send(command: unknown): Promise<unknown> {
      sendCalls.push(command);
      return sendImpl.current(command);
    }
  }
  return {
    S3Client: FakeS3Client,
    PutObjectCommand: class extends FakeCommand {},
    GetObjectCommand: class extends FakeCommand {},
    DeleteObjectCommand: class extends FakeCommand {},
    DeleteObjectsCommand: class extends FakeCommand {},
    ListObjectsV2Command: class extends FakeCommand {},
  };
});

// Imported after the mock is registered (vi.mock's hoisting handles the
// ordering) so `S3Storage`'s own `import('@aws-sdk/client-s3')` resolves to
// the fake above, whether this file's `S3Storage` import is used directly
// or only transitively.
const { S3Storage } = await import('./s3-storage.js');

function resetFakeSdk(): void {
  constructorCalls.length = 0;
  sendCalls.length = 0;
  sendImpl.current = () => Promise.resolve({});
}

/** A real `Error`, `$metadata`-shaped the way `isPreconditionFailed` (s3-storage.ts) duck-types a
 *  412 response — matches what the real AWS SDK actually throws closely enough to exercise it. */
function preconditionFailedError(): Error & { $metadata: { httpStatusCode: number } } {
  return Object.assign(new Error('PreconditionFailed'), { $metadata: { httpStatusCode: 412 } });
}

describe('S3Storage — lazy SDK loading', () => {
  it('constructing an instance never touches the SDK — no S3Client built, no send calls', () => {
    resetFakeSdk();
    expect(() => new S3Storage({ bucket: 'b', region: 'us-east-1' })).not.toThrow();
    expect(constructorCalls).toHaveLength(0);
    expect(sendCalls).toHaveLength(0);
  });

  it('an injected client (config.client) is used directly — no S3Client is constructed', async () => {
    resetFakeSdk();
    const injected = { send: vi.fn().mockResolvedValue({}) };
    const storage = new S3Storage({
      bucket: 'b',
      region: 'us-east-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately untyped fake, matching the class's own `send`-only contract
      client: injected as any,
    });

    await storage.get(contractVersionKey(1));

    expect(injected.send).toHaveBeenCalledTimes(1);
    expect(constructorCalls).toHaveLength(0); // the real (fake) S3Client constructor was never reached
  });

  it('builds exactly one S3Client and reuses it across multiple method calls', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.resolve({ Body: undefined });
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await storage.get(contractVersionKey(1));
    await storage.get(contractVersionKey(2));
    await storage.getPublic(contractPublicKey(1));

    expect(constructorCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(3);
  });

  it('concurrent first calls still only build one client (memoized by the in-flight promise, not just a settled value)', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.resolve({ Body: undefined });
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await Promise.all([storage.get(contractVersionKey(1)), storage.get(contractVersionKey(2))]);

    expect(constructorCalls).toHaveLength(1);
  });

  it('passes region/endpoint/forcePathStyle through to the client, omitting unset optional fields', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.resolve({ Body: undefined });
    const storage = new S3Storage({
      bucket: 'b',
      region: 'eu-west-1',
      endpoint: 'https://minio.local',
      forcePathStyle: true,
    });

    await storage.get(contractVersionKey(1));

    expect(constructorCalls).toEqual([
      { region: 'eu-west-1', endpoint: 'https://minio.local', forcePathStyle: true },
    ]);
  });

  it('omits endpoint/forcePathStyle from the client config entirely when unset, rather than passing undefined', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.resolve({ Body: undefined });
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await storage.get(contractVersionKey(1));

    expect(constructorCalls).toEqual([{ region: 'us-east-1' }]);
  });

  it('put(): a plain PutObjectCommand success is not treated as a write-once conflict', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.resolve({});
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await expect(
      storage.put(contractVersionKey(1), new TextEncoder().encode('hello')),
    ).resolves.toBeUndefined();
    expect(sendCalls).toHaveLength(1);
  });

  it('put(): a 412 PreconditionFailed with identical bytes on GetObject is swallowed (retried upload)', async () => {
    resetFakeSdk();
    const content = new TextEncoder().encode('hello');
    let call = 0;
    sendImpl.current = () => {
      call += 1;
      if (call === 1) {
        return Promise.reject(preconditionFailedError());
      }
      // The write-once fallback GetObject, returning the same bytes just written.
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(content) },
      });
    };
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await expect(storage.put(contractVersionKey(1), content)).resolves.toBeUndefined();
    expect(sendCalls).toHaveLength(2); // PutObjectCommand, then the fallback GetObjectCommand
  });

  it('put(): a 412 PreconditionFailed with different bytes on GetObject throws the write-once conflict error', async () => {
    resetFakeSdk();
    let call = 0;
    sendImpl.current = () => {
      call += 1;
      if (call === 1) {
        return Promise.reject(preconditionFailedError());
      }
      return Promise.resolve({
        Body: {
          transformToByteArray: () => Promise.resolve(new TextEncoder().encode('different')),
        },
      });
    };
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await expect(
      storage.put(contractVersionKey(1), new TextEncoder().encode('hello')),
    ).rejects.toThrow(/storage object exists with different content/);
  });

  it('put(): a non-412 send failure is not swallowed as a write-once conflict', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.reject(new Error('network exploded'));
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await expect(
      storage.put(contractVersionKey(1), new TextEncoder().encode('hello')),
    ).rejects.toThrow(/network exploded/);
  });

  it('get(): an empty response body reads back as an empty Uint8Array rather than throwing', async () => {
    resetFakeSdk();
    sendImpl.current = () => Promise.resolve({ Body: undefined });
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await expect(storage.get(contractVersionKey(1))).resolves.toEqual(new Uint8Array(0));
  });

  it('deletePrefix (via deleteOrg): pages through ListObjectsV2 and batches DeleteObjects per page', async () => {
    resetFakeSdk();
    const calls: string[] = [];
    sendImpl.current = (command: unknown) => {
      const ctor = (command as { constructor: { name: string } }).constructor.name;
      calls.push(ctor);
      if (ctor === 'ListObjectsV2Command') {
        const input = (command as { input: { ContinuationToken?: string } }).input;
        if (!input.ContinuationToken) {
          return Promise.resolve({
            Contents: [{ Key: 'orgs/org-a/docs/doc-1/v1' }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          });
        }
        return Promise.resolve({
          Contents: [{ Key: 'orgs/org-a/docs/doc-1/v2' }],
          IsTruncated: false,
        });
      }
      return Promise.resolve({});
    };
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await storage.deleteOrg('org-a' as Parameters<typeof storage.deleteOrg>[0]);

    expect(calls).toEqual([
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
    ]);
  });

  it('deletePrefix: an empty page issues no DeleteObjects call', async () => {
    resetFakeSdk();
    const calls: string[] = [];
    sendImpl.current = (command: unknown) => {
      calls.push((command as { constructor: { name: string } }).constructor.name);
      return Promise.resolve({ Contents: [], IsTruncated: false });
    };
    const storage = new S3Storage({ bucket: 'b', region: 'us-east-1' });

    await storage.deleteOrg('org-a' as Parameters<typeof storage.deleteOrg>[0]);

    expect(calls).toEqual(['ListObjectsV2Command']);
  });

  /**
   * NOT covered here: `loadAwsSdk()`'s `ERR_MODULE_NOT_FOUND` → actionable
   * "npm i @aws-sdk/client-s3" error translation. `vi.mock` above replaces
   * the module with a working fake for every test in this file — it can't
   * additionally simulate "this package was never installed" for one test
   * without `vi.doUnmock`/`vi.resetModules` gymnastics around a dynamic
   * `import()` inside a class method, which would be fighting the module
   * system for a single line of error-translation logic already covered by
   * type-checking (the `catch` branch's shape matches `s3-storage.ts`'s
   * `isModuleNotFoundError` exactly) rather than testing real behavior.
   */
});
