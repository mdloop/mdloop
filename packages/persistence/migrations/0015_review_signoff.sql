-- Phase B: sign-off workflow ("pass the mdloop"). A reviewer is requested on a
-- document; they submit an approve / changes-requested verdict pinned to the
-- version they reviewed. Doc status is DERIVED from active requests + latest
-- verdicts (ADR 0002) — no status column to drift. Composite (id, org_id) FKs
-- and per-table tenant_isolation RLS like every other tenant table
-- (CONSTITUTION.md — plain FKs leak, FK checks bypass RLS). Grant template:
-- 0010_comment_upvotes.sql.

-- Org master switch: soft (advisory) or hard (approve is blocked while open
-- comments remain). Default soft — the gate never surprises an existing org.
alter table organizations
  add column approval_gate text not null default 'soft'
  check (approval_gate in ('soft', 'hard'));

-- A reviewer requested on a document. Revoke is the only mutation (revoked_at
-- set) — hence the update grant; there is no delete. The partial unique keeps
-- at most one ACTIVE request per (document, reviewer): a revoked row does not
-- block re-requesting the same person.
create table review_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  document_id uuid not null,
  reviewer_user_id uuid not null,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, org_id),
  -- Cascades on the document's own deletion (purge/erasure) only — the only
  -- way one of these rows ever disappears, since the table grants no delete.
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade,
  foreign key (reviewer_user_id, org_id) references users (id, org_id),
  foreign key (requested_by, org_id) references users (id, org_id)
);

create unique index review_requests_active_uniq
  on review_requests (org_id, document_id, reviewer_user_id)
  where revoked_at is null;

create index review_requests_document_idx on review_requests (org_id, document_id);

alter table review_requests enable row level security;
alter table review_requests force row level security;
create policy tenant_isolation on review_requests
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Revoke is the only update path (the use case only ever sets revoked_at).
grant select, insert, update on review_requests to mdloop_app;

-- A verdict, pinned to the version it was made against. APPEND-ONLY: latest
-- verdict per reviewer-per-version wins (ADR 0002) — never updated, never
-- deleted, enforced structurally by withholding the update/delete grant.
-- via_api_key_id carries agent attribution (Phase A), same composite-FK shape.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  document_id uuid not null,
  version_id uuid not null,
  reviewer_user_id uuid not null,
  verdict text not null check (verdict in ('approved', 'changes_requested')),
  note text check (note is null or length(note) <= 2000),
  via_api_key_id uuid,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  -- Same cascade-only-on-erasure story as review_requests above: a verdict
  -- disappears if and only if its document (or the version it pinned) is
  -- torn down entirely — never via an app-level delete.
  foreign key (document_id, org_id) references documents (id, org_id) on delete cascade,
  foreign key (version_id, org_id) references document_versions (id, org_id) on delete cascade,
  foreign key (reviewer_user_id, org_id) references users (id, org_id),
  foreign key (via_api_key_id, org_id) references api_keys (id, org_id)
);

create index approvals_document_version_idx on approvals (org_id, document_id, version_id);

alter table approvals enable row level security;
alter table approvals force row level security;
create policy tenant_isolation on approvals
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Append-only at the grant level: no update, no delete — a verdict, once
-- written, is a permanent record (ADR 0002).
grant select, insert on approvals to mdloop_app;
