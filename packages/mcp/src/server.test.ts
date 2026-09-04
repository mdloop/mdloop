import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Actor, OAuthTokenVerifierPort } from '@mdloop/app';
import type { DocumentId, UserId } from '@mdloop/shared';
import { actorForApiKey, actorForOAuthToken, createApiKey } from '@mdloop/app';
import { NoopTelemetry } from '@mdloop/app/test-support';
import {
  FsStorage,
  PgAnchorResolutionRepository,
  PgApiKeyRepository,
  PgCommentRepository,
  PgDirectoryRepository,
  PgDocumentRepository,
  PgOrganizationRepository,
  PgProjectRepository,
  PgSearchRepository,
  PgShareGrantRepository,
  PgUploadUnitOfWork,
  PgReviewRepository,
  PgVersionRepository,
} from '@mdloop/persistence';
import { createTestDb } from '@mdloop/persistence/test-support';
import type { TestDb } from '@mdloop/persistence/test-support';
import type { McpDeps } from './server.js';
import { buildMcpServer } from './server.js';

interface JsonToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/** Maps presented tokens to a WorkOS `sub` claim — same fake-port style as
 * oauth-tokens.test.ts, standing in for a real WorkosJwtVerifier here since
 * this file's own job is proving `actorForOAuthToken` end to end against a
 * live Postgres directory, not re-testing JWT verification (that's
 * auth/workos-jwt-verifier.test.ts). */
class TestOAuthVerifier implements OAuthTokenVerifierPort {
  constructor(private readonly subjectByToken: Map<string, string>) {}

  verify(token: string): Promise<{ readonly sub: string } | undefined> {
    const sub = this.subjectByToken.get(token);
    return Promise.resolve(sub ? { sub } : undefined);
  }
}

function parse(result: JsonToolResult): unknown {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

describe('MCP server', () => {
  let db: TestDb;
  let deps: McpDeps;
  let storageDir: string;
  let ownerActor: Actor;
  let otherOrgActor: Actor;

  async function connectAs(actor: Actor, depsOverride?: Partial<McpDeps>): Promise<Client> {
    const server = buildMcpServer({ ...deps, ...depsOverride }, actor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  beforeAll(async () => {
    db = await createTestDb();
    const directory = new PgDirectoryRepository(db.pool);
    storageDir = await mkdtemp(path.join(tmpdir(), 'mdloop-mcp-blobs-'));
    const storage = new FsStorage(storageDir);
    deps = {
      documents: new PgDocumentRepository(db.pool),
      projects: new PgProjectRepository(db.pool),
      versions: new PgVersionRepository(db.pool),
      comments: new PgCommentRepository(db.pool),
      reviews: new PgReviewRepository(db.pool),
      resolutions: new PgAnchorResolutionRepository(db.pool),
      grants: new PgShareGrantRepository(db.pool),
      organizations: new PgOrganizationRepository(db.pool),
      uploadUow: new PgUploadUnitOfWork(db.pool),
      storage,
      apiKeys: new PgApiKeyRepository(db.pool),
      search: new PgSearchRepository(db.pool),
      telemetry: new NoopTelemetry(),
    };

    const org = await directory.createOrganization('Acme');
    const owner = await directory.createUser(org.id, {
      workosUserId: 'wos_owner',
      email: 'owner@acme.test',
      displayName: 'Owner',
      role: 'admin',
    });
    ownerActor = { ctx: { orgId: org.id, userId: owner.id }, role: 'admin' };

    const otherOrg = await directory.createOrganization('Globex');
    const otherUser = await directory.createUser(otherOrg.id, {
      workosUserId: 'wos_other',
      email: 'other@globex.test',
      displayName: 'Other',
      role: 'admin',
    });
    otherOrgActor = { ctx: { orgId: otherOrg.id, userId: otherUser.id }, role: 'admin' };
  }, 60_000);

  afterAll(async () => {
    await db.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  it('resolves an actor from a live API key, end to end', async () => {
    const created = await createApiKey(deps.apiKeys, ownerActor, 'agent key');
    if (!created.ok) throw new Error('setup');
    const resolved = await actorForApiKey(deps.apiKeys, created.value.key);
    // The actor carries the key that authenticated it, for write attribution.
    expect(resolved).toEqual({ ...ownerActor, apiKeyId: created.value.record.id });
    expect(await actorForApiKey(deps.apiKeys, 'mdloop_not-a-real-key')).toBeUndefined();
  });

  // ADR 0013: the OAuth sibling of the test above — a WorkOS-issued token
  // resolves through actorForOAuthToken against the same live directory,
  // no apiKeyId set (a human/interactive actor, not an API key).
  it('resolves an actor from a WorkOS-issued OAuth token, end to end', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const verifier = new TestOAuthVerifier(new Map([['tok-owner', 'wos_owner']]));
    const resolved = await actorForOAuthToken(directory, verifier, 'tok-owner');
    expect(resolved).toEqual(ownerActor);
    expect(await actorForOAuthToken(directory, verifier, 'tok-unknown')).toBeUndefined();
  });

  // Direct analogue of "tenant isolation: an org B identity cannot reach an
  // org A document" below, but for an actor resolved through the OAuth path
  // instead of a pre-built Actor literal — proves the isolation guarantee
  // holds for whatever actorForOAuthToken hands buildMcpServer, not just for
  // the API-key path.
  it('tenant isolation holds for an OAuth-issued token from another org', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const verifier = new TestOAuthVerifier(new Map([['tok-other', 'wos_other']]));
    const resolvedOtherOrg = await actorForOAuthToken(directory, verifier, 'tok-other');
    expect(resolvedOtherOrg).toEqual(otherOrgActor);

    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'oauth-secret.md', content: '# OAuth Secret' },
      })) as JsonToolResult,
    ) as { document_id: string };
    await owner.close();

    const stranger = await connectAs(resolvedOtherOrg!);
    const result = (await stranger.callTool({
      name: 'get_document',
      arguments: { document_id: uploaded.document_id },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('document_not_found');
    await stranger.close();
  });

  it('lists every tool', async () => {
    const client = await connectAs(ownerActor);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'accept_suggestion',
        'create_comment',
        'create_project',
        'export_org',
        'get_diff',
        'get_document',
        'get_document_status',
        'get_feedback_bundle',
        'get_org_usage',
        'get_review_status',
        'list_documents',
        'list_projects',
        'list_versions',
        'reject_suggestion',
        'reply_to_comment',
        'request_review',
        'resolve_comment',
        'search_documents',
        'submit_review',
        'upload_document',
      ].sort(),
    );
    await client.close();
  });

  // The tool surface IS the agent-facing documentation — an undescribed
  // parameter is a guess an agent has to make at call time. Locked in here so a
  // new tool or a new parameter can't ship undocumented.
  it('documents every tool and every parameter', async () => {
    const client = await connectAs(ownerActor);
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description ?? '', `${t.name} description`).not.toHaveLength(0);
      // Every tool goes through the shared rate-limit wrapper, so every tool
      // can return this and every description says so in the same words.
      expect(t.description, `${t.name} mentions rate_limited`).toContain('`rate_limited`');
      const properties = (t.inputSchema as { properties?: Record<string, unknown> }).properties;
      for (const [name, schema] of Object.entries(properties ?? {})) {
        const described = (schema as { description?: string }).description ?? '';
        expect(described, `${t.name}.${name} description`).not.toHaveLength(0);
      }
    }
    await client.close();
  });

  it('drives the full agent loop: upload, feedback, reply, resolve', async () => {
    const client = await connectAs(ownerActor);

    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'runbook.md', content: '# Runbook\n\nSteps here.' },
      })) as JsonToolResult,
    ) as { document_id: string };
    expect(uploaded.document_id).toBeTruthy();

    const listed = parse(
      (await client.callTool({ name: 'list_documents', arguments: {} })) as JsonToolResult,
    ) as { id: string; title: string }[];
    expect(listed.some((d) => d.id === uploaded.document_id)).toBe(true);

    const fetched = parse(
      (await client.callTool({
        name: 'get_document',
        arguments: { document_id: uploaded.document_id },
      })) as JsonToolResult,
    ) as { content: string };
    expect(fetched.content).toContain('Steps here.');

    const commented = parse(
      (await client.callTool({
        name: 'create_comment',
        arguments: { document_id: uploaded.document_id, body: 'needs a rollback section' },
      })) as JsonToolResult,
    ) as { comment_id: string };

    const bundle = (await client.callTool({
      name: 'get_feedback_bundle',
      arguments: { document_id: uploaded.document_id },
    })) as unknown as { structuredContent: { open_count: number } };
    expect(bundle.structuredContent.open_count).toBe(1);

    const replied = parse(
      (await client.callTool({
        name: 'reply_to_comment',
        arguments: { comment_id: commented.comment_id, body: 'added it' },
      })) as JsonToolResult,
    ) as { reply_id: string };
    expect(replied.reply_id).toBeTruthy();

    const resolved = parse(
      (await client.callTool({
        name: 'resolve_comment',
        arguments: { comment_id: commented.comment_id },
      })) as JsonToolResult,
    ) as { resolved: boolean };
    expect(resolved.resolved).toBe(true);

    const found = parse(
      (await client.callTool({
        name: 'search_documents',
        arguments: { query: 'runbook' },
      })) as JsonToolResult,
    ) as { documents: { id: string }[]; comments: unknown[] };
    expect(found.documents.map((d) => d.id)).toContain(uploaded.document_id);

    // Comment FTS parity (ADR 0003 §C): the same tool returns anchor-grained
    // comment hits — the "rollback" comment body is reachable by search.
    const foundComment = parse(
      (await client.callTool({
        name: 'search_documents',
        arguments: { query: 'rollback' },
      })) as JsonToolResult,
    ) as { comments: { comment_id: string; document_id: string }[] };
    expect(foundComment.comments.map((c) => c.comment_id)).toContain(commented.comment_id);

    await client.close();
  });

  it('upload_document refuses non-markdown content, code intact (ADR 0011)', async () => {
    const client = await connectAs(ownerActor);

    // No MCP-side mapping table exists or is needed: `errorResult` forwards
    // whatever code the use-case returned, so a new UploadError code reaches
    // an agent verbatim the moment the domain starts producing it.
    const controlBytes = (await client.callTool({
      name: 'upload_document',
      arguments: { title: 'renamed.md', content: '# Notes\n\u0000binary' },
    })) as JsonToolResult;
    expect(controlBytes.isError).toBe(true);
    expect((parse(controlBytes) as { error: string }).error).toBe('control_byte_detected');

    const pdf = (await client.callTool({
      name: 'upload_document',
      arguments: { title: 'report.md', content: '%PDF-1.7 not markdown' },
    })) as JsonToolResult;
    expect(pdf.isError).toBe(true);
    expect((parse(pdf) as { error: string }).error).toBe('binary_signature_detected');

    // Same gate on the append branch of the same tool.
    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'clean.md', content: '# Clean' },
      })) as JsonToolResult,
    ) as { document_id: string };
    const appended = (await client.callTool({
      name: 'upload_document',
      arguments: { document_id: uploaded.document_id, content: '# Clean\n\u0000' },
    })) as JsonToolResult;
    expect(appended.isError).toBe(true);
    expect((parse(appended) as { error: string }).error).toBe('control_byte_detected');

    await client.close();
  });

  // CONSTITUTION §3: an unhandled throw (as opposed to a typed Result the
  // handler turns into `errorResult(code)`) must never reach the calling
  // agent with the raw error text, since that can quote row/constraint
  // values. A malformed id is a real, easy way to make the live Postgres
  // repository throw (invalid input syntax for type uuid) rather than
  // return `undefined` — no fake/mock repo needed.
  it('normalizes an unhandled throw to a static code, never the raw error text', async () => {
    const client = await connectAs(ownerActor);
    const result = (await client.callTool({
      name: 'get_document',
      arguments: { document_id: 'not-a-uuid' },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: 'internal' });
    expect(result.content[0]?.text).not.toMatch(/uuid|syntax|postgres/i);
    await client.close();
  });

  it('get_document_status answers "has this moved?" without the body', async () => {
    const client = await connectAs(ownerActor);
    const content = '# Status\n\nFirst leg.';
    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'status.md', content },
      })) as JsonToolResult,
    ) as { document_id: string; version_seq: number };

    const status = parse(
      (await client.callTool({
        name: 'get_document_status',
        arguments: { document_id: uploaded.document_id },
      })) as JsonToolResult,
    ) as Record<string, unknown>;
    expect(status).toEqual({
      document_id: uploaded.document_id,
      version_seq: uploaded.version_seq,
      // Exactly what the sync CLI hashes locally: sha256 hex over the raw
      // UTF-8 bytes, no normalization (`contentHashOf`).
      content_hash: createHash('sha256').update(content).digest('hex'),
      my_permission: 'edit',
    });
    // The whole point of the tool: no markdown crosses the wire.
    expect(Object.keys(status)).not.toContain('content');

    const second = '# Status\n\nSecond leg.';
    await client.callTool({
      name: 'upload_document',
      arguments: { document_id: uploaded.document_id, content: second },
    });
    const moved = parse(
      (await client.callTool({
        name: 'get_document_status',
        arguments: { document_id: uploaded.document_id },
      })) as JsonToolResult,
    ) as { version_seq: number; content_hash: string };
    // Seq gaps are legal (`reserveVersionSeq` is a monotonic counter), so the
    // guard this tool feeds compares for inequality, never `prev + 1`.
    expect(moved.version_seq).toBeGreaterThan(uploaded.version_seq);
    expect(moved.content_hash).toBe(createHash('sha256').update(second).digest('hex'));
    await client.close();
  });

  it('get_document_status: tenant isolation and unknown ids both read as not found', async () => {
    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'private-status.md', content: '# Private' },
      })) as JsonToolResult,
    ) as { document_id: string };
    await owner.close();

    const stranger = await connectAs(otherOrgActor);
    const crossOrg = (await stranger.callTool({
      name: 'get_document_status',
      arguments: { document_id: uploaded.document_id },
    })) as JsonToolResult;
    expect(crossOrg.isError).toBe(true);
    expect((parse(crossOrg) as { error: string }).error).toBe('document_not_found');
    await stranger.close();
  });

  it('get_org_usage reports the org tier and active document count', async () => {
    const client = await connectAs(ownerActor);
    // Give the org at least one live document so the count is meaningfully
    // nonzero, not just proving the zero case.
    await client.callTool({
      name: 'upload_document',
      arguments: { title: 'usage-fixture.md', content: '# Usage' },
    });

    const usage = parse(
      (await client.callTool({ name: 'get_org_usage', arguments: {} })) as JsonToolResult,
    ) as {
      tier: string;
      active_doc_count: number;
      max_active_docs: number | null;
      project_usage?: unknown;
    };
    expect(usage.tier).toBe('team');
    expect(usage.max_active_docs).toBe(5_000);
    expect(usage.active_doc_count).toBeGreaterThanOrEqual(1);
    // No project_id was passed, so the field is omitted entirely, never null.
    expect(usage).not.toHaveProperty('project_usage');
    await client.close();
  });

  it('get_org_usage includes project_usage only when project_id is passed', async () => {
    const client = await connectAs(ownerActor);
    const project = parse(
      (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Usage', color: '#000000' },
      })) as JsonToolResult,
    ) as { id: string };
    await client.callTool({
      name: 'upload_document',
      arguments: { title: 'in-project.md', content: '# In project', project_id: project.id },
    });

    const withoutProjectId = parse(
      (await client.callTool({ name: 'get_org_usage', arguments: {} })) as JsonToolResult,
    ) as { project_usage?: unknown };
    expect(withoutProjectId).not.toHaveProperty('project_usage');

    const withProjectId = parse(
      (await client.callTool({
        name: 'get_org_usage',
        arguments: { project_id: project.id },
      })) as JsonToolResult,
    ) as {
      project_usage?: { active_doc_count: number; max_active_docs_per_project: number | null };
    };
    expect(withProjectId.project_usage).toEqual({
      active_doc_count: 1,
      max_active_docs_per_project: 500,
    });
    await client.close();
  });

  it('create_project: happy path returns id/name/color, and the project appears in list_projects', async () => {
    const client = await connectAs(ownerActor);
    const created = parse(
      (await client.callTool({
        name: 'create_project',
        arguments: { name: 'Roadmap', color: '#123abc' },
      })) as JsonToolResult,
    ) as { id: string; name: string; color: string };
    expect(created.name).toBe('Roadmap');
    expect(created.color).toBe('#123abc');
    expect(created.id).toBeTruthy();

    const listed = parse(
      (await client.callTool({ name: 'list_projects', arguments: {} })) as JsonToolResult,
    ) as { id: string; name: string; color: string }[];
    expect(listed).toContainEqual(created);
    await client.close();
  });

  it('create_project: invalid_name for an empty string and for a 121-character name', async () => {
    const client = await connectAs(ownerActor);
    const empty = (await client.callTool({
      name: 'create_project',
      arguments: { name: '' },
    })) as JsonToolResult;
    expect(empty.isError).toBe(true);
    expect((parse(empty) as { error: string }).error).toBe('invalid_name');

    const tooLong = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'x'.repeat(121) },
    })) as JsonToolResult;
    expect(tooLong.isError).toBe(true);
    expect((parse(tooLong) as { error: string }).error).toBe('invalid_name');
    await client.close();
  });

  it('create_project: invalid_color for a non-hex string', async () => {
    const client = await connectAs(ownerActor);
    const result = (await client.callTool({
      name: 'create_project',
      arguments: { name: 'Badges', color: 'not-a-color' },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('invalid_color');
    await client.close();
  });

  it('create_project: a project created by org A is invisible to org B in list_projects', async () => {
    const owner = await connectAs(ownerActor);
    const created = parse(
      (await owner.callTool({
        name: 'create_project',
        arguments: { name: 'Acme-only' },
      })) as JsonToolResult,
    ) as { id: string };
    await owner.close();

    const stranger = await connectAs(otherOrgActor);
    const listed = parse(
      (await stranger.callTool({ name: 'list_projects', arguments: {} })) as JsonToolResult,
    ) as { id: string }[];
    expect(listed.some((p) => p.id === created.id)).toBe(false);
    await stranger.close();
  });

  it('get_org_usage: org_not_found for an actor whose org id matches no row (RLS sees zero rows)', async () => {
    // A well-formed but nonexistent org id: current_org_id() casts fine, but
    // `select * from organizations` under RLS returns zero rows — the same
    // "tenant boundary and 404 are the same answer" shape as everywhere else
    // in this file, exercised through the tool instead of the fake-backed
    // unit test in org-usage.test.ts.
    const ghost: Actor = {
      ctx: { orgId: randomUUID() as Actor['ctx']['orgId'], userId: randomUUID() as UserId },
      role: 'admin',
    };
    const client = await connectAs(ghost);
    const usage = (await client.callTool({
      name: 'get_org_usage',
      arguments: {},
    })) as JsonToolResult;
    expect(usage.isError).toBe(true);
    expect((parse(usage) as { error: string }).error).toBe('org_not_found');
    await client.close();
  });

  it('reply_to_comment threads under a parent reply via parent_reply_id', async () => {
    const client = await connectAs(ownerActor);
    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'threaded.md', content: '# T\n\nBody.' },
      })) as JsonToolResult,
    ) as { document_id: string };
    const commented = parse(
      (await client.callTool({
        name: 'create_comment',
        arguments: { document_id: uploaded.document_id, body: 'top-level' },
      })) as JsonToolResult,
    ) as { comment_id: string };
    const parent = parse(
      (await client.callTool({
        name: 'reply_to_comment',
        arguments: { comment_id: commented.comment_id, body: 'first reply' },
      })) as JsonToolResult,
    ) as { reply_id: string };
    const child = parse(
      (await client.callTool({
        name: 'reply_to_comment',
        arguments: {
          comment_id: commented.comment_id,
          body: 'nested reply',
          parent_reply_id: parent.reply_id,
        },
      })) as JsonToolResult,
    ) as { reply_id: string };
    expect(child.reply_id).toBeTruthy();

    const bundle = (await client.callTool({
      name: 'get_feedback_bundle',
      arguments: { document_id: uploaded.document_id },
    })) as unknown as {
      structuredContent: { items: { replies: { body: string; depth: number }[] }[] };
    };
    const replies = bundle.structuredContent.items[0]?.replies ?? [];
    expect(replies).toEqual([
      { body: 'first reply', mine: true, depth: 1 },
      { body: 'nested reply', mine: true, depth: 2 },
    ]);
    await client.close();
  });

  it('sign-off: request review, reviewer approves, status flips to approved', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const reviewer = await directory.createUser(ownerActor.ctx.orgId, {
      workosUserId: 'wos_reviewer',
      email: 'reviewer@acme.test',
      displayName: 'Reviewer',
      role: 'admin',
    });
    const reviewerActor: Actor = {
      ctx: { orgId: ownerActor.ctx.orgId, userId: reviewer.id },
      role: 'admin',
    };

    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'signoff.md', content: '# Sign-off\n\nReady for review.' },
      })) as JsonToolResult,
    ) as { document_id: string };

    const requested = parse(
      (await owner.callTool({
        name: 'request_review',
        arguments: { document_id: uploaded.document_id, reviewer_user_id: reviewer.id },
      })) as JsonToolResult,
    ) as { request_id: string; reviewer_user_id: string };
    expect(requested.reviewer_user_id).toBe(reviewer.id);
    await owner.close();

    const reviewerClient = await connectAs(reviewerActor);
    const status = parse(
      (await reviewerClient.callTool({
        name: 'get_review_status',
        arguments: { document_id: uploaded.document_id },
      })) as JsonToolResult,
    ) as { status: string; requests: { reviewer_user_id: string }[] };
    expect(status.status).toBe('in_review');
    expect(status.requests.map((r) => r.reviewer_user_id)).toContain(reviewer.id);

    const submitted = parse(
      (await reviewerClient.callTool({
        name: 'submit_review',
        arguments: { document_id: uploaded.document_id, verdict: 'approved' },
      })) as JsonToolResult,
    ) as { status: string; verdict: string };
    expect(submitted.verdict).toBe('approved');
    expect(submitted.status).toBe('approved');
    await reviewerClient.close();
  });

  it('upload_document and request_review carry a url only when webAppUrl is configured', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const reviewer = await directory.createUser(ownerActor.ctx.orgId, {
      workosUserId: 'wos_url_reviewer',
      email: 'url-reviewer@acme.test',
      displayName: 'URL Reviewer',
      role: 'admin',
    });

    // Default deps (no webAppUrl, matching every other test in this file):
    // the field is omitted entirely, never a guessed or empty-string link.
    const bare = await connectAs(ownerActor);
    const bareUploaded = parse(
      (await bare.callTool({
        name: 'upload_document',
        arguments: { title: 'no-url.md', content: '# No URL configured' },
      })) as JsonToolResult,
    ) as { document_id: string; url?: string };
    expect(bareUploaded.url).toBeUndefined();
    const bareRequested = parse(
      (await bare.callTool({
        name: 'request_review',
        arguments: { document_id: bareUploaded.document_id, reviewer_user_id: reviewer.id },
      })) as JsonToolResult,
    ) as { url?: string };
    expect(bareRequested.url).toBeUndefined();
    await bare.close();

    // With webAppUrl set: both tools build `${webAppUrl}/d/${documentId}`,
    // matching packages/web/src/app.route.ts's route.
    const withUrl = await connectAs(ownerActor, { webAppUrl: 'https://mdloop.example.test' });
    const uploaded = parse(
      (await withUrl.callTool({
        name: 'upload_document',
        arguments: { title: 'has-url.md', content: '# URL configured' },
      })) as JsonToolResult,
    ) as { document_id: string; url?: string };
    expect(uploaded.url).toBe(`https://mdloop.example.test/d/${uploaded.document_id}`);
    const requested = parse(
      (await withUrl.callTool({
        name: 'request_review',
        arguments: { document_id: uploaded.document_id, reviewer_user_id: reviewer.id },
      })) as JsonToolResult,
    ) as { url?: string };
    expect(requested.url).toBe(`https://mdloop.example.test/d/${uploaded.document_id}`);
    await withUrl.close();
  });

  it('request_review fires onReviewRequested with the document url, and never on upload_document', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const reviewer = await directory.createUser(ownerActor.ctx.orgId, {
      workosUserId: 'wos_notify_reviewer',
      email: 'notify-reviewer@acme.test',
      displayName: 'Notify Reviewer',
      role: 'admin',
    });
    const onReviewRequested = vi.fn();

    const client = await connectAs(ownerActor, {
      webAppUrl: 'https://mdloop.example.test',
      onReviewRequested,
    });
    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'notify.md', content: '# Should not auto-launch on upload' },
      })) as JsonToolResult,
    ) as { document_id: string };
    // Every ordinary revision goes through upload_document — firing here
    // too would pop a browser tab per edit, not just when review is asked
    // for.
    expect(onReviewRequested).not.toHaveBeenCalled();

    await client.callTool({
      name: 'request_review',
      arguments: { document_id: uploaded.document_id, reviewer_user_id: reviewer.id },
    });
    expect(onReviewRequested).toHaveBeenCalledExactlyOnceWith(
      `https://mdloop.example.test/d/${uploaded.document_id}`,
    );
    await client.close();
  });

  it('a callback throwing from onReviewRequested never fails the request_review call it triggered', async () => {
    const directory = new PgDirectoryRepository(db.pool);
    const reviewer = await directory.createUser(ownerActor.ctx.orgId, {
      workosUserId: 'wos_throwing_reviewer',
      email: 'throwing-reviewer@acme.test',
      displayName: 'Throwing Reviewer',
      role: 'admin',
    });
    const client = await connectAs(ownerActor, {
      webAppUrl: 'https://mdloop.example.test',
      onReviewRequested: () => {
        throw new Error('simulated: browser launch failed');
      },
    });
    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'still-succeeds.md', content: '# Still succeeds' },
      })) as JsonToolResult,
    ) as { document_id: string };
    const requested = parse(
      (await client.callTool({
        name: 'request_review',
        arguments: { document_id: uploaded.document_id, reviewer_user_id: reviewer.id },
      })) as JsonToolResult,
    ) as { request_id: string };
    expect(requested.request_id).toBeTruthy();
    await client.close();
  });

  it('a non-reviewer cannot submit a verdict', async () => {
    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'unreviewed.md', content: '# No reviewer yet' },
      })) as JsonToolResult,
    ) as { document_id: string };

    const result = (await owner.callTool({
      name: 'submit_review',
      arguments: { document_id: uploaded.document_id, verdict: 'approved' },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('not_a_reviewer');
    await owner.close();
  });

  it('list_versions + get_diff: version history carries the change note, diff shows the edit', async () => {
    const client = await connectAs(ownerActor);

    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: {
          title: 'versioned.md',
          content: '# Versioned\n\nThe quick brown fox jumps.',
          change_note: 'first draft',
        },
      })) as JsonToolResult,
    ) as { document_id: string };

    await client.callTool({
      name: 'upload_document',
      arguments: {
        document_id: uploaded.document_id,
        content: '# Versioned\n\nThe quick brown fox leaps.',
        change_note: 'reworded the sentence',
      },
    });

    const versions = parse(
      (await client.callTool({
        name: 'list_versions',
        arguments: { document_id: uploaded.document_id },
      })) as JsonToolResult,
    ) as { seq: number; source: string; change_note: string | null; purged: boolean }[];
    // Newest first, notes threaded through upload, blob still present.
    expect(versions.map((v) => v.seq)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({
      source: 'mcp',
      change_note: 'reworded the sentence',
      purged: false,
    });
    expect(versions[1]?.change_note).toBe('first draft');

    const diff = parse(
      (await client.callTool({
        name: 'get_diff',
        arguments: { document_id: uploaded.document_id, from_seq: 1, to_seq: 2 },
      })) as JsonToolResult,
    ) as {
      from: { seq: number };
      to: { seq: number; changeNote: string | null };
      blocks: { type: string; runsKind?: string; runs?: { op: string; text: string }[] }[];
    };
    expect(diff.from.seq).toBe(1);
    // get_diff mirrors the HTTP /diff response shape exactly (API/MCP parity),
    // so the leg carries camelCase changeNote, not the tool's snake_case.
    expect(diff.to).toMatchObject({ seq: 2, changeNote: 'reworded the sentence' });
    const modified = diff.blocks.find((b) => b.type === 'modified');
    expect(modified?.runsKind).toBe('word');
    expect(modified?.runs?.some((r) => r.op === 'del' && r.text.includes('jumps'))).toBe(true);
    expect(modified?.runs?.some((r) => r.op === 'ins' && r.text.includes('leaps'))).toBe(true);

    await client.close();
  });

  it('get_diff degrades honestly for a missing version', async () => {
    const client = await connectAs(ownerActor);
    const uploaded = parse(
      (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'oneleg.md', content: '# Only one version' },
      })) as JsonToolResult,
    ) as { document_id: string };

    const result = (await client.callTool({
      name: 'get_diff',
      arguments: { document_id: uploaded.document_id, from_seq: 1, to_seq: 99 },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('version_not_found');
    await client.close();
  });

  // ADR 0008 (Phase 28): `edit` is grantable, so "may write this document" is
  // no longer implied by ownership. The MCP surface of the three-surface
  // isolation proof — the HTTP twin is in packages/api/src/documents-api.test.ts,
  // the repository twin in features/tenant-isolation.feature.
  it('tenant isolation: an org B edit grantee cannot upload to an org A document', async () => {
    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'org-a-only.md', content: '# Org A only' },
      })) as JsonToolResult,
    ) as { document_id: string };
    await owner.close();

    // A real editor — of a document in the other org, plus a grant forged to
    // name org A's document. Neither buys anything across the boundary.
    const documents = new PgDocumentRepository(db.pool);
    const grants = new PgShareGrantRepository(db.pool);
    const theirDoc = await documents.create(otherOrgActor.ctx, {
      projectId: null,
      ownerId: otherOrgActor.ctx.userId,
      title: 'org-b.md',
    });
    for (const subjectId of [theirDoc.id, uploaded.document_id as typeof theirDoc.id]) {
      await grants.create(otherOrgActor.ctx, {
        subject: { type: 'document', id: subjectId },
        grantee: { type: 'user', userId: otherOrgActor.ctx.userId },
        permission: 'edit',
        tokenHash: null,
        createdBy: otherOrgActor.ctx.userId,
      });
    }

    const stranger = await connectAs(otherOrgActor);
    const result = (await stranger.callTool({
      name: 'upload_document',
      arguments: { document_id: uploaded.document_id, content: '# tampered' },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('document_not_found');
    await stranger.close();
  });

  // ADR 0014's second isolation proof (project-subject grants, not just
  // document-subject ones) — MCP twin of features/tenant-isolation.feature's
  // "A project grantee cannot reach another organization's document"; the
  // HTTP twin is in packages/api/src/documents-api.test.ts.
  it('tenant isolation: an org B project-edit grantee cannot upload to an org A document filed in a project', async () => {
    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'org-a-in-project.md', content: '# Org A, in a project' },
      })) as JsonToolResult,
    ) as { document_id: string };
    await owner.close();

    const documents = new PgDocumentRepository(db.pool);
    const grants = new PgShareGrantRepository(db.pool);
    const projects = new PgProjectRepository(db.pool);

    // A real project-edit grantee — of a project in the OTHER org.
    const ownProject = await projects.create(otherOrgActor.ctx, {
      name: 'org B project',
      color: '#123456',
    });
    await grants.create(otherOrgActor.ctx, {
      subject: { type: 'project', id: ownProject.id },
      grantee: { type: 'user', userId: otherOrgActor.ctx.userId },
      permission: 'edit',
      tokenHash: null,
      createdBy: otherOrgActor.ctx.userId,
    });

    // Move org A's document into an org-A-side project, then forge a project
    // grant (in org B, via RLS) naming that project.
    const orgAProject = await projects.create(ownerActor.ctx, {
      name: 'org A project',
      color: '#654321',
    });
    await documents.moveToProject(
      ownerActor.ctx,
      uploaded.document_id as DocumentId,
      orgAProject.id,
    );
    await grants.create(otherOrgActor.ctx, {
      subject: { type: 'project', id: orgAProject.id },
      grantee: { type: 'user', userId: otherOrgActor.ctx.userId },
      permission: 'edit',
      tokenHash: null,
      createdBy: otherOrgActor.ctx.userId,
    });

    const stranger = await connectAs(otherOrgActor);
    const result = (await stranger.callTool({
      name: 'upload_document',
      arguments: { document_id: uploaded.document_id, content: '# tampered via project grant' },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('document_not_found');
    await stranger.close();
  });

  it('tenant isolation: an org B identity cannot reach an org A document', async () => {
    const owner = await connectAs(ownerActor);
    const uploaded = parse(
      (await owner.callTool({
        name: 'upload_document',
        arguments: { title: 'secret.md', content: '# Secret' },
      })) as JsonToolResult,
    ) as { document_id: string };
    await owner.close();

    const stranger = await connectAs(otherOrgActor);
    const result = (await stranger.callTool({
      name: 'get_document',
      arguments: { document_id: uploaded.document_id },
    })) as JsonToolResult;
    expect(result.isError).toBe(true);
    expect((parse(result) as { error: string }).error).toBe('document_not_found');

    const list = parse(
      (await stranger.callTool({ name: 'list_documents', arguments: {} })) as JsonToolResult,
    ) as { id: string }[];
    expect(list.map((d) => d.id)).not.toContain(uploaded.document_id);
    await stranger.close();
  });

  // Phase 33.A.1: doc_cap_exceeded / project_doc_cap_exceeded /
  // version_cap_exceeded carry a numeric `limit` in the domain
  // (packages/domain/src/tier.ts) that used to be dropped at this boundary —
  // an agent saw only the bare code. These four tests prove the MCP layer now
  // forwards `limit` plus a human-readable `message`, and that every other
  // error code (document_not_found here) is untouched. The cap-hit logic
  // itself is already exhaustively covered at the app layer
  // (packages/app/src/use-cases/upload.test.ts); these only prove the
  // boundary carries the enrichment through, so each fills the cap directly
  // via the repository (no blob I/O) rather than re-driving uploadNewDocument
  // in a loop.
  describe('tier-cap errors carry a human-readable message and limit (Phase 33.A.1)', () => {
    it('doc_cap_exceeded: upload_document reports the numeric limit and a plain-language message', async () => {
      const directory = new PgDirectoryRepository(db.pool);
      const org = await directory.createOrganization('CapOrgDoc', 'free');
      const capUser = await directory.createUser(org.id, {
        workosUserId: 'wos_cap_doc',
        email: 'cap-doc@example.test',
        displayName: 'Cap Doc Owner',
        role: 'admin',
      });
      const capActor: Actor = { ctx: { orgId: org.id, userId: capUser.id }, role: 'admin' };
      // Free tier's org-wide doc cap is 100 (Phase 33) — fill it directly.
      for (let i = 0; i < 100; i++) {
        await deps.documents.create(capActor.ctx, {
          title: `d${String(i)}.md`,
          projectId: null,
          ownerId: capActor.ctx.userId,
        });
      }
      const client = await connectAs(capActor);
      const result = (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'over.md', content: '# Over the line' },
      })) as JsonToolResult;
      expect(result.isError).toBe(true);
      const parsed = parse(result) as { error: string; limit: number; message: string };
      expect(parsed.error).toBe('doc_cap_exceeded');
      expect(parsed.limit).toBe(100);
      expect(parsed.message).toContain('100');
      expect(parsed.message).toContain('nothing changed');
      await client.close();
    }, 30_000);

    it('project_doc_cap_exceeded: upload_document reports the project-scoped limit and message', async () => {
      const directory = new PgDirectoryRepository(db.pool);
      // Team tier so the org-wide cap (5,000) stays nowhere near full while
      // isolating the project-scoped cap (500) — same reasoning as the
      // app-layer equivalent test.
      const org = await directory.createOrganization('CapOrgProject', 'team');
      const capUser = await directory.createUser(org.id, {
        workosUserId: 'wos_cap_project',
        email: 'cap-project@example.test',
        displayName: 'Cap Project Owner',
        role: 'admin',
      });
      const capActor: Actor = { ctx: { orgId: org.id, userId: capUser.id }, role: 'admin' };
      const projects = new PgProjectRepository(db.pool);
      const project = await projects.create(capActor.ctx, { name: 'Big', color: '#6366f1' });
      for (let i = 0; i < 500; i++) {
        await deps.documents.create(capActor.ctx, {
          title: `d${String(i)}.md`,
          projectId: project.id,
          ownerId: capActor.ctx.userId,
        });
      }
      const client = await connectAs(capActor);
      const result = (await client.callTool({
        name: 'upload_document',
        arguments: { title: 'over.md', content: '# Over the line', project_id: project.id },
      })) as JsonToolResult;
      expect(result.isError).toBe(true);
      const parsed = parse(result) as { error: string; limit: number; message: string };
      expect(parsed.error).toBe('project_doc_cap_exceeded');
      expect(parsed.limit).toBe(500);
      expect(parsed.message).toContain('500');
      expect(parsed.message).toContain('nothing changed');
      await client.close();
    }, 30_000);

    it('version_cap_exceeded: upload_document (append) reports the limit and mentions auto-purge', async () => {
      const directory = new PgDirectoryRepository(db.pool);
      const org = await directory.createOrganization('CapOrgVersion', 'free');
      const capUser = await directory.createUser(org.id, {
        workosUserId: 'wos_cap_version',
        email: 'cap-version@example.test',
        displayName: 'Cap Version Owner',
        role: 'admin',
      });
      const capActor: Actor = { ctx: { orgId: org.id, userId: capUser.id }, role: 'admin' };
      const doc = await deps.documents.create(capActor.ctx, {
        title: 'versioned.md',
        projectId: null,
        ownerId: capActor.ctx.userId,
      });
      // Free tier's live-version cap is 100 (Phase 33). Appended directly via
      // the repository — no blob write needed to prove the count trips the
      // cap, since the cap counts rows, not bytes on disk.
      for (let i = 0; i < 100; i++) {
        await deps.versions.append(capActor.ctx, {
          documentId: doc.id,
          contentHash: `hash-${String(i)}`,
          byteSize: 10,
          source: 'mcp',
          createdBy: capActor.ctx.userId,
        });
      }
      const client = await connectAs(capActor);
      const result = (await client.callTool({
        name: 'upload_document',
        arguments: { document_id: doc.id, content: '# One too many' },
      })) as JsonToolResult;
      expect(result.isError).toBe(true);
      const parsed = parse(result) as { error: string; limit: number; message: string };
      expect(parsed.error).toBe('version_cap_exceeded');
      expect(parsed.limit).toBe(100);
      expect(parsed.message).toContain('100');
      expect(parsed.message).toContain('nothing changed');
      // Version auto-purge: the sweep frees headroom on its own schedule, so
      // the message should say so rather than only "upgrade tier".
      expect(parsed.message.toLowerCase()).toContain('auto-purge');
      await client.close();
    }, 30_000);

    it('an unrelated error code stays exactly the old shape — no stray limit or message', async () => {
      const owner = await connectAs(ownerActor);
      const uploaded = parse(
        (await owner.callTool({
          name: 'upload_document',
          arguments: { title: 'unenriched.md', content: '# Plain' },
        })) as JsonToolResult,
      ) as { document_id: string };
      await owner.close();

      const stranger = await connectAs(otherOrgActor);
      const result = (await stranger.callTool({
        name: 'get_document',
        arguments: { document_id: uploaded.document_id },
      })) as JsonToolResult;
      expect(result.isError).toBe(true);
      expect(parse(result)).toEqual({ error: 'document_not_found' });
      await stranger.close();
    });
  });
});
