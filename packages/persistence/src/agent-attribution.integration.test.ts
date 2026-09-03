import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantContext } from '@vorlyn/app';
import { PgApiKeyRepository } from './repositories/pg-api-key-repository.js';
import {
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgVersionRepository,
} from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

/**
 * Phase A (agent attribution): via_api_key_id round-trips on comments,
 * replies and versions, and the name lookup respects tenant isolation
 * (RLS) the same as every other read.
 */
describe('agent attribution', () => {
  let db: TestDb;
  let ctxA: TenantContext;
  let ctxB: TenantContext;
  let apiKeysA: PgApiKeyRepository;
  let apiKeysB: PgApiKeyRepository;
  let keyIdA: string;
  let keyIdB: string;

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    const orgA = await directory.createOrganization('Acme');
    const aliceA = await directory.createUser(orgA.id, {
      workosUserId: 'wos_alice',
      email: 'alice@acme.test',
      displayName: 'Alice',
      role: 'member',
    });
    ctxA = { orgId: orgA.id, userId: aliceA.id };

    const orgB = await directory.createOrganization('Globex');
    const aliceB = await directory.createUser(orgB.id, {
      workosUserId: 'wos_bob',
      email: 'bob@globex.test',
      displayName: 'Bob',
      role: 'member',
    });
    ctxB = { orgId: orgB.id, userId: aliceB.id };

    apiKeysA = new PgApiKeyRepository(db.pool);
    apiKeysB = new PgApiKeyRepository(db.pool);
    const keyA = await apiKeysA.create(ctxA, {
      userId: ctxA.userId,
      name: 'ci bot A',
      keyHash: 'hash-a',
    });
    keyIdA = keyA.id;
    const keyB = await apiKeysB.create(ctxB, {
      userId: ctxB.userId,
      name: 'ci bot B',
      keyHash: 'hash-b',
    });
    keyIdB = keyB.id;
  });

  afterAll(async () => {
    await db.close();
  });

  it('round-trips via_api_key_id on a comment and its reply', async () => {
    const documents = new PgDocumentRepository(db.pool);
    const comments = new PgCommentRepository(db.pool);
    const doc = await documents.create(ctxA, {
      projectId: null,
      ownerId: ctxA.userId,
      title: 'x.md',
    });
    const versions = new PgVersionRepository(db.pool);
    const version = await versions.append(ctxA, {
      documentId: doc.id,
      contentHash: 'h1',
      byteSize: 4,
      createdBy: ctxA.userId,
      source: 'mcp',
      viaApiKeyId: keyIdA,
    });
    expect(version.viaApiKeyId).toBe(keyIdA);
    const reloadedVersion = await versions.byId(ctxA, version.id);
    expect(reloadedVersion?.viaApiKeyId).toBe(keyIdA);

    const comment = await comments.create(ctxA, {
      documentId: doc.id,
      versionId: version.id,
      authorId: ctxA.userId,
      body: 'from an agent',
      anchor: { type: 'document' },
      viaApiKeyId: keyIdA,
    });
    expect(comment.viaApiKeyId).toBe(keyIdA);
    const reloadedComment = await comments.byId(ctxA, comment.id);
    expect(reloadedComment?.viaApiKeyId).toBe(keyIdA);

    const reply = await comments.addReply(ctxA, {
      commentId: comment.id,
      parentReplyId: null,
      authorId: ctxA.userId,
      body: 'agent reply',
      viaApiKeyId: keyIdA,
    });
    expect(reply.viaApiKeyId).toBe(keyIdA);
    const [reloadedReply] = await comments.listReplies(ctxA, comment.id);
    expect(reloadedReply?.viaApiKeyId).toBe(keyIdA);
  });

  it('leaves via_api_key_id null for human-authored rows', async () => {
    const documents = new PgDocumentRepository(db.pool);
    const comments = new PgCommentRepository(db.pool);
    const versions = new PgVersionRepository(db.pool);
    const doc = await documents.create(ctxA, {
      projectId: null,
      ownerId: ctxA.userId,
      title: 'human.md',
    });
    const version = await versions.append(ctxA, {
      documentId: doc.id,
      contentHash: 'h2',
      byteSize: 4,
      createdBy: ctxA.userId,
      source: 'web',
    });
    expect(version.viaApiKeyId).toBeNull();
    const comment = await comments.create(ctxA, {
      documentId: doc.id,
      versionId: version.id,
      authorId: ctxA.userId,
      body: 'from a human',
      anchor: { type: 'document' },
    });
    expect(comment.viaApiKeyId).toBeNull();
  });

  it('namesByIds resolves within one org; another org key id is absent — no cross-tenant leak', async () => {
    const names = await apiKeysA.namesByIds(ctxA, [keyIdA, keyIdB]);
    expect(names.get(keyIdA)).toBe('ci bot A');
    expect(names.has(keyIdB)).toBe(false);

    const namesFromB = await apiKeysB.namesByIds(ctxB, [keyIdA, keyIdB]);
    expect(namesFromB.get(keyIdB)).toBe('ci bot B');
    expect(namesFromB.has(keyIdA)).toBe(false);
  });

  it('namesByIds still resolves a revoked key — honest attribution survives revocation', async () => {
    const key = await apiKeysA.create(ctxA, {
      userId: ctxA.userId,
      name: 'soon revoked',
      keyHash: 'hash-revoke-me',
    });
    await apiKeysA.revoke(ctxA, key.id);
    const names = await apiKeysA.namesByIds(ctxA, [key.id]);
    expect(names.get(key.id)).toBe('soon revoked');
  });
});
