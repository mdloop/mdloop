import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import type { CommentSearchHit, SearchHit, SearchRepository } from '../ports/repositories.port.js';
import type { Actor } from './org-settings.js';

export interface SearchError {
  readonly code: 'empty_query';
}

/**
 * Full-text search over documents the caller can access (owned, granted, or
 * whole org for admins) — never org-wide. Backed by `search_index`
 * (title + current version body), permission-scoped in the same query
 * (ARCHITECTURE.md §9).
 */
export async function searchDocuments(
  search: SearchRepository,
  actor: Actor,
  query: string,
): Promise<Result<SearchHit[], SearchError>> {
  const trimmed = query.trim();
  if (!trimmed) return err({ code: 'empty_query' });
  const hits = await search.search(actor.ctx, actor.ctx.userId, actor.role, trimmed);
  return ok(hits);
}

/**
 * Full-text search over COMMENTS the caller can reach (ADR 0003 §C) — the same
 * owner/grant/admin permission scoping as document search, replicated in the
 * query through each comment's document, with soft-deleted comments excluded.
 * Comment-grained hits (a discriminated sibling of `SearchHit`) so the caller
 * can jump to the anchor. RLS is the backstop, not the filter.
 */
export async function searchComments(
  search: SearchRepository,
  actor: Actor,
  query: string,
): Promise<Result<CommentSearchHit[], SearchError>> {
  const trimmed = query.trim();
  if (!trimmed) return err({ code: 'empty_query' });
  const hits = await search.searchComments(actor.ctx, actor.ctx.userId, actor.role, trimmed);
  return ok(hits);
}
