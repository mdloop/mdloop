import type { Organization } from '@mdloop/domain';

/**
 * Notified after a human joins an organization — invite accept or SSO
 * just-in-time join — with the org's new human member count.
 *
 * This exists because "someone joined, the headcount changed" is a fact the
 * core knows and other systems care about, while *what to do about it* is not
 * the core's business. A deployment might reconcile seats with an identity
 * provider, check a licence ceiling, emit a metric, notify an admin, or do
 * nothing at all. The core states the fact and stops there.
 *
 * The default is `NoopSeatSync`, so an instance that has no opinion configures
 * nothing and the join path behaves exactly as if this port did not exist.
 *
 * Note what is deliberately absent: any notion of billable seats, customers, or
 * subscriptions. The port reports the raw human member count and hands over the
 * whole `Organization`; deriving anything commercial from that — collapsing
 * members into billable units, resolving a payment-provider customer — belongs
 * to the adapter that cares, not here.
 */
export interface SeatSyncPort {
  /**
   * @param org The organization that was just joined.
   * @param humanMemberCount Members excluding guests, as the core counts them.
   *   Not a billing quantity — any such mapping is the adapter's to apply.
   */
  onSeatsChanged(org: Organization, humanMemberCount: number): Promise<void>;
}

/** The default: the core reports the join, nothing acts on it. */
export const NoopSeatSync: SeatSyncPort = {
  onSeatsChanged: () => Promise.resolve(),
};
