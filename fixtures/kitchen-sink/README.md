# fixtures/kitchen-sink/

Two hand-written sample markdown documents — GFM tables, nested callouts, wrapped list items,
mermaid blocks, the shapes real agent-authored docs actually take — used as worked examples while
developing the anchor/rendering pipeline (`packages/web/src/anchors`, `packages/web/src/components/
markdown-view.tsx`). Content inside them (e.g. `engineering-design.md`'s "billing path" callout,
`onboarding-runbook.md`'s guest-sharing walkthrough) is fictional, written to exercise rendering
edge cases, not to describe this product.

Not loaded programmatically — a handful of anchor tests transcribe a specific block from one of
these files inline (see `packages/web/src/anchors/anchors.test.tsx`) rather than reading the file at
run time, so a case stays reproducible even if this directory changes later. Treat these as
reference samples to reach for when adding a new rendering edge case, not as fixtures a test suite
depends on.
