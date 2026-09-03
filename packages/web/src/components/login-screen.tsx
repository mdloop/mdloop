import { useEffect } from 'react';
import type { JSX } from 'react';
import { LOGIN_URL } from '../api/client.js';
import { apiErrorCopy } from '../api/error-copy.js';
import { VorlynMark } from './vorlyn-mark.js';

export interface LoginScreenProps {
  /**
   * Code from `?authError=` (Phase 38.C): `/api/auth/callback` used to send
   * a sign-in failure — expired invite, seat cap, disposable email, JIT
   * denial — as a bare JSON body in the browser. It now redirects back here
   * with the code in the query string instead, and this renders the same
   * sentence `error-copy.ts` would give any other surface. `null` when there
   * is nothing to report (the common case).
   */
  authError?: string | null;
}

export function LoginScreen({ authError = null }: LoginScreenProps): JSX.Element {
  // Query string is presentation state, not navigation state — strip it so
  // a refresh or a bookmark of this exact URL doesn't replay a stale error.
  useEffect(() => {
    if (authError) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [authError]);

  return (
    <div className="login">
      <div className="login-card">
        <h1>
          <VorlynMark size={36} />
          vorlyn
        </h1>
        <p className="login-tagline">Publish. Review. Revise. Repeat.</p>
        {authError && (
          <p className="banner-error" role="alert">
            {apiErrorCopy(authError)}
          </p>
        )}
        <a className="btn btn-primary" href={LOGIN_URL}>
          Sign in
        </a>
      </div>
    </div>
  );
}
