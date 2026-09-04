-- Phase 20.A: `cli` joins the document_versions.source vocabulary.
--
-- The sync CLI (Phase 20) mirrors a repo file into a Leg. That is
-- a different provenance from an agent authoring in place over MCP, and the
-- version strip says so — so the domain union (`UploadSource`) and this CHECK
-- have to agree before anything can write it.
--
-- Expand-only (Core Principle 6, ADR 0006). Widening a CHECK is additive:
-- every row the previous app version can write still satisfies the new
-- constraint, so blue and green run against this schema simultaneously. No
-- contract step is needed or scheduled — nothing is removed.
--
-- Blue-green window: nothing WRITES 'cli' yet (upload_document has no way to
-- tell a CLI caller from any other MCP client, so CLI pushes still record
-- 'mcp'), and on READ the old app version passes source straight through to a
-- display label — an unfamiliar label, never an error.
alter table document_versions drop constraint document_versions_source_check;
alter table document_versions
  add constraint document_versions_source_check
  check (source in ('web', 'mcp', 'cli'));
