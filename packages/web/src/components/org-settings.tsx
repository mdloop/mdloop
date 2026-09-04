import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api/client.js';
import { errorCopy } from '../api/error-copy.js';
import { fmtDateWithYear, humanBytes } from '../format.js';
import type {
  AllowlistEntryDto,
  ApiKeyDto,
  InviteDto,
  Me,
  OrgSettingsDto,
  OrgUsageDto,
  OrgUserDto,
  PublicHubDocDto,
  TierPlanDto,
} from '../api/client.js';
import { AppHeader } from './app-header.js';
import { Badge } from './badge.js';
import type { BadgeTone } from './badge.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { DataTable } from './data-table.js';
import type { DataTableColumn } from './data-table.js';
import { Meter } from './meter.js';
import { Record as RecordLedger } from './record.js';
import { SettingsLayout } from './settings-layout.js';
import type { SettingsRailGroup } from './settings-layout.js';
import { Tooltip } from './tooltip.js';
import type { ThemeMode } from '../theme.js';
import { IconCheck, IconCopy, IconPlus, IconTrash } from './icons.js';

/* Every org-wide action on this screen is admin-gated, so a bare `forbidden`
   there always means the same specific thing — worth saying, where the shared
   map has to stay generic for the surfaces where it doesn't. The API-key
   section below is *not* admin-gated and carries its own overrides. */
const ORG_ADMIN_ERRORS: Readonly<Record<string, string>> = {
  forbidden: 'You need admin access to do that.',
  cannot_demote_self: "You can't change your own role — ask another admin.",
  user_not_found: 'That member could not be found — refresh and try again.',
  invalid_retention_days: 'Enter a whole number of days, 0 to 365.',
  invalid_version_retention: 'Enter a whole number of versions and a whole number of days.',
  version_retention_exceeds_tier_ceiling:
    "That's more history than your plan keeps — lower the number, or upgrade.",
};

/* API keys are per-person, not per-org: a member mints their own. The only
   identity the server refuses is a guest, which is a different sentence than
   "you need admin access". */
const API_KEY_ERRORS: Readonly<Record<string, string>> = {
  forbidden: 'Your account cannot hold API keys.',
  invalid_name: 'Give the key a name first.',
};

export interface OrgSettingsProps {
  me: Me;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  onBack: () => void;
  onOpenDocument: (id: string) => void;
  onLogout: () => void;
}

type OrgSection =
  'overview' | 'members' | 'access' | 'retention' | 'developer-keys' | 'developer-hub';

const TIER_LABEL: Readonly<Record<OrgSettingsDto['tier'], string>> = {
  free: 'Personal',
  team: 'Team',
  enterprise: 'Enterprise',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** `null` only occurs on a hypothetical unlimited ceiling — every tier's
 *  version-retention ceiling is finite as of 2026-08-13 — but this stays
 *  generic rather than assuming that never changes. Deliberately duplicated
 *  from the old `billing-panel.tsx`'s `fmtCeiling` (own comment there
 *  explained why: same precedent as `fmtDate` above) rather than shared,
 *  since a plan ceiling ("Custom") and a live usage lane ("Unlimited") are
 *  different vocabularies for the same `null`. */
function fmtPlanCeiling(n: number | null): string {
  return n === null ? 'Custom' : n.toLocaleString();
}

function inviteStatus(invite: InviteDto): { label: string; tone: BadgeTone } {
  if (invite.revokedAt) return { label: 'Revoked', tone: 'neutral' };
  if (invite.acceptedAt) return { label: 'Accepted', tone: 'resolved' };
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    return { label: 'Expired', tone: 'neutral' };
  }
  return { label: 'Pending', tone: 'signal' };
}

/**
 * Personal API keys — the credential `mdloop link` / `mdloop push` and MCP
 * clients present. Deliberately *not* admin-gated, unlike everything else on
 * this screen: a key belongs to a person, and the person who needs one is the
 * developer running the CLI. The server decides the visible set (own keys for
 * a member, the whole org for an admin), so this list never filters.
 *
 * The minted key is shown exactly once and then is genuinely unrecoverable —
 * only its hash is stored — so the reveal block mirrors the invite-token
 * idiom above it rather than inventing a second one.
 */
function ApiKeysSection({ me }: { me: Me }): JSX.Element {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [name, setName] = useState('');
  const [minted, setMinted] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyDto | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.listApiKeys();
    setKeys(res.keys);
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      setError('Could not load API keys.');
    });
  }, [refresh]);

  function submit(): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setError(null);
    setMinted(null);
    api
      .createApiKey(trimmed)
      .then(({ key, record }) => {
        setName('');
        setMinted({ name: record.name, key });
        setCopied(false);
        return refresh();
      })
      .catch((e: unknown) => {
        setError(
          errorCopy(e, { overrides: API_KEY_ERRORS, fallback: 'Could not create the key.' }),
        );
      });
  }

  function revoke(id: string): void {
    setError(null);
    api
      .revokeApiKey(id)
      .then(() => refresh())
      .catch((e: unknown) => {
        setError(
          errorCopy(e, { overrides: API_KEY_ERRORS, fallback: 'Could not revoke the key.' }),
        );
      });
  }

  // Yours first: an admin sees the whole org here, and the rows they actually
  // act on day to day are their own. Other people's rows carry no identity
  // beyond "another member" — this screen has no directory to resolve a
  // userId against, and a raw id on screen would be noise, not information.
  const sorted = [
    ...keys.filter((k) => k.userId === me.userId),
    ...keys.filter((k) => k.userId !== me.userId),
  ];

  return (
    <section className="settings-section" aria-labelledby="api-keys-heading">
      {pendingRevoke && (
        <ConfirmDialog
          title={`Revoke "${pendingRevoke.name}"?`}
          body="Anything still using this key — a CLI checkout, an agent — stops working immediately. Keys cannot be un-revoked."
          confirmLabel="Revoke"
          danger
          onConfirm={() => {
            revoke(pendingRevoke.id);
            setPendingRevoke(null);
          }}
          onCancel={() => {
            setPendingRevoke(null);
          }}
        />
      )}
      <div className="settings-section-head">
        <h3 id="api-keys-heading">API keys</h3>
        <p className="help-text">
          A key lets the <code>mdloop</code> CLI and MCP clients act as you. Run{' '}
          <code>mdloop link</code> in a repo and paste the key when it asks.{' '}
          {me.role === 'admin'
            ? 'As an admin you can see and revoke every key in the org.'
            : 'You can see and revoke your own keys.'}
        </p>
        <details className="settings-install-help">
          <summary>Installing the CLI and the MCP integration</summary>
          <p>
            <strong>CLI</strong> — not yet published to a package registry; build{' '}
            <code>@mdloop/cli</code> from source (
            <code>pnpm install &amp;&amp; pnpm typecheck</code>) and put{' '}
            <code>packages/cli/dist/main.js</code> on your <code>PATH</code> (or export{' '}
            <code>MDLOOP_CLI_PATH</code>). Full flag reference: the CLI reference doc.
          </p>
          <p>
            <strong>MCP</strong> — for Claude Code, install the <code>mdloop-sync</code> plugin (see
            the plugin&apos;s README for the marketplace command); any other MCP-compatible client
            can connect directly to this org&apos;s MCP endpoint, using a key from below as the
            bearer token. Full tool reference: the MCP reference doc.
          </p>
        </details>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <form
        className="invite-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          placeholder="Laptop, CI, review agent…"
          aria-label="Name for the new API key"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <button type="submit" className="btn btn-primary" title="Create API key">
          <IconPlus size={14} />
          Create key
        </button>
      </form>

      {minted && (
        <div className="share-token" data-testid="api-key-token">
          <p>
            Key for {minted.name} — copy it now. This is the only time it can be shown; we store
            only a hash of it.
          </p>
          <code>{minted.key}</code>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              title="Copy API key"
              onClick={() => {
                void navigator.clipboard.writeText(minted.key).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
              {copied ? 'Copied' : 'Copy key'}
            </button>
          </div>
        </div>
      )}

      <ul className="invite-list" data-testid="api-key-list">
        {sorted.map((key) => (
          <li key={key.id} className="invite-row">
            <span className="invite-email">{key.name}</span>
            <span className="doc-meta">
              {key.userId === me.userId ? 'Yours' : 'Another member'}
            </span>
            <span className="doc-meta">created {fmtDate(key.createdAt)}</span>
            <span className="doc-meta">
              {key.lastUsedAt ? `last used ${fmtDate(key.lastUsedAt)}` : 'never used'}
            </span>
            {key.revokedAt ? (
              <Badge tone="neutral">Revoked</Badge>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                title={`Revoke ${key.name}`}
                onClick={() => {
                  setPendingRevoke(key);
                }}
              >
                <IconTrash size={14} />
                Revoke
              </button>
            )}
          </li>
        ))}
        {keys.length === 0 && (
          <li className="doc-meta">No API keys yet — create one above to use the CLI.</li>
        )}
      </ul>
    </section>
  );
}

/** Unpublish is admin-only same as everything else on this screen, but the
 *  section can only ever render for an admin at a home-org anyway — this
 *  exists mostly so a stale/expired session gets readable copy, not a raw code. */
const PUBLIC_HUB_ERRORS: Readonly<Record<string, string>> = {
  forbidden: 'You need admin access to do that.',
};

/**
 * Public Docs Hub admin view (Phase 23) — read + unpublish only; publishing
 * itself lives per-document in `SharePanel` (picking a document by browsing
 * beats typing a raw document id into a settings screen). There is no
 * `publicHubOrgId` exposed to the frontend, so whether this org can publish
 * at all is discovered by calling `GET /public-hub/documents`: 200 means
 * this org is the hub's home org, 403 means "not applicable here" — the
 * common case for nearly every org, not an error, so no banner for it. This
 * effect only runs when `me.role === 'admin'` (checked by the caller), so a
 * `forbidden` here can only mean "not the home org", never "not an admin".
 */
function PublicHubSection(): JSX.Element | null {
  const [available, setAvailable] = useState(false);
  const [docs, setDocs] = useState<PublicHubDocDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingUnpublish, setPendingUnpublish] = useState<PublicHubDocDto | null>(null);

  const load = useCallback(async () => {
    const page = await api.listPublicHubDocs();
    setAvailable(true);
    setDocs(page.docs);
    setNextCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    load().catch(() => {
      // Not the home org (the expected, common case) — hide the section
      // entirely, no error banner.
      setAvailable(false);
    });
  }, [load]);

  function loadMore(): void {
    if (!nextCursor) return;
    api
      .listPublicHubDocs({ cursor: nextCursor })
      .then((page) => {
        setDocs((prev) => [...prev, ...page.docs]);
        setNextCursor(page.nextCursor);
      })
      .catch(() => {
        setError('Could not load more published docs.');
      });
  }

  function unpublish(doc: PublicHubDocDto): void {
    setError(null);
    api
      .unpublishFromPublicHub(doc.slug)
      .then(() => load())
      .catch((e: unknown) => {
        setError(
          errorCopy(e, { overrides: PUBLIC_HUB_ERRORS, fallback: 'Could not unpublish that doc.' }),
        );
      });
  }

  if (!available) return null;

  return (
    <section className="settings-section" aria-labelledby="public-hub-heading">
      {pendingUnpublish && (
        <ConfirmDialog
          title={`Unpublish "${pendingUnpublish.title}"?`}
          body="It will no longer be visible at its public hub link."
          confirmLabel="Unpublish"
          danger
          onConfirm={() => {
            unpublish(pendingUnpublish);
            setPendingUnpublish(null);
          }}
          onCancel={() => {
            setPendingUnpublish(null);
          }}
        />
      )}
      <div className="settings-section-head">
        <h3 id="public-hub-heading">Public docs hub</h3>
        <p className="help-text">
          Docs published here are visible to anyone with the link, no login required. Publish a
          document from its Share panel.
        </p>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <ul className="invite-list" data-testid="public-hub-list">
        {docs.map((doc) => (
          <li key={doc.id} className="invite-row">
            <span className="invite-email">{doc.title}</span>
            <span className="doc-meta">/{doc.slug}</span>
            <span className="doc-meta">v{doc.seq}</span>
            <span className="doc-meta">published {fmtDate(doc.publishedAt)}</span>
            <button
              type="button"
              className="btn btn-ghost btn-danger"
              title={`Unpublish ${doc.title}`}
              onClick={() => {
                setPendingUnpublish(doc);
              }}
            >
              <IconTrash size={14} />
              Unpublish
            </button>
          </li>
        ))}
        {docs.length === 0 && (
          <li className="doc-meta">
            Nothing published yet — publish a document from its Share panel.
          </li>
        )}
      </ul>

      {nextCursor && (
        <button
          type="button"
          className="btn load-more"
          title="Load more published docs"
          onClick={loadMore}
        >
          Load more
        </button>
      )}
    </section>
  );
}

/**
 * Org configuration screen. The org-wide sections (overview, members, access
 * & security, retention) are admin-only — backend is the source of truth for
 * every rule here, this is just the control surface — and non-admins are
 * told so. The API-key section is the one part everybody gets, since keys
 * are personal, not org-wide.
 *
 * Guests never reach this screen at all (app.tsx routes a guest session to
 * the viewer and nothing else), so there is no guest branch to write here.
 */
export function OrgSettings({
  me,
  mode,
  setMode,
  onBack,
  onOpenDocument,
  onLogout,
}: OrgSettingsProps): JSX.Element {
  const [section, setSection] = useState<OrgSection>('overview');
  const [settings, setSettings] = useState<OrgSettingsDto | null>(null);
  const [usage, setUsage] = useState<OrgUsageDto | null>(null);
  // This org's own row from GET /org/tiers — carries the version-history
  // ceiling and plan-default numbers the retention form seeds itself from.
  const [tierPlan, setTierPlan] = useState<TierPlanDto | null>(null);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [allowlist, setAllowlist] = useState<AllowlistEntryDto[]>([]);
  const [members, setMembers] = useState<OrgUserDto[]>([]);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [orgName, setOrgName] = useState('');

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [mintedInvite, setMintedInvite] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<
    | { kind: 'invite'; id: string; email: string }
    | { kind: 'allowlist'; id: string; email: string }
    | null
  >(null);

  const [allowlistEmail, setAllowlistEmail] = useState('');
  // Empty string = the 24h global default (null); a number 1..24 shortens it.
  const [sessionHours, setSessionHours] = useState('');
  // Inline, field-local echo of a validation failure — alongside the
  // page-top banner (setError), not instead of it.
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Retention form state — mirrors the session-length idiom above: local
  // string state for the inputs, parsed and validated on submit.
  const [retentionDaysInput, setRetentionDaysInput] = useState('');
  const [retentionError, setRetentionError] = useState<string | null>(null);
  const [keepLastNInput, setKeepLastNInput] = useState('');
  const [keepLastNError, setKeepLastNError] = useState<string | null>(null);
  const [keepDaysInput, setKeepDaysInput] = useState('');
  const [keepDaysError, setKeepDaysError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [settingsRes, tiersRes, usageRes, invitesRes, allowlistRes, membersRes] =
      await Promise.all([
        api.getOrgSettings(),
        api.getTierPlans(),
        api.getOrgUsage(),
        api.listInvites(),
        api.listAllowlist(),
        api.listOrgUsers({ limit: 50 }),
      ]);
    const myPlan = tiersRes.tiers.find((t) => t.tier === settingsRes.tier) ?? null;
    setSettings(settingsRes);
    setTierPlan(myPlan);
    setUsage(usageRes);
    setOrgName(settingsRes.name);
    setSessionHours(
      settingsRes.sessionMaxHours === null ? '' : String(settingsRes.sessionMaxHours),
    );
    setRetentionDaysInput(String(settingsRes.retentionDays));
    // `versionRetention === null` means "follow the plan default" — seed the
    // boxes with that default rather than leaving them blank, so the admin
    // always sees the number actually in effect. An explicit override seeds
    // from the stored config instead. Either way this mirrors
    // `effectiveVersionRetention` (packages/domain/src/tier.ts) so the UI
    // never shows a number the backend isn't really running on.
    const effectiveRetention =
      settingsRes.versionRetention ??
      (myPlan
        ? {
            keepLastN: myPlan.versionRetention.defaultKeepLastN,
            keepDays: myPlan.versionRetention.defaultKeepDays,
          }
        : null);
    setKeepLastNInput(effectiveRetention ? String(effectiveRetention.keepLastN) : '');
    setKeepDaysInput(
      effectiveRetention?.keepDays != null ? String(effectiveRetention.keepDays) : '',
    );
    setInvites(invitesRes.invites);
    setAllowlist(allowlistRes.entries);
    setMembers(membersRes.users);
    setMembersCursor(membersRes.nextCursor);
  }, []);

  useEffect(() => {
    if (me.role !== 'admin') return;
    refresh().catch(() => {
      setError('Could not load org settings.');
    });
  }, [me.role, refresh]);

  function run(fn: () => Promise<unknown>): void {
    setError(null);
    fn()
      .then(() => refresh())
      .catch((e: unknown) => {
        setError(errorCopy(e, { overrides: ORG_ADMIN_ERRORS, fallback: 'Something went wrong.' }));
      });
  }

  function loadMoreMembers(): void {
    if (!membersCursor) return;
    setError(null);
    api
      .listOrgUsers({ cursor: membersCursor, limit: 50 })
      .then((page) => {
        setMembers((prev) => [...prev, ...page.users]);
        setMembersCursor(page.nextCursor);
      })
      .catch(() => {
        setError('Could not load more members.');
      });
  }

  function submitRoleChange(userId: string, role: 'admin' | 'member'): void {
    run(() => api.setUserRole(userId, role));
  }

  function submitRename(): void {
    const trimmed = orgName.trim();
    if (trimmed.length === 0 || trimmed === settings?.name) return;
    run(() => api.updateOrgSettings({ name: trimmed }));
  }

  function submitInvite(): void {
    const email = inviteEmail.trim();
    if (email.length === 0) return;
    setError(null);
    setMintedInvite(null);
    api
      .sendInvite({ email, role: inviteRole })
      .then(({ invite, token }) => {
        setInviteEmail('');
        setMintedInvite({
          email: invite.email,
          // Same destination as the emailed link (Phase 38.C): lands on our
          // /invite/accept card first, not straight at WorkOS — this link
          // gets pasted into Slack/Teams/etc. just as often as it's used
          // as-is, so it gets the same fix.
          link: `${window.location.origin}/invite/accept?token=${token}`,
        });
        setCopied(false);
        return refresh();
      })
      .catch((e: unknown) => {
        setError(
          errorCopy(e, { overrides: ORG_ADMIN_ERRORS, fallback: 'Could not send the invite.' }),
        );
      });
  }

  function submitAllowlistEntry(): void {
    const email = allowlistEmail.trim();
    if (email.length === 0) return;
    setAllowlistEmail('');
    run(() => api.addAllowlistEntry(email));
  }

  function submitSessionMax(): void {
    const trimmed = sessionHours.trim();
    // Empty resets to the 24h global default; otherwise a whole number 1..24.
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 24)) {
      const msg = 'Session length must be a whole number of hours between 1 and 24.';
      setError(msg);
      setSessionError(msg);
      return;
    }
    setSessionError(null);
    run(() => api.updateOrgSettings({ sessionMaxHours: value }));
  }

  function submitRetentionDays(): void {
    const value = Number(retentionDaysInput.trim());
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      const msg = 'Retention must be a whole number of days, 0 to 365.';
      setError(msg);
      setRetentionError(msg);
      return;
    }
    setRetentionError(null);
    run(() => api.updateOrgSettings({ retentionDays: value }));
  }

  function submitVersionRetention(): void {
    const ceiling = tierPlan?.versionRetention ?? null;
    const keepLastN = Number(keepLastNInput.trim());
    if (!Number.isInteger(keepLastN) || keepLastN < 1) {
      const msg = 'Versions to keep must be a whole number of 1 or more.';
      setError(msg);
      setKeepLastNError(msg);
      return;
    }
    if (ceiling?.keepLastNMax != null && keepLastN > ceiling.keepLastNMax) {
      const msg = `Your plan keeps at most ${String(ceiling.keepLastNMax)} versions — lower the number, or upgrade.`;
      setError(msg);
      setKeepLastNError(msg);
      return;
    }
    setKeepLastNError(null);
    // Every tier's day ceiling is finite as of 2026-08-13, so "keep forever"
    // is never legal input — this is a required field, not the "blank = no
    // day limit" option it used to be (that combination is always rejected
    // server-side by `clampVersionRetention` once no ceiling is unlimited).
    const keepDays = Number(keepDaysInput.trim());
    if (!Number.isInteger(keepDays) || keepDays < 1) {
      const msg = 'Days to keep must be a whole number of 1 or more.';
      setError(msg);
      setKeepDaysError(msg);
      return;
    }
    if (ceiling?.keepDaysMax != null && keepDays > ceiling.keepDaysMax) {
      const msg = `Your plan keeps history for at most ${String(ceiling.keepDaysMax)} days — lower the number, or upgrade.`;
      setError(msg);
      setKeepDaysError(msg);
      return;
    }
    setKeepDaysError(null);
    run(() => api.updateOrgSettings({ versionRetention: { keepLastN, keepDays } }));
  }

  function resetVersionRetentionToDefault(): void {
    run(() => api.updateOrgSettings({ versionRetention: null }));
  }

  const isAdmin = me.role === 'admin';

  const rail: SettingsRailGroup[] = [
    {
      heading: 'ORGANIZATION',
      items: [
        {
          id: 'overview',
          label: 'Overview',
          active: section === 'overview',
          onSelect: () => {
            setSection('overview');
          },
        },
        {
          id: 'members',
          label: 'Members',
          active: section === 'members',
          onSelect: () => {
            setSection('members');
          },
        },
        {
          id: 'access',
          label: 'Access',
          active: section === 'access',
          onSelect: () => {
            setSection('access');
          },
        },
        {
          id: 'retention',
          label: 'Retention',
          active: section === 'retention',
          onSelect: () => {
            setSection('retention');
          },
        },
      ],
    },
    {
      heading: 'DEVELOPER',
      items: [
        {
          id: 'developer-keys',
          label: 'API keys',
          active: section === 'developer-keys',
          onSelect: () => {
            setSection('developer-keys');
          },
        },
        {
          id: 'developer-hub',
          label: 'Public hub',
          active: section === 'developer-hub',
          onSelect: () => {
            setSection('developer-hub');
          },
        },
      ],
    },
  ];

  const memberColumns: DataTableColumn<OrgUserDto>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (u) => u.displayName || (u.email ?? '(unnamed)'),
    },
    {
      key: 'email',
      header: 'Email',
      shed: true,
      render: (u) => u.email ?? <span className="doc-meta">hidden</span>,
    },
    {
      key: 'role',
      header: 'Role',
      render: (u) => {
        const self = u.id === me.userId;
        const name = u.displayName || (u.email ?? u.id);
        const select = (
          <select
            aria-label={`Role for ${name}`}
            value={u.role}
            disabled={self}
            onChange={(e) => {
              submitRoleChange(u.id, e.target.value as 'admin' | 'member');
            }}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        );
        return self ? (
          <Tooltip content="You can't change your own role — ask another admin.">{select}</Tooltip>
        ) : (
          select
        );
      },
    },
  ];

  return (
    <SettingsLayout
      header={
        <AppHeader
          me={me}
          mode={mode}
          setMode={setMode}
          onLogout={onLogout}
          onNavigateHome={onBack}
          onOpenDocument={onOpenDocument}
        >
          <h2 className="page-title">Org settings</h2>
        </AppHeader>
      }
      rail={rail}
    >
      {pendingRevoke && (
        <ConfirmDialog
          title={
            pendingRevoke.kind === 'invite'
              ? `Revoke invite for ${pendingRevoke.email}?`
              : `Remove ${pendingRevoke.email} from the allowlist?`
          }
          body={
            pendingRevoke.kind === 'invite'
              ? "They won't be able to use this invite link to join."
              : "They won't be able to self-serve join with this email anymore."
          }
          confirmLabel={pendingRevoke.kind === 'invite' ? 'Revoke' : 'Remove'}
          danger
          onConfirm={() => {
            if (pendingRevoke.kind === 'invite') run(() => api.revokeInvite(pendingRevoke.id));
            else run(() => api.removeAllowlistEntry(pendingRevoke.id));
            setPendingRevoke(null);
          }}
          onCancel={() => {
            setPendingRevoke(null);
          }}
        />
      )}
      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {!isAdmin && (
        <section className="settings-section" aria-labelledby="admins-only-heading">
          <div className="settings-section-head">
            <h3 id="admins-only-heading">Admins only</h3>
            <p className="help-text">
              Org-wide settings — members, who can join, sharing, sign-off, retention — are managed
              by an org admin. Ask one if you need something changed. Your own API keys are below.
            </p>
          </div>
        </section>
      )}

      {isAdmin && section === 'overview' && settings && (
        <>
          <section className="settings-section" aria-labelledby="overview-heading">
            <div className="settings-section-head">
              <h3 id="overview-heading">{settings.name}</h3>
            </div>
            <RecordLedger
              items={[
                { label: 'Plan', value: <Badge>{TIER_LABEL[settings.tier]}</Badge> },
                { label: 'Created', value: fmtDateWithYear(settings.createdAt) },
              ]}
            />
            {usage && (
              <div className="settings-usage-lanes">
                <Meter
                  label="Documents"
                  value={usage.activeDocCount}
                  ceiling={usage.maxActiveDocs}
                />
                <Meter label="Seats" value={usage.memberCount} ceiling={usage.maxCollaborators} />
                <Meter
                  label="Storage"
                  value={usage.storageBytes}
                  ceiling={null}
                  formatter={humanBytes}
                />
                <Meter
                  label="Guests"
                  value={usage.activeGuestCount}
                  ceiling={usage.maxExternalGuests}
                />
              </div>
            )}
          </section>

          <section className="settings-section" aria-labelledby="org-profile-heading">
            <div className="settings-section-head">
              <h3 id="org-profile-heading">Org name</h3>
              <p className="help-text">Shown to every member, and on shared documents.</p>
            </div>
            <form
              className="invite-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitRename();
              }}
            >
              <input
                type="text"
                aria-label="Organization name"
                value={orgName}
                onChange={(e) => {
                  setOrgName(e.target.value);
                }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                title="Save organization name"
                aria-label="Save organization name"
                disabled={orgName.trim().length === 0 || orgName.trim() === settings.name}
              >
                <IconCheck size={14} />
                Save
              </button>
            </form>
          </section>
        </>
      )}

      {isAdmin && section === 'members' && (
        <>
          <section className="settings-section" aria-labelledby="invite-heading">
            <div className="settings-section-head">
              <h3 id="invite-heading">Invite people</h3>
              <p className="help-text">Invited people join as the role you pick below.</p>
            </div>

            {usage && (
              <Meter label="Seats" value={usage.memberCount} ceiling={usage.maxCollaborators} />
            )}

            <form
              className="invite-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitInvite();
              }}
            >
              <input
                type="email"
                placeholder="name@company.com"
                aria-label="Email to invite"
                value={inviteEmail}
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                }}
              />
              <select
                aria-label="Role"
                value={inviteRole}
                onChange={(e) => {
                  setInviteRole(e.target.value as 'admin' | 'member');
                }}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" className="btn btn-primary" title="Send invite">
                <IconPlus size={14} />
                Send invite
              </button>
            </form>

            {mintedInvite && (
              <div className="share-token" data-testid="invite-token">
                <p>Invite link for {mintedInvite.email} — shown once, copy it now:</p>
                <code>{mintedInvite.link}</code>
                <div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    title="Copy invite link"
                    onClick={() => {
                      void navigator.clipboard.writeText(mintedInvite.link).then(() => {
                        setCopied(true);
                      });
                    }}
                  >
                    {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                </div>
              </div>
            )}

            <ul className="invite-list" data-testid="invite-list">
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                return (
                  <li key={invite.id} className="invite-row">
                    <span className="invite-email">{invite.email}</span>
                    <span className="doc-meta">{invite.role}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="doc-meta">expires {fmtDate(invite.expiresAt)}</span>
                    {!invite.revokedAt && !invite.acceptedAt && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-danger"
                        title={`Revoke invite for ${invite.email}`}
                        onClick={() => {
                          setPendingRevoke({
                            kind: 'invite',
                            id: invite.id,
                            email: invite.email,
                          });
                        }}
                      >
                        <IconTrash size={14} />
                        Revoke
                      </button>
                    )}
                  </li>
                );
              })}
              {invites.length === 0 && (
                <li className="doc-meta">No invites yet — send one above to get someone in.</li>
              )}
            </ul>
          </section>

          <section className="settings-section" aria-labelledby="members-heading">
            <div className="settings-section-head">
              <h3 id="members-heading">Members</h3>
              <p className="help-text">
                Change a member&apos;s role. You can&apos;t change your own.
              </p>
            </div>
            <DataTable
              columns={memberColumns}
              rows={members}
              getRowKey={(u) => u.id}
              caption="Org members"
              emptyState={<p className="doc-meta">No members yet.</p>}
            />
            {membersCursor && (
              <button
                type="button"
                className="btn load-more"
                title="Load more members"
                onClick={loadMoreMembers}
              >
                Load more
              </button>
            )}
          </section>
        </>
      )}

      {isAdmin && section === 'access' && (
        <>
          <section className="settings-section" aria-labelledby="provisioning-heading">
            <div className="settings-section-head">
              <h3 id="provisioning-heading">Who can join</h3>
              <p className="help-text">
                Open lets anyone with an invite link in, allowlist restricts self-serve signup to
                the emails listed below.
              </p>
            </div>
            <div className="provisioning-toggle" role="group" aria-label="Provisioning mode">
              <Tooltip content="Anyone with an invite link can join">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.provisioningMode === 'open'}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ provisioningMode: 'open' }));
                  }}
                >
                  Open
                </button>
              </Tooltip>
              <Tooltip content="Only allowlisted emails can self-serve join">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.provisioningMode === 'allowlist'}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ provisioningMode: 'allowlist' }));
                  }}
                >
                  Allowlist
                </button>
              </Tooltip>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="allowlist-heading">
            <div className="settings-section-head">
              <h3 id="allowlist-heading">Signup allowlist</h3>
              <p className="help-text">
                Email addresses allowed to self-serve join this org, when provisioning above is set
                to allowlist.
              </p>
            </div>

            <form
              className="invite-form"
              onSubmit={(e) => {
                e.preventDefault();
                submitAllowlistEntry();
              }}
            >
              <input
                type="email"
                placeholder="name@company.com"
                aria-label="Email to allow"
                value={allowlistEmail}
                onChange={(e) => {
                  setAllowlistEmail(e.target.value);
                }}
              />
              <button type="submit" className="btn btn-primary" title="Add to allowlist">
                <IconPlus size={14} />
                Add to allowlist
              </button>
            </form>

            <ul className="invite-list" data-testid="allowlist-list">
              {allowlist.map((entry) => (
                <li key={entry.id} className="invite-row">
                  <span className="invite-email">{entry.email}</span>
                  <span className="doc-meta">added {fmtDate(entry.createdAt)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger"
                    title={`Remove ${entry.email} from allowlist`}
                    onClick={() => {
                      setPendingRevoke({ kind: 'allowlist', id: entry.id, email: entry.email });
                    }}
                  >
                    <IconTrash size={14} />
                    Remove
                  </button>
                </li>
              ))}
              {allowlist.length === 0 && (
                <li className="doc-meta">
                  No allowlist entries yet — add an email above to allow it.
                </li>
              )}
            </ul>
          </section>

          <section className="settings-section" aria-labelledby="guest-sharing-heading">
            <div className="settings-section-head">
              <h3 id="guest-sharing-heading">External guest sharing</h3>
              <p className="help-text">
                Lets members email a document to someone outside the organization. Guests get
                time-limited read or comment access to that one document only.
              </p>
            </div>
            <div className="provisioning-toggle" role="group" aria-label="External sharing">
              <Tooltip content="Allow sharing documents with external guests">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.externalSharing === true}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ externalSharing: true }));
                  }}
                >
                  On
                </button>
              </Tooltip>
              <Tooltip content="Block sharing documents with external guests">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.externalSharing === false}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ externalSharing: false }));
                  }}
                >
                  Off
                </button>
              </Tooltip>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="approval-gate-heading">
            <div className="settings-section-head">
              <h3 id="approval-gate-heading">Sign-off gate</h3>
              <p className="help-text">
                Soft lets a reviewer approve with open comments still on the document (a warning is
                shown). Hard blocks approval until every comment is resolved.
              </p>
            </div>
            <div className="provisioning-toggle" role="group" aria-label="Sign-off gate">
              <Tooltip content="Reviewers may approve with open comments (warned, not blocked)">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.approvalGate === 'soft'}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ approvalGate: 'soft' }));
                  }}
                >
                  Soft
                </button>
              </Tooltip>
              <Tooltip content="Approval is blocked while any comment is open">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.approvalGate === 'hard'}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ approvalGate: 'hard' }));
                  }}
                >
                  Hard
                </button>
              </Tooltip>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="session-max-heading">
            <div className="settings-section-head">
              <h3 id="session-max-heading">Session length</h3>
              <p className="help-text">
                How long a signed-in session stays valid before people have to log in again. Leave
                blank for the 24-hour default; you can only shorten it (1–24 hours), never extend
                it.
              </p>
            </div>
            <form
              className="settings-form-row"
              // Native min/max constraint validation would silently block
              // submit before this handler ever runs, so the worded
              // validation message below (not a native browser tooltip)
              // never gets a chance to show — same reasoning on every form
              // in this file with a min/max number input.
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submitSessionMax();
              }}
            >
              <span className="field-row">
                <input
                  type="number"
                  min={1}
                  max={24}
                  step={1}
                  placeholder="24"
                  aria-label="Session length in hours"
                  aria-invalid={sessionError !== null}
                  aria-describedby={sessionError !== null ? 'session-hours-error' : undefined}
                  value={sessionHours}
                  onChange={(e) => {
                    setSessionHours(e.target.value);
                    setSessionError(null);
                  }}
                />
                hours
              </span>
              <Tooltip content="Save session length">
                <button type="submit" className="btn btn-primary" aria-label="Save session length">
                  <IconCheck size={14} />
                  Save
                </button>
              </Tooltip>
              {sessionError && (
                <span id="session-hours-error" className="field-error" role="alert">
                  {sessionError}
                </span>
              )}
            </form>
          </section>
        </>
      )}

      {isAdmin && section === 'retention' && (
        <>
          <section className="settings-section" aria-labelledby="retention-days-heading">
            <div className="settings-section-head">
              <h3 id="retention-days-heading">Deleted documents</h3>
              <p className="help-text">
                {settings?.purgeImmediately
                  ? 'Deleted documents are purged immediately — there is no recovery window.'
                  : 'How long a deleted document stays recoverable before it and its versions are permanently purged. Purged data ages out of all backups within 35 days.'}
              </p>
            </div>
            <form
              className="settings-form-row"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submitRetentionDays();
              }}
            >
              <span className="field-row">
                <input
                  type="number"
                  min={0}
                  max={365}
                  step={1}
                  aria-label="Retention days for deleted documents"
                  aria-invalid={retentionError !== null}
                  aria-describedby={retentionError !== null ? 'retention-days-error' : undefined}
                  value={retentionDaysInput}
                  disabled={settings?.purgeImmediately === true}
                  onChange={(e) => {
                    setRetentionDaysInput(e.target.value);
                    setRetentionError(null);
                  }}
                />
                days
              </span>
              <Tooltip content="Save retention days">
                <button
                  type="submit"
                  className="btn btn-primary"
                  aria-label="Save retention days"
                  disabled={settings?.purgeImmediately === true}
                >
                  <IconCheck size={14} />
                  Save
                </button>
              </Tooltip>
              {retentionError && (
                <span id="retention-days-error" className="field-error" role="alert">
                  {retentionError}
                </span>
              )}
            </form>
            <div
              className="provisioning-toggle"
              role="group"
              aria-label="Purge deleted documents immediately"
            >
              <Tooltip content="Deleted documents wait out the retention window above before their content is gone">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.purgeImmediately === false}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ purgeImmediately: false }));
                  }}
                >
                  Wait
                </button>
              </Tooltip>
              <Tooltip content="Skip the retention window — a deleted document is purged right away">
                <button
                  type="button"
                  className="btn"
                  aria-pressed={settings?.purgeImmediately === true}
                  onClick={() => {
                    run(() => api.updateOrgSettings({ purgeImmediately: true }));
                  }}
                >
                  Purge immediately
                </button>
              </Tooltip>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="version-retention-heading">
            <div className="settings-section-head">
              <h3 id="version-retention-heading">Version history</h3>
              <p className="help-text">
                Older versions of a document are purged automatically once they fall outside both
                limits below — kept versions are whichever of the two limits keeps more. Your plan
                clamps how high these can go; an amount over your plan&apos;s ceiling is rejected,
                not silently lowered.
              </p>
              {settings && tierPlan && (
                <p className="help-text version-retention-status">
                  {settings.versionRetention === null ? (
                    <>
                      Following your {TIER_LABEL[settings.tier]} plan&apos;s default —{' '}
                      {tierPlan.versionRetention.defaultKeepLastN} versions /{' '}
                      {fmtPlanCeiling(tierPlan.versionRetention.defaultKeepDays)} days.
                    </>
                  ) : (
                    <>
                      Custom — your {TIER_LABEL[settings.tier]} plan allows up to{' '}
                      {fmtPlanCeiling(tierPlan.versionRetention.keepLastNMax)} versions /{' '}
                      {fmtPlanCeiling(tierPlan.versionRetention.keepDaysMax)} days.{' '}
                      <Tooltip content="Go back to following your plan's default — upgrades then apply automatically">
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={resetVersionRetentionToDefault}
                        >
                          Reset to plan default
                        </button>
                      </Tooltip>
                    </>
                  )}
                </p>
              )}
            </div>
            <form
              className="settings-form-row"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                submitVersionRetention();
              }}
            >
              <span className="field-row">
                <label htmlFor="keep-last-n-input">Keep at least</label>
                <input
                  id="keep-last-n-input"
                  type="number"
                  min={1}
                  max={tierPlan?.versionRetention.keepLastNMax ?? undefined}
                  step={1}
                  aria-label="Versions to always keep"
                  aria-invalid={keepLastNError !== null}
                  aria-describedby={keepLastNError !== null ? 'keep-last-n-error' : undefined}
                  value={keepLastNInput}
                  onChange={(e) => {
                    setKeepLastNInput(e.target.value);
                    setKeepLastNError(null);
                  }}
                />
                versions
                {tierPlan && (
                  <span className="field-hint">
                    {TIER_LABEL[tierPlan.tier]} plan: up to{' '}
                    {fmtPlanCeiling(tierPlan.versionRetention.keepLastNMax)}
                  </span>
                )}
              </span>
              <span className="field-row">
                <label htmlFor="keep-days-input">or younger than</label>
                <input
                  id="keep-days-input"
                  type="number"
                  min={1}
                  max={tierPlan?.versionRetention.keepDaysMax ?? undefined}
                  step={1}
                  aria-label="Days to keep versions"
                  aria-invalid={keepDaysError !== null}
                  aria-describedby={keepDaysError !== null ? 'keep-days-error' : undefined}
                  value={keepDaysInput}
                  onChange={(e) => {
                    setKeepDaysInput(e.target.value);
                    setKeepDaysError(null);
                  }}
                />
                days
                {tierPlan && (
                  <span className="field-hint">
                    {TIER_LABEL[tierPlan.tier]} plan: up to{' '}
                    {fmtPlanCeiling(tierPlan.versionRetention.keepDaysMax)}
                  </span>
                )}
              </span>
              <Tooltip content="Save version retention">
                <button
                  type="submit"
                  className="btn btn-primary"
                  aria-label="Save version retention"
                >
                  <IconCheck size={14} />
                  Save
                </button>
              </Tooltip>
              {keepLastNError && (
                <span id="keep-last-n-error" className="field-error" role="alert">
                  {keepLastNError}
                </span>
              )}
              {keepDaysError && (
                <span id="keep-days-error" className="field-error" role="alert">
                  {keepDaysError}
                </span>
              )}
            </form>
          </section>
        </>
      )}

      {isAdmin && section === 'developer-keys' && <ApiKeysSection me={me} />}
      {isAdmin && section === 'developer-hub' && <PublicHubSection />}

      {/* API keys are personal, not org-wide, so a non-admin still reaches
              them via the same DEVELOPER rail item — everyone gets this one. */}
      {!isAdmin && me.role !== 'guest' && <ApiKeysSection me={me} />}
    </SettingsLayout>
  );
}
