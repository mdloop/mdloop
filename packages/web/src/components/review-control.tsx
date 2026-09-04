import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { ApiError, api } from '../api/client.js';
import type { GrantDto, Me, OrgUserDto, ReviewDto, ReviewStatusValue } from '../api/client.js';
import { errorCopy } from '../api/error-copy.js';
import { IconCheck, IconMessage, IconTrash, IconX } from './icons.js';

export interface ReviewControlProps {
  documentId: string;
  me: Me;
  /** True when the viewer is the doc owner or an org admin — reviewer management. */
  canManage: boolean;
  /** Notify the parent (e.g. to refresh the home list) after a status change. */
  onChanged?: () => void;
  /** Fires whenever whether the signed-in user is a requested reviewer with
   *  no verdict yet changes — the header (ADR 0003 §F.6) uses this to decide
   *  whether the verdict action or "Add comment" gets the single primary
   *  slot for read/comment users. */
  onPendingVerdictChange?: (pending: boolean) => void;
}

const STATUS_LABEL: Record<ReviewStatusValue, string> = {
  draft: 'No review',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

/** A guest reviewer candidate picked from the doc's existing guest grants. */
interface GuestCandidate {
  userId: string;
  email: string;
}

function guestCandidates(grants: GrantDto[]): GuestCandidate[] {
  return grants.flatMap((g) =>
    g.granteeEmail !== null && g.grantee.type === 'user'
      ? [{ userId: g.grantee.userId, email: g.granteeEmail }]
      : [],
  );
}

/**
 * Sign-off ("pass the mdloop") control in the viewer header: a status chip that
 * opens a management popover, plus inline Approve / Request-changes buttons for
 * a requested reviewer. Owners and admins request and revoke reviewers; a
 * requested reviewer (member or guest) submits a verdict. The soft gate only
 * warns about open comments near Approve; the hard gate's 409 surfaces as a
 * clear, resolvable message.
 */
export function ReviewControl({
  documentId,
  me,
  canManage,
  onChanged,
  onPendingVerdictChange,
}: ReviewControlProps): JSX.Element | null {
  const [review, setReview] = useState<ReviewDto | null>(null);
  const [open, setOpen] = useState(false);
  const [orgUsers, setOrgUsers] = useState<OrgUserDto[]>([]);
  const [guests, setGuests] = useState<GuestCandidate[]>([]);
  const [pickedReviewer, setPickedReviewer] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    return api
      .getReview(documentId)
      .then((r) => {
        setReview(r);
      })
      .catch(() => {
        /* A reader without review access simply sees no control. */
      });
  }, [documentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reviewer-picker sources — only the owner/admin surfaces need these, and
  // only guests can't call listOrgUsers, so this stays behind canManage.
  // Refetches every time the popover opens (not just on mount) since a guest
  // share created while the panel was closed would otherwise never appear.
  useEffect(() => {
    if (!canManage || !open) return;
    void Promise.all([api.listOrgUsers(), api.listShares(documentId)])
      .then(([userRes, shareRes]) => {
        setOrgUsers(userRes.users);
        setGuests(guestCandidates(shareRes.grants));
      })
      .catch(() => {
        /* Non-essential — the picker just stays empty. */
      });
  }, [canManage, documentId, open]);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent): void {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.document.addEventListener('mousedown', onOutside);
    window.document.addEventListener('keydown', onKey);
    return () => {
      window.document.removeEventListener('mousedown', onOutside);
      window.document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isReviewer = review?.requests.some((r) => r.reviewerUserId === me.userId) ?? false;
  const myVerdict = review?.approvals.find((a) => a.reviewerUserId === me.userId);
  /** Requested but hasn't voted yet — the header's single-primary-action
   *  rule (ADR 0003 §F.6) keys off this, not just isReviewer, so a reviewer
   *  who already voted doesn't keep stealing the primary slot from
   *  "Add comment". */
  const pendingVerdict = isReviewer && !myVerdict;

  useEffect(() => {
    onPendingVerdictChange?.(pendingVerdict);
  }, [pendingVerdict, onPendingVerdictChange]);

  if (!review) return null;

  const openCount = review.openCommentCount;

  function run(fn: () => Promise<unknown>): void {
    setError(null);
    fn()
      .then(() => refresh())
      .then(() => {
        onChanged?.();
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.code === 'open_comments_block_approval') {
          setError(
            `Resolve the ${String(openCount)} open comment${openCount === 1 ? '' : 's'} before approving — this org requires a clean document to approve.`,
          );
        } else {
          setError(errorCopy(e, { fallback: 'Review action failed.' }));
        }
      });
  }

  function submit(verdict: 'approved' | 'changes_requested'): void {
    run(() => api.submitReviewVerdict(documentId, verdict, note.trim() || null));
    setNote('');
  }

  const softWarn = review.gate === 'soft' && openCount > 0;

  return (
    <div className="review-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`review-chip review-chip--${review.status} review-chip--button${open ? ' review-chip--open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Review status"
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        {review.status === 'approved' && <IconCheck size={13} />}
        {STATUS_LABEL[review.status]}
      </button>

      {isReviewer && (
        <span className="review-verdict-actions">
          <button
            type="button"
            className={`btn${pendingVerdict ? ' btn-primary' : ''}`}
            title={
              softWarn
                ? `${String(openCount)} comment${openCount === 1 ? '' : 's'} still open — you can still approve`
                : 'Approve this version'
            }
            onClick={() => {
              submit('approved');
            }}
          >
            <IconCheck size={14} />
            Approve
          </button>
          <button
            type="button"
            className="btn"
            title="Request changes on this version"
            onClick={() => {
              submit('changes_requested');
            }}
          >
            <IconMessage size={14} />
            Request changes
          </button>
        </span>
      )}

      {open && (
        <div className="review-panel" data-testid="review-panel">
          <div className="share-panel-head">
            <strong>Sign-off</strong>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label="Close review"
              onClick={() => {
                setOpen(false);
              }}
            >
              <IconX />
            </button>
          </div>

          {error && (
            <div className="banner-error" role="alert">
              {error}
            </div>
          )}

          {softWarn && (
            <p className="help-text" data-testid="soft-gate-warning">
              {openCount} open comment{openCount === 1 ? '' : 's'} — approving now leaves them
              unaddressed.
            </p>
          )}

          {isReviewer && (
            <div className="review-section">
              <label className="sidebar-heading" htmlFor="review-note">
                Add a note (optional)
              </label>
              <textarea
                id="review-note"
                className="review-note"
                rows={2}
                placeholder="Context for your verdict…"
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </div>
          )}

          <ul className="review-reviewer-list">
            {review.requests.map((r) => {
              const verdict = review.approvals.find((a) => a.reviewerUserId === r.reviewerUserId);
              return (
                <li key={r.id} className="review-reviewer">
                  <span>{r.reviewerName || r.reviewerEmail}</span>
                  <span className={`review-chip review-chip--${verdict?.verdict ?? 'in_review'}`}>
                    {verdict
                      ? verdict.verdict === 'approved'
                        ? 'Approved'
                        : 'Changes requested'
                      : 'Awaiting'}
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-danger"
                      title="Remove this reviewer"
                      onClick={() => {
                        run(() => api.revokeReviewRequest(documentId, r.id));
                      }}
                    >
                      <IconTrash size={14} />
                    </button>
                  )}
                </li>
              );
            })}
            {review.requests.length === 0 && (
              <li className="help-text">No reviewers requested yet.</li>
            )}
          </ul>

          {canManage && (
            <div className="review-section">
              <div className="sidebar-heading">Request a reviewer</div>
              <div className="share-controls">
                <select
                  aria-label="Reviewer"
                  value={pickedReviewer}
                  onChange={(e) => {
                    setPickedReviewer(e.target.value);
                  }}
                >
                  <option value="">Choose reviewer…</option>
                  {orgUsers.length > 0 && (
                    <optgroup label="Members">
                      {orgUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName || u.email}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {guests.length > 0 && (
                    <optgroup label="Guests">
                      {guests.map((g) => (
                        <option key={g.userId} value={g.userId}>
                          {g.email} (guest)
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pickedReviewer === ''}
                  title="Request this reviewer"
                  onClick={() => {
                    run(() => api.requestReview(documentId, pickedReviewer));
                    setPickedReviewer('');
                  }}
                >
                  Request
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
