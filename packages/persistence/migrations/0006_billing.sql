-- Phase 13: billing + free personal tier.
--
-- Billing lifecycle lives on the org row; the provider (Stripe) is behind a
-- port and only opaque ids are stored (Core Principle 3: no org data leaves,
-- provider ids never logged). last_activity_at feeds the idle free-org
-- lifecycle; it is bumped by uploads and comments, not reads.

alter table organizations
  add column subscription_status text not null default 'none'
    check (subscription_status in ('none', 'trialing', 'active', 'past_due', 'canceled_grace')),
  add column billing_customer_id text unique,
  add column trial_ends_at timestamptz,
  add column read_only_at timestamptz,
  add column purge_scheduled_at timestamptz,
  add column idle_warning_sent_at timestamptz,
  add column last_activity_at timestamptz not null default now();

-- Webhook idempotency ledger: the provider event id is the primary key, so a
-- redelivered webhook inserts nothing and is skipped. org_id is nullable —
-- events can reference customers we no longer know. System-processed (no
-- tenant on the call stack): provisioner role, RLS-free like org bootstrap.
create table billing_events (
  provider_event_id text primary key,
  org_id uuid references organizations (id) on delete set null,
  event_type text not null,
  processed_at timestamptz not null default now()
);

-- update(org_id): org purge unlinks the ledger (history stays, pointer nulled).
grant select, insert, update (org_id) on billing_events to mdloop_provisioner;
-- Webhook processing + lifecycle sweeps update org billing columns without a
-- tenant context, same trust boundary as org bootstrap.
grant update (
  tier, subscription_status, billing_customer_id, trial_ends_at,
  read_only_at, purge_scheduled_at, idle_warning_sent_at
) on organizations to mdloop_provisioner;
