/**
 * Web-side mirror of the share-permission lattice (`read < comment < share <
 * edit`, `packages/domain/src/permission.ts`, ADR 0014). `web` cannot import
 * `@vorlyn/domain` (dependency-cruiser `web-frontend-only` — the web app
 * talks HTTP and nothing else), so this is a deliberate small duplicate, same
 * precedent as `mentions.ts`/`upload-precheck.ts`. Shared by `share-panel.tsx`
 * (document grants) and `project-share-panel.tsx` (project grants, ADR 0014)
 * so the label copy and the delegation cap can't drift between the two.
 */

export type SharePermission = 'read' | 'comment' | 'share' | 'edit';

const RANK: Record<SharePermission, number> = { read: 0, comment: 1, share: 2, edit: 3 };

/** Human copy for a grant's `permission`, used anywhere one is rendered. */
export const PERMISSION_LABEL: Readonly<Record<SharePermission, string>> = {
  read: 'Can read',
  comment: 'Can comment',
  share: 'Can share',
  edit: 'Can edit',
};

/**
 * The permissions a caller at `callerLevel` may grant to someone else,
 * mirroring domain `canDelegate`: owner/org-admin (`'manage'`) may grant all
 * four; anyone else — a `share` or `edit` grantee — is capped at or below
 * their own held rung. Order matches display order (comment, read, share,
 * edit), not lattice rank.
 */
export function delegableOptions(callerLevel: SharePermission | 'manage'): SharePermission[] {
  const display: SharePermission[] = ['comment', 'read', 'share', 'edit'];
  if (callerLevel === 'manage') return display;
  return display.filter((p) => RANK[p] <= RANK[callerLevel]);
}
