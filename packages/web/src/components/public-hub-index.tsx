import { useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { api } from '../api/client.js';

interface PublicDocSummary {
  slug: string;
  title: string;
  publishedAt: string;
}

interface PublicSearchHit {
  slug: string;
  title: string;
  snippet: string;
}

export interface PublicHubIndexProps {
  onOpenDoc: (slug: string) => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The server's snippet is `ts_headline` output delimited with
 * `«`/`»` (see pg-repositories.ts `search()`) rather than HTML — there is no
 * markup to sanitize, but we still avoid `dangerouslySetInnerHTML` and split
 * the delimiters ourselves into plain React nodes so a `<mark>` highlight
 * never depends on trusting server-provided markup.
 */
function renderSnippet(snippet: string): ReactNode[] {
  const parts = snippet.split(/(«[^»]*»)/g);
  return parts.map((part, i) => {
    const m = /^«([^»]*)»$/.exec(part);
    if (m) return <mark key={i}>{m[1]}</mark>;
    return <span key={i}>{part}</span>;
  });
}

/**
 * Public Docs Hub index (ADR 0004 / Phase 22): anonymous, read-only landing
 * page — lists published docs and offers full-text search over them. No
 * session, no comments, no tenant chrome. Locked to light mode along with
 * `PublicDocViewer` for a consistent "public site" identity distinct from
 * the authenticated app (see app.tsx `hub`/`hub-doc` routes).
 */
export function PublicHubIndex({ onOpenDoc }: PublicHubIndexProps): JSX.Element {
  const [docs, setDocs] = useState<PublicDocSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PublicSearchHit[] | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    api
      .getPublicDocs()
      .then((res) => {
        setDocs(res.docs);
      })
      .catch(() => {
        setLoadFailed(true);
      });
  }, []);

  // Debounced search — same shape as AppHeader's document search.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) {
      setHits(null);
      return;
    }
    const seq = (searchSeq.current += 1);
    const timer = window.setTimeout(() => {
      api
        .searchPublicDocs(q)
        .then((res) => {
          if (searchSeq.current === seq) setHits(res.hits);
        })
        .catch(() => {
          if (searchSeq.current === seq) setHits([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const searching = query.trim().length > 0;

  return (
    <div className="hub hub-light">
      <div className="hub-header">
        <h1 className="hub-title">Public docs</h1>
        <p className="hub-tagline">Documents this organization has chosen to publish.</p>
        <input
          type="search"
          className="hub-search"
          placeholder="Search public docs…"
          aria-label="Search public docs"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
        />
      </div>

      {searching ? (
        hits === null ? (
          <p className="hub-empty">Searching…</p>
        ) : hits.length === 0 ? (
          <p className="hub-empty">No matches.</p>
        ) : (
          <ul className="hub-list" role="list">
            {hits.map((hit) => (
              <li key={hit.slug}>
                <button
                  type="button"
                  className="hub-list-item"
                  onClick={() => {
                    onOpenDoc(hit.slug);
                  }}
                >
                  <span className="hub-list-title">{hit.title}</span>
                  <span className="hub-list-snippet">{renderSnippet(hit.snippet)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : docs === null ? (
        <p className="hub-empty">
          {loadFailed ? "Couldn't load documents. Refresh to retry." : 'Loading…'}
        </p>
      ) : docs.length === 0 ? (
        <p className="hub-empty">No public documents yet.</p>
      ) : (
        <ul className="hub-list" role="list">
          {docs.map((doc) => (
            <li key={doc.slug}>
              <button
                type="button"
                className="hub-list-item"
                onClick={() => {
                  onOpenDoc(doc.slug);
                }}
              >
                <span className="hub-list-title">{doc.title}</span>
                <span className="hub-list-date">{formatDate(doc.publishedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
