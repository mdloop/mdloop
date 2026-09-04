import { describe, expect, it } from 'vitest';
import { resolveWebDist, webDistCandidates, webSpaServingEnabled } from './serve-web-spa.js';

describe('webSpaServingEnabled', () => {
  it('defaults to serving when MDLOOP_SERVE_WEB is unset', () => {
    expect(webSpaServingEnabled({})).toBe(true);
  });

  it('serves for any value other than the literal "false"', () => {
    expect(webSpaServingEnabled({ MDLOOP_SERVE_WEB: 'true' })).toBe(true);
    expect(webSpaServingEnabled({ MDLOOP_SERVE_WEB: '' })).toBe(true);
    expect(webSpaServingEnabled({ MDLOOP_SERVE_WEB: 'no' })).toBe(true);
  });

  it('stands down on "false", tolerating surrounding whitespace', () => {
    expect(webSpaServingEnabled({ MDLOOP_SERVE_WEB: 'false' })).toBe(false);
    expect(webSpaServingEnabled({ MDLOOP_SERVE_WEB: '  false  ' })).toBe(false);
  });
});

describe('webDistCandidates', () => {
  it('lists the monorepo path, then the installed-package path, relative to the caller', () => {
    // Modelling dist/api/selfhost-embedded-main.js inside an installed
    // `mdloop` package rooted at /pkg: the monorepo-shaped candidate (two
    // levels up + web/dist) lands outside /pkg entirely — it's the
    // installed-shaped candidate (one level up + web) that matches this
    // layout's real packages/mdloop/dist/web/.
    const candidates = webDistCandidates('file:///pkg/dist/api/selfhost-embedded-main.js').map(
      (c) => c.replace(/\\/g, '/'),
    );
    expect(candidates).toEqual(['/pkg/web/dist', '/pkg/dist/web']);
  });

  it('resolves the monorepo candidate relative to the real compiled api directory by default', () => {
    expect(webDistCandidates()[0]?.replace(/\\/g, '/')).toMatch(/packages\/web\/dist$/);
  });
});

describe('resolveWebDist', () => {
  it('returns the first candidate whose index.html is present', async () => {
    const result = await resolveWebDist(['/a', '/b'], (c) => c === '/b');
    expect(result).toBe('/b');
  });

  /**
   * The exact regression this guard exists for: `tsc --build` populates
   * packages/web/dist with .d.ts files only, so the directory exists and
   * @fastify/static registers happily — there is just no index.html to serve.
   * A directory-existence check would pass here; only the index.html check
   * catches it.
   */
  it('does not treat a bare existing directory as built — only index.html counts', async () => {
    await expect(resolveWebDist(['/w'], () => false)).rejects.toThrow();
  });

  it('names every candidate tried and how to fix it, when none are built', async () => {
    await expect(
      resolveWebDist(['/some/where/web/dist', '/dist/web'], () => false),
    ).rejects.toThrow(/pnpm build.*MDLOOP_SERVE_WEB=false.*\/some\/where\/web\/dist.*\/dist\/web/s);
  });
});
