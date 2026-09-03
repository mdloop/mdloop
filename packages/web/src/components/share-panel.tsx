import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ApiError, api } from '../api/client.js';
import type { GrantDto, Me, OrgUserDto } from '../api/client.js';
import { errorCopy } from '../api/error-copy.js';
import { PERMISSION_LABEL, delegableOptions } from '../permission-copy.js';
import type { SharePermission } from '../permission-copy.js';
import { slugify } from '../slug.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { IconLink, IconPlus, IconTrash, IconX } from './icons.js';

export interface SharePanelProps {
  documentId: string;
  documentTitle: string;
  /** The caller's own permission on this document — governs what the
   *  person-grant select offers (ADR 0014: delegation capped at own level)
   *  when `canManage` is false. */
  myPermission: SharePermission;
  /** Owner/org-admin — offered every permission on the person select and may
   *  revoke any grant, not just ones they created themselves. */
  canManage: boolean;
  me: Me;
  onClose: () => void;
}

/**
 * Share management, rendered as a popover anchored to the Share trigger (see
 * .share-anchor in viewer.tsx) — one location for this feature in both List
 * and Bubbles mode. Since ADR 0014 this is no longer owner/admin only: a
 * `share`/`edit` grantee reaches it too (viewer.tsx's `canShare` gate), so
 * every action here is capped at what the caller may actually do — the
 * person select only offers permissions at or below the caller's own level
 * (`delegableOptions`, `'manage'` for owner/admin), and revoke is only
 * offered for a grant the caller created themselves unless they can manage.
 *
 * Link mode mints a token shown exactly once; directory mode grants to org
 * members; guest sharing is always available. Each flow gets its own
 * permission control (defaulting to 'comment') since one shared select would
 * silently govern three different audiences — and the caps genuinely differ
 * since ADR 0008/0014. Only the directory-person select offers "Can share"
 * and "Can edit". The link select doesn't: a link is forwardable, a named
 * grant is not. The guest select doesn't either, and that one is absolute —
 * external guests are capped at read/comment regardless of grant
 * (CONSTITUTION §9).
 */
export function SharePanel({
  documentId,
  documentTitle,
  myPermission,
  canManage,
  me,
  onClose,
}: SharePanelProps): JSX.Element {
  const [mode, setMode] = useState<'link' | 'directory' | null>(null);
  const [grants, setGrants] = useState<GrantDto[]>([]);
  const [users, setUsers] = useState<OrgUserDto[]>([]);
  const [linkPermission, setLinkPermission] = useState<'read' | 'comment'>('comment');
  const [grantPermission, setGrantPermission] = useState<SharePermission>('comment');
  const [guestPermission, setGuestPermission] = useState<'read' | 'comment'>('comment');
  /** What the person select may offer — capped at the caller's own held
   *  level unless they can manage the document (ADR 0014). */
  const grantOptions = delegableOptions(canManage ? 'manage' : myPermission);
  const [pickedUser, setPickedUser] = useState('');
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [guestEmail, setGuestEmail] = useState('');
  const [guestDays, setGuestDays] = useState(7);
  const [guestToken, setGuestToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; label: string } | null>(null);

  /**
   * Public Docs Hub (Phase 23). There is no `publicHubOrgId` exposed to the
   * frontend, so whether this org can publish at all is discovered by
   * probing `GET /public-hub/documents` on mount: 200 means home org, 403
   * means "not applicable here" (nearly every org — not an error, so no
   * banner). Publishing is org-admin-only server-side (`canPublish`), a
   * narrower gate than this panel's own — since ADR 0014 a `share`/`edit`
   * grantee can reach `SharePanel` without being an org admin, so that
   * caller's probe always 403s too (never role `'admin'`, or `canManage`
   * would already be true), same as a plain member's would. Either way,
   * `forbidden` here is expected and never a banner-worthy error.
   */
  const [hubAvailable, setHubAvailable] = useState(false);
  const [hubSlug, setHubSlug] = useState(slugify(documentTitle));
  const [hubTitle, setHubTitle] = useState('');
  const [hubError, setHubError] = useState<string | null>(null);
  const [publishedSlug, setPublishedSlug] = useState<string | null>(null);

  function refresh(): void {
    void Promise.all([api.listShares(documentId), api.orgSettings(), api.listOrgUsers()])
      .then(([shareRes, settings, userRes]) => {
        setGrants(shareRes.grants);
        setMode(settings.sharingMode);
        setUsers(userRes.users);
      })
      .catch(() => {
        setError('Could not load sharing settings.');
      });
  }

  useEffect(refresh, [documentId]);

  useEffect(() => {
    let cancelled = false;
    api
      .listPublicHubDocs()
      .then(() => {
        if (!cancelled) setHubAvailable(true);
      })
      .catch(() => {
        // Not the hub's home org (the common case) or the probe failed —
        // either way, no publish UI. Never a banner for this.
        if (!cancelled) setHubAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  function publish(): void {
    const slug = hubSlug.trim();
    if (slug === '') return;
    setHubError(null);
    setPublishedSlug(null);
    const title = hubTitle.trim();
    api
      .publishToPublicHub({ documentId, slug, ...(title !== '' ? { title } : {}) })
      .then((doc) => {
        setPublishedSlug(doc.slug);
      })
      .catch((e: unknown) => {
        setHubError(
          e instanceof ApiError && e.code === 'invalid_slug'
            ? "That slug isn't valid — use lowercase letters, numbers, and hyphens."
            : e instanceof ApiError &&
                (e.code === 'document_not_found' || e.code === 'version_purged')
              ? "Couldn't publish this document right now."
              : 'Publishing failed.',
        );
      });
  }

  function run(fn: () => Promise<unknown>): void {
    setError(null);
    fn()
      .then(refresh)
      .catch((e: unknown) => {
        setError(errorCopy(e, { fallback: 'Sharing failed.' }));
      });
  }

  return (
    <div className="share-panel" data-testid="share-panel">
      {pendingRevoke && (
        <ConfirmDialog
          title={`Revoke access for ${pendingRevoke.label}?`}
          body="They'll lose access to this document immediately."
          confirmLabel="Revoke"
          danger
          onConfirm={() => {
            run(() => api.revokeShare(documentId, pendingRevoke.id));
            setPendingRevoke(null);
          }}
          onCancel={() => {
            setPendingRevoke(null);
          }}
        />
      )}
      <div className="share-panel-head">
        <strong>Share</strong>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Close sharing"
          title="Close sharing"
          onClick={onClose}
        >
          <IconX />
        </button>
      </div>

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {mode === 'link' && (
        <div className="share-section">
          <div className="sidebar-heading">Link for the org</div>
          <div className="share-controls">
            <select
              aria-label="Permission for the org link"
              value={linkPermission}
              onChange={(e) => {
                setLinkPermission(e.target.value as 'read' | 'comment');
              }}
            >
              <option value="comment">Can comment</option>
              <option value="read">Can read</option>
            </select>
            <button
              type="button"
              className="btn btn-primary"
              title="Create a share link"
              onClick={() => {
                setMintedToken(null);
                void api
                  .createShareLink(documentId, linkPermission)
                  .then(({ token }) => {
                    setMintedToken(token);
                    refresh();
                  })
                  .catch(() => {
                    setError('Sharing failed.');
                  });
              }}
            >
              <IconLink size={14} />
              Create link
            </button>
          </div>
          {mintedToken && (
            <div className="share-token" data-testid="share-token">
              <p>Share this link — the token is shown only once:</p>
              <code>{`${window.location.origin}/s/${mintedToken}/${slugify(documentTitle)}`}</code>
            </div>
          )}
        </div>
      )}

      {mode === 'directory' && (
        <div className="share-section">
          <div className="sidebar-heading">Grant a person</div>
          <div className="share-controls">
            <select
              aria-label="Grant to"
              value={pickedUser}
              onChange={(e) => {
                setPickedUser(e.target.value);
              }}
            >
              <option value="">Choose person…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName || u.email}
                </option>
              ))}
            </select>
            <select
              aria-label="Permission for this person"
              value={grantPermission}
              onChange={(e) => {
                setGrantPermission(e.target.value as SharePermission);
              }}
            >
              {grantOptions.includes('comment') && <option value="comment">Can comment</option>}
              {grantOptions.includes('read') && <option value="read">Can read</option>}
              {grantOptions.includes('share') && (
                // ADR 0014: creating/revoking grants on this document, capped
                // at the granter's own level — never delete/archive/move,
                // resolve, or upload a new version.
                <option value="share">Can share</option>
              )}
              {grantOptions.includes('edit') && (
                // ADR 0008: new versions only — not delete, share or resolve.
                <option value="edit">Can edit</option>
              )}
            </select>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pickedUser === ''}
              title="Grant access"
              onClick={() => {
                run(() => api.createUserGrant(documentId, pickedUser, grantPermission));
              }}
            >
              <IconPlus size={14} />
              Grant
            </button>
          </div>
        </div>
      )}

      <div className="share-guest" data-testid="guest-share">
        <div className="sidebar-heading">Share with a guest</div>
        <p className="help-text">
          Someone outside your organization — emailed a link that expires. Re-sharing to the same
          email extends their access.
        </p>
        <div className="share-controls">
          <input
            type="email"
            aria-label="Guest email"
            placeholder="name@example.com"
            value={guestEmail}
            onChange={(e) => {
              setGuestEmail(e.target.value);
            }}
          />
          <span className="share-days-field">
            <input
              type="number"
              aria-label="Days of access"
              min={1}
              max={365}
              value={guestDays}
              onChange={(e) => {
                setGuestDays(Number(e.target.value));
              }}
            />
            <span className="doc-meta" aria-hidden="true">
              days
            </span>
          </span>
          <select
            aria-label="Permission for this guest"
            value={guestPermission}
            onChange={(e) => {
              setGuestPermission(e.target.value as 'read' | 'comment');
            }}
          >
            <option value="comment">Can comment</option>
            <option value="read">Can read</option>
          </select>
          <button
            type="button"
            className="btn btn-primary"
            disabled={guestEmail.trim().length === 0}
            title="Send guest link"
            onClick={() => {
              setGuestToken(null);
              setError(null);
              void api
                .createGuestShare(documentId, {
                  email: guestEmail.trim(),
                  permission: guestPermission,
                  days: guestDays,
                })
                .then(({ token }) => {
                  setGuestToken(token);
                  setGuestEmail('');
                  refresh();
                })
                .catch((e: unknown) => {
                  setError(
                    e instanceof ApiError && e.code === 'guest_cap_exceeded'
                      ? 'Guest limit reached for your plan.'
                      : e instanceof ApiError && e.code === 'external_sharing_disabled'
                        ? 'External sharing is turned off for your organization.'
                        : 'Sharing failed.',
                  );
                });
            }}
          >
            <IconPlus size={14} />
            Send guest link
          </button>
        </div>
        {guestToken && (
          <div className="share-token" data-testid="guest-share-token">
            <p>Guest link (also emailed) — shown only once:</p>
            <code>{`${window.location.origin}/g/${guestToken}`}</code>
          </div>
        )}
      </div>

      {hubAvailable && (
        <div className="share-section" data-testid="publish-hub">
          <div className="sidebar-heading">Publish to public hub</div>
          <p className="help-text">
            Visible to anyone with the link, no login — for onboarding docs, runbooks, guides.
          </p>
          {hubError && (
            <div className="banner-error" role="alert">
              {hubError}
            </div>
          )}
          <div className="share-controls">
            <input
              type="text"
              aria-label="Public hub slug"
              placeholder="slug"
              value={hubSlug}
              onChange={(e) => {
                setHubSlug(e.target.value);
              }}
            />
            <input
              type="text"
              aria-label="Public hub title override"
              placeholder={documentTitle}
              value={hubTitle}
              onChange={(e) => {
                setHubTitle(e.target.value);
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={hubSlug.trim() === ''}
              title="Publish to the public hub"
              onClick={publish}
            >
              Publish
            </button>
          </div>
          {publishedSlug && (
            <div className="share-token" data-testid="publish-hub-token">
              <p>Published — view it at:</p>
              <code>
                <a href={`/hub/${publishedSlug}`} target="_blank" rel="noreferrer">
                  {`${window.location.origin}/hub/${publishedSlug}`}
                </a>
              </code>
            </div>
          )}
        </div>
      )}

      <ul className="share-grant-list">
        {grants.map((g) => {
          const label =
            g.granteeEmail !== null
              ? `${g.granteeEmail} (guest)`
              : g.grantee.type === 'link'
                ? 'Anyone in the org with the link'
                : (users.find((u) => u.id === (g.grantee as { userId: string }).userId)
                    ?.displayName ?? 'Org member');
          return (
            <li key={g.id} className="share-grant">
              <span>{label}</span>
              <span className="doc-meta">
                {PERMISSION_LABEL[g.permission]}
                {g.expiresAt !== null && ` · expires ${new Date(g.expiresAt).toLocaleDateString()}`}
              </span>
              {/* ADR 0014: a share/edit grantee may only revoke a grant they
                  themselves created — the server enforces this too (403
                  forbidden), but hiding the button for one that would just
                  error is a small, worthwhile UX improvement. */}
              {(canManage || g.createdBy === me.userId) && (
                <button
                  type="button"
                  className="btn btn-ghost btn-danger"
                  title="Revoke this share"
                  onClick={() => {
                    setPendingRevoke({ id: g.id, label });
                  }}
                >
                  <IconTrash size={14} />
                  Revoke
                </button>
              )}
            </li>
          );
        })}
        {grants.length === 0 && (
          <li className="help-text">
            No active shares yet — create a link or invite a guest above.
          </li>
        )}
      </ul>
    </div>
  );
}
