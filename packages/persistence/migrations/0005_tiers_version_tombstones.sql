-- Phase 12: tiers + version tombstones (ADR 0001).
--
-- organizations.tier: ceiling profile selector; limits live in the domain
-- layer (TIER_PROFILES), never in SQL — one code path for all tiers.
-- organizations.version_retention: org auto-purge config as jsonb
--   {"keepLastN": int, "keepDays": int|null}; SQL null = tier default.
--   Validation + ceiling clamp happen in the domain layer.
-- document_versions.purged_at: tombstone marker — blob deleted by retention
--   policy, row retained so comments keep valid FKs (Core Principle 2).

-- Default 'team' until the billing phase ships free signup: every org today
-- is a pre-billing team; the free tier starts existing when Phase 13 flips
-- signup on and sets tier explicitly.
alter table organizations
  add column tier text not null default 'team'
    check (tier in ('free', 'team', 'enterprise')),
  add column version_retention jsonb;

alter table document_versions
  add column purged_at timestamptz;

-- Versions stay content-immutable; the single allowed UPDATE is the tombstone
-- transition: purged_at null -> set, every other column byte-identical.
create or replace function forbid_version_mutation() returns trigger as $$
begin
  if old.purged_at is null
     and new.purged_at is not null
     and new.id = old.id
     and new.org_id = old.org_id
     and new.document_id = old.document_id
     and new.seq = old.seq
     and new.content_hash = old.content_hash
     and new.byte_size = old.byte_size
     and new.created_by = old.created_by
     and new.source = old.source
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'document_versions are immutable except the tombstone transition (ADR 0001)';
end;
$$ language plpgsql;

-- Purge worker scan: live versions per document, oldest first.
create index document_versions_live_idx
  on document_versions (org_id, document_id, seq)
  where purged_at is null;
