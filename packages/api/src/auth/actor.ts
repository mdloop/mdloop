import type { FastifyRequest } from 'fastify';
import type { Actor } from '@mdloop/app';

/**
 * The session guard attaches the actor before any protected handler runs;
 * this accessor makes that contract explicit instead of sprinkling
 * non-null assertions through route code.
 */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new Error('route registered outside the session guard');
  return req.actor;
}
