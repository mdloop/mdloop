import type { FastifyInstance } from 'fastify';
import type {
  DocumentRepository,
  OrganizationRepository,
  RoleDirectory,
  ShareGrantRepository,
  VersionRepository,
} from '@mdloop/app';
import { listTierPlans, orgUsage, setUserRole, updateOrgSettings } from '@mdloop/app';
import type { ProjectId, UserId } from '@mdloop/shared';
import { requireAdmin } from '../auth/guards.js';
import { actorOf } from '../auth/actor.js';

const settingsPatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    sharingMode: { enum: ['link', 'directory'] },
    retentionDays: { type: 'integer' },
    purgeImmediately: { type: 'boolean' },
    // Version auto-purge rule (ADR 0001); null resets to the tier default.
    versionRetention: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['keepLastN', 'keepDays'],
      properties: {
        keepLastN: { type: 'integer' },
        keepDays: { type: ['integer', 'null'] },
      },
    },
    // Enterprise SSO JIT mode (Phase 15); irrelevant without an sso_connection_id.
    provisioningMode: { enum: ['open', 'allowlist'] },
    // External guest sharing master switch (Phase 18).
    externalSharing: { type: 'boolean' },
    // Sign-off gate (Phase B, ADR 0002): soft (advisory) or hard (blocks approve).
    approvalGate: { enum: ['soft', 'hard'] },
    // Session ceiling (Phase 24): 1..24 hours, or null to reset to the 24h default.
    sessionMaxHours: { type: ['integer', 'null'], minimum: 1, maximum: 24 },
  },
} as const;

interface SettingsPatchBody {
  name?: string;
  sharingMode?: 'link' | 'directory';
  retentionDays?: number;
  purgeImmediately?: boolean;
  versionRetention?: { keepLastN: number; keepDays: number | null } | null;
  provisioningMode?: 'open' | 'allowlist';
  externalSharing?: boolean;
  approvalGate?: 'soft' | 'hard';
  sessionMaxHours?: number | null;
}

export interface OrgRouteDeps {
  orgs: OrganizationRepository & RoleDirectory;
  documents: DocumentRepository;
  versions: VersionRepository;
  grants: ShareGrantRepository;
}

export function registerOrgRoutes(server: FastifyInstance, deps: OrgRouteDeps): void {
  server.get('/org/settings', async (req, reply) => {
    const org = await deps.orgs.current(actorOf(req).ctx);
    if (!org) return reply.code(404).send({ error: 'org_not_found' });
    return {
      name: org.name,
      sharingMode: org.sharingMode,
      retentionDays: org.retentionDays,
      purgeImmediately: org.purgeImmediately,
      tier: org.tier,
      versionRetention: org.versionRetention,
      provisioningMode: org.provisioningMode,
      externalSharing: org.externalSharing,
      approvalGate: org.approvalGate,
      sessionMaxHours: org.sessionMaxHours,
      // Settings overview ledger (Phase 39.C) shows a "Created" row.
      createdAt: org.createdAt,
    };
  });

  server.patch<{ Body: SettingsPatchBody }>(
    '/org/settings',
    { preHandler: requireAdmin, schema: { body: settingsPatchSchema } },
    async (req, reply) => {
      const result = await updateOrgSettings(deps.orgs, actorOf(req), req.body);
      if (!result.ok) {
        const status = result.error.code === 'forbidden' ? 403 : 400;
        return reply.code(status).send({ error: result.error.code });
      }
      const org = result.value;
      return {
        name: org.name,
        sharingMode: org.sharingMode,
        retentionDays: org.retentionDays,
        purgeImmediately: org.purgeImmediately,
        tier: org.tier,
        versionRetention: org.versionRetention,
        provisioningMode: org.provisioningMode,
        externalSharing: org.externalSharing,
        approvalGate: org.approvalGate,
        // Was missing here while GET already returned it (bug found in the
        // Phase 39 settings-redesign audit) — masked only because the web
        // client re-fetches GET /org/settings after every successful patch.
        sessionMaxHours: org.sessionMaxHours,
        createdAt: org.createdAt,
      };
    },
  );

  server.patch<{ Params: { userId: string }; Body: { role: 'admin' | 'member' } }>(
    '/org/users/:userId/role',
    {
      preHandler: requireAdmin,
      schema: {
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: { role: { enum: ['admin', 'member'] } },
        },
      },
    },
    async (req, reply) => {
      const result = await setUserRole(
        deps.orgs,
        actorOf(req),
        req.params.userId as UserId,
        req.body.role,
      );
      if (!result.ok) {
        const status =
          result.error.code === 'forbidden'
            ? 403
            : result.error.code === 'user_not_found'
              ? 404
              : 400;
        return reply.code(status).send({ error: result.error.code });
      }
      return reply.code(204).send();
    },
  );

  // Any org member may read usage (not admin-only): it informs an admin
  // sending an invite, but read-only usage numbers aren't sensitive within
  // the org itself. `null` ceilings mean the tier has no cap on that lane.
  server.get<{ Querystring: { projectId?: string } }>('/org/usage', async (req, reply) => {
    const result = await orgUsage(
      deps.orgs,
      deps.documents,
      deps.versions,
      deps.grants,
      actorOf(req),
      req.query.projectId as ProjectId | undefined,
    );
    if (!result.ok) return reply.code(404).send({ error: result.error.code });
    const usage = result.value;
    return {
      tier: usage.tier,
      activeDocCount: usage.activeDocCount,
      maxActiveDocs: usage.maxActiveDocs,
      memberCount: usage.memberCount,
      maxCollaborators: usage.maxCollaborators,
      storageBytes: usage.storageBytes,
      activeGuestCount: usage.activeGuestCount,
      maxExternalGuests: usage.maxExternalGuests,
      ...(usage.projectUsage ? { projectUsage: usage.projectUsage } : {}),
    };
  });

  // Plan-comparison data for all three tiers (Phase 39.B, relocated here
  // post-billing-removal), generated straight from TIER_PROFILES — the same
  // constant that enforces the ceilings — so this can never drift from
  // what's actually enforced. No admin gate: any signed-in member can see
  // what the tiers offer, same as /org/usage.
  server.get('/org/tiers', () => ({ tiers: listTierPlans() }));
}
