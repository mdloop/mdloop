-- Phase 26.B: cross-org directory (read-only) — keyset sort index + the one
-- missing mdloop_provisioner grant the storage-bytes aggregate needs.
--
-- mdloop_provisioner already has select on organizations and users (0001), so
-- the directory listing and its memberCount aggregate need nothing new. It
-- has never had any grant on document_versions, though (0002 only granted a
-- narrow column-select on documents for the retention sweep) — the
-- storageBytes aggregate (sum of live document_versions.byte_size per org)
-- needs a plain select there.

create index if not exists organizations_name_idx on organizations (lower(name), id);

grant select on document_versions to mdloop_provisioner;
