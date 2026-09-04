-- Phase A: agent attribution. Comments, replies, and versions record which
-- API key (agent) created them, if any — nullable, so human-authored rows
-- are unaffected. No backfill: existing rows simply have no attribution.
alter table comments add column via_api_key_id uuid;
alter table comments
  add constraint comments_via_api_key_fk
  foreign key (via_api_key_id, org_id) references api_keys (id, org_id);

alter table comment_replies add column via_api_key_id uuid;
alter table comment_replies
  add constraint comment_replies_via_api_key_fk
  foreign key (via_api_key_id, org_id) references api_keys (id, org_id);

alter table document_versions add column via_api_key_id uuid;
alter table document_versions
  add constraint document_versions_via_api_key_fk
  foreign key (via_api_key_id, org_id) references api_keys (id, org_id);
