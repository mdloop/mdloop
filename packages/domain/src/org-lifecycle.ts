import type { Organization } from './entities.js';

/**
 * Is this organization frozen for writes?
 *
 * Reads, export and sign-in stay open; every mutation path refuses with
 * `org_read_only`. The point is that an org can be suspended without its data
 * becoming unreachable — a customer in a cancellation grace window, a tenant
 * under a compliance hold, an instance paused for maintenance, all need to get
 * their content *out* while being unable to put more *in*.
 *
 * The core owns the lock and the gate; it deliberately does not own the
 * decision to engage it. Nothing here ever writes `readOnlyAt` — a deployment
 * sets it for whatever reason it has, and the core simply honours it. That
 * split is why this is a core concept and not a billing one: the reason is
 * situational, the enforcement is universal.
 */
export function orgIsWriteLocked(org: Organization): boolean {
  return org.readOnlyAt !== null;
}
