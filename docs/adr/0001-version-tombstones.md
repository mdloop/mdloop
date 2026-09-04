# ADR 0001 — Version blobs become deletable-by-policy (tombstones)

- Status: Accepted (2026-07-19, explicit OK per CONSTITUTION §8.5 — confirmed shipped in Phase 12
  and referenced as governing authority by ADR 0002 and ADR 0003 since; status corrected during the
  Phase 24 docs pass, which found it stale at "Proposed" despite the machinery being live for
  multiple phases)
- Date: 2026-07-13
- Deciders: Jasdeep (product)
- Relates to: the tiered-retention decision this ADR records (2026-07-13)

## Context

CONSTITUTION §5 states versions are **immutable**: "every upload creates a new version row + new S3 object. Nothing mutates a stored blob." CONSTITUTION §6 fixes retention at a flat "life of document; 30 days after delete."

The pricing decision (2026-07-13) introduces **tiered retention** with **version auto-purge**: old version blobs are deleted automatically per an org-configurable keep-last-N / younger-than-T rule, clamped to a tier ceiling. This deletes stored blobs by policy, which conflicts with the current §5 wording and supersedes the flat §6 retention row. Per §8.5, any change to §1–7 requires an ADR and explicit human OK — this is that ADR.

The tension to resolve: Core Principle 2 (**comments never lie**) depends on versions existing so comments survive re-uploads. Deleting version content must not orphan or misattach comments, and must never silently pretend content still exists.

## Decision

Version **blobs** become deletable by retention policy. Version **rows** never are — a purged version's row becomes a **tombstone**.

1. **Purge rule per document**: a version is purged once it is **older than T days AND outside the last N versions** (equivalently: kept while among the last N OR younger than T — whichever rule keeps it, it stays). N/T are org settings on every tier (admin-only, per §4); the tier defines only the ceiling, and orgs may configure stricter, never looser. Enforcement in the domain layer via the same `QuotaLimits`-style ceiling-profile machinery — one code path for all tiers.

   **Product defaults and ceilings** (defaults apply until an org admin changes them):

   | Tier       | Ceiling                   | Default                                                      |
   | ---------- | ------------------------- | ------------------------------------------------------------ |
   | Free       | N ≤ 20, T ≤ 90 days       | N = 20, T = 90 days (= ceiling)                              |
   | Team       | N ≤ 1,000, T unlimited    | N = 50, T = 180 days                                         |
   | Enterprise | Custom (set per contract) | N = 50, T = 180 days (Team defaults) until custom-configured |

2. **Always keep**: the current version, and any version referenced by an **open (unresolved) comment**. An active discussion never loses its source document. Resolved-comment versions are purgeable.
3. **Purge = blob only.** The row is retained as a tombstone: `id`, `org_id`, content hash, byte size, timestamps kept; `purged_at` set; S3 object deleted (via the typed `VersionKey` path — no raw keys, per the storage-seam rule).
4. **Comments stay truthful without the blob**:
   - Comments keep a valid `(version_id, org_id)` composite FK forever — nothing nulled, nothing cascaded; RLS and the composite-FK scheme are untouched.
   - The anchor JSONB on the comment row already stores the exact quote + surrounding context (§5), so a comment on a purged version still displays its quoted text truthfully. Only "open the full original document" is lost.
   - A comment whose pinned version is purged is **not** orphaned: it keeps quote + context; deep links fall back to the nearest surviving version via normal confidence-scored re-anchoring, orphaning below threshold as usual. Core Principle 2 intact.
5. **Honest degradation**: version lists show tombstones as "content purged per retention policy". Diff and re-anchoring need two blobs; against a tombstone they report "not available — version purged" — never a guess. Identical behavior via HTTP and MCP (§5 parity).
6. **Interaction with tier upload caps**: the versions-per-doc caps (Free 100 / Team 1,000) count **live blobs, not tombstones** — auto-purge frees headroom, so the cap bites only sustained bursts inside the retention window. The cap blocks new uploads; it never prunes old versions (pruning-by-cap would be a second, implicit deletion path — auto-purge is the only one).

## Update (2026-08-13): Team/Enterprise ceiling retuned, no longer unlimited

The N/T table in the Decision section above is the original 2026-07-13 numbers, left as the historical
record rather than silently edited. The actual platform-supported maximums as of 2026-08-13 (source of
truth: `packages/domain/src/tier.ts`'s `TIER_PROFILES`):

| Tier       | Ceiling                              | Default                                    |
| ---------- | ------------------------------------ | ------------------------------------------ |
| Free       | N ≤ 20, T ≤ 90 days                  | N = 20, T = 90 days (= ceiling, unchanged) |
| Team       | N ≤ 250, T ≤ 365 days                | N = 50, T = 90 days                        |
| Enterprise | N ≤ 250, T ≤ 365 days (same as Team) | N = 100, T = 180 days                      |

What changed and why: Team's `T unlimited` ceiling was a live, self-serve cost exposure (flagged
2026-08-10) — an admin could set `keepDays: null` and ride `keepLastN` to its old 1,000
ceiling, reaching 2.5TB/org with no cost signal anywhere in the product. Closing it meant giving every
tier a finite day ceiling, which meant Enterprise's ceiling (previously `null`/unlimited, "Custom (set
per contract)" per the original table above) had to become finite too, rather than carved out as an
exception — no per-org/per-contract override of `TIER_PROFILES` exists in code, so "Custom" was never a
real mechanism, only prose (tracked, not built, in `tier.ts`'s doc comment on `TIER_PROFILES.enterprise`).
Team and Enterprise now share one finite ceiling; Enterprise keeps a higher _default_ (100/180 vs
50/90) so it still reads as more generous day to day. `keepDays: null` (unlimited age) is consequently
never valid admin input on any tier anymore — every ceiling clamps it to a finite number, which is
always looser than the `null` input and therefore rejected — so the org-settings UI's "or younger than"
field became a required number rather than an optional "blank = no day limit" one. Rule #1
(purge-when-outside-both-N-and-T), #2 (always keep current + open-comment versions), and #3–6 (tombstone
mechanics) are all unchanged; only the N/T constants moved. No new ADR: this is a parameter retune within
the design this ADR already established, not a §1–7 architectural deviation.

## Constitution amendments (applied with this ADR)

- **§5 "Immutable versions"** → renamed **"Immutable version content, tombstone-on-purge"**: content is never mutated in place — a blob is either the bytes originally uploaded or deleted by retention policy, in which case the version row persists as a tombstone (`purged_at`) and comments retain valid FKs and truthful quotes. No history-rewrite path exists.
- **§6 retention table**: document-content row now reads "per tier retention policy" (tiered soft-delete windows + version auto-purge, `packages/domain/src/tier.ts`) instead of the flat 30-day rule. Purge-from-backups horizon: 35 days, uniform.

## Consequences

- New machinery (Phase 12): `purged_at` on version rows, purge worker, org retention settings + tier ceiling clamp, tombstone rendering in web/MCP, purge events into the erasure log (Phase 14).
- Restore procedure must replay the erasure log so purged blobs stay purged after a PITR restore (Phase 10 runbook stub, Phase 14 drill).
- Gherkin money paths required for every keep/purge rule, open-comment pinning, tombstone display, and live-blob cap counting (§3).
- What we give up: guaranteed ability to open any historical version forever. Accepted — old versions are mostly noise, the quote survives on the comment, and compliance customers _want_ drafts destroyed.

## Alternatives considered

- **Delete version rows entirely**: dangling or nulled comment FKs, cascade deletes of comments, or re-pointing comments to other versions — every variant either lies (Core Principle 2) or destroys discussion history. Rejected.
- **Never purge (status quo)**: unbounded storage growth is cheap relative to other costs in this system, but it is a privacy/compliance liability — orgs, especially compliance-minded ones, need drafts destroyable by policy. Rejected.
- **S3 lifecycle rules as the mechanism**: lifecycle rules can't express "keep last N", "keep open-comment versions", or per-org N/T — the rule engine must be in the domain layer; S3 only executes deletes. Rejected as the policy engine (still used for soft-delete expiry where applicable).
