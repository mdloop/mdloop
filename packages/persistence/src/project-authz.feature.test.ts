import { fileURLToPath } from 'node:url';
import { describeFeature, loadFeature } from '@amiceli/vitest-cucumber';
import { expect } from 'vitest';
import type { Actor } from '@vorlyn/app';
import { createProject, deleteProject, updateProject } from '@vorlyn/app';
import type { Project } from '@vorlyn/domain';
import type { OrgId, Result } from '@vorlyn/shared';
import { withTenant } from './db.js';
import {
  PgDirectoryRepository,
  PgDocumentRepository,
  PgProjectRepository,
} from './repositories/pg-repositories.js';
import { createTestDb } from './test-support/test-db.js';
import type { TestDb } from './test-support/test-db.js';

const feature = await loadFeature(
  fileURLToPath(new URL('../../../features/project-authz.feature', import.meta.url)),
);

interface World {
  db: TestDb;
  projects: PgProjectRepository;
  documents: PgDocumentRepository;
  orgId: OrgId;
  alice: Actor;
  bob: Actor;
  carol: Actor;
  project: Project;
  lastResult: Result<unknown, { code: string }>;
}

const w = {} as World;

async function makeActor(
  directory: PgDirectoryRepository,
  orgId: OrgId,
  name: string,
  role: 'admin' | 'member',
): Promise<Actor> {
  const user = await directory.createUser(orgId, {
    workosUserId: `wos-${name}-${crypto.randomUUID()}`,
    email: `${name}@example.test`,
    displayName: name,
    role,
  });
  return { ctx: { orgId, userId: user.id }, role };
}

describeFeature(feature, ({ Background, Scenario, AfterAllScenarios }) => {
  AfterAllScenarios(async () => {
    await w.db.close();
  });

  Background(({ Given }) => {
    Given('an organization "acme" with admin "alice" and members "bob" and "carol"', async () => {
      if (!(w as Partial<World>).db) {
        w.db = await createTestDb();
        w.projects = new PgProjectRepository(w.db.pool);
        w.documents = new PgDocumentRepository(w.db.pool);
      }
      const directory = new PgDirectoryRepository(w.db.pool);
      const acme = await directory.createOrganization('acme');
      w.orgId = acme.id;
      w.alice = await makeActor(directory, acme.id, 'alice', 'admin');
      w.bob = await makeActor(directory, acme.id, 'bob', 'member');
      w.carol = await makeActor(directory, acme.id, 'carol', 'member');
    });
  });

  Scenario('A member manages their own project', ({ Given, When, Then }) => {
    Given('"bob" created a project "runbooks"', async () => {
      const r = await createProject(w.projects, w.bob, { name: 'runbooks' });
      if (!r.ok) throw new Error('setup');
      w.project = r.value;
    });
    When('"bob" renames "runbooks" to "ops-runbooks"', async () => {
      w.lastResult = await updateProject(w.projects, w.bob, w.project.id, {
        name: 'ops-runbooks',
      });
    });
    Then('the rename succeeds', () => {
      expect(w.lastResult.ok).toBe(true);
    });
  });

  Scenario("A member cannot mutate another member's project", ({ Given, When, Then }) => {
    Given('"bob" created a project "runbooks"', async () => {
      const r = await createProject(w.projects, w.bob, { name: 'runbooks' });
      if (!r.ok) throw new Error('setup');
      w.project = r.value;
    });
    When('"carol" tries to rename "runbooks" to "mine-now"', async () => {
      w.lastResult = await updateProject(w.projects, w.carol, w.project.id, { name: 'mine-now' });
    });
    Then('the rename is refused as forbidden', () => {
      expect(!w.lastResult.ok && w.lastResult.error.code).toBe('forbidden');
    });
    When('"carol" tries to delete "runbooks"', async () => {
      w.lastResult = await deleteProject(w.projects, w.carol, w.project.id);
    });
    Then('the delete is refused as forbidden', () => {
      expect(!w.lastResult.ok && w.lastResult.error.code).toBe('forbidden');
    });
  });

  Scenario('An admin can manage any project', ({ Given, When, Then }) => {
    Given('"bob" created a project "runbooks"', async () => {
      const r = await createProject(w.projects, w.bob, { name: 'runbooks' });
      if (!r.ok) throw new Error('setup');
      w.project = r.value;
      // File a document under the project so delete has something to unfile.
      await withTenant(w.db.pool, w.bob.ctx, async (c) => {
        await c.query(
          `insert into documents (org_id, project_id, owner_id, title)
           values ($1, $2, $3, 'doc.md')`,
          [w.orgId, w.project.id, w.bob.ctx.userId],
        );
      });
    });
    When('"alice" deletes "runbooks"', async () => {
      w.lastResult = await deleteProject(w.projects, w.alice, w.project.id);
    });
    Then('the project is gone and its documents are unfiled', async () => {
      expect(w.lastResult.ok).toBe(true);
      expect(await w.projects.byId(w.alice.ctx, w.project.id)).toBeUndefined();
      const docs = await w.documents.list(w.alice.ctx);
      expect(docs.every((d) => d.projectId === null)).toBe(true);
    });
  });

  Scenario('A project with no recorded creator is admin-only', ({ Given, When, Then }) => {
    Given('a project "legacy" with no recorded creator', async () => {
      // Pre-migration rows have created_by NULL — insert one directly.
      const id = await withTenant(w.db.pool, w.alice.ctx, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `insert into projects (org_id, name, color) values ($1, 'legacy', '#6366f1')
           returning id`,
          [w.orgId],
        );
        return rows[0]?.id as Project['id'];
      });
      const project = await w.projects.byId(w.alice.ctx, id);
      if (!project) throw new Error('setup');
      w.project = project;
    });
    When('"bob" tries to rename "legacy" to "claimed"', async () => {
      w.lastResult = await updateProject(w.projects, w.bob, w.project.id, { name: 'claimed' });
    });
    Then('the request is refused as forbidden', () => {
      expect(!w.lastResult.ok && w.lastResult.error.code).toBe('forbidden');
    });
    When('"alice" renames "legacy" to "migrated"', async () => {
      w.lastResult = await updateProject(w.projects, w.alice, w.project.id, { name: 'migrated' });
    });
    Then('the rename succeeds', () => {
      expect(w.lastResult.ok).toBe(true);
    });
  });
});
