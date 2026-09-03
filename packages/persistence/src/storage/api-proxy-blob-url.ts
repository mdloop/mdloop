import type { BlobUrlPort, VersionKey } from '@vorlyn/app';

/**
 * Stage-1 default: the API already
 * proxies blob bytes directly (`packages/api/src/routes/document-routes.ts`,
 * `GET /documents/:id/versions/:versionId/content`), permission-checked on
 * every byte — there is nothing to sign. `ttlSeconds` is accepted (to match
 * `BlobUrlPort`) but ignored: a same-origin proxy URL doesn't expire the way
 * a CloudFront signed URL does, so there's no policy to enforce here.
 *
 * Known gap, deliberate for this pass: `VersionKey` carries `seq` (the
 * canonical `StoragePort` key shape), but the live route above is keyed by
 * the version row's UUID (`versionId`), not `seq` — there is no registered
 * route today that resolves a version by `(orgId, documentId, seq)`. This
 * adapter is a seam, not wired into `document-routes.ts` in this pass, so
 * the path below is the shape a future
 * seq-keyed route would need, not yet a route that exists. Wiring this for
 * real requires either adding that route or changing this adapter to take
 * the version id instead of a bare `VersionKey` — a decision for whoever
 * actually flips `document-routes.ts` onto `BlobUrlPort`.
 */
export class ApiProxyBlobUrl implements BlobUrlPort {
  signedUrlFor(key: VersionKey, _ttlSeconds: number): Promise<string> {
    return Promise.resolve(`/documents/${key.documentId}/versions/seq/${String(key.seq)}/content`);
  }
}
