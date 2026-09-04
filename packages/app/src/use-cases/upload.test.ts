import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@mdloop/domain';
import type { DocumentId, ProjectId, UserId } from '@mdloop/shared';
import {
  FakeShareGrantRepository,
  FakeStorage,
  FakeUploadUnitOfWork,
  FakeWorld,
} from '../test-support/fakes.js';
import type { Actor } from './org-settings.js';
import { contentHashOf, uploadNewDocument, uploadNewVersion } from './upload.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function setup() {
  const world = new FakeWorld();
  const org = world.org();
  const owner: Actor = {
    ctx: { orgId: org.id, userId: 'user-owner' as UserId },
    role: 'member',
  };
  return { world, org, owner, uow: new FakeUploadUnitOfWork(world), storage: new FakeStorage() };
}

describe('uploadNewDocument', () => {
  it('creates the document, first version, ledger entry and blob', async () => {
    const { world, owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'runbook.md',
      projectId: null,
      content: bytes('# Runbook'),
      source: 'web',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.seq).toBe(1);
    expect(result.value.document.currentVersionId).toBe(result.value.version.id);
    expect(result.value.version.contentHash).toBe(contentHashOf(bytes('# Runbook')));
    expect(world.ledger).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
  });

  it('persists an optional change note on the version, null when absent (ADR 0003 §B)', async () => {
    const { owner, uow, storage } = setup();
    const noted = await uploadNewDocument(uow, storage, owner, {
      title: 'noted.md',
      projectId: null,
      content: bytes('# Noted'),
      source: 'web',
      changeNote: 'first draft',
    });
    expect(noted.ok && noted.value.version.changeNote).toBe('first draft');

    const v2 = await uploadNewVersion(uow, storage, owner, {
      documentId: (noted.ok ? noted.value.document.id : '') as DocumentId,
      content: bytes('# Noted v2'),
      source: 'web',
    });
    expect(v2.ok && v2.value.version.changeNote).toBeNull();
  });

  it('rejects an empty title', async () => {
    const { owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: '   ',
      projectId: null,
      content: bytes('x'),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('invalid_title');
  });

  it('records the acting API key on the first version; session actors leave it null', async () => {
    const { owner, uow, storage } = setup();
    const viaAgent: Actor = { ...owner, apiKeyId: 'key-1' };
    const agentUpload = await uploadNewDocument(uow, storage, viaAgent, {
      title: 'agent.md',
      projectId: null,
      content: bytes('x'),
      source: 'mcp',
    });
    expect(agentUpload.ok && agentUpload.value.version.viaApiKeyId).toBe('key-1');

    const humanUpload = await uploadNewDocument(uow, storage, owner, {
      title: 'human.md',
      projectId: null,
      content: bytes('y'),
      source: 'web',
    });
    expect(humanUpload.ok && humanUpload.value.version.viaApiKeyId).toBeNull();
  });

  it('rejects an unknown project', async () => {
    const { owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'a.md',
      projectId: 'missing' as ProjectId,
      content: bytes('x'),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('project_not_found');
  });

  it('files the document under an existing project', async () => {
    const { world, org, owner, uow, storage } = setup();
    const project = world.addProject(org.id, { name: 'Docs', color: '#6366f1' });
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'a.md',
      projectId: project.id,
      content: bytes('x'),
      source: 'web',
    });
    expect(result.ok && result.value.document.projectId).toBe(project.id);
  });

  it('rejects an empty file without writing anything', async () => {
    const { world, owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'a.md',
      projectId: null,
      content: new Uint8Array(0),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('empty_file');
    expect(world.ledger).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects content that is not markdown before opening a transaction (ADR 0011)', async () => {
    const { world, owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'renamed-binary.md',
      projectId: null,
      content: new Uint8Array([...bytes('# Renamed binary'), 0x00, 0x01]),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('control_byte_detected');
    // Nothing was created: the check runs before `uow.run`, so there is no
    // document, no version, no ledger row and no blob to clean up.
    expect(world.documents.size).toBe(0);
    expect(world.ledger).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });

  it('rejects a file over the 500KB cap', async () => {
    const { owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'big.md',
      projectId: null,
      // Filled, not zeroed: content policy (ADR 0011) runs before the size
      // check, so a buffer of NULs would be refused as binary first.
      content: new Uint8Array(MAX_UPLOAD_BYTES + 1).fill(0x78),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('file_too_large');
  });

  it('errors when the org row is unreadable', async () => {
    const { world, owner, uow, storage } = setup();
    world.orgs.delete(owner.ctx.orgId);
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'a.md',
      projectId: null,
      content: bytes('x'),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('org_not_found');
  });
});

// A failed blob write (or the phase-two finalize transaction) must not leave
// an orphaned document row — one with no version, ever — visible in the
// document list while 404ing on open. Regression coverage for exactly that
// failure mode, hit for real when the AWS-dev deploy tried to upload before
// storageFromEnv/S3Storage were wired in (Phase 10.G).
describe('uploadNewDocument rolls back the document row on failure', () => {
  it('deletes the document when storage.put rejects, and propagates the original error', async () => {
    const { world, owner, uow, storage } = setup();
    const boom = new Error('storage unavailable');
    storage.put = () => Promise.reject(boom);

    await expect(
      uploadNewDocument(uow, storage, owner, {
        title: 'runbook.md',
        projectId: null,
        content: bytes('# Runbook'),
        source: 'web',
      }),
    ).rejects.toBe(boom);

    expect([...world.documents.values()]).toHaveLength(0);
  });

  it('deletes the document when the finalize transaction fails after the blob is written', async () => {
    const { world, owner, uow, storage } = setup();
    const boom = new Error('db unavailable');
    const originalInsert = world.insertVersionAt.bind(world);
    world.insertVersionAt = () => {
      throw boom;
    };

    await expect(
      uploadNewDocument(uow, storage, owner, {
        title: 'runbook.md',
        projectId: null,
        content: bytes('# Runbook'),
        source: 'web',
      }),
    ).rejects.toBe(boom);

    expect([...world.documents.values()]).toHaveLength(0);
    world.insertVersionAt = originalInsert;
  });

  it('a retried upload at the same path succeeds after the rollback frees it', async () => {
    const { owner, uow, storage } = setup();
    const boom = new Error('storage unavailable');
    let shouldFail = true;
    const realPut = storage.put.bind(storage);
    storage.put = (key, content) => (shouldFail ? Promise.reject(boom) : realPut(key, content));

    const failed = await uploadNewDocument(uow, storage, owner, {
      title: 'runbook.md',
      projectId: null,
      content: bytes('# Runbook'),
      source: 'cli',
      path: 'docs/runbook.md',
    }).catch((e: unknown) => e);
    expect(failed).toBe(boom);

    shouldFail = false;
    const retried = await uploadNewDocument(uow, storage, owner, {
      title: 'runbook.md',
      projectId: null,
      content: bytes('# Runbook'),
      source: 'cli',
      path: 'docs/runbook.md',
    });
    expect(retried.ok).toBe(true);
  });
});

describe('tier caps on upload (TIER_PROFILES, tier.ts)', () => {
  it('blocks new documents at the free doc cap; deleting frees headroom', async () => {
    const world = new FakeWorld();
    const org = world.org({ tier: 'free' });
    const owner: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'member' };
    const uow = new FakeUploadUnitOfWork(world);
    const storage = new FakeStorage();
    // Free tier's org-wide doc cap is 100 (Phase 33).
    for (let i = 0; i < 100; i++) {
      world.addDocument(org.id, {
        title: `d${String(i)}.md`,
        projectId: null,
        ownerId: owner.ctx.userId,
      });
    }
    const blocked = await uploadNewDocument(uow, storage, owner, {
      title: 'over.md',
      projectId: null,
      content: bytes('x'),
      source: 'web',
    });
    expect(!blocked.ok && blocked.error).toEqual({ code: 'doc_cap_exceeded', limit: 100 });

    const [first] = world.documents.values();
    if (!first) throw new Error('setup');
    world.documents.set(first.id, { ...first, deletedAt: new Date() });
    const allowed = await uploadNewDocument(uow, storage, owner, {
      title: 'over.md',
      projectId: null,
      content: bytes('x'),
      source: 'web',
    });
    expect(allowed.ok).toBe(true);
  });

  it('paid tiers get the fair-use doc ceiling, not the free one', async () => {
    const { world, owner, uow, storage } = setup(); // team org
    for (let i = 0; i < 10; i++) {
      world.addDocument(world.orgs.keys().next().value!, {
        title: `d${String(i)}.md`,
        projectId: null,
        ownerId: owner.ctx.userId,
      });
    }
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'eleventh.md',
      projectId: null,
      content: bytes('x'),
      source: 'web',
    });
    expect(result.ok).toBe(true);
  });

  it('blocks new documents in a project at its own cap, independent of the org-wide cap', async () => {
    // Team tier: project cap 500, org cap 5,000 — the org is nowhere near
    // full, so this isolates the project-scoped check specifically.
    const { world, org, owner, uow, storage } = setup();
    const project = world.addProject(org.id, { name: 'Big Project', color: '#6366f1' });
    for (let i = 0; i < 500; i++) {
      world.addDocument(org.id, {
        title: `d${String(i)}.md`,
        projectId: project.id,
        ownerId: owner.ctx.userId,
      });
    }
    const blocked = await uploadNewDocument(uow, storage, owner, {
      title: 'over.md',
      projectId: project.id,
      content: bytes('x'),
      source: 'web',
    });
    expect(!blocked.ok && blocked.error).toEqual({ code: 'project_doc_cap_exceeded', limit: 500 });
  });

  it('an unfiled document (projectId null) is never subject to the project cap', async () => {
    // Same team-tier project cap (500) as above, but every document here is
    // unfiled — there is no project to scope the cap against, so 500
    // unfiled docs (a count that would trip a project cap) still uploads
    // fine, and the org-wide cap (5,000) is nowhere near reached either.
    const { world, org, owner, uow, storage } = setup();
    for (let i = 0; i < 500; i++) {
      world.addDocument(org.id, {
        title: `d${String(i)}.md`,
        projectId: null,
        ownerId: owner.ctx.userId,
      });
    }
    const allowed = await uploadNewDocument(uow, storage, owner, {
      title: 'over.md',
      projectId: null,
      content: bytes('x'),
      source: 'web',
    });
    expect(allowed.ok).toBe(true);
  });

  it('org cap and project cap are independent: a full org blocks even a project with headroom', async () => {
    // Free tier, where org cap and project cap are both numerically 100 —
    // deliberately chosen to prove which check is actually tripping. The
    // target project holds only 1 document (far under its own 100 cap);
    // the org total is at 100 only because of 99 other, unfiled documents.
    const world = new FakeWorld();
    const org = world.org({ tier: 'free' });
    const owner: Actor = { ctx: { orgId: org.id, userId: 'u1' as UserId }, role: 'member' };
    const uow = new FakeUploadUnitOfWork(world);
    const storage = new FakeStorage();
    const project = world.addProject(org.id, { name: 'Small', color: '#6366f1' });
    world.addDocument(org.id, {
      title: 'p0.md',
      projectId: project.id,
      ownerId: owner.ctx.userId,
    });
    for (let i = 0; i < 99; i++) {
      world.addDocument(org.id, {
        title: `u${String(i)}.md`,
        projectId: null,
        ownerId: owner.ctx.userId,
      });
    }
    const blocked = await uploadNewDocument(uow, storage, owner, {
      title: 'over.md',
      projectId: project.id,
      content: bytes('x'),
      source: 'web',
    });
    expect(!blocked.ok && blocked.error).toEqual({ code: 'doc_cap_exceeded', limit: 100 });
  });
});

describe('uploadNewVersion', () => {
  async function withDocument() {
    const s = setup();
    const first = await uploadNewDocument(s.uow, s.storage, s.owner, {
      title: 'a.md',
      projectId: null,
      content: bytes('v1'),
      source: 'web',
    });
    if (!first.ok) throw new Error('setup upload failed');
    return { ...s, documentId: first.value.document.id };
  }

  it('appends seq 2 and moves the current version', async () => {
    const { owner, uow, storage, documentId } = await withDocument();
    const result = await uploadNewVersion(uow, storage, owner, {
      documentId,
      content: bytes('v2'),
      source: 'mcp',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.seq).toBe(2);
    expect(result.value.deduplicated).toBe(false);
    expect(result.value.document.currentVersionId).toBe(result.value.version.id);
  });

  it('is a quota-free no-op when content matches the current version', async () => {
    const { world, owner, uow, storage, documentId } = await withDocument();
    const result = await uploadNewVersion(uow, storage, owner, {
      documentId,
      content: bytes('v1'),
      source: 'mcp',
    });
    expect(result.ok && result.value.deduplicated).toBe(true);
    expect(result.ok && result.value.version.seq).toBe(1);
    expect(world.ledger).toHaveLength(1);
  });

  it('re-appends content that matches an older, non-current version', async () => {
    const { owner, uow, storage, documentId } = await withDocument();
    await uploadNewVersion(uow, storage, owner, {
      documentId,
      content: bytes('v2'),
      source: 'web',
    });
    const back = await uploadNewVersion(uow, storage, owner, {
      documentId,
      content: bytes('v1'),
      source: 'web',
    });
    expect(back.ok && back.value.version.seq).toBe(3);
  });

  it('404s on a missing document', async () => {
    const { owner, uow, storage } = setup();
    const result = await uploadNewVersion(uow, storage, owner, {
      documentId: 'missing' as DocumentId,
      content: bytes('x'),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('document_not_found');
  });

  it('rejects content that is not markdown before opening a transaction (ADR 0011)', async () => {
    const { world, owner, uow, storage, documentId } = await withDocument();
    const before = storage.objects.size;
    const result = await uploadNewVersion(uow, storage, owner, {
      documentId,
      // A PDF renamed .md: caught by the magic-byte table, which runs first.
      content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('binary_signature_detected');
    // The content check precedes `uow.run`, so the existing document is
    // untouched: still one version, one ledger row, one blob.
    expect(world.ledger).toHaveLength(1);
    expect(storage.objects.size).toBe(before);
  });

  it('forbids non-owner members and allows org admins', async () => {
    const { org, owner, uow, storage, documentId } = await withDocument();
    const stranger: Actor = { ctx: { orgId: org.id, userId: 'user-b' as UserId }, role: 'member' };
    const admin: Actor = { ctx: { orgId: org.id, userId: 'user-c' as UserId }, role: 'admin' };
    void owner;
    const denied = await uploadNewVersion(uow, storage, stranger, {
      documentId,
      content: bytes('v2'),
      source: 'web',
    });
    expect(!denied.ok && denied.error.code).toBe('forbidden');
    const allowed = await uploadNewVersion(uow, storage, admin, {
      documentId,
      content: bytes('v2'),
      source: 'web',
    });
    expect(allowed.ok).toBe(true);
  });

  describe('edit grants (ADR 0008)', () => {
    async function withGrants() {
      const world = new FakeWorld();
      const org = world.org();
      const grants = new FakeShareGrantRepository(world);
      const owner: Actor = {
        ctx: { orgId: org.id, userId: 'user-owner' as UserId },
        role: 'member',
      };
      const uow = new FakeUploadUnitOfWork(world, new Date(), grants);
      const storage = new FakeStorage();
      const first = await uploadNewDocument(uow, storage, owner, {
        title: 'a.md',
        projectId: null,
        content: bytes('v1'),
        source: 'web',
      });
      if (!first.ok) throw new Error('setup upload failed');
      const documentId = first.value.document.id;
      const grantee: Actor = { ctx: { orgId: org.id, userId: 'user-b' as UserId }, role: 'member' };
      const grant = async (permission: 'read' | 'comment' | 'edit', to = grantee) => {
        await grants.create(owner.ctx, {
          subject: { type: 'document', id: documentId },
          grantee: { type: 'user', userId: to.ctx.userId },
          permission,
          tokenHash: null,
          createdBy: owner.ctx.userId,
        });
      };
      return { org, owner, grantee, grant, uow, storage, documentId };
    }

    it('lets an edit grantee push a new version', async () => {
      const { grantee, grant, uow, storage, documentId } = await withGrants();
      await grant('edit');
      const result = await uploadNewVersion(uow, storage, grantee, {
        documentId,
        content: bytes('v2'),
        source: 'mcp',
      });
      expect(result.ok && result.value.version.seq).toBe(2);
    });

    it('takes the highest grant when several are held', async () => {
      const { grantee, grant, uow, storage, documentId } = await withGrants();
      await grant('read');
      await grant('edit');
      await grant('comment');
      const result = await uploadNewVersion(uow, storage, grantee, {
        documentId,
        content: bytes('v2'),
        source: 'mcp',
      });
      expect(result.ok).toBe(true);
    });

    it('still refuses a comment-only grantee', async () => {
      const { grantee, grant, uow, storage, documentId } = await withGrants();
      await grant('comment');
      const result = await uploadNewVersion(uow, storage, grantee, {
        documentId,
        content: bytes('v2'),
        source: 'mcp',
      });
      expect(!result.ok && result.error.code).toBe('forbidden');
    });

    it('refuses a grantee with no grant at all', async () => {
      const { grantee, uow, storage, documentId } = await withGrants();
      const result = await uploadNewVersion(uow, storage, grantee, {
        documentId,
        content: bytes('v2'),
        source: 'mcp',
      });
      expect(!result.ok && result.error.code).toBe('forbidden');
    });

    it('refuses a guest holding a forged edit grant', async () => {
      const { org, grant, uow, storage, documentId } = await withGrants();
      const guest: Actor = { ctx: { orgId: org.id, userId: 'user-g' as UserId }, role: 'guest' };
      await grant('edit', guest);
      const result = await uploadNewVersion(uow, storage, guest, {
        documentId,
        content: bytes('v2'),
        source: 'mcp',
      });
      expect(!result.ok && result.error.code).toBe('forbidden');
    });
  });

  it('errors when the org row is unreadable', async () => {
    const { world, org, owner, uow, storage, documentId } = await withDocument();
    world.orgs.delete(org.id);
    const result = await uploadNewVersion(uow, storage, owner, {
      documentId,
      content: bytes('v2'),
      source: 'web',
    });
    expect(!result.ok && result.error.code).toBe('org_not_found');
  });

  it('records the acting API key on the version; session actors leave it null', async () => {
    const { owner, uow, storage, documentId } = await withDocument();
    const viaAgent: Actor = { ...owner, apiKeyId: 'key-1' };
    const agentVersion = await uploadNewVersion(uow, storage, viaAgent, {
      documentId,
      content: bytes('v2'),
      source: 'mcp',
    });
    expect(agentVersion.ok && agentVersion.value.version.viaApiKeyId).toBe('key-1');

    const humanVersion = await uploadNewVersion(uow, storage, owner, {
      documentId,
      content: bytes('v3'),
      source: 'web',
    });
    expect(humanVersion.ok && humanVersion.value.version.viaApiKeyId).toBeNull();
  });

  describe('two-phase reservation (upload-transaction lock reshape)', () => {
    it('surfaces a blob-write failure without minting a version, and a later upload still gets the next seq', async () => {
      const { world, owner, uow, storage, documentId } = await withDocument();
      const originalPut = storage.put.bind(storage);
      let shouldFail = true;
      storage.put = (key, content) => {
        if (shouldFail) {
          shouldFail = false;
          return Promise.reject(new Error('storage unavailable'));
        }
        return originalPut(key, content);
      };

      await expect(
        uploadNewVersion(uow, storage, owner, {
          documentId,
          content: bytes('v2 that never lands'),
          source: 'web',
        }),
      ).rejects.toThrow('storage unavailable');

      // The reservation counter (documents.next_seq) is durable, so seq 2
      // was permanently consumed by the failed attempt even though no row
      // was ever inserted for it — the retry gets 3, not a reused 2. That
      // gap is intentional (see reserveVersionSeq's doc comment): nothing
      // enforces seq contiguity, and a recomputed max(seq)+1 would let two
      // concurrent reservations collide, which is exactly what this fake now
      // models the same way the real Postgres counter does.
      const retried = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2 for real this time'),
        source: 'web',
      });
      expect(retried.ok && retried.value.version.seq).toBe(3);
      // Exactly two version rows total (the original v1 + the successful
      // retry) — no dangling row for the failed attempt.
      expect([...world.versions.values()].filter((v) => v.documentId === documentId)).toHaveLength(
        2,
      );
    });

    it('assigns strictly unique, non-colliding seqs across interleaved uploads to the same document', async () => {
      const { owner, uow, storage, documentId } = await withDocument();
      const results = await Promise.all([
        uploadNewVersion(uow, storage, owner, { documentId, content: bytes('a'), source: 'web' }),
        uploadNewVersion(uow, storage, owner, { documentId, content: bytes('b'), source: 'web' }),
        uploadNewVersion(uow, storage, owner, { documentId, content: bytes('c'), source: 'web' }),
      ]);
      const seqs = results.map((r) => (r.ok ? r.value.version.seq : -1)).sort((a, b) => a - b);
      expect(seqs).toEqual([2, 3, 4]);
      // The stronger claim — that the real Postgres lock (not just this
      // fake's single-threaded JS semantics) prevents a collision — is
      // proven separately against a real database: see
      // packages/persistence/src/upload-seq-concurrency.integration.test.ts.
    });

    it('runs onAppended for a deduplicated upload too, even though no version is minted', async () => {
      const { owner, uow, storage, documentId } = await withDocument();
      const first = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'web',
      });
      if (!first.ok) throw new Error('setup');

      let hookRan = false;
      const dedup = await uploadNewVersion(
        uow,
        storage,
        owner,
        { documentId, content: bytes('v2'), source: 'web' },
        (_tx, result) => {
          hookRan = true;
          expect(result.deduplicated).toBe(true);
          return Promise.resolve();
        },
      );
      expect(dedup.ok && dedup.value.deduplicated).toBe(true);
      expect(hookRan).toBe(true);
    });
  });
});

/**
 * Workspace paths (Phase 29). `path` is display metadata that lets mdloop
 * rebuild the folder structure the sync CLI mirrored in — it never touches
 * quota, anchoring, or storage keys, which stay `VersionKey{orgId,
 * documentId, seq}` (CONSTITUTION.md §3).
 */
describe('document paths (Phase 29)', () => {
  it('creates a document at a path, and without one leaves it null', async () => {
    const { owner, uow, storage } = setup();
    const withPath = await uploadNewDocument(uow, storage, owner, {
      title: 'auth.md',
      projectId: null,
      content: bytes('# Auth'),
      source: 'cli',
      path: 'docs/specs/auth.md',
    });
    expect(withPath.ok && withPath.value.document.path).toBe('docs/specs/auth.md');

    const manual = await uploadNewDocument(uow, storage, owner, {
      title: 'manual.md',
      projectId: null,
      content: bytes('# Manual'),
      source: 'web',
    });
    expect(manual.ok && manual.value.document.path).toBeNull();
  });

  it('rejects an invalid path on create, before anything is written', async () => {
    const { world, owner, uow, storage } = setup();
    const result = await uploadNewDocument(uow, storage, owner, {
      title: 'a.md',
      projectId: null,
      content: bytes('x'),
      source: 'cli',
      path: '../../etc/passwd',
    });
    expect(!result.ok && result.error.code).toBe('invalid_path');
    expect(world.documents.size).toBe(0);
    expect(storage.objects.size).toBe(0);
  });

  it('refuses a second document at a path already taken in the same project', async () => {
    const { world, org, owner, uow, storage } = setup();
    const project = world.addProject(org.id, { name: 'Docs', color: '#6366f1' });
    const first = await uploadNewDocument(uow, storage, owner, {
      title: 'auth.md',
      projectId: project.id,
      content: bytes('one'),
      source: 'cli',
      path: 'docs/auth.md',
    });
    expect(first.ok).toBe(true);

    const clash = await uploadNewDocument(uow, storage, owner, {
      title: 'auth.md',
      projectId: project.id,
      content: bytes('two'),
      source: 'cli',
      path: 'docs/auth.md',
    });
    expect(!clash.ok && clash.error.code).toBe('path_taken');

    // A different project is a different uniqueness scope.
    const other = world.addProject(org.id, { name: 'Other', color: '#6366f1' });
    const elsewhere = await uploadNewDocument(uow, storage, owner, {
      title: 'auth.md',
      projectId: other.id,
      content: bytes('three'),
      source: 'cli',
      path: 'docs/auth.md',
    });
    expect(elsewhere.ok).toBe(true);
  });

  it('never collides two manual (path-less) uploads', async () => {
    const { org, world, owner, uow, storage } = setup();
    const project = world.addProject(org.id, { name: 'Docs', color: '#6366f1' });
    for (const n of ['a', 'b', 'c']) {
      const r = await uploadNewDocument(uow, storage, owner, {
        title: `${n}.md`,
        projectId: project.id,
        content: bytes(n),
        source: 'web',
      });
      expect(r.ok).toBe(true);
    }
    expect(world.documents.size).toBe(3);
  });

  describe('uploadNewVersion repaths (the `git mv` case)', () => {
    async function pushed(path: string, content = 'v1') {
      const s = setup();
      const project = s.world.addProject(s.org.id, { name: 'Docs', color: '#6366f1' });
      const first = await uploadNewDocument(s.uow, s.storage, s.owner, {
        title: 'auth.md',
        projectId: project.id,
        content: bytes(content),
        source: 'cli',
        path,
      });
      if (!first.ok) throw new Error('setup upload failed');
      return { ...s, project, documentId: first.value.document.id };
    }

    it('moves the document when a new version arrives at a new path', async () => {
      const { world, owner, uow, storage, documentId } = await pushed('docs/auth.md');
      const moved = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'cli',
        path: 'docs/specs/auth.md',
      });
      expect(moved.ok && moved.value.document.path).toBe('docs/specs/auth.md');
      expect(world.documents.get(documentId)?.path).toBe('docs/specs/auth.md');
      // One document, not a fork.
      expect(world.documents.size).toBe(1);
    });

    it('applies the repath even when the content is byte-identical — the commonest `git mv`', async () => {
      const { world, owner, uow, storage, documentId } = await pushed('docs/auth.md');
      const moved = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v1'),
        source: 'cli',
        path: 'docs/specs/auth.md',
      });
      expect(moved.ok && moved.value.deduplicated).toBe(true);
      expect(moved.ok && moved.value.document.path).toBe('docs/specs/auth.md');
      expect(world.documents.get(documentId)?.path).toBe('docs/specs/auth.md');
    });

    it('regression: a version-cap failure on new content blocks the repath too, not just the version', async () => {
      // Same regression this test always proved, adapted to the surviving
      // check: the upload-velocity quota that used to trigger it is retired
      // (rate-limiting redesign, 2026-08-11) — the live-version-per-doc cap
      // is the other check inside checkVersionUploadAllowed that can still
      // fail on non-dedup content, so it takes over as the trigger here.
      const { world, org, owner, uow, storage, documentId } = await pushed('docs/auth.md');
      // `pushed` already minted 1 live version; fill to team tier's 1,000
      // live-version-per-doc ceiling (tier.ts) with the rest.
      for (let i = 0; i < 999; i++) {
        world.addVersion(org.id, {
          documentId,
          contentHash: `hash-${String(i)}`,
          byteSize: 2,
          source: 'cli',
          createdBy: owner.ctx.userId,
        });
      }
      const result = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'cli',
        path: 'docs/specs/auth.md',
      });
      expect(!result.ok && result.error.code).toBe('version_cap_exceeded');
      // Regression for the withTenant commit-on-err bug: the repath used to
      // run before this check could reject the call, so a cap-exceeded push
      // still silently moved the document.
      expect(world.documents.get(documentId)?.path).toBe('docs/auth.md');
    });

    it('leaves the stored path alone when the upload carries none', async () => {
      const { world, owner, uow, storage, documentId } = await pushed('docs/auth.md');
      const plain = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'web',
      });
      expect(plain.ok && plain.value.document.path).toBe('docs/auth.md');
      expect(world.documents.get(documentId)?.path).toBe('docs/auth.md');
    });

    it('rejects an invalid new path without minting a version', async () => {
      const { world, owner, uow, storage, documentId } = await pushed('docs/auth.md');
      const result = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'cli',
        path: '/absolute/auth.md',
      });
      expect(!result.ok && result.error.code).toBe('invalid_path');
      expect(world.documents.get(documentId)?.path).toBe('docs/auth.md');
      expect([...world.versions.values()]).toHaveLength(1);
    });

    it('refuses to move onto a path another live document already holds', async () => {
      const s = await pushed('docs/auth.md');
      const other = await uploadNewDocument(s.uow, s.storage, s.owner, {
        title: 'billing.md',
        projectId: s.project.id,
        content: bytes('billing'),
        source: 'cli',
        path: 'docs/billing.md',
      });
      expect(other.ok).toBe(true);

      const clash = await uploadNewVersion(s.uow, s.storage, s.owner, {
        documentId: s.documentId,
        content: bytes('v2'),
        source: 'cli',
        path: 'docs/billing.md',
      });
      expect(!clash.ok && clash.error.code).toBe('path_taken');
      expect(s.world.documents.get(s.documentId)?.path).toBe('docs/auth.md');
    });

    it('re-sending the same path is a no-op, not a self-collision', async () => {
      const { owner, uow, storage, documentId } = await pushed('docs/auth.md');
      const again = await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'cli',
        path: 'docs/auth.md',
      });
      expect(again.ok && again.value.document.path).toBe('docs/auth.md');
    });

    it('keeps blob keys free of the path — storage is still keyed by seq alone', async () => {
      const { org, owner, uow, storage, documentId } = await pushed('docs/auth.md');
      await uploadNewVersion(uow, storage, owner, {
        documentId,
        content: bytes('v2'),
        source: 'cli',
        path: 'docs/specs/auth.md',
      });
      // CONSTITUTION.md §3: keys derive from VersionKey{orgId, documentId,
      // seq} and nothing else. Asserted exactly, not by substring, so a path
      // leaking into a key can never pass by coincidence.
      expect([...storage.objects.keys()].sort()).toEqual([
        `orgs/${org.id}/docs/${documentId}/v1`,
        `orgs/${org.id}/docs/${documentId}/v2`,
      ]);
    });
  });
});
