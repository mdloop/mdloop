-- Comment upvotes: reviewers signal priority, coding agents order work by
-- count. Composite FKs (comment_id, org_id) and (user_id, org_id) like every
-- other tenant-table FK (CONSTITUTION.md — plain FKs leak, FK checks bypass
-- RLS). One upvote per user per comment; cascade with the comment.

create table comment_upvotes (
  comment_id uuid not null,
  org_id uuid not null references organizations (id),
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id),
  foreign key (comment_id, org_id) references comments (id, org_id) on delete cascade,
  foreign key (user_id, org_id) references users (id, org_id)
);

create index comment_upvotes_comment_idx on comment_upvotes (org_id, comment_id);

alter table comment_upvotes enable row level security;
alter table comment_upvotes force row level security;
create policy tenant_isolation on comment_upvotes
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

grant select, insert, delete on comment_upvotes to mdloop_app;
