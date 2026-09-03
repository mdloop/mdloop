# ADR 0004 — Public Docs Hub (cross-org, unauthenticated, read-only)

- Status: Accepted (2026-07-18, explicit OK per CONSTITUTION §8.5 — plan reviewed and approved by
  Jasdeep before implementation)
- Date: 2026-07-18
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §1 (tenant isolation is absolute), §4 (every API route requires an
  authenticated session except health checks and auth callbacks), §5 (storage boundary, immutable
  versions), §9 (MVP scope)

## Context

The owner wants to publish curated docs (onboarding artifacts, runbooks, guides) to **anyone**, across
**all** orgs, with **no login** and **read-only** — using the platform to promote itself. This is
cross-org broadcast: no single org's `share_grants`/RLS scoping can express "visible to every org and to
no org at all." It also requires a route with no session, which §4 states only health checks and
auth callbacks may have.

Both are real deviations from the letter of Sections 1 and 4, so they need an ADR rather than being
folded quietly into an existing phase.

## Decision

**The public hub lives entirely outside the multi-tenant model — not as an RLS exception on
`documents`.**

- New table `public_documents` has no `org_id` column and RLS is never enabled on it — there is no
  tenant to scope it to. It contains only rows a home-org admin explicitly published.
- New DB role `vorlyn_public_reader` (`nologin nobypassrls`) is granted `SELECT` on `public_documents`
  only. It has no grant on `documents`, `document_versions`, or any other tenant table — it is
  structurally incapable of reading tenant data, not merely policy-restricted from it. The one new
  unauthenticated route (`GET /public/...`) runs exclusively under this role.
- Publishing is the **single bridge** between the tenant model and the public store: a home-org admin
  (gated by `actor.role === 'admin' && actor.ctx.orgId === config.publicHubOrgId`, config-driven, no new
  role concept) triggers a snapshot copy — read the source version inside normal `withTenant` (home org),
  write a copy into the public table/keyspace via the existing `vorlyn_provisioner` role. The public read
  path never runs this bridge in reverse and never constructs a tenant `VersionKey`.
- Blob content is snapshot-copied at publish time into a separate keyspace (`public/{publicDocId}/v{seq}`),
  not referenced live — editing the source document does not change what's public until re-published.
  This keeps published runbooks stable and keeps the public read path from ever touching tenant blob
  paths.
- Core Principle 1 ("no code path may return another organization's data") is preserved because the
  public store isn't another organization's data being returned across a boundary — it's data the owning
  org's admin explicitly promoted out of the tenant model, through one auditable use-case, same shape as
  choosing to make something public on any platform.
- §4's authenticated-by-default rule is amended: the public hub's read routes (`GET /public/docs`,
  `GET /public/docs/:slug`, `GET /public/docs/:slug/content`, `GET /public/search`) join `/healthz` and
  `/auth/*` as the named exceptions, registered on the base Fastify instance before the session-guard
  scope (`packages/api/src/server.ts`), mirroring the existing sessionless guest-redeem route.

Rejected alternative — RLS carve-out on `documents` (`... OR is_published = true`): rejected because it
mixes a public-read exception into the same policy that guarantees tenant isolation for every other row,
widening the blast radius of any future policy bug on that table. A separate table with no RLS at all is
smaller, auditable in one place, and cannot regress tenant isolation by construction.

Rejected alternative — live pointer instead of snapshot copy: rejected per product decision (2026-07-18)
— published runbooks should not shift under readers mid-edit, and a live pointer would require the public
route to construct a tenant `VersionKey`, eroding the "no function accepts a raw storage key from outside"
rule.

## Scope

Read-only. No comments, threads, anchoring, or reactions on public docs. Only the latest published
snapshot per slug is servable (no public version history). Only the configured home org
(`PUBLIC_HUB_ORG_ID`) may publish in v1 — this is not a self-serve feature for every customer org.
Full implementation: `packages/api`'s public Hub routes and `PUBLIC_HUB_ORG_ID` config.
