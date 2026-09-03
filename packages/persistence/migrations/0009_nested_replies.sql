-- Nested replies (threading to depth 5, enforced in the domain layer).
-- parent_reply_id is a composite self-FK: (id, org_id) like every other
-- tenant-table FK, so the FK check can never reach across orgs
-- (CONSTITUTION.md — plain FKs leak, FK checks bypass RLS).

alter table comment_replies
  add constraint comment_replies_id_org_unique unique (id, org_id);

alter table comment_replies
  add column parent_reply_id uuid,
  add constraint comment_replies_parent_fk
    foreign key (parent_reply_id, org_id) references comment_replies (id, org_id);

create index comment_replies_parent_idx on comment_replies (org_id, parent_reply_id);
