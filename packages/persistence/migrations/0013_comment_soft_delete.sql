-- Author-only comment deletion. Soft delete, matching the documents/versions
-- pattern (deleted_at, never a hard delete) — replies stay in the DB (FK
-- intact) even though the deleted parent drops out of every listing.
alter table comments add column deleted_at timestamptz;
