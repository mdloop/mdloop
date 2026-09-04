import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { api, ApiError } from '../api/client.js';
import { IconArrowLeft } from './icons.js';
import { MarkdownView } from './markdown-view.js';
import { FeatureBoundary, FeatureFallback } from './error-boundary.js';

export interface PublicDocViewerProps {
  slug: string;
  onBack: () => void;
}

interface PublicDocMeta {
  slug: string;
  title: string;
  publishedAt: string;
  updatedAt: string;
}

type Status =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error' }
  | { kind: 'ok'; meta: PublicDocMeta; content: string };

/**
 * Public Docs Hub document view (ADR 0004 / Phase 22): anonymous, read-only
 * render of a single published document. Deliberately does not use
 * `Viewer` — no threads, composer, minimap, gutter, anchoring, or keyboard
 * shortcuts. `MarkdownView` always renders with `dark={false}` — the public
 * hub is locked to light mode regardless of the visitor's theme preference.
 */
export function PublicDocViewer({ slug, onBack }: PublicDocViewerProps): JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: 'loading' });
    Promise.all([api.getPublicDoc(slug), api.getPublicDocContent(slug)])
      .then(([meta, content]) => {
        if (cancelled) return;
        if (meta === null) {
          setStatus({ kind: 'not-found' });
          return;
        }
        setStatus({ kind: 'ok', meta, content });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setStatus({ kind: 'not-found' });
        else setStatus({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (status.kind === 'loading') {
    return (
      <div className="hub hub-light">
        <p className="hub-empty">Loading…</p>
      </div>
    );
  }

  if (status.kind === 'not-found' || status.kind === 'error') {
    return (
      <div className="hub hub-light">
        <div className="viewer-missing empty">
          <h3>
            {status.kind === 'not-found'
              ? "This document isn't published"
              : 'Could not load this document'}
          </h3>
          <p>
            {status.kind === 'not-found'
              ? 'It may have been unpublished, or the link is incorrect.'
              : 'Refresh to retry.'}
          </p>
          <button type="button" className="btn" title="Back to hub" onClick={onBack}>
            <IconArrowLeft size={14} />
            Back to hub
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="hub hub-light hub-doc">
      <button type="button" className="btn hub-back-link" title="Back to hub" onClick={onBack}>
        <IconArrowLeft size={14} />
        Back to hub
      </button>
      <div className="viewer-content-wrap">
        <div className="viewer-content">
          <h1 className="hub-doc-title">{status.meta.title}</h1>
          {/* An anonymous visitor has no session to lose and nothing else on
              the page to fall back to, so the fallback keeps the words: the
              raw markdown, under a one-line explanation. Reset on `slug` —
              navigating to another published doc always gets a fresh try. */}
          <FeatureBoundary
            source="public-doc"
            resetKey={slug}
            fallback={
              <FeatureFallback title="This document couldn't be displayed — here is its source.">
                <pre className="feature-fallback-source">
                  <code>{status.content}</code>
                </pre>
              </FeatureFallback>
            }
          >
            <MarkdownView source={status.content} dark={false} />
          </FeatureBoundary>
        </div>
      </div>
    </div>
  );
}
