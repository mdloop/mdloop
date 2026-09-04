-- Phase 24.A (production hardening): anchor-resolution lookup index.
--
-- The only read path (PgAnchorResolutionRepository.forVersion) filters
-- `where version_id = $1` under RLS `org_id = current_org_id()` — without an
-- index on that pair, every doc open runs an org-wide seq scan over
-- comment_anchor_resolutions. Composite (org_id, version_id) matches the RLS
-- predicate first so the planner can use it under the policy as written.
create index comment_anchor_resolutions_version_idx
  on comment_anchor_resolutions (org_id, version_id);
