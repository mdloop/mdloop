import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from '../api/client.js';
import type { OrgUserDto, ProjectGrantDto } from '../api/client.js';
import { errorCopy } from '../api/error-copy.js';
import { PERMISSION_LABEL } from '../permission-copy.js';
import type { SharePermission } from '../permission-copy.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { IconPlus, IconTrash, IconX } from './icons.js';

export interface ProjectSharePanelProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
}

/**
 * Project-level share management (ADR 0014, Phase 42), rendered as a popover
 * anchored inside the project row's kebab-menu container in shell.tsx — same
 * `.share-panel` shape as the document `SharePanel`, deliberately smaller.
 *
 * Org-admin only to even open (gated at the call site, mirroring the
 * server's own `requireAdminProject`), so unlike the document panel there is
 * no delegation cap to enforce here: every permission is always offered, and
 * every grant may always be revoked — a caller who reaches this component is
 * always the equivalent of `SharePanel`'s `canManage`. A grant here confers
 * its permission on every document currently in the project (a grant on the
 * document itself still wins if it's higher — see `documentPermissionFor` in
 * `sharing.ts`); named-user grants only, never a link or a guest, same as
 * `createProjectGrant`'s doc comment in `project-sharing.ts` explains (an
 * ordinary member can create a project and later have someone else's
 * document land in it, so this stays narrower than document sharing on
 * purpose — admin-only forecloses that escalation path).
 */
export function ProjectSharePanel({
  projectId,
  projectName,
  onClose,
}: ProjectSharePanelProps): JSX.Element {
  const [grants, setGrants] = useState<ProjectGrantDto[]>([]);
  const [users, setUsers] = useState<OrgUserDto[]>([]);
  const [pickedUser, setPickedUser] = useState('');
  const [permission, setPermission] = useState<SharePermission>('comment');
  const [error, setError] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; label: string } | null>(null);

  function refresh(): void {
    void Promise.all([api.listProjectGrants(projectId), api.listOrgUsers()])
      .then(([grantRes, userRes]) => {
        setGrants(grantRes.grants);
        setUsers(userRes.users);
      })
      .catch(() => {
        setError('Could not load sharing settings.');
      });
  }

  useEffect(refresh, [projectId]);

  function run(fn: () => Promise<unknown>): void {
    setError(null);
    fn()
      .then(refresh)
      .catch((e: unknown) => {
        setError(errorCopy(e, { fallback: 'Sharing failed.' }));
      });
  }

  return (
    <div className="share-panel" data-testid="project-share-panel">
      {pendingRevoke && (
        <ConfirmDialog
          title={`Revoke access for ${pendingRevoke.label}?`}
          body="They'll lose the access this project grants them across every document in it, immediately."
          confirmLabel="Revoke"
          danger
          onConfirm={() => {
            run(() => api.revokeProjectGrant(projectId, pendingRevoke.id));
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

      <p className="help-text">
        Grants a permission on every document currently in {projectName} — a grant on a document
        itself still wins if it's higher.
      </p>

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
            value={permission}
            onChange={(e) => {
              setPermission(e.target.value as SharePermission);
            }}
          >
            <option value="comment">Can comment</option>
            <option value="read">Can read</option>
            <option value="share">Can share</option>
            <option value="edit">Can edit</option>
          </select>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pickedUser === ''}
            title="Grant access"
            onClick={() => {
              run(() => api.createProjectGrant(projectId, pickedUser, permission));
            }}
          >
            <IconPlus size={14} />
            Grant
          </button>
        </div>
      </div>

      <ul className="share-grant-list">
        {grants.map((g) => {
          const label = users.find((u) => u.id === g.grantee.userId)?.displayName ?? 'Org member';
          return (
            <li key={g.id} className="share-grant">
              <span>{label}</span>
              <span className="doc-meta">{PERMISSION_LABEL[g.permission]}</span>
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
            </li>
          );
        })}
        {grants.length === 0 && (
          <li className="help-text">No grants yet on this project — add one above.</li>
        )}
      </ul>
    </div>
  );
}
