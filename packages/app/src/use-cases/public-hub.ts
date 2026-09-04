import { normalizePublicSlug } from '@mdloop/domain';
import type { DocumentId, OrgId, PublicDocId, Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type {
  DocumentRepository,
  PublicDoc,
  PublicHubKeyset,
  PublicHubRepository,
  VersionRepository,
} from '../ports/repositories.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { Actor } from './org-settings.js';

/**
 * Public Docs Hub (ADR 0004). Publishing is the one deliberate bridge from
 * the tenant model into the public store: gated on `actor.role === 'admin'`
 * AND the actor's org being the one configured `publicHubOrgId` — no new
 * role concept, config-driven, home-org-only for v1. Everything is read
 * through the ordinary tenant-scoped repositories (`documents`/`versions`/
 * `storage.get`), never `withProvisioner` directly from here — the
 * repository implementations own that boundary.
 *
 * The anonymous read path (`getPublicDoc`/`listPublicDocs`/`searchPublicDocs`)
 * takes no `Actor` at all: there is no tenant context for an unauthenticated
 * reader, by design.
 */
export interface PublicHubConfig {
  /** Home org allowed to publish (ADR 0004) — undefined means publishing is off entirely. */
  readonly publicHubOrgId?: OrgId;
}

export interface PublicHubDeps {
  readonly documents: DocumentRepository;
  readonly versions: VersionRepository;
  readonly storage: StoragePort;
  readonly publicHub: PublicHubRepository;
}

export type PublishError =
  | { readonly code: 'forbidden' }
  | { readonly code: 'document_not_found' }
  | { readonly code: 'version_purged' }
  | { readonly code: 'invalid_slug' };

export interface UnpublishError {
  readonly code: 'forbidden';
}
export interface PublicDocNotFoundError {
  readonly code: 'not_found';
}
export interface PublicSearchError {
  readonly code: 'empty_query';
}

export interface PublishToPublicHubInput {
  readonly documentId: DocumentId;
  readonly slug: string;
  /** Falls back to the source document's own title when omitted. */
  readonly title?: string;
}

const decoder = new TextDecoder();

function canPublish(actor: Actor, config: PublicHubConfig): boolean {
  return (
    actor.role === 'admin' &&
    config.publicHubOrgId !== undefined &&
    actor.ctx.orgId === config.publicHubOrgId
  );
}

/**
 * Snapshot-publish a document's current version (ADR 0004). Reads the source
 * document/version/blob inside the actor's normal tenant context — nothing
 * here constructs a raw storage key or reaches for `withProvisioner`
 * directly, that stays inside the repository implementations. `publish()` is
 * the DB authority on the row's `id`/`seq` (an upsert-by-slug that bumps
 * `seq` on every re-publish), so it runs BEFORE the blob write: the blob key
 * is derived from what the DB actually assigned, never guessed client-side.
 * A storage failure after a successful `publish()` leaves the row pointing at
 * a `seq` with no blob yet; a retried publish (same or updated content)
 * bumps `seq` again and repairs it on the next successful write — the same
 * "retry re-writes, never dangles" tolerance the ordinary upload path has.
 */
export async function publishToPublicHub(
  actor: Actor,
  config: PublicHubConfig,
  deps: PublicHubDeps,
  input: PublishToPublicHubInput,
): Promise<Result<PublicDoc, PublishError>> {
  if (!canPublish(actor, config)) return err({ code: 'forbidden' });

  const normalizedSlug = normalizePublicSlug(input.slug);
  if (!normalizedSlug) return err({ code: 'invalid_slug' });

  const document = await deps.documents.byId(actor.ctx, input.documentId);
  if (!document || document.deletedAt || !document.currentVersionId) {
    return err({ code: 'document_not_found' });
  }

  const version = await deps.versions.byId(actor.ctx, document.currentVersionId);
  if (!version) return err({ code: 'document_not_found' });
  if (version.purgedAt) return err({ code: 'version_purged' });

  const content = await deps.storage.get({
    orgId: actor.ctx.orgId,
    documentId: document.id,
    seq: version.seq,
  });
  const trimmedTitle = input.title?.trim();
  const title = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : document.title;

  const publicDoc = await deps.publicHub.publish({
    slug: normalizedSlug,
    title,
    body: decoder.decode(content),
    contentHash: version.contentHash,
    byteSize: version.byteSize,
    sourceOrgId: actor.ctx.orgId,
    sourceDocumentId: document.id,
    sourceVersionId: version.id,
    publishedBy: actor.ctx.userId,
  });

  await deps.storage.putPublic({ publicDocId: publicDoc.id, seq: publicDoc.seq }, content);

  return ok(publicDoc);
}

/** Same publish gate as `publishToPublicHub`; removes the row (blob left as a harmless orphan). */
export async function unpublishPublicDoc(
  actor: Actor,
  config: PublicHubConfig,
  publicHub: Pick<PublicHubRepository, 'unpublish'>,
  slug: string,
): Promise<Result<void, UnpublishError>> {
  if (!canPublish(actor, config)) return err({ code: 'forbidden' });
  await publicHub.unpublish(slug);
  return ok(undefined);
}

/** Anonymous read: one published doc by slug. No actor — there is no tenant context here. */
export async function getPublicDoc(
  publicHub: Pick<PublicHubRepository, 'getBySlug'>,
  slug: string,
): Promise<Result<PublicDoc, PublicDocNotFoundError>> {
  const doc = await publicHub.getBySlug(slug);
  if (!doc) return err({ code: 'not_found' });
  return ok(doc);
}

export const PUBLIC_HUB_DEFAULT_LIMIT = 50;
const PUBLIC_HUB_MAX_LIMIT = 100;

/** One keyset page of published docs (newest first) plus the next cursor. */
export interface PublicDocPage {
  readonly docs: PublicDoc[];
  readonly nextCursor: string | null;
}

/** Opaque keyset cursor over (publishedAt desc, id desc). */
function encodePublicCursor(doc: PublicDoc): string {
  return Buffer.from(`${String(doc.publishedAt.getTime())}:${doc.id}`).toString('base64url');
}

function decodePublicCursor(cursor: string): PublicHubKeyset | null {
  const raw = Buffer.from(cursor, 'base64url').toString();
  const sep = raw.indexOf(':');
  if (sep < 1) return null;
  const time = Number(raw.slice(0, sep));
  return Number.isFinite(time)
    ? { publishedAt: new Date(time), id: raw.slice(sep + 1) as PublicDocId }
    : null;
}

/**
 * Anonymous read: a keyset page of published docs, newest first (Phase 24.F).
 * No actor — there is no tenant context here. Fetches one extra row to know
 * whether a further page exists without a count.
 */
export async function listPublicDocs(
  publicHub: Pick<PublicHubRepository, 'list'>,
  cursor?: string,
  limit?: number,
): Promise<PublicDocPage> {
  const bounded = Math.min(Math.max(limit ?? PUBLIC_HUB_DEFAULT_LIMIT, 1), PUBLIC_HUB_MAX_LIMIT);
  const after = cursor ? decodePublicCursor(cursor) : null;
  const rows = await publicHub.list(after, bounded + 1);
  const hasMore = rows.length > bounded;
  const docs = hasMore ? rows.slice(0, bounded) : rows;
  const last = docs.at(-1);
  return { docs, nextCursor: hasMore && last ? encodePublicCursor(last) : null };
}

/** Anonymous read: the hub's own search, never the tenant FTS index. No actor. */
export async function searchPublicDocs(
  publicHub: Pick<PublicHubRepository, 'search'>,
  query: string,
): Promise<Result<(PublicDoc & { snippet: string })[], PublicSearchError>> {
  const trimmed = query.trim();
  if (!trimmed) return err({ code: 'empty_query' });
  const hits = await publicHub.search(trimmed);
  return ok(hits);
}
