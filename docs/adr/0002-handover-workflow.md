# ADR 0002 — Handover workflow: sign-off, agent attribution, suggested edits

> **§C decisions 2 and 3 superseded by ADR 0007** (2026-07-26). This ADR originally made accepting
> a suggestion equivalent to an upload ("accepting is honesty-gated... extended from display to
> action", "accepting is owner-or-org-admin... because accepting _is_ an upload"). ADR 0007 replaces
> both: accepting is now metadata-only, and materialization is detected lazily by the re-anchor
> pipeline. §C decision 1 (suggestion is a comment subtype, not a new table) and decision 4
> (suggestions count toward the comment cap) are untouched. This note is a pointer, not a rewrite;
> see `docs/adr/0007-deferred-suggestion-materialization.md` for the full decision.

- Status: Accepted (2026-07-17, explicit OK per CONSTITUTION §8.5)
- Date: 2026-07-17
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §9 (MVP scope exclusions), §5 (anchor model, Core Principle 2), Phase 18 (guest sharing), ADR 0001 (version tombstones)

## Context

CONSTITUTION §9 explicitly lists "sign-off workflow" and "suggested edits" as out of MVP scope ("needs dreaming + ADR"). Both are now being built as part of one "handover" arc, alongside agent attribution (which touches no listed principle and needs no ADR on its own, but is documented here since the arc's later decisions depend on it). Per §8.5, any change to §1–9 requires an ADR and explicit human OK before merge — this is that ADR, written to cover the whole arc rather than two separate ceremonies, since sign-off and suggested edits share the same underlying tension: extending the product beyond "comment on a version" into "acting on a version's behalf" without breaking Core Principle 2 (comments never lie) or the Phase 18 guest hard rule (external guests never mutate a document).

Three features, one arc:

- **A. Agent attribution** — a nullable `via_api_key_id` on comments, replies, versions, and (below) approvals, so a human can tell a machine-authored contribution from a person's. Shipped first; no principle touched, no ADR needed on its own.
- **B. Sign-off workflow** — version-pinned reviewer requests and approve/changes-requested verdicts, with a derived (never stored) document status.
- **C. Suggested edits** — a comment subtype carrying proposed replacement text; accepting one re-anchors, splices, and uploads a new version through the existing owner/admin-gated path.

## Decision

### B. Sign-off workflow

1. **Status is derived, never stored.** No `status` column on `documents` or anywhere else. `draft | in_review | changes_requested | approved` is computed from active `review_requests` rows and `approvals` rows filtered to the document's current version, every time it's read. Rejected alternative: a cached/materialized status column, updated by triggers or application code on every request/approval/version-upload. Rejected because a derived value can never drift from the facts it summarizes — the same reasoning CONSTITUTION §5 already applies to comment anchors (Core Principle 2) applies here to review status.

2. **Approvals are append-only, latest-verdict-per-reviewer-per-version wins.** A verdict is never updated or deleted at the application layer — the `approvals` table grants `select, insert` only, no `update`, no `delete` (structural, not just convention). A reviewer who changes their mind submits a new row for the same version; the derivation takes each reviewer's most recent verdict. Rejected alternative: `upsert` on `(version_id, reviewer_user_id)`. Rejected because it destroys the historical record of a reviewer's earlier verdict, which is exactly the kind of silent rewrite Core Principle 2 already forbids for comments — a verdict, once given, is a fact about a point in time, not a mutable field.

3. **Approvals and requests are erasable only by cascade, never by direct delete.** Document purge / retention / org erasure legitimately needs these rows gone — but that must happen only as a structural consequence of the document (or its version) being destroyed entirely, via `on delete cascade` FKs to `documents` and `document_versions`, never via an explicit `DELETE FROM approvals` issued by application code. This was discovered as a real bug during implementation (the purge path originally issued explicit deletes against a table it had no delete grant on) and fixed by adding the cascade — which is also the more correct expression of the invariant: a verdict disappears if and only if the thing it was a verdict _about_ disappears.

4. **`approval_gate` is an org setting, `soft` (default) or `hard`.** Soft never blocks an approve verdict, regardless of open comments — it only surfaces a warning ("N comments still open") in the UI. Hard refuses an approve verdict with open comments (`open_comments_block_approval`, 409) until they're resolved; `changes_requested` is never gated by either mode. Same pattern as `sharing_mode`/`external_sharing` (CONSTITUTION §2 admin-only settings). Rejected alternative: hard-only (simpler, one code path) — rejected because it lets any single commenter filibuster an approval indefinitely, which is worse than the flexibility cost of a second mode.

5. **Guests can be requested reviewers.** A guest with an active `comment`-permission grant (Phase 18) can be named a reviewer and can submit a verdict, exactly like any member. **This is a deliberate, careful extension of Phase 18, not a weakening of it.** The Phase 18 hard rule — "external guests are capped at read + comment/annotate — never document updates, never new versions" — survives _structurally_: a verdict is a row in an append-only table with no relationship to document content; the only verb in this entire arc that mutates a document (`uploadNewVersion`, reused unchanged by Phase C below) remains gated to owner-or-org-admin, which a guest role can never satisfy. No schema change to `share_grants.permission` (still `read | comment` only, `edit` never grantable) was needed or made. Guests never request reviews or revoke them (owner/admin only, defense-in-depth both at the route allowlist and in the use-case).

6. **Reviewer access reuses `documentPermissionFor`, no new authority model.** A request is valid only if the named reviewer already has some access to the document (owner, org admin, or an active grant) — requesting a reviewer never _grants_ access, it only asks someone who already has it to look. This is why a guest with a comment grant qualifies without any new mechanism: `documentPermissionFor` already resolves guests correctly (Phase 18).

### A. Agent attribution (prerequisite, no ADR-worthy tension)

`Actor` gains an optional `apiKeyId`, populated only when the request came through an MCP tool call via `actorForApiKey` — a session-authenticated actor's `apiKeyId` is always absent. Recorded as a nullable, composite-FK'd `via_api_key_id` on comments, replies, versions, and approvals. Key _names_ (not the key itself) are joined into read DTOs at the route layer, never in the domain/app layer, and never enter logs or telemetry (Core Principle 3) — an operator-chosen label is not org content, but it's still kept out of the one place CONSTITUTION says nothing but opaque IDs may go.

### C. Suggested edits (design decided; not yet built as of this ADR)

1. **A suggestion is a comment subtype, not a new table.** `comments.kind` (`comment | suggestion`), `proposed_text`, `suggestion_outcome`, `applied_version_id`. This inherits, unchanged: anchor storage and `validateAnchor`, the confidence-scored re-anchoring pipeline and its cache, threading/replies/upvotes, the per-document comment tier cap, the guest route allowlist (creating a comment is already guest-open), soft delete, and the feedback bundle. Rejected alternative: a separate `suggestions` table. Rejected because it would duplicate all of the above rather than reuse it, for a feature whose only real difference from a comment is two extra fields and a different accept verb.

2. **Accepting a suggestion is honesty-gated exactly like re-anchoring a comment, extended from _display_ to _action_.** Core Principle 2 today means: a comment's anchor, if it can't be re-resolved above the 0.6 confidence floor, is shown as honestly orphaned rather than silently misattached. Accepting a suggestion extends the same rule one step further — the same `resolveTextAnchor` call that would otherwise just _locate_ the text for re-anchoring is now used to locate it for _splicing_, and a below-floor result refuses the accept outright (`suggestion_unanchored`) rather than guessing where to place the replacement text. No new anchor logic; the existing floor and the existing resolver are reused as-is.

3. **Accepting a suggestion is owner-or-org-admin, using the exact same check as `uploadNewVersion`** (`upload.ts:147-150`), because accepting _is_ an upload — splice the proposed text into the current content, encode it, call `uploadNewVersion` unchanged (dedup, quota-as-applier, read-only gate, version cap all inherited free). This is what keeps the guest hard rule intact for suggestions too: a guest can create a suggestion (comment permission), but can never accept one, structurally, because they can never pass the owner-or-admin check — same reasoning as guest reviewers above, same single choke point.

4. **Suggestions count toward the free-tier comment cap.** Intended, not an oversight — an unbounded, hard-to-review flood of proposed edits is exactly the kind of abuse the existing cap already guards against for ordinary comments.

## Constitution amendments (applied with this ADR)

- **§9 MVP scope**: "sign-off workflow" and "suggested edits" move from the "post-MVP exploration" / "explicitly out" lists to shipped scope. The existing hard rule under external guest sharing — "external guests are capped at read + comment/annotate — never document updates, never new versions" — is retained verbatim; this ADR documents _how_ two new guest-visible actions (submitting a verdict, creating a suggestion) both stay inside that cap.
- **API/MCP parity table** (§5): grows by five tools total across the arc — `request_review`, `get_review_status`, `submit_review` (Phase B); `accept_suggestion`, `reject_suggestion` (Phase C, plus an extension to the existing `create_comment` tool rather than a sixth new tool, for parity with the HTTP route which reuses `POST /documents/:id/comments`).
- **Money-path Gherkin** (§3, §8.2): the reviewer-authority matrix (including the guest boundary and the hard/soft gate) and, when Phase C lands, the suggestion accept-permission matrix (including the guest boundary and the unanchored refusal) are both required scenarios, per the standing rule that permission checks and tenant isolation are always specified as executable Gherkin.

## Consequences

- New tables `review_requests`, `approvals`; new column `organizations.approval_gate`; new nullable `via_api_key_id` columns on four tables. All RLS-enforced, composite-`(id, org_id)`-FK'd, per the standing tenant-isolation rule.
- `/overview` and the MCP feedback bundle both grow a `review` field — one grouped per-org query (`reviewRollup`), not a per-document query, to keep the home-list read cost flat as review data grows.
- Accepted suggestions mint new versions, which interacts with ADR 0001's version-count ceilings (a full version cap blocks an accept with the same `version_cap_exceeded`-family error `uploadNewVersion` already returns for any other upload — no new cap logic).
- What we give up: a small amount of purity in "comments are for discussion, not action" — a suggestion is a comment that can trigger a version upload, and a verdict is table content that gates a workflow. Accepted, because both stay behind the exact same authority checks (owner/org-admin) that already gate every other document mutation, so the boundary that actually matters — who can change a document — has not moved at all.

## Alternatives considered

- **A `PATCH /documents/:id { reviewStatus }` endpoint letting a reviewer set status directly**: rejected outright — it's the status-column mistake (decision 1) at the API layer instead of the schema layer, same drift risk.
- **Suggested edits as a distinct `edit` share-grant permission**: rejected — CONSTITUTION locks `share_grants.permission` to `read | comment`, and a new grantable `edit`-adjacent permission would be exactly the schema change the lock exists to prevent. The comment-subtype design needs no grant change at all.
- **Gating guest verdicts behind a new org toggle (e.g. `guest_signoff_enabled`)**: considered for extra caution, rejected as unnecessary — the existing `external_sharing` toggle already gates whether guests exist for a document at all; a second toggle would be a distinction without a difference, since a guest who can comment can already, by Phase 18 design, participate in the document's discussion.
