-- Upper bound on comment/reply body length (MAX_COMMENT_BODY_LENGTH in
-- @vorlyn/domain). The existing `length(body) > 0` check only guards the
-- floor; this adds the ceiling as a separate constraint rather than
-- replacing the original, so it doesn't depend on guessing Postgres's
-- auto-generated name for the inline check.
alter table comments add constraint comments_body_max_length check (length(body) <= 2000);
alter table comment_replies add constraint comment_replies_body_max_length check (length(body) <= 2000);
