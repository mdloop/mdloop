import type { Document } from '@vorlyn/domain';
import { purgeAfter } from '@vorlyn/domain';
import type { DocumentId, ProjectId, Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
import type {
  DocumentListFilter,
  DocumentRepository,
  ProjectRepository,
  RetentionSweepRepository,
} from '../ports/repositories.port.js';
import type { ErasureLogPort } from '../ports/erasure-log.port.js';
import type { StoragePort } from '../ports/storage.port.js';
import type { Actor, OrganizationRepository } from './org-settings.js';

export type DocumentError =
  | { readonly code: 'document_not_found' }
  | { readonly code: 'project_not_found' }
  | { readonly code: 'org_not_found' }
  /**
   * The target project already holds a live document at this document's repo
   * path (Phase 29). Only reachable when moving a path-backed (CLI-mirrored)
   * document; `documents_project_path_uniq` would otherwise reject the UPDATE
   * as a raw constraint violation.
   */
  | { readonly code: 'path_taken' }
  | { readonly code: 'forbidden' };

export function listDocuments(
  documents: DocumentRepository,
  actor: Actor,
  filter?: DocumentListFilter,
): Promise<Document[]> {
  return documents.list(actor.ctx, filter);
}

export async function getDocument(
  documents: DocumentRepository,
  actor: Actor,
  id: DocumentId,
): Promise<Result<Document, DocumentError>> {
  const document = await documents.byId(actor.ctx, id);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  return ok(document);
}

/** Manage rights (move/archive/delete) = owner or org admin. */
function canManage(actor: Actor, document: Document): boolean {
  return document.ownerId === actor.ctx.userId || actor.role === 'admin';
}

async function requireManageable(
  documents: DocumentRepository,
  actor: Actor,
  id: DocumentId,
): Promise<Result<Document, DocumentError>> {
  const document = await documents.byId(actor.ctx, id);
  if (!document || document.deletedAt) return err({ code: 'document_not_found' });
  if (!canManage(actor, document)) return err({ code: 'forbidden' });
  return ok(document);
}

export async function moveDocument(
  documents: DocumentRepository,
  projects: ProjectRepository,
  actor: Actor,
  id: DocumentId,
  projectId: ProjectId | null,
): Promise<Result<void, DocumentError>> {
  const doc = await requireManageable(documents, actor, id);
  if (!doc.ok) return doc;
  if (projectId !== null && !(await projects.byId(actor.ctx, projectId))) {
    return err({ code: 'project_not_found' });
  }
  // A project move never rewrites `path` — the two are orthogonal (Phase 29) —
  // but it does carry the path into a new uniqueness scope, so a path-backed
  // document can land on one the target project already holds. Refuse with a
  // typed error rather than let the partial unique index throw.
  if (doc.value.path !== null) {
    const occupant = await documents.documentIdAtPath(actor.ctx, projectId, doc.value.path);
    if (occupant !== undefined && occupant !== id) return err({ code: 'path_taken' });
  }
  await documents.moveToProject(actor.ctx, id, projectId);
  return ok(undefined);
}

export async function setDocumentArchived(
  documents: DocumentRepository,
  actor: Actor,
  id: DocumentId,
  archived: boolean,
): Promise<Result<void, DocumentError>> {
  const doc = await requireManageable(documents, actor, id);
  if (!doc.ok) return doc;
  await documents.setArchived(actor.ctx, id, archived);
  return ok(undefined);
}

/**
 * Soft delete with the org's retention policy (CONSTITUTION.md §6): the row
 * is stamped `purge_after`; with `purge_immediately` the blobs and rows go
 * now. Purge order is storage first — a re-run after a storage failure finds
 * the document still due and retries, whereas deleting rows first would
 * orphan the blobs invisibly.
 */
export async function deleteDocument(
  documents: DocumentRepository,
  orgs: OrganizationRepository,
  storage: StoragePort,
  erasures: ErasureLogPort,
  actor: Actor,
  id: DocumentId,
  now: Date = new Date(),
): Promise<Result<{ purged: boolean }, DocumentError>> {
  const doc = await requireManageable(documents, actor, id);
  if (!doc.ok) return doc;
  const org = await orgs.current(actor.ctx);
  if (!org) return err({ code: 'org_not_found' });

  const settings = { retentionDays: org.retentionDays, purgeImmediately: org.purgeImmediately };
  await documents.softDelete(actor.ctx, id, purgeAfter(now, settings));
  if (!settings.purgeImmediately) return ok({ purged: false });

  await storage.deleteDocument(actor.ctx.orgId, id);
  await documents.purge(actor.ctx, id);
  await erasures.record({ kind: 'document_purge', orgId: actor.ctx.orgId, documentId: id });
  return ok({ purged: true });
}

/**
 * Retention sweep (system job, runs on a schedule): permanently purges every
 * soft-deleted document past its `purge_after`. Returns how many were purged.
 */
export async function sweepDuePurges(
  sweep: RetentionSweepRepository,
  storage: StoragePort,
  erasures: ErasureLogPort,
  now: Date = new Date(),
): Promise<number> {
  const due = await sweep.listDue(now);
  for (const { orgId, documentId } of due) {
    await storage.deleteDocument(orgId, documentId);
    await sweep.purge(orgId, documentId);
    await erasures.record({ kind: 'document_purge', orgId, documentId });
  }
  return due.length;
}
