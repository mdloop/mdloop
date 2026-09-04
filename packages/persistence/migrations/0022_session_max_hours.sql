-- Phase 24.C (sessions + CSRF).
--
-- Org-configurable session ceiling. `null` = the global 24h default; a value
-- may only *shorten* the window (1..24), never lengthen it — the CHECK enforces
-- the ceiling at the schema level so no application path can widen it. Enforced
-- per-request at decode time as min(global default, org max) applied to the
-- session's issued-at; see packages/domain/src/session.ts.

alter table organizations add column session_max_hours integer;

alter table organizations
  add constraint organizations_session_max_hours_check
  check (session_max_hours is null or (session_max_hours > 0 and session_max_hours <= 24));
