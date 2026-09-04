import type { JSX } from 'react';
import { LOGIN_URL } from '../api/client.js';
import { MdloopMark } from './mdloop-mark.js';
import { IconArrowLeft } from './icons.js';

export interface InviteAcceptProps {
  token: string;
  onBack: () => void;
}

/**
 * In-app landing for an invite link — both the primary destination an
 * invite email now opens (Phase 38.C: previously the email linked straight
 * to WorkOS, skipping our branding entirely for the common, anonymous case)
 * and the fallback for one opened while already signed in (e.g. pasted into
 * the address bar, or clicked from another tab). Rendered ahead of the
 * anonymous-session gate in `app.tsx` for exactly that reason — it needs no
 * session of its own. The real redemption happens server-side through the
 * hosted-auth round trip — this page just hands the browser off to it.
 * There's no endpoint to preview invite details (email/role) without
 * redeeming, so we keep the copy generic and honest about that.
 */
export function InviteAccept({ token, onBack }: InviteAcceptProps): JSX.Element {
  const acceptUrl = `${LOGIN_URL}?invite=${encodeURIComponent(token)}`;

  return (
    <div className="login">
      <div className="login-card">
        <h1>
          <MdloopMark size={36} />
          mdloop
        </h1>
        <p className="login-tagline">You've been invited to join an organization.</p>
        <p className="help-text">
          Continuing will take you through sign-in to finish joining. If the invite was already used
          or has expired, you'll see that on the next screen.
        </p>
        <a
          className="btn btn-primary"
          href={acceptUrl}
          data-testid="invite-accept-continue"
          style={{ marginTop: 16 }}
        >
          Continue
        </a>
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost" title="Back to mdloop" onClick={onBack}>
            <IconArrowLeft size={14} />
            Back to mdloop
          </button>
        </div>
      </div>
    </div>
  );
}
