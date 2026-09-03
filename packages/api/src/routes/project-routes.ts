import type { FastifyInstance } from 'fastify';
import type {
  DocumentRepository,
  OrganizationRepository,
  ProjectError,
  ProjectRepository,
  ProjectSharingError,
  ReviewRepository,
  ShareGrantRepository,
} from '@vorlyn/app';
import {
  createProject,
  createProjectGrant,
  deleteProject,
  listProjectGrants,
  projectTree,
  revokeProjectGrant,
  setProjectArchived,
  updateProject,
} from '@vorlyn/app';
import type { Project, ShareGrant } from '@vorlyn/domain';
import type { GrantId, ProjectId, UserId } from '@vorlyn/shared';
import { actorOf } from '../auth/actor.js';

export interface ProjectRouteDeps {
  projects: ProjectRepository;
  /** The workspace tree (Phase 29) reads documents + their review rollup. */
  documents: DocumentRepository;
  reviews: ReviewRepository;
  /** Project sharing (ADR 0014, Phase 42). */
  grants: ShareGrantRepository;
  organizations: OrganizationRepository;
}

function projectDto(p: Project) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    // Phase 24: the web menu gates edit/delete on me.id === createdBy || admin.
    createdBy: p.createdBy,
    archivedAt: p.archivedAt,
    createdAt: p.createdAt,
  };
}

function projectGrantDto(g: ShareGrant) {
  return {
    id: g.id,
    grantee: g.grantee,
    permission: g.permission,
    createdBy: g.createdBy,
    createdAt: g.createdAt,
  };
}

const errorStatus: Record<ProjectError['code'], number> = {
  invalid_name: 400,
  invalid_color: 400,
  forbidden: 403,
  project_not_found: 404,
};

const shareErrorStatus: Record<ProjectSharingError['code'], number> = {
  project_not_found: 404,
  forbidden: 403,
  grant_not_found: 404,
  guest_edit_forbidden: 403,
};

export function registerProjectRoutes(server: FastifyInstance, deps: ProjectRouteDeps): void {
  const projects = deps.projects;
  server.post<{ Body: { name: string; color?: string } }>(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string' }, color: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const result = await createProject(projects, actorOf(req), req.body);
      if (!result.ok)
        return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
      return reply.code(201).send(projectDto(result.value));
    },
  );

  server.get('/projects', async (req) => {
    const list = await projects.list(actorOf(req).ctx);
    return { projects: list.map(projectDto) };
  });

  server.patch<{
    Params: { id: string };
    Body: { name?: string; color?: string; archived?: boolean };
  }>(
    '/projects/:id',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            color: { type: 'string' },
            archived: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const id = req.params.id as ProjectId;
      if (req.body.name !== undefined || req.body.color !== undefined) {
        const updated = await updateProject(projects, actor, id, {
          ...(req.body.name !== undefined ? { name: req.body.name } : {}),
          ...(req.body.color !== undefined ? { color: req.body.color } : {}),
        });
        if (!updated.ok) {
          return reply.code(errorStatus[updated.error.code]).send({ error: updated.error.code });
        }
      }
      if (req.body.archived !== undefined) {
        const archived = await setProjectArchived(projects, actor, id, req.body.archived);
        if (!archived.ok) {
          return reply.code(errorStatus[archived.error.code]).send({ error: archived.error.code });
        }
      }
      const project = await projects.byId(actor.ctx, id);
      if (!project) return reply.code(404).send({ error: 'project_not_found' });
      return projectDto(project);
    },
  );

  /**
   * The project's workspace file tree (Phase 29) — a FLAT array; the client
   * splits `path` on `/` and builds the hierarchy, because nesting is a
   * rendering decision and the server should not have to agree with the client
   * about collapse state or ordering.
   *
   * Unpaged by design, unlike `GET /overview`: a folder's aggregated
   * open-comment count is only honest over the whole project, and aggregating
   * over a 50-row page would under-report every folder past the first one. The
   * bound is `tooLarge` instead — over ~2000 live documents the payload is
   * refused and the lane falls back to the paged flat list.
   *
   * Read-only, and no permission semantics beyond "can you read this project's
   * documents": the same owner/grant/admin scoping `/overview` applies, with
   * RLS underneath. A project in another org simply does not resolve → 404.
   */
  server.get<{ Params: { id: string } }>('/projects/:id/tree', async (req, reply) => {
    const result = await projectTree(
      deps.documents,
      projects,
      deps.reviews,
      actorOf(req),
      req.params.id as ProjectId,
    );
    if (!result.ok) return reply.code(404).send({ error: result.error.code });
    return result.value;
  });

  server.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const result = await deleteProject(projects, actorOf(req), req.params.id as ProjectId);
    if (!result.ok)
      return reply.code(errorStatus[result.error.code]).send({ error: result.error.code });
    return reply.code(204).send();
  });

  /**
   * Project-level sharing (ADR 0014, Phase 42) — org admin only. A grant here
   * confers its permission on every document currently in the project; see
   * `createProjectGrant`'s doc comment for why this is deliberately narrower
   * than document sharing (owner/admin/share-holder).
   */
  server.post<{
    Params: { id: string };
    Body: { userId: string; permission: 'read' | 'comment' | 'share' | 'edit' };
  }>(
    '/projects/:id/shares',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId', 'permission'],
          additionalProperties: false,
          properties: {
            userId: { type: 'string' },
            permission: { enum: ['read', 'comment', 'share', 'edit'] },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await createProjectGrant(
        projects,
        deps.grants,
        deps.organizations,
        actorOf(req),
        req.params.id as ProjectId,
        req.body.userId as UserId,
        req.body.permission,
      );
      if (!result.ok) {
        return reply.code(shareErrorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(201).send({ grant: projectGrantDto(result.value) });
    },
  );

  server.get<{ Params: { id: string } }>('/projects/:id/shares', async (req, reply) => {
    const result = await listProjectGrants(
      projects,
      deps.grants,
      actorOf(req),
      req.params.id as ProjectId,
    );
    if (!result.ok) {
      return reply.code(shareErrorStatus[result.error.code]).send({ error: result.error.code });
    }
    return { grants: result.value.map(projectGrantDto) };
  });

  server.delete<{ Params: { id: string; grantId: string } }>(
    '/projects/:id/shares/:grantId',
    async (req, reply) => {
      const result = await revokeProjectGrant(
        projects,
        deps.grants,
        actorOf(req),
        req.params.id as ProjectId,
        req.params.grantId as GrantId,
      );
      if (!result.ok) {
        return reply.code(shareErrorStatus[result.error.code]).send({ error: result.error.code });
      }
      return reply.code(204).send();
    },
  );
}
