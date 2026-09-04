import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from './client.js';
import { API_ERROR_COPY, apiErrorCopy, errorCopy } from './error-copy.js';

describe('apiErrorCopy', () => {
  it('maps a known code to a sentence', () => {
    expect(apiErrorCopy('seat_cap_reached')).toBe(
      'Your plan is out of seats — upgrade to invite more.',
    );
  });

  it('falls back generically for an unmapped code, never echoing it', () => {
    const copy = apiErrorCopy('some_code_nobody_mapped');
    expect(copy).toBe('Something went wrong — try again.');
    expect(copy).not.toContain('some_code_nobody_mapped');
  });

  it('prefers the call site fallback over the generic one for an unmapped code', () => {
    expect(
      apiErrorCopy('some_code_nobody_mapped', { fallback: 'Could not send the invite.' }),
    ).toBe('Could not send the invite.');
  });

  it('lets a surface override one code without forking the whole map', () => {
    const overrides = {
      seat_cap_reached: "This org's plan is out of seats — raise its tier first.",
    };
    expect(apiErrorCopy('seat_cap_reached', { overrides })).toBe(
      "This org's plan is out of seats — raise its tier first.",
    );
    // Everything else still comes from the shared map.
    expect(apiErrorCopy('invalid_tier', { overrides })).toBe('Not a valid tier.');
  });

  it('never renders a raw code as its own copy', () => {
    for (const [code, copy] of Object.entries(API_ERROR_COPY)) {
      expect(copy).not.toContain(code);
      expect(copy).not.toContain('Request failed');
    }
  });
});

describe('errorCopy', () => {
  it('resolves an ApiError through the map', () => {
    expect(errorCopy(new ApiError(403, 'forbidden'))).toBe('You do not have access to do that.');
  });

  it('gives a non-ApiError throw the fallback, never its message', () => {
    const boom = new Error('fetch failed: https://internal.example/orgs/abc');
    const copy = errorCopy(boom, { fallback: 'Could not purge this organization.' });
    expect(copy).toBe('Could not purge this organization.');
    expect(copy).not.toContain('internal.example');
  });

  it('handles a thrown non-Error too', () => {
    expect(errorCopy('nope')).toBe('Something went wrong — try again.');
  });
});

/**
 * Drift guard (Phase 34.B): eight tier/cap codes went unmapped from Phase 33
 * straight through to production with zero test noticing — an unmapped code
 * silently falls through to the generic "Something went wrong" copy, which
 * is actively wrong advice for e.g. a cap breach ("upgrade your plan" is the
 * actual answer). This scans every `packages/api/src/routes/*.ts` file for
 * `error: '<code>'` literals and fails if one has no entry here.
 *
 * One code is deliberately excluded — it never reaches the SPA's fetch
 * wrapper (`ApiError` in client.ts) as a JSON body at all, so it cannot be
 * routed through `errorCopy`:
 *  - `invalid_oauth_state` (auth-routes.ts, admin-routes.ts): the browser
 *    hits `/auth/callback` as a top-level navigation during the WorkOS
 *    round trip, not a `fetch()` call this app's client wraps.
 * (`invalid_signature`, the Stripe webhook's own equivalent exclusion, went
 * with billing-routes.ts in the S4 billing-removal spike — nothing left to
 * exclude it for.)
 */
describe('API_ERROR_COPY has no drift against the codes the API can actually return', () => {
  const NEVER_JSON_FETCHED = new Set(['invalid_oauth_state']);

  it("every `error: '<code>'` literal in packages/api/src/routes is mapped", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const routesDir = path.join(here, '../../../api/src/routes');
    const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0); // the scan itself didn't silently find nothing

    const found = new Set<string>();
    const codeLiteral = /error:\s*'([a-z_]+)'/g;
    for (const file of files) {
      const text = readFileSync(path.join(routesDir, file), 'utf8');
      for (const match of text.matchAll(codeLiteral)) {
        const code = match[1];
        if (code !== undefined) found.add(code);
      }
    }

    const unmapped = [...found]
      .filter((code) => !NEVER_JSON_FETCHED.has(code))
      .filter((code) => !(code in API_ERROR_COPY));
    expect(unmapped).toEqual([]);
  });
});
