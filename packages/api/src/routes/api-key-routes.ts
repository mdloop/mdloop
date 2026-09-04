import type { FastifyInstance } from 'fastify';
import type { ApiKey, ApiKeyRepository } from '@mdloop/app';
import { createApiKey, listApiKeys, revokeApiKey } from '@mdloop/app';
import { actorOf } from '../auth/actor.js';

function keyDto(k: ApiKey) {
  return {
    id: k.id,
    userId: k.userId,
    name: k.name,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
  };
}

export function registerApiKeyRoutes(server: FastifyInstance, keys: ApiKeyRepository): void {
  server.post<{ Body: { name: string } }>(
    '/api-keys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const result = await createApiKey(keys, actorOf(req), req.body.name);
      if (!result.ok) {
        const status = result.error.code === 'forbidden' ? 403 : 400;
        return reply.code(status).send({ error: result.error.code });
      }
      // The key appears in this response and never again — only its hash is stored.
      return reply.code(201).send({ key: result.value.key, record: keyDto(result.value.record) });
    },
  );

  server.get('/api-keys', async (req) => {
    const list = await listApiKeys(keys, actorOf(req));
    return { keys: list.map(keyDto) };
  });

  server.delete<{ Params: { id: string } }>('/api-keys/:id', async (req, reply) => {
    const result = await revokeApiKey(keys, actorOf(req), req.params.id);
    if (!result.ok) return reply.code(404).send({ error: result.error.code });
    return reply.code(204).send();
  });
}
