-- Phase 21.C (ADR 0003 §C, §D): comment full-text search + doc-scoped mentions.
--
-- §C — FTS lives ON the comments table as a generated STORED tsvector + GIN,
-- never folded into the per-document search_index vector (that would force a
-- blob read + full re-vectorize on every comment write). Generated-STORED
-- self-maintains on every insert and edit, so there is no trigger to keep in
-- sync. proposed_text folds into the same vector — a suggestion's replacement
-- text is searchable too (ADR §C) — via coalesce so a plain comment (null
-- proposed_text) is unaffected. Replies are NOT indexed (deferred by the ADR:
-- replies carry no document_id, so scoping them doubles the query surface for
-- low search value). RLS already scopes comments to the org; the search query
-- adds the owner/grant/admin predicate as the real filter — RLS is the
-- backstop, not the filter (§C).
alter table comments
  add column search_vector tsvector
    generated always as (
      to_tsvector('english', coalesce(body, '') || ' ' || coalesce(proposed_text, ''))
    ) stored;

create index comments_search_vector_idx on comments using gin (search_vector);

-- §D — mentions are a join table, never a uuid[] column: arrays cannot carry
-- the composite (id, org_id) FKs that keep tenant isolation structural (§5).
-- Store + display only — a mention is a stored reference plus a UI highlight.
-- Delivery (notification) is the §9-excluded webhooks arc and needs its own
-- ADR (SSRF surface), so nothing here writes anywhere. Both FKs are composite
-- (id, org_id): a plain FK bypasses RLS and would leak row existence across
-- orgs (CONSTITUTION hard rule).
create table comment_mentions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id),
  comment_id uuid not null,
  mentioned_user_id uuid not null,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  -- At most one mention row per (comment, user): re-parsing an edited body
  -- against this table is idempotent.
  unique (comment_id, mentioned_user_id),
  -- Cascades when the comment is hard-deleted (org erasure/purge) — the only
  -- way a comment row ever disappears; soft delete leaves the row (and its
  -- mentions) in place, filtered out at read time.
  foreign key (comment_id, org_id) references comments (id, org_id) on delete cascade,
  foreign key (mentioned_user_id, org_id) references users (id, org_id)
);

create index comment_mentions_comment_idx on comment_mentions (org_id, comment_id);

alter table comment_mentions enable row level security;
alter table comment_mentions force row level security;
create policy tenant_isolation on comment_mentions
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- Mentions are re-derived on comment edit (delete-all + re-insert the current
-- body's matches), so delete is granted here — unlike the append-only review
-- tables which withhold it.
grant select, insert, delete on comment_mentions to mdloop_app;
