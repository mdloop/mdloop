# ADR 0008 — `edit` becomes a grantable share permission

- Status: Accepted (2026-07-30, explicit OK per CONSTITUTION §8.5)
- Date: 2026-07-30
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION §9 (MVP scope — the sharing/roles line, and the external-guest hard rule, which this ADR leaves intact), CONSTITUTION §5 (permission lattice), ADR 0006 (expand/contract migrations — this one is expand-only), ADR 0007 (deferred suggestion materialization — the prerequisite that made repo-pushed content safe), ADR 0002 §C (suggestion accept/reject — deliberately NOT widened here), the IDE-agnostic sync CLI (`packages/cli`, the consumer this unblocks)

> **Amended by ADR 0014** (2026-08-13, Phase 42): decision 1's claim that `edit`
> "explicitly does not buy ... re-share the document" is no longer accurate.
> ADR 0014 inserts a `share` rung between `comment` and `edit` and makes `edit`
> inherit it by lattice (`permits('edit', 'share') === true`), so an `edit`
> grantee can now also create/revoke grants on the document. Everything else
> below — including that document _management_ (delete/archive/move, resolve,
> review requests, suggestion accept/reject) stays owner-or-org-admin via
> `canManageDocument`, untouched by either ADR — remains accurate as written.
> This note is a pointer, not a rewrite; see `docs/adr/0014-share-permission-and-project-grants.md`
> for the full decision.

## Context

`canManageDocument` (`packages/app/src/policy.ts`) is "owner OR org admin", and `uploadNewVersion` (`packages/app/src/use-cases/upload.ts`) gates on it directly, with the comment "Edit right = upload new versions: owner or org admin, never a grantee." That was defensible while every document entered Vorlyn by its owner dragging a file into the web app.

It stops being defensible the moment a repo is the source of truth. The Phase 20 sync CLI pushes with a **per-developer API key**, and an API key executes as its owning user (`api_keys`, ARCHITECTURE §4). So developer B pushing a document developer A happened to create first gets `forbidden` — not because B lacks access to the repo, the document, or the project, but because of who ran `vorlyn link` first. The workarounds are all worse than the rule: share one API key across the team (destroys `via_api_key_id` attribution and any audit story), make every developer an org admin (hands out org-wide destructive rights to fix a per-document problem), or have the CLI impersonate the document owner (a lie in the version list). The only honest fix is to make "may push new versions of this document" a thing you can be granted.

ADR 0007 already removed the blocker underneath this: accepting a suggestion no longer mints a version, so Vorlyn never originates content for a document whose canonical copy lives in a repo. Without that, adding more writers to a document would have multiplied the collision surface this ADR is trying to serve.

**This contradicts a stated hard rule.** `CONSTITUTION.md` §9 and `CLAUDE.md` both say `share_grants.permission` is `read | comment` only — "`edit` is never grantable, by schema" — and `packages/domain/src/permission.ts` enforced it with `GrantablePermission = Exclude<Permission, 'edit'>`. Per CONSTITUTION §8.5, changing it requires this ADR plus an explicit human OK, which was given when the Phase 28 plan was approved on 2026-07-30.

## Decision

### 1. `edit` is grantable, and it is narrow

An `edit` grant buys exactly one capability: **`uploadNewVersion`**. That is the whole list.

It explicitly does **not** buy: delete, archive, move between projects, resolve a comment, re-share the document (share link, user grant, or guest share), request or revoke a review, or **accept/reject a suggested edit**. Those all stay owner-or-org-admin. ADR 0002 §C's accept gate, as amended by ADR 0007 decision 4, is unchanged — deciding whether a proposal is _right_ is an authorship judgement, while pushing the bytes the repo already agreed on is not, and this ADR only claims the second.

The narrowness is enforced structurally, not by convention: a **new predicate** `canEditDocument(actor, document, grant)` sits next to `canManageDocument` in `packages/app/src/policy.ts`, and `canManageDocument` is not touched. Nothing that gates on management today silently changes meaning. If the two were merged, or if `canManageDocument` had simply learned about grants, every management call site would have widened at once — which is precisely the drift this ADR exists to prevent.

### 2. Schema: `read | comment | edit`, expand-only

Migration `0030_grantable_edit.sql` widens the `share_grants_permission_check` constraint to `check (permission in ('read', 'comment', 'edit'))`.

Expand-only per ADR 0006 / Core Principle 6: widening a `CHECK` is additive, so every row the old app version can write still satisfies the new constraint and both versions run against this schema simultaneously. No contract step is needed or scheduled — nothing is removed. In the blue-green window the old version never _writes_ `'edit'` (its wire schema enums it out) and on _read_ only passes the string through to a display label, so a row written by green and read by blue degrades to an unfamiliar label, never an error.

### 3. The external-guest carve-out is absolute — three independent layers

CONSTITUTION §9's hard rule is unchanged and non-negotiable: **external guests are capped at read + comment/annotate — never document updates, never new versions, regardless of grant.** Widening the enum makes that rule newly _expressible_ in a row, so it is now enforced three separate times, each sufficient on its own:

- **(a) The database.** Migration 0030 also adds `check (permission <> 'edit' or grantee_email is null)`. Every guest grant carries `grantee_email` by construction (migration 0011), so "a guest grant is never `edit`" is a database guarantee, not app discipline. It covers the guest re-share path too, which UPDATEs `permission` in place (`extendGuestGrant`).
- **(b) Grant creation.** `createGuestShare` types its `permission` as `GuestGrantablePermission` and re-checks at runtime via `isGuestGrantable`, returning `guest_edit_forbidden`. `createUserGrant` refuses `edit` when the named grantee's `users.role` is `guest`. The guest-share HTTP route keeps its `['read','comment']` wire enum.
- **(c) The policy predicate.** `canEditDocument` returns `false` for `actor.role === 'guest'` _before it reads the grant at all_. A row forged straight into the table by any means still buys nothing. `documentPermissionFor` mirrors this on the read side, filtering `edit` out of a guest's held permissions rather than reporting it.

`blockGuestBeyondReview` (`packages/api/src/auth/guards.ts`) is untouched and remains the transport-level route allowlist — a fourth layer that predates this ADR.

### 4. `edit` is grantable on named user grants only, not share links

`createShareLink` and link redemption stay capped at `read | comment` (`LinkGrantablePermission`, plus a refusal in `redeemShareLink` for any `edit` row that reached the table another way). A link is forwardable and a named grant is not, and that is a materially different blast radius for the first loosening of a constitutional rule. This is a **policy** cap, not a structural one — it is one type alias and one branch to relax later if directory mode proves too narrow in practice, and relaxing it would not touch the guest rule in decision 3, which is structural.

### 5. The type-level cap moves rather than disappears

`GrantablePermission` becomes an alias for `Permission` (keeping the name means ~30 grant-shaped call sites don't churn), and the `Exclude<Permission, 'edit'>` cap is re-homed — twice, with different force — as `GuestGrantablePermission` (decision 3, absolute) and `LinkGrantablePermission` (decision 4, policy). Runtime twins `isGuestGrantable`/`isLinkGrantable` refuse values that arrive from a wire or a database row without passing through the typed call sites. The compile-time guarantee that existed is not deleted; it is narrowed to where it is still true.

### 6. `myPermission` reports the lattice honestly

`documentPermissionFor` previously fell through to `'read'` for any grant that wasn't `comment`. Left alone, an `edit` grantee would read back as `read` — unable to even comment in the web UI on a document they can overwrite. So this function had to change either way; it now reports `'edit'` for an `edit` grant.

The consequence is that `myPermission === 'edit'` no longer implies management rights, and the web viewer had conflated the two into a single `canEdit` boolean. It is split into `canEdit` (upload affordances: New leg, paste-to-upload, quiet-marks reading posture, header primary-action choice) and `canManage` (resolve, suggestion accept/reject, review control, share panel), the latter computed client-side from `document.ownerId` + `me.role` — **no API change**. Behaviour is identical for every actor that existed before this ADR: owners and admins are both, read/comment users are neither.

`createGuestShare` was the repo's only `requireDocumentAccess(…, 'edit')` caller, where `'edit'` was a stand-in for "owner or admin". It now requires `'read'` plus an explicit `canManageDocument`, still returning `document_not_found` on failure so the no-existence-oracle behaviour is byte-identical.

## Constitution amendments (applied with this ADR)

- **§9 core-scope line**: "roles (admin/member, read vs comment)" → "read / comment / edit (ADR 0008)". The external-guest hard rule in the same section keeps its wording, with the DB-check note added.
- **`CLAUDE.md` hard rules**: the `share_grants.permission` bullet becomes `read | comment | edit`, stating that `edit` buys `uploadNewVersion` only and that guests are excluded by schema + grant creation + policy.
- **`docs/ARCHITECTURE.md`**: §7 lattice line and the `share_grants` data-model line; ADR index extended (it was stale at 0005) and the migration range corrected.
- No RLS change. No change to the tenant-isolation model: an `edit` grant is an ordinary `share_grants` row under RLS, so it is unreachable across an org boundary by construction — proven per §8.3 across API, MCP, and direct repository call.

## Consequences

- **The "by schema" absolute becomes "by schema for guests, by policy for everyone else."** That is a real weakening of a constitutional guarantee and should be read as one. The compensation is that the part with the strongest justification (guests) is the part that stays schema-enforced, and it gained a check constraint it never actually had before — the old guarantee came from the enum not containing `edit` at all, which protected guests only incidentally.
- `features/sharing.feature`'s "The schema itself refuses an edit grant" scenario is **rewritten, not deleted** — it now proves the guest case, which is the part that is still schema-true.
- **An asymmetry users may find surprising**: an `edit` grantee can push a new version of a document but cannot accept a suggestion on it, cannot resolve a comment, and cannot re-share it. This is intentional (decision 1), but it is the kind of thing that generates a support question. Revisit resolve rights first if it does; suggestion accept last.
- Phase 20's sync CLI becomes usable by any grantee, not just the document owner — which is the entire point. A teammate cloning the repo needs only their own `VORLYN_API_KEY` plus an `edit` grant on the documents they push.
- `SharingError`/`GuestShareError` each gain `guest_edit_forbidden` (HTTP 403), and `POST /documents/:id/shares` gains a 400 `edit_not_grantable_by_link`. Both are new failure modes on shipped routes.
- The upload gate now reads the caller's grant inside the same transaction as the rest of the check (`UploadTx.highestGrantFor`), so a concurrent revoke cannot race a push through. Owner and admin pushes short-circuit before that query, so the common path costs nothing extra.

## Alternatives considered

- **A separate `document_editors` table** instead of a permission rung: rejected. It creates two overlapping grant systems with two revocation stories and two expiry stories, when the lattice already had the rung, the repository already had the queries, and the revoke/expire semantics already worked.
- **Widening `canManageDocument` itself**: rejected — it silently hands delete, re-share, resolve, and suggestion-accept to every editor in one edit. Exactly the drift decision 1 exists to prevent.
- **Leaving push owner-only and having the CLI impersonate the document owner**: rejected. It destroys agent attribution (`via_api_key_id`), makes the version list lie about who pushed, and leaves no audit story — all to preserve a rule that was an artifact of the upload UX, not a security boundary.
- **Allowing `edit` on share links too** (the wider read of decision 4): deferred, not rejected. It is genuinely useful for link-mode orgs, but a forwardable edit right is a different risk conversation and this ADR should not smuggle it in.
- **Also widening suggestion accept/reject to editors**: rejected here for the same reason ADR 0007 declined to widen it to guests — a permission-boundary change deserves its own scrutiny, not a free ride on an adjacent ADR.
