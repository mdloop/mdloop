import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Actor, RateLimitError, RateLimiterPort } from '@vorlyn/app';
import { UserRateLimiter } from '@vorlyn/app';
import { NoopTelemetry } from '@vorlyn/app/test-support';
import type { RateLimitState, Tier } from '@vorlyn/domain';
import { TIER_PROFILES, consumeRequest } from '@vorlyn/domain';
import type { Result, UserId } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';
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
  RedisRateLimiter,
} from '@vorlyn/persistence';
import { createTestDb, createTestRedis } from '@vorlyn/persistence/test-support';
import type { TestDb, TestRedis } from '@vorlyn/persistence/test-support';
import type { McpDeps } from './server.js';
import { buildMcpServer } from './server.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/rate-limit-parity.feature', import.meta.url)),
);

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * A `RateLimiterPort` pre-seeded with a specific `RateLimitState` for one
 * user — used only by the day/month scenarios below, so proving a
 * many-thousands-request window doesn't need that many real MCP round
 * trips. Wraps the real `consumeRequest` (no reimplemented rate-limit
 * logic, unlike `UserRateLimiter`/`RedisRateLimiter` it doesn't own a Map or
 * a store) — it just starts from a chosen state instead of the zeroed one
 * `initialRateLimitState` would give. The exact boundary arithmetic is
 * already covered by packages/domain/src/rate-limit.test.ts; this proves
 * the day/month rejection reaches the real MCP surface with the right typed
 * error, not the arithmetic itself.
 */
class SeededRateLimiter implements RateLimiterPort {
  constructor(
    private readonly userId: UserId,
    private state: RateLimitState,
  ) {}

  check(userId: UserId, tier: Tier): Promise<Result<void, RateLimitError>> {
    if (userId !== this.userId) {
      throw new Error('SeededRateLimiter is single-user, seeded for one specific test actor');
    }
    const profile = TIER_PROFILES[tier].ceilings.rateLimit;
    const decision = consumeRequest(this.state, profile, Date.now());
    this.state = decision.state;
    if (!decision.allowed) {
      return Promise.resolve(
        err({ code: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds }),
      );
    }
    return Promise.resolve(ok(undefined));
  }
}

describeFeature(feature, ({ Scenario, AfterAllScenarios }) => {
  let db: TestDb;
  let client: Client;
  let storageDir: string;
  let limited: { error: string; retryAfterSeconds: number } | undefined;
  // Test-owned clock so "the budget refills" needs no wall-clock waiting.
  let nowMs = Date.parse('2026-07-13T00:00:00Z');

  let redis: TestRedis | undefined;
  const storageDirs: string[] = [];
  const extraDbs: TestDb[] = [];

  AfterAllScenarios(async () => {
    await db.close();
    await rm(storageDir, { recursive: true, force: true });
    if (redis) await redis.close();
    await Promise.all(extraDbs.map((extraDb) => extraDb.close()));
    await Promise.all(storageDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function callListDocuments(onClient: Client = client): Promise<ToolResult> {
    return (await onClient.callTool({ name: 'list_documents', arguments: {} })) as ToolResult;
  }

  /**
   * One MCP server + linked in-memory client for a given actor, sharing
   * `testDb` and whichever `RateLimiterPort` the caller supplies — used
   * directly by scenario one (its own `UserRateLimiter`) and by scenario
   * two to build two independent "replicas" (two distinct `RateLimiterPort`
   * instances) plus a second actor sharing replica two's instance, since a
   * real deployed instance routes every user's requests through the one
   * limiter object it constructed at boot, not a per-user instance.
   */
  async function buildServerAndClient(
    testDb: TestDb,
    actor: Actor,
    rateLimiter: RateLimiterPort,
  ): Promise<Client> {
    const dir = await mkdtemp(path.join(tmpdir(), 'vorlyn-parity-'));
    storageDirs.push(dir);
    const deps: McpDeps = {
      documents: new PgDocumentRepository(testDb.pool),
      projects: new PgProjectRepository(testDb.pool),
      versions: new PgVersionRepository(testDb.pool),
      comments: new PgCommentRepository(testDb.pool),
      reviews: new PgReviewRepository(testDb.pool),
      resolutions: new PgAnchorResolutionRepository(testDb.pool),
      grants: new PgShareGrantRepository(testDb.pool),
      organizations: new PgOrganizationRepository(testDb.pool),
      uploadUow: new PgUploadUnitOfWork(testDb.pool),
      storage: new FsStorage(dir),
      apiKeys: new PgApiKeyRepository(testDb.pool),
      search: new PgSearchRepository(testDb.pool),
      telemetry: new NoopTelemetry(),
      userRateLimiter: rateLimiter,
    };
    const server = buildMcpServer(deps, actor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: 'test-agent', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);
    return newClient;
  }

  Scenario(
    'MCP tool calls beyond the budget return the identical typed error',
    ({ Given, When, Then, And }) => {
      Given('organization "Acme" on the free tier with an agent acting as "alice"', async () => {
        db = await createTestDb();
        const directory = new PgDirectoryRepository(db.pool);
        const org = await directory.createOrganization('Acme');
        await db.pool.query(`update organizations set tier = 'free' where id = $1`, [org.id]);
        const alice = await directory.createUser(org.id, {
          workosUserId: 'wos_alice',
          email: 'alice@acme.test',
          displayName: 'Alice',
          role: 'member',
        });
        const actor: Actor = { ctx: { orgId: org.id, userId: alice.id }, role: 'member' };
        storageDir = await mkdtemp(path.join(tmpdir(), 'vorlyn-parity-'));
        const deps: McpDeps = {
          documents: new PgDocumentRepository(db.pool),
          projects: new PgProjectRepository(db.pool),
          versions: new PgVersionRepository(db.pool),
          comments: new PgCommentRepository(db.pool),
          reviews: new PgReviewRepository(db.pool),
          resolutions: new PgAnchorResolutionRepository(db.pool),
          grants: new PgShareGrantRepository(db.pool),
          organizations: new PgOrganizationRepository(db.pool),
          uploadUow: new PgUploadUnitOfWork(db.pool),
          storage: new FsStorage(storageDir),
          apiKeys: new PgApiKeyRepository(db.pool),
          search: new PgSearchRepository(db.pool),
          telemetry: new NoopTelemetry(),
          userRateLimiter: new UserRateLimiter(() => nowMs),
        };
        const server = buildMcpServer(deps, actor);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        client = new Client({ name: 'test-agent', version: '0.0.1' });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      });
      When('the agent calls tools past the free per-minute budget', async () => {
        limited = undefined;
        for (let i = 0; i < 61; i++) {
          const result = await callListDocuments();
          if (result.isError) {
            limited = JSON.parse(result.content[0]?.text ?? '{}') as typeof limited;
            break;
          }
        }
      });
      Then('the tool result is the typed error "rate_limited" with a retry hint', () => {
        // The exact shape the HTTP API sends with its 429 (parity).
        expect(limited).toEqual({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) });
      });
      And('tool calls succeed again once the budget refills', async () => {
        nowMs += 60_000;
        const result = await callListDocuments();
        expect(result.isError ?? false).toBe(false);
      });
    },
  );

  Scenario(
    'The budget is shared across replicas, not per-process',
    ({ Given, When, Then, And }) => {
      let bobOnReplicaOne: Client;
      let bobOnReplicaTwo: Client;
      let carolOnReplicaTwo: Client;
      let replicaTwoResultForBob: ToolResult;

      // Real work is split across this step and the And step below (rather
      // than all crammed into this one) so each step's name stays an honest
      // description of what it does — vitest-cucumber runs them in order, and
      // the And step needs `redis` to already exist to build both replicas'
      // limiters.
      Given('organization "Acme" on the free tier with an agent acting as "bob"', async () => {
        redis = await createTestRedis();
      });
      And(
        'two simulated MCP replicas, each with its own RateLimiterPort backed by the same Valkey store',
        async () => {
          if (!redis) throw new Error('redis must be created in the prior step');
          const testDb = await createTestDb();
          extraDbs.push(testDb);
          const directory = new PgDirectoryRepository(testDb.pool);
          const org = await directory.createOrganization('Acme');
          await testDb.pool.query(`update organizations set tier = 'free' where id = $1`, [org.id]);
          const bob = await directory.createUser(org.id, {
            workosUserId: 'wos_bob',
            email: 'bob@acme.test',
            displayName: 'Bob',
            role: 'member',
          });
          const carol = await directory.createUser(org.id, {
            workosUserId: 'wos_carol',
            email: 'carol@acme.test',
            displayName: 'Carol',
            role: 'member',
          });
          const bobActor: Actor = { ctx: { orgId: org.id, userId: bob.id }, role: 'member' };
          const carolActor: Actor = { ctx: { orgId: org.id, userId: carol.id }, role: 'member' };

          // Two distinct RedisRateLimiter *objects* — each stands in for one
          // deployed instance's own limiter instance, both pointed at the
          // same real Valkey. If the budget were still in-process (the bug this
          // whole feature exists to fix), replica two's object would have its
          // own independent budget for bob and never see replica one's usage.
          const replicaOneLimiter = new RedisRateLimiter(redis.client, () => nowMs);
          const replicaTwoLimiter = new RedisRateLimiter(redis.client, () => nowMs);

          bobOnReplicaOne = await buildServerAndClient(testDb, bobActor, replicaOneLimiter);
          bobOnReplicaTwo = await buildServerAndClient(testDb, bobActor, replicaTwoLimiter);
          // Carol shares replica two's limiter *object* — a real replica
          // routes every user through the one limiter it constructed at
          // boot, not a fresh instance per request.
          carolOnReplicaTwo = await buildServerAndClient(testDb, carolActor, replicaTwoLimiter);
        },
      );
      When('"bob" calls tools on replica one until the budget is exhausted', async () => {
        for (let i = 0; i < 61; i++) {
          const result = await callListDocuments(bobOnReplicaOne);
          if (result.isError) break;
        }
      });
      Then('a call on replica two for the same user is also rate-limited', async () => {
        replicaTwoResultForBob = await callListDocuments(bobOnReplicaTwo);
        expect(replicaTwoResultForBob.isError).toBe(true);
        const body = JSON.parse(replicaTwoResultForBob.content[0]?.text ?? '{}') as {
          error: string;
        };
        expect(body).toEqual({ error: 'rate_limited', retryAfterSeconds: expect.any(Number) });
      });
      And('a call on replica two for a different user still succeeds', async () => {
        const result = await callListDocuments(carolOnReplicaTwo);
        expect(result.isError ?? false).toBe(false);
      });
    },
  );

  Scenario(
    'The daily cap still fires on its own, with the monthly budget untouched',
    ({ Given, And, When, Then }) => {
      let carolClient: Client;
      let carolResult: ToolResult;

      Given('organization "Acme" on the free tier with an agent acting as "carol"', async () => {
        const testDb = await createTestDb();
        extraDbs.push(testDb);
        const directory = new PgDirectoryRepository(testDb.pool);
        const org = await directory.createOrganization('Acme');
        await testDb.pool.query(`update organizations set tier = 'free' where id = $1`, [org.id]);
        const carol = await directory.createUser(org.id, {
          workosUserId: 'wos_carol_day',
          email: 'carol.day@acme.test',
          displayName: 'Carol',
          role: 'member',
        });
        const carolActor: Actor = { ctx: { orgId: org.id, userId: carol.id }, role: 'member' };
        // Free tier: day=2500, month=7500 (day = month/3). Seeded at the day
        // cap with the month barely touched, proving day fires on its own
        // rather than being unreachable dead weight now that month exists.
        const seedNowMs = Date.now();
        const seeded: RateLimitState = {
          tokens: 60,
          lastRefillMs: seedNowMs,
          dayCount: 2500,
          dayStartMs: seedNowMs,
          monthCount: 1,
          monthStartMs: seedNowMs,
        };
        carolClient = await buildServerAndClient(
          testDb,
          carolActor,
          new SeededRateLimiter(carol.id, seeded),
        );
      });
      And(
        '"carol" has already used her full daily budget but almost none of her monthly budget',
        () => {
          // Setup only — the seeded state above already encodes this.
        },
      );
      When('the agent calls a tool', async () => {
        carolResult = await callListDocuments(carolClient);
      });
      Then(
        'the tool result is the typed error "rate_limited" with a retry hint under 24 hours',
        () => {
          expect(carolResult.isError).toBe(true);
          const body = JSON.parse(carolResult.content[0]?.text ?? '{}') as {
            error: string;
            retryAfterSeconds: number;
          };
          expect(body.error).toBe('rate_limited');
          expect(body.retryAfterSeconds).toBeGreaterThan(0);
          expect(body.retryAfterSeconds).toBeLessThanOrEqual(24 * 3600);
        },
      );
    },
  );

  Scenario(
    'The monthly cap fires even with a fresh day and a full minute bucket',
    ({ Given, And, When, Then }) => {
      let danaClient: Client;
      let danaResult: ToolResult;

      Given('organization "Acme" on the free tier with an agent acting as "dana"', async () => {
        const testDb = await createTestDb();
        extraDbs.push(testDb);
        const directory = new PgDirectoryRepository(testDb.pool);
        const org = await directory.createOrganization('Acme');
        await testDb.pool.query(`update organizations set tier = 'free' where id = $1`, [org.id]);
        const dana = await directory.createUser(org.id, {
          workosUserId: 'wos_dana_month',
          email: 'dana.month@acme.test',
          displayName: 'Dana',
          role: 'member',
        });
        const danaActor: Actor = { ctx: { orgId: org.id, userId: dana.id }, role: 'member' };
        // Free tier month=7500, exhausted; day/minute both fresh — proves
        // month binds on its own even when neither of the other two windows
        // would reject, i.e. it's a real, independent constraint, not just
        // a formality that day always trips first.
        const seedNowMs = Date.now();
        const seeded: RateLimitState = {
          tokens: 60,
          lastRefillMs: seedNowMs,
          dayCount: 0,
          dayStartMs: seedNowMs,
          monthCount: 7500,
          monthStartMs: seedNowMs,
        };
        danaClient = await buildServerAndClient(
          testDb,
          danaActor,
          new SeededRateLimiter(dana.id, seeded),
        );
      });
      And('"dana" has already used her full monthly budget but her daily budget just reset', () => {
        // Setup only — the seeded state above already encodes this.
      });
      When('the agent calls a tool', async () => {
        danaResult = await callListDocuments(danaClient);
      });
      Then(
        'the tool result is the typed error "rate_limited" with a retry hint near 30 days',
        () => {
          expect(danaResult.isError).toBe(true);
          const body = JSON.parse(danaResult.content[0]?.text ?? '{}') as {
            error: string;
            retryAfterSeconds: number;
          };
          expect(body.error).toBe('rate_limited');
          // Clearly a monthly-scale retry, not a daily one.
          expect(body.retryAfterSeconds).toBeGreaterThan(24 * 3600);
          expect(body.retryAfterSeconds).toBeLessThanOrEqual(30 * 24 * 3600);
        },
      );
    },
  );
});
