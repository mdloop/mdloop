import type * as AwsSdkClientS3 from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PublicDocKey, StoragePort, VersionKey } from '@mdloop/app';
import { publicObjectKey, versionObjectKey } from '@mdloop/app';
import type { DocumentId, OrgId } from '@mdloop/shared';

/**
 * `@aws-sdk/client-s3` is loaded via `import()`, not a static top-level
 * import, and every reference above is `import type` (erased at compile
 * time, `verbatimModuleSyntax` makes that explicit) — deliberately, so this
 * module carries zero runtime footprint from the AWS SDK until something
 * actually calls an `S3Storage` method.
 *
 * This is not merely an optimization; it's load-bearing for the published
 * `mdloop` npm package, which bundles this file (esbuild inlines every
 * `@mdloop/*` module into one output) while declaring `@aws-sdk/client-s3`
 * an `optionalDependencies` entry. Proven empirically, not assumed: a static
 * `import` anywhere in a module reachable through the bundle — even one
 * reached only via a *dynamic* `import()` of a first-party wrapper module —
 * gets hoisted by esbuild to a real top-level `import` statement in the
 * single-file output, which Node's ESM loader resolves eagerly at
 * module-link time, before any code runs and regardless of whether that
 * code path is ever taken. Only a dynamic `import()` whose argument is the
 * bare external specifier *written directly at the call site* — never
 * indirected through another first-party module, however that module is
 * itself reached — stays a genuinely deferred, catchable runtime import.
 * `packages/persistence/src/telemetry/optional-setup.ts` needs the same
 * property for the same reason; see its doc comment for the parallel case.
 *
 * Memoized at module scope — not just per-`S3Storage`-instance — so the
 * literal `import('@aws-sdk/client-s3')` expression below executes exactly
 * once, ever, for the life of the process. Every caller (`getClient()` and
 * every method that also needs a Command class) awaits the same cached
 * promise rather than issuing its own independent `import()` of the same
 * specifier. This isn't just tidiness: `writeOnce`/`readObject`/`delete`/
 * `deletePrefix` each start `getClient()` (which itself calls
 * `loadAwsSdk()`) *concurrently* with their own direct `loadAwsSdk()` call
 * via `Promise.all([loadAwsSdk(), this.getClient()])` — two independent,
 * concurrent dynamic imports of the same first-load specifier. Real Node
 * resolves that safely (its own ESM loader cache is reentrant), but that
 * shape reproducibly defeated `vitest`'s `vi.mock` interception in this
 * package's tests — one of the two concurrent calls fell through to the
 * real module instead of the mock. Memoizing here means there is only ever
 * one real `import()` call site invocation to intercept, sidestepping the
 * question of whose mock-resolution race that was, in either environment.
 */
let awsSdkPromise: Promise<typeof AwsSdkClientS3> | undefined;

async function loadAwsSdk(): Promise<typeof AwsSdkClientS3> {
  awsSdkPromise ??= (async () => {
    try {
      return await import('@aws-sdk/client-s3');
    } catch (error) {
      if (isModuleNotFoundError(error)) {
        throw new Error(
          'MDLOOP_BLOBS_BUCKET is set but @aws-sdk/client-s3 is not installed — run ' +
            '"npm i @aws-sdk/client-s3", or unset MDLOOP_BLOBS_BUCKET to use local-disk storage.',
        );
      }
      throw error;
    }
  })();
  return awsSdkPromise;
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
  );
}

export interface S3StorageConfig {
  readonly bucket: string;
  readonly region: string;
  /**
   * Override the AWS endpoint — required to point at an S3-compatible
   * backend (MinIO, Cloudflare R2) instead of real AWS S3. Unset means the
   * SDK's normal AWS endpoint resolution (`https://s3.<region>.amazonaws.com`
   * and friends). The write-once conditional-write mechanism this class
   * depends on is live-verified against MinIO and documented-supported (not
   * yet independently verified) against R2.
   */
  readonly endpoint?: string;
  /**
   * Path-style addressing (`https://<endpoint>/<bucket>/<key>` instead of
   * virtual-hosted `https://<bucket>.<endpoint>/<key>`) — MinIO needs this;
   * real AWS S3 works with either. Unset means the SDK default
   * (virtual-hosted, i.e. `false`).
   */
  readonly forcePathStyle?: boolean;
  /**
   * Escape hatch for tests: inject a pre-built `S3Client` (e.g. one wired to
   * a mocked `requestHandler`) instead of letting this class construct its
   * own from `region`/`endpoint`/`forcePathStyle`. Never set in production
   * wiring.
   */
  readonly client?: S3Client;
}

/**
 * S3-backed blob store (prod; `FsStorage` is the local/test equivalent).
 * Same write-once contract as
 * `FsStorage`: `put`/`putPublic` of an existing key succeeds silently if the
 * new bytes are identical (a retried upload after a failed DB commit),
 * throws `storage object exists with different content: <key>` if they
 * differ. `FsStorage` gets this from the filesystem's `wx` open flag, which
 * has no S3 equivalent — here it's a conditional `PutObject`
 * (`IfNoneMatch: '*'`, GA on S3 since the 2024 "S3 Conditional Writes"
 * feature) so the check-then-write is atomic server-side rather than a
 * client-side race. On the resulting 412 PreconditionFailed, fall back to a
 * `GetObject` to compare bytes and either return (identical) or throw
 * (different) — same observable behavior as `FsStorage`, different
 * mechanism, proven by the same shared contract suite
 * (`storage-contract.ts`).
 */
export class S3Storage implements StoragePort {
  private readonly bucket: string;
  private readonly config: S3StorageConfig;
  private clientPromise: Promise<S3Client> | undefined;

  /**
   * Deliberately does not construct an `S3Client` (or touch the AWS SDK at
   * all) — this class is safe to instantiate unconditionally, even in a
   * process that never installed `@aws-sdk/client-s3` (`optionalDependencies`
   * in the published `mdloop` package). The SDK is loaded lazily, once, the
   * first time any method actually needs it — see `getClient()`.
   */
  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.config = config;
  }

  private async getClient(): Promise<S3Client> {
    if (this.config.client) return this.config.client;
    this.clientPromise ??= loadAwsSdk().then(({ S3Client: S3ClientCtor }) => {
      const { region, endpoint, forcePathStyle } = this.config;
      return new S3ClientCtor({
        region,
        ...(endpoint !== undefined ? { endpoint } : {}),
        ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
      });
    });
    return this.clientPromise;
  }

  private async writeOnce(objectKey: string, content: Uint8Array): Promise<void> {
    const [{ PutObjectCommand }, client] = await Promise.all([loadAwsSdk(), this.getClient()]);
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: content,
          IfNoneMatch: '*',
        }),
      );
      return;
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e;
    }
    // Write-once: identical bytes = retried write whose DB commit failed,
    // safe to treat as done; different bytes = programming error. Compare
    // by reading the existing object back rather than trusting ETag (which
    // isn't reliably a plain content MD5 across every upload path, e.g.
    // SSE-KMS or a future multipart upload).
    const existing = await this.readObject(objectKey);
    if (existing.length === content.length && Buffer.from(existing).equals(Buffer.from(content))) {
      return;
    }
    throw new Error(`storage object exists with different content: ${objectKey}`);
  }

  private async readObject(objectKey: string): Promise<Uint8Array> {
    const [{ GetObjectCommand }, client] = await Promise.all([loadAwsSdk(), this.getClient()]);
    const result = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    const body = result.Body;
    if (!body) return new Uint8Array(0);
    return body.transformToByteArray();
  }

  async put(key: VersionKey, content: Uint8Array): Promise<void> {
    await this.writeOnce(versionObjectKey(key), content);
  }

  async get(key: VersionKey): Promise<Uint8Array> {
    return this.readObject(versionObjectKey(key));
  }

  async putPublic(key: PublicDocKey, content: Uint8Array): Promise<void> {
    await this.writeOnce(publicObjectKey(key), content);
  }

  async getPublic(key: PublicDocKey): Promise<Uint8Array> {
    return this.readObject(publicObjectKey(key));
  }

  async delete(key: VersionKey): Promise<void> {
    const [{ DeleteObjectCommand }, client] = await Promise.all([loadAwsSdk(), this.getClient()]);
    // DeleteObject on a missing key is a 204 no-op on S3 — idempotent for
    // free, same as FsStorage's `rm(..., { force: true })`.
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: versionObjectKey(key) }));
  }

  async deleteDocument(orgId: OrgId, documentId: DocumentId): Promise<void> {
    await this.deletePrefix(`orgs/${orgId}/docs/${documentId}/`);
  }

  async deleteOrg(orgId: OrgId): Promise<void> {
    await this.deletePrefix(`orgs/${orgId}/`);
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const [{ ListObjectsV2Command, DeleteObjectsCommand }, client] = await Promise.all([
      loadAwsSdk(),
      this.getClient(),
    ]);
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        // DeleteObjects caps at 1000 keys/request; ListObjectsV2 pages at
        // 1000/page too, so one delete call per list page always fits.
        await client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys, Quiet: true },
          }),
        );
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

/**
 * `$metadata.httpStatusCode` is populated generically from the raw HTTP
 * response status by the SDK's deserializer middleware, independent of
 * whether the error body's XML/JSON parses into a named exception class —
 * more robust than matching on `error.name`, which S3 has no modeled
 * exception type for on a conditional-write conflict.
 */
function isPreconditionFailed(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('$metadata' in e)) return false;
  const metadata: unknown = e.$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return false;
  }
  return metadata.httpStatusCode === 412;
}
