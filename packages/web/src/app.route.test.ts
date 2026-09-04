// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { routeFromLocation } from './app.js';

function setLocation(path: string): void {
  window.history.replaceState(null, '', path);
}

describe('routeFromLocation', () => {
  afterEach(() => {
    setLocation('/');
  });

  it('parses a bare share token', () => {
    setLocation('/s/abc123');
    expect(routeFromLocation()).toEqual({ kind: 'share', token: 'abc123' });
  });

  it('ignores a cosmetic slug appended after the share token', () => {
    setLocation('/s/abc123/q3-roadmap-draft');
    expect(routeFromLocation()).toEqual({ kind: 'share', token: 'abc123' });
  });

  it('parses a bare document id', () => {
    setLocation('/d/doc-1');
    expect(routeFromLocation()).toEqual({ kind: 'document', id: 'doc-1', commentId: null });
  });

  it('ignores a cosmetic slug appended after the document id', () => {
    setLocation('/d/doc-1/q3-roadmap-draft');
    expect(routeFromLocation()).toEqual({ kind: 'document', id: 'doc-1', commentId: null });
  });

  it('still reads the comment-id hash when a slug is present', () => {
    setLocation('/d/doc-1/q3-roadmap-draft');
    window.location.hash = '#c=comment-9';
    expect(routeFromLocation()).toEqual({ kind: 'document', id: 'doc-1', commentId: 'comment-9' });
  });

  it('parses the home route', () => {
    setLocation('/');
    expect(routeFromLocation()).toEqual({ kind: 'home' });
  });

  it('resolves to not-found for an unmatched path (Phase 38.C: no longer a silent home fallback)', () => {
    setLocation('/nonsense');
    expect(routeFromLocation()).toEqual({ kind: 'not-found' });
  });

  it('parses the org settings route', () => {
    setLocation('/settings/org');
    expect(routeFromLocation()).toEqual({ kind: 'settings', section: 'org' });
  });

  it('resolves the former billing settings route to not-found (S4 spike: billing removed)', () => {
    setLocation('/settings/billing');
    expect(routeFromLocation()).toEqual({ kind: 'not-found' });
  });

  it('defaults the bare settings route to the org section', () => {
    setLocation('/settings');
    expect(routeFromLocation()).toEqual({ kind: 'settings', section: 'org' });
  });

  it('parses an invite accept link with its token', () => {
    setLocation('/invite/accept?token=tok-abc');
    expect(routeFromLocation()).toEqual({ kind: 'invite-accept', token: 'tok-abc' });
  });

  it('resolves to not-found for an invite accept link missing a token', () => {
    setLocation('/invite/accept');
    expect(routeFromLocation()).toEqual({ kind: 'not-found' });
  });

  it('parses the public docs hub index route', () => {
    setLocation('/hub');
    expect(routeFromLocation()).toEqual({ kind: 'hub' });
  });

  it('parses a public docs hub document route with its slug', () => {
    setLocation('/hub/getting-started');
    expect(routeFromLocation()).toEqual({ kind: 'hub-doc', slug: 'getting-started' });
  });

  it('resolves the former operator admin console routes to not-found (removed, open-source release)', () => {
    setLocation('/admin');
    expect(routeFromLocation()).toEqual({ kind: 'not-found' });
    setLocation('/admin/organizations');
    expect(routeFromLocation()).toEqual({ kind: 'not-found' });
    setLocation('/admin/organizations/org-1');
    expect(routeFromLocation()).toEqual({ kind: 'not-found' });
  });
});
