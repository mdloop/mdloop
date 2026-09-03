import type { Pool } from 'pg';
import type { ErasureEvent, ErasureLogPort, LoggedErasure } from '@vorlyn/app';
import type { DocumentId, OrgId } from '@vorlyn/shared';
import { withProvisioner } from '../db.js';

/**
 * Append-only erasure log (Phase 14). Opaque ids + timestamps only; the DB
 * trigger forbids UPDATE/DELETE, so history cannot be rewritten from here
 * either. Reads/writes run as the provisioner — purge paths and the
 * post-restore replay are system jobs (an org purge outlives its tenant).
 */
export class PgErasureLogRepository implements ErasureLogPort {
  constructor(private readonly pool: Pool) {}

  async record(event: ErasureEvent): Promise<void> {
    await withProvisioner(this.pool, async (c) => {
      await c.query(
        `insert into erasure_log (kind, org_id, document_id, version_seq)
         values ($1, $2, $3, $4)`,
        [
          event.kind,
          event.orgId,
          event.kind === 'org_purge' ? null : event.documentId,
          event.kind === 'version_purge' ? event.versionSeq : null,
        ],
      );
    });
  }

  async list(): Promise<LoggedErasure[]> {
    return withProvisioner(this.pool, async (c) => {
      const { rows } = await c.query<{
        kind: 'org_purge' | 'document_purge' | 'version_purge';
        org_id: string;
        document_id: string | null;
        version_seq: number | null;
        occurred_at: Date;
      }>('select * from erasure_log order by occurred_at, id');
      return rows.map((r): LoggedErasure => {
        const orgId = r.org_id as OrgId;
        if (r.kind === 'org_purge') return { kind: 'org_purge', orgId, occurredAt: r.occurred_at };
        const documentId = r.document_id as DocumentId;
        if (r.kind === 'document_purge') {
          return { kind: 'document_purge', orgId, documentId, occurredAt: r.occurred_at };
        }
        return {
          kind: 'version_purge',
          orgId,
          documentId,
          versionSeq: r.version_seq ?? 0,
          occurredAt: r.occurred_at,
        };
      });
    });
  }
}
