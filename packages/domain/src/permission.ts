/**
 * Permission lattice: read < comment < share < edit (CONSTITUTION.md §5,
 * ARCHITECTURE.md §7, ADR 0014).
 *
 * `edit` became grantable with ADR 0008 (Phase 28) and originally bought
 * exactly one thing: uploading new versions. ADR 0014 (Phase 42) inserted
 * `share` beneath it and made `edit` inherit it by lattice — an `edit`
 * grantee may now also create/revoke grants on the document, via
 * `permits('edit', 'share') === true`. Document _management_ — delete,
 * archive, move, resolve, review requests, suggestion accept/reject — is
 * still NOT on this lattice; it stays owner-or-org-admin via
 * `canManageDocument` in `@mdloop/app`. Keeping management off the lattice is
 * what stops "editor" silently drifting into "owner".
 *
 * `share` buys creating and revoking grants on the document (`canShareDocument`
 * in `@mdloop/app`) — nothing else. A `share`/`edit` holder may only mint a
 * grant at or below their own level (`canDelegate`), and may only revoke a
 * grant they themselves created; the owner and org admin are uncapped on both.
 *
 * Two narrower aliases carry the caps that survive ADR 0008 and ADR 0014, now
 * expressed as explicit ALLOWLISTS rather than `Exclude<Permission, 'edit'>`
 * — a subtractive cap silently admits every new rung added above it, which is
 * exactly the bug a rung insertion must not reintroduce:
 * - `GuestGrantablePermission` — external guests are capped at read/comment
 *   regardless of grant (CONSTITUTION §9, enforced additionally by a DB check
 *   and by `canEditDocument`/`canShareDocument`). This cap is absolute.
 * - `LinkGrantablePermission` — a share link is forwardable, a named user
 *   grant is not, so `share` and `edit` are deliberately not offered on links.
 *   This cap is policy, revisitable without touching the guest rule.
 */
export const PERMISSIONS = ['read', 'comment', 'share', 'edit'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * What a named user grant may carry — the full lattice as of ADR 0014. Kept
 * as a distinct name from `Permission` because grant-shaped call sites read
 * better for it, and because it is the type that would narrow again if a rung
 * were ever withdrawn.
 */
export type GrantablePermission = Permission;

/** What an external-guest grant may carry — never `share` or `edit` (CONSTITUTION §9). */
export type GuestGrantablePermission = 'read' | 'comment';

/** What a share link may carry — never `share` or `edit` (ADR 0008 decision 4, ADR 0014). */
export type LinkGrantablePermission = 'read' | 'comment';

const rank: Record<Permission, number> = { read: 0, comment: 1, share: 2, edit: 3 };

/** True when `held` satisfies a requirement of `required`. */
export function permits(held: Permission, required: Permission): boolean {
  return rank[held] >= rank[required];
}

/** Highest of a set of held permissions; undefined when none held. */
export function highest(held: readonly Permission[]): Permission | undefined {
  let best: Permission | undefined;
  for (const p of held) {
    if (best === undefined || rank[p] > rank[best]) best = p;
  }
  return best;
}

/**
 * May a holder of `held` mint a grant carrying `requested` (ADR 0014)?
 * Delegation is capped at the granter's own rung — you can never create a
 * grant more powerful than the one you hold, so the set of editors can only
 * grow by an edit holder's own action, never past it. Currently identical to
 * `permits`; exported under its own name because the two mean different
 * things (one is "do I meet a requirement", the other is "may I hand this
 * out") and are free to diverge later without a call-site rename.
 */
export function canDelegate(held: Permission, requested: Permission): boolean {
  return permits(held, requested);
}

/**
 * Runtime half of the guest cap — the compile-time alias only protects call
 * sites we typed; this refuses a wire/DB value that arrived any other way.
 */
export function isGuestGrantable(p: Permission): p is GuestGrantablePermission {
  return p === 'read' || p === 'comment';
}

/** Runtime half of the link cap (ADR 0008 decision 4, ADR 0014). */
export function isLinkGrantable(p: Permission): p is LinkGrantablePermission {
  return p === 'read' || p === 'comment';
}
