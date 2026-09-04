-- Phase 14: erasure log (GDPR Art. 17 pattern).
--
-- Append-only record of every purge event, carrying opaque ids and
-- timestamps ONLY (Core Principle 3) — enough to re-apply erasures after a
-- backup restore, never enough to reconstruct content. Deliberately a
-- system table, not tenant-scoped: rows must outlive the org they describe
-- (an org purge is itself logged), so there is no FK and no RLS — the
-- application role can only append, and nothing can rewrite history.

create table erasure_log (
  id uuid primary key default gen_random_uuid(),
  -- 'version_purge' (blob tombstoned), 'document_purge', 'org_purge'
  kind text not null check (kind in ('version_purge', 'document_purge', 'org_purge')),
  org_id uuid not null,
  document_id uuid,
  version_seq integer,
  occurred_at timestamptz not null default now(),
  check ((kind = 'org_purge') = (document_id is null)),
  check ((kind = 'version_purge') = (version_seq is not null))
);

create or replace function forbid_erasure_log_mutation() returns trigger as $$
begin
  raise exception 'erasure_log is append-only';
end;
$$ language plpgsql;

create trigger erasure_log_append_only
  before update or delete on erasure_log
  for each row execute function forbid_erasure_log_mutation();

create index erasure_log_time_idx on erasure_log (occurred_at);

-- mdloop_app appends from tenant-scoped purge paths; the provisioner appends
-- from system sweeps and reads for post-restore replay. Nobody deletes.
grant insert on erasure_log to mdloop_app;
grant select, insert on erasure_log to mdloop_provisioner;
