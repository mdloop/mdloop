# ADR 0003 — Rendered leg diff, version notes, comment search, mentions, and the signal budget

- Status: Accepted (2026-07-17, explicit OK per CONSTITUTION §8.5; diff cap set to 200 KB per leg by decider)
- Date: 2026-07-17
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §3 (layering, no org data in logs), §5 (anchor model, parity table), §9 (MVP scope — "Version diff view: rendered markdown diff" is already in locked scope; "webhooks" and "diagram diffs" are explicitly out), ADR 0001 (tombstones), ADR 0002 (suggested edits reuse), Phase 6 (source diff), Phase 18 (guests)
- Informed by: two independent reviews run 2026-07-17 — an adversarial architecture/scalability review and a UX signal-density review (two personas: non-technical reviewer on a shared link vs. power user). Their load-bearing findings are inlined below rather than filed separately.

## Context

The Phase 6 diff is source-level: `DiffView` fetches the old leg's raw markdown and renders a `diff-match-patch` character diff in a `<pre>` (`packages/web/src/components/diff-view.tsx`). The §9 scope line — "Version diff view: **rendered** markdown diff, 'what changed since my comment'" — has therefore never actually been met; the source view was the honest v1 because deletions need somewhere to live and a plain re-render has nowhere to show removed text.

This ADR covers the arc that closes that gap plus four adjacent review-loop features (MCP version awareness, version notes, comment search, mentions), and — because the UX review found the viewer's signal budget already at its ceiling — the disclosure rules that keep all of it usable by a non-technical reviewer.

Two review findings shape everything below:

1. **Boundary reality (architecture review).** `web` cannot import `domain` (`.dependency-cruiser.cjs` `web-frontend-only`, CI-enforced), and `shared` cannot import `domain` either. So "a domain diff function reused client-side" is impossible as stated. Any reuse of the domain re-anchoring scorer must happen server-side.
2. **Amber is over-subscribed (UX review).** The `--signal` amber hue carries eight distinct meanings in the shipped viewer (open marks, minimap ticks, density layer, diagram tint, open-suggestion chips, warning callouts, `in_review` chip, and — wrongly — the `approved` chip background). Adding diff color on top without first paying this debt produces rainbow soup, worst for exactly the persona the product courts: the once-a-week non-technical reviewer.

## Decision

### A. Rendered leg diff — server-side structural diff, rendered by a transient Compare surface

1. **`computeDocDiff(before, after)` lives in `packages/domain`, and the diff is computed server-side.** Exposed as `GET /documents/:id/diff?from_seq&to_seq` returning structured block-diff JSON; `DiffView` renders that JSON. This inverts the naive "diff in the browser" ordering because of the boundary reality above, and buys three things at once: legitimate reuse of `reanchor.ts`'s `similarity`/`diffVersions` for block pairing (block alignment _is_ re-anchoring — same primitive, already tested), ETag caching from day one, and API/MCP parity without a second implementation.

   **Dependency ruling (explicit, per CONSTITUTION §3):** `remark`/`mdast` join `diff-match-patch` (already a domain dependency, `packages/domain/package.json`) as permitted domain libraries. The §3 rule's spirit is "no I/O, no platform, no framework coupling" — a pure `string → AST` parser is a computation library, same category as a diff engine. dependency-cruiser does not police npm deps; this ADR line is the governing record. The remark **major version is pinned identical across `web` and `domain`** — the viewer renders with react-markdown's bundled remark, and parser drift between the two would misalign block boundaries against what the reader actually sees.

   Rejected alternative — new `packages/diff`: cleaner-looking hexagonally but requires new dep-cruiser rules and still can't be reached by `web`, so it buys nothing the domain placement doesn't; the scorer reuse argues for domain.

2. **Two-tier structure.** Tier 1: parse both legs to mdast, align top-level blocks (normalize + hash), classify `unchanged | added | removed | modified` — a _modified_ pair is two blocks whose token similarity clears the same family of scoring used by re-anchoring. Tier 2 (later phase): inline `ins`/`del` runs inside modified blocks — flatten text nodes with position maps, `diff-match-patch` word mode, splice deletion runs into the after-tree as annotation nodes. Diff markers are **never injected into markdown source** (breaks inside link URLs/tables — the CriticMarkup failure mode); annotation happens on the AST.

3. **Deletions get a place by being rendered.** A removed block renders as real markdown under a removed wash with strikethrough — this is the answer to the Phase 6 comment's objection, and why the source `<pre>` is no longer the only honest form.

4. **Strictly lazy, hard-bounded, honest degradation (DoS surface).**
   - **Lazy:** the diff is computed only when a client requests it — opening the Compare surface is the sole trigger. Nothing computes at upload time, no background jobs, no stored diff artifacts. No Compare open, no cost.
   - **Algorithm by reuse, not by hand:** block alignment uses `diff-match-patch`'s `diff_linesToChars` mapping — each top-level block maps to one character, the library's internal Myers O(ND) diff aligns the sequence, results map back to blocks. No hand-rolled LCS/Myers (a naive O(N·M) matrix on a 2 MB doc of short lines ≈ 50k blocks is a per-request memory/CPU bomb, and a bespoke Myers is avoidable code). Typical edits have small edit distance D, so alignment is near-linear in practice.
   - **One cap, checked before parsing: 200 KB per leg (~1 000 top-level blocks).** If either leg exceeds it, the endpoint returns `diff_too_large` _without parsing_ — the client falls back to the existing client-side source `<pre>` view (raw markdown diff), which costs the server nothing. Degrade, never error blind.
   - **Measured (2026-07-17, repo's exact deps, realistic mixed markdown, 5% revision + full-rewrite worst case):** parse dominates at ~90% of pipeline cost — alignment is 1–51 ms even at 8k blocks, so the byte cap is really a parse cap, which is why it must run before parsing. 50 KB legs: 23 ms / 9 MB transient. At the 200 KB cap: 62 ms / 23 MB — real docs (specs, READMEs, design docs at 5–50 KB) live at or below this line, effectively zero impact, and each pair is cold-once-then-304. Beyond ~1 MB the binding constraint would be the **event loop**, not memory: the synchronous parse blocks the node task 300–600 ms (2 MB: 601 ms / 182 MB heap spike), delaying every concurrent request on 2-task sizing — the cap keeps that region unreachable by an order of magnitude. Escape hatch if large-doc structural diffing ever becomes a real demand: raise the cap behind a worker-thread parse — noted, deliberately not built now.

5. **Caching and tombstones.** Strong ETag = hash over `(fromContentHash, toContentHash)` — both immutable, so the pair is immutable; same 304 pattern as the content routes. A purged (tombstoned) `from` version returns an honest "version purged" result, mirroring how suggestion accept already degrades against a purged pin (ADR 0001).

6. **MCP:** two new tools, `list_versions` (genuinely new — no tool can enumerate legs today) and `get_diff` (same structured JSON — agents want "section 'Auth' modified, paragraph 3 rewritten", not pixels). Both inherit per-tool rate limiting automatically. Parity table in §5 grows by two.

7. **The Compare surface is transient, not a mode.** No persistent Read/Review/Compare lens switch — context (role, grant, route) already selects the surface, and a third chrome toggle would join List/Bubbles + theme + chips as a fourth mode control. Compare opens from the three existing entry points (version strip, thread "changed since Leg n", post-upload triage), takes the full sheet, and closes back to reading. Two tabs only: **Rendered** (default) and **Source** (the current `<pre>`, kept as trust fallback).

8. **Visual language: two accent families never light the same sheet.** Conversation owns amber + blue; change owns green + red. Entering Compare suppresses all conversation signal on the sheet (anchor washes, diagram tint, density, callout amber). Diff reuses existing tokens only — `--insert-wash`/`--resolved` edge for added, `--danger-wash`/strikethrough for removed; **modified is a container (neutral rail), not a third color**. Washes stay low-saturation so 17px serif prose reads as a marked-up manuscript, not a code review. No new palette entries.

9. **Diagram changes: neutral "diagram changed" badge with a before/after toggle** (amber tint suppressed in Compare, so no collision on the SVG). §9 lists "diagram diffs" as out of MVP — this ADR keeps that exclusion: rendering two legs' diagrams behind a toggle is not a structural diagram diff, and no part-level diagram diffing is built. Code fences get line-level ins/del inside the highlighted block in a horizontally scrolling container.

10. **Deferred: thread-overlay chips on diff blocks** ("this change touched 2 open comments"). Highest rainbow-soup risk of the arc — it re-injects conversation hues onto the change surface — and it collapses entirely on mobile single-column. Revisit only after Compare ships and with the neutral-mono-chip treatment from the UX review, never amber inside Compare.

### B. Version notes

Nullable `change_note text` on `document_versions`, set at upload from web/API/MCP, optional, never blocking. The `forbid_version_mutation` trigger makes the table INSERT-only, so a note is **written once and never editable** — consistent with immutable versions, and stated here so nobody later asks for post-hoc editing without a new ADR. Length CHECK mirrors the 20k cap pattern from migration 0016. The note is org content: never in logs/telemetry, included in `exportOrg`. Suggestion accepts may auto-fill (e.g. "Applied suggestion"). Surfacing (UX ruling): Compare header subtitle, the existing viewing-old-leg banner, and version-chip tooltips — **never** inline text in the version strip chips. This is also the seam Phase 16 (LLM summary) would later fill when blank.

### C. Comment search

FTS lives **on the `comments` table** — `GENERATED ALWAYS AS (to_tsvector(...)) STORED` column + GIN index — never folded into the per-document `search_index` vector (which would force a blob read + full re-vectorize on every comment write). Comments are mutable, so generated-STORED self-maintains on edit.

**RLS is the backstop, not the filter.** RLS gives org scope only; the query must replicate the owner/grant/admin predicate the document search already uses, plus exclude soft-deleted comments. Cross-user and cross-org Gherkin scenarios are required (permission checks are money paths, §3/§8.2). v1 indexes top-level comment bodies and suggestion `proposed_text`; replies deferred (no `document_id` on replies — scoping them doubles the query surface for low search value). Result shape is comment-grained (jump-to-anchor), a discriminated sibling of `SearchHit`, mirrored in the MCP search tool for parity. UX ruling: the search input lives **in the comment rail** (appearing when thread count exceeds ~8), never in the app header — that's document search.

### D. Mentions — store + display only, doc-scoped

`comment_mentions(comment_id, mentioned_user_id, org_id)` join table — composite `(id, org_id)` FKs to both parents, RLS + FORCE; **never a `uuid[]` column** (arrays can't carry composite FKs, §5). Picker is scoped to people already on the document (reviewers + thread participants), not the org directory — guests can't list org users, so a directory picker would be broken for them and leak the directory. **Delivery is explicitly out of this ADR**: a mention's point is notification, and notification infrastructure (outbox + poller + webhook/email delivery) is the §9-excluded webhooks arc, which requires its own ADR (SSRF surface, first async infra in the product). v1 mentions are stored references + UI highlight, honestly scoped.

### E. Draft-then-submit review batch — **not built**

Both reviews independently converge on cutting the GitHub-style pending-comment batch. Architecture: a draft flag must be filtered in _every_ comment read path (list, counts, status rollup, feedback bundle, minimap, search, the hard approval gate — whose open-count a reviewer's own drafts would otherwise deadlock); one missed predicate leaks a reviewer's unsent notes cross-user. UX: a once-a-week reviewer expects Post → sent, and **mdloop already has its batch-submit moment — the sign-off verdict with note** (ADR 0002). Building a second competing "pending" concept adds developer-tool vocabulary for negative value. Revisit only on demonstrated power-user demand, opt-in, and only while a review is in progress.

### F. Signal-budget debt paid before any of the above ships

Pre-work, from the UX review, all small:

1. Minimap density layer recolored to neutral `--lane` (or cut) — it restates the ticks in the same amber at the same positions.
2. Re-anchor confidence becomes plain language: ≥0.9 silent; 0.6–0.9 "Moved — check this still fits"; <0.6 stays the existing honest orphan note. Raw percentage moves to a hover tooltip. The 0.6 honesty floor (Core Principle 2) is untouched — words, not digits.
3. `review-chip--changes_requested` stops using `--danger` red and `approved` moves onto `--insert-wash` — both would collide head-on with diff colors.
4. Keyboard hint rendered once, not twice.
5. New `quiet-marks` default for non-editing readers: anchor marks render as hairlines with no amber fill until the rail is opened — the calm reading surface for persona A, keyed off existing permission context, no mode switch.
6. One primary action in the header for read/comment users: requested reviewer → verdict buttons; otherwise → Add comment.

## Phasing

- **Phase D0** — signal-budget debt (F.1–F.6). Ships first, independently green.
- **Phase A** — `computeDocDiff` tier 1 in domain (Myers, caps, honest degradation) + `GET /documents/:id/diff` with ETag + Compare surface (Rendered/Source tabs, block washes) + version notes (migration, upload paths, Compare/banner/tooltip surfacing).
- **Phase B** — tier 2 inline ins/del + code-fence line diffs; MCP `list_versions` + `get_diff` + `upload_document` note param.
- **Phase C** — comment FTS (+ Gherkin) + mentions store/display + diagram before/after toggle.
- **Deferred, own ADR required** — webhooks/notifications (outbox, poller, SSRF policy); thread-overlay chips on Compare; draft batch.

## Consequences

- New migrations: `change_note` column (B), comments tsvector generated column + GIN (C), `comment_mentions` table (D). All tenant-scoped, RLS, composite FKs per standing rules.
- §5 parity table grows by `list_versions` and `get_diff`.
- New org-content surfaces — diff JSON, version notes, comment-search results, mentions — all bound by §3 (never in logs) and all added to `exportOrg`.
- The diff endpoint doubles blob reads per call versus `get_document`; ETag 304s and the immutability of the pair make this cheap in practice, and the block cap bounds the worst case.
- What we give up: the pending-batch feature some power users may expect from GitHub (cut, per E), and mention notifications (deferred behind the webhooks ADR). Both are honest scope statements rather than half-features.
