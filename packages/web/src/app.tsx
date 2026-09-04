import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api } from './api/client.js';
import type { Me } from './api/client.js';
import { InviteAccept } from './components/invite-accept.js';
import { LoginScreen } from './components/login-screen.js';
import { OrgSettings } from './components/org-settings.js';
import { Shell } from './components/shell.js';
import { ThemeToggle } from './components/theme-toggle.js';
import { BrandMark } from './components/brand-mark.js';
import { Viewer } from './components/viewer.js';
import { IconArrowLeft } from './components/icons.js';
import { useTheme } from './theme.js';

// Lazy: unauthenticated hub browsing is not code the average signed-in
// session ever executes — split out so it isn't paid for on every load.
const PublicHubIndex = lazy(() =>
  import('./components/public-hub-index.js').then((m) => ({ default: m.PublicHubIndex })),
);
const PublicDocViewer = lazy(() =>
  import('./components/public-doc-viewer.js').then((m) => ({ default: m.PublicDocViewer })),
);

type Session = { state: 'loading' } | { state: 'anonymous' } | { state: 'signed-in'; me: Me };

export type Route =
  | { kind: 'home' }
  | { kind: 'document'; id: string; commentId: string | null }
  | { kind: 'share'; token: string }
  | { kind: 'guest'; token: string }
  | { kind: 'settings'; section: 'org' }
  | { kind: 'invite-accept'; token: string }
  | { kind: 'hub' }
  | { kind: 'hub-doc'; slug: string }
  | { kind: 'not-found' };

/**
 * Routes: `/`, `/d/:id/:slug?#c=:commentId` (viewer deep link), `/s/:token/:slug?`
 * (share link), `/settings` and its sub-route `/settings/org` (the unified
 * settings shell, Phase 39.A; bare `/settings` defaults to the org section —
 * billing was removed as a settings section in the S4 billing-removal spike),
 * `/invite/accept?token=` (in-app landing for an invite link — both the
 * primary destination emailed invites now open on, and the fallback for one
 * opened while already signed in, e.g. pasted into the address bar — the
 * trailing slug on share links is cosmetic only, derived from the document
 * title at share time, never looked up or validated — the id/token before it
 * is the sole authority), `/hub`, `/hub/:slug` (Public Docs Hub, ADR 0004 —
 * genuinely unauthenticated, no session dependency at all), and
 * anything else (`not-found`, Phase 38.C) — previously fell through to
 * `home` silently; a typo or dead link now gets an honest page instead of a
 * confusing one.
 */
export function routeFromLocation(): Route {
  const path = window.location.pathname;
  const share = /^\/s\/([^/]+)(?:\/[^/]*)?$/.exec(path);
  if (share?.[1]) return { kind: 'share', token: share[1] };
  const guest = /^\/g\/([^/]+)$/.exec(path);
  if (guest?.[1]) return { kind: 'guest', token: guest[1] };
  if (path === '/settings/org' || path === '/settings') {
    return { kind: 'settings', section: 'org' };
  }
  if (path === '/invite/accept') {
    const token = new URLSearchParams(window.location.search).get('token');
    return token ? { kind: 'invite-accept', token } : { kind: 'not-found' };
  }
  if (path === '/hub') return { kind: 'hub' };
  const hubDoc = /^\/hub\/([^/]+)$/.exec(path);
  if (hubDoc?.[1]) return { kind: 'hub-doc', slug: hubDoc[1] };
  const m = /^\/d\/([^/]+)(?:\/[^/]*)?$/.exec(path);
  if (m?.[1]) {
    const c = /(?:^|[#&])c=([^&]+)/.exec(window.location.hash);
    return { kind: 'document', id: m[1], commentId: c?.[1] ?? null };
  }
  if (path === '/') return { kind: 'home' };
  return { kind: 'not-found' };
}

/**
 * Redeems a guest-share token (Phase 18): unauthenticated — the server mints
 * a guest session cookie, then we reload into the document.
 */
function GuestRedeemer({ token }: { token: string }): JSX.Element {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .redeemGuestShare(token)
      .then(({ documentId }) => {
        // Full reload so the app boots with the fresh guest session.
        window.location.replace(`/d/${documentId}`);
      })
      .catch(() => {
        setFailed(true);
      });
  }, [token]);

  if (failed) {
    return (
      <div className="viewer-missing empty">
        <h3>This guest link doesn't work</h3>
        <p>It may have expired, been revoked, or external sharing was turned off.</p>
      </div>
    );
  }
  return <div />;
}

/** Redeems a share token, then routes to the document (or home on failure). */
function ShareRedeemer({
  token,
  onDone,
}: {
  token: string;
  onDone: (documentId: string | null) => void;
}): JSX.Element {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .redeemShare(token)
      .then(({ documentId }) => {
        onDone(documentId);
      })
      .catch(() => {
        setFailed(true);
      });
  }, [token, onDone]);

  if (failed) {
    return (
      <div className="viewer-missing empty">
        <h3>This link doesn't work</h3>
        <p>It may have been revoked, or it belongs to a different organization.</p>
        <button
          type="button"
          className="btn"
          title="Back to documents"
          onClick={() => {
            onDone(null);
          }}
        >
          <IconArrowLeft size={14} />
          Back to documents
        </button>
      </div>
    );
  }
  return <div />;
}

export function App(): JSX.Element {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [route, setRoute] = useState<Route>(routeFromLocation);
  const { mode, setMode, dark } = useTheme();

  useEffect(() => {
    api
      .me()
      .then((me) => {
        setSession({ state: 'signed-in', me });
      })
      .catch((e: unknown) => {
        void e;
        setSession({ state: 'anonymous' });
      });
  }, []);

  useEffect(() => {
    const onPop = (): void => {
      setRoute(routeFromLocation());
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, '', path);
    setRoute(routeFromLocation());
  }, []);

  if (session.state === 'loading') return <div />;

  // Unmatched path (Phase 38.C): no session dependency, same footing as
  // guest/hub below — render it before anything asks what session we have.
  if (route.kind === 'not-found') {
    return (
      <>
        <BrandMark
          onClick={() => {
            navigate('/');
          }}
        />
        <ThemeToggle mode={mode} setMode={setMode} floating />
        <div className="viewer-missing empty">
          <h3>Page not found</h3>
          <p>That page doesn't exist — check the link, or head back home.</p>
          <button
            type="button"
            className="btn"
            title="Back to mdloop"
            onClick={() => {
              navigate('/');
            }}
          >
            <IconArrowLeft size={14} />
            Back to mdloop
          </button>
        </div>
      </>
    );
  }

  // Guest redemption needs no session — the token mints one.
  if (route.kind === 'guest') {
    return (
      <>
        <BrandMark
          onClick={() => {
            navigate('/');
          }}
        />
        <ThemeToggle mode={mode} setMode={setMode} floating />
        <GuestRedeemer token={route.token} />
      </>
    );
  }

  // Public Docs Hub (ADR 0004): genuinely unauthenticated — no cookie is
  // ever sent, and these routes must render whether or not a session
  // resolves. Locked to light mode (see .hub-light in styles.css) for a
  // consistent "public site" identity distinct from the app chrome, so no
  // ThemeToggle here — there is nothing for it to toggle.
  if (route.kind === 'hub') {
    return (
      <>
        <BrandMark
          onClick={() => {
            navigate('/');
          }}
        />
        <Suspense fallback={<div />}>
          <PublicHubIndex
            onOpenDoc={(slug) => {
              navigate(`/hub/${slug}`);
            }}
          />
        </Suspense>
      </>
    );
  }

  if (route.kind === 'hub-doc') {
    return (
      <>
        <BrandMark
          onClick={() => {
            navigate('/');
          }}
        />
        <Suspense fallback={<div />}>
          <PublicDocViewer
            slug={route.slug}
            onBack={() => {
              navigate('/hub');
            }}
          />
        </Suspense>
      </>
    );
  }

  // Ahead of the anonymous gate (Phase 38.C fix): this is now the primary
  // landing for an emailed invite link, not just the already-signed-in
  // fallback its docstring used to describe — most invitees are anonymous,
  // so gating it behind `session.state === 'anonymous'` returning
  // LoginScreen first silently dropped the token for exactly the common
  // case. The card itself needs no session; it only builds a link.
  if (route.kind === 'invite-accept') {
    return (
      <>
        <BrandMark
          onClick={() => {
            navigate('/');
          }}
        />
        <ThemeToggle mode={mode} setMode={setMode} floating />
        <InviteAccept
          token={route.token}
          onBack={() => {
            navigate('/');
          }}
        />
      </>
    );
  }

  if (session.state === 'anonymous') {
    // LoginScreen carries its own logo/wordmark in the card — the floating
    // corner BrandMark every other pre-auth screen uses would just duplicate it.
    return (
      <>
        <ThemeToggle mode={mode} setMode={setMode} floating />
        <LoginScreen authError={new URLSearchParams(window.location.search).get('authError')} />
      </>
    );
  }

  // Guest chrome (Phase 18): viewer only — no home, no org surface.
  if (session.me.role === 'guest') {
    if (route.kind === 'document') {
      return (
        <>
          <div className="banner-info guest-banner" role="status">
            Guest access — you can see only this document.
          </div>
          <Viewer
            documentId={route.id}
            deepLinkCommentId={route.commentId}
            me={session.me}
            dark={dark}
            mode={mode}
            setMode={setMode}
            onBack={() => {
              /* Guests have no home to go back to. */
            }}
          />
        </>
      );
    }
    return (
      <div className="viewer-missing empty">
        <h3>Guest access</h3>
        <p>Open the link you were emailed to view the shared document.</p>
      </div>
    );
  }

  if (route.kind === 'share') {
    return (
      <>
        <BrandMark
          onClick={() => {
            navigate('/');
          }}
        />
        <ThemeToggle mode={mode} setMode={setMode} floating />
        <ShareRedeemer
          token={route.token}
          onDone={(documentId) => {
            navigate(documentId ? `/d/${documentId}` : '/');
          }}
        />
      </>
    );
  }

  const onLogout = (): void => {
    void api.logout().finally(() => {
      setSession({ state: 'anonymous' });
    });
  };

  // `section` is a singleton ('org') post billing-removal (S4 spike) — kept
  // on the Route type for a future settings section to slot back into,
  // rather than collapsed away for one call site's sake.
  if (route.kind === 'settings') {
    return (
      <OrgSettings
        me={session.me}
        mode={mode}
        setMode={setMode}
        onBack={() => {
          navigate('/');
        }}
        onOpenDocument={(id) => {
          navigate(`/d/${id}`);
        }}
        onLogout={onLogout}
      />
    );
  }

  if (route.kind === 'document') {
    return (
      <Viewer
        // Remount on document change — switching documents (search, the
        // in-viewer document switcher) is a different entity, not a prop
        // update; reusing the instance left stale doc-scoped state (selected
        // thread, diff/version view, draft anchor...) pointed at marks and
        // versions that don't exist in the new document. Hash-only nav
        // (deep-link comment id, same document) keeps the same key on
        // purpose — see the resync effect in Viewer for why that one stays
        // a prop update instead.
        key={route.id}
        documentId={route.id}
        deepLinkCommentId={route.commentId}
        me={session.me}
        dark={dark}
        mode={mode}
        setMode={setMode}
        onBack={() => {
          navigate('/');
        }}
        onOpenDocument={(id) => {
          navigate(`/d/${id}`);
        }}
        onLogout={onLogout}
        onOpenOrgSettings={() => {
          navigate('/settings/org');
        }}
      />
    );
  }

  return (
    <Shell
      me={session.me}
      mode={mode}
      setMode={setMode}
      onOpenDocument={(id) => {
        navigate(`/d/${id}`);
      }}
      onOpenOrgSettings={() => {
        navigate('/settings/org');
      }}
      onLogout={onLogout}
    />
  );
}
