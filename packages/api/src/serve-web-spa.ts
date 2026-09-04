import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { firstExistingRelative } from '@mdloop/shared';

/**
 * Serving the built web SPA out of the API process — the single-process
 * default for both self-host composition roots (`selfhost-main.ts`'s
 * real-Postgres deploy and `selfhost-embedded-main.ts`'s PGlite-backed
 * `mdloop open`).
 *
 * Extracted here for the same reason as `selfhost-server-deps.ts`: the two
 * entrypoints previously carried this block hand-copied byte for byte, and a
 * guard added to one copy would silently not exist in the other.
 */

/**
 * Where `packages/web/dist` (or its published-package equivalent) can be
 * found, relative to *this module's own compiled location* — the same
 * candidate-list idiom `packages/cli/src/local-instance.ts`'s embedded
 * entrypoint lookup uses, and for the same reason: a single hard-coded
 * `../../web/dist` hop only works inside this monorepo. Checked in order:
 *
 *  1. Monorepo — this file compiles to `packages/api/dist/serve-web-spa.js`
 *     (or, unbuilt, `packages/api/src/serve-web-spa.ts`); the SPA lives at
 *     `packages/web/dist`, two levels up and back down.
 *  2. Installed (bundled) package — this file *is*
 *     `dist/api/selfhost-embedded-main.js` (esbuild inlines this module into
 *     it), and the SPA sits at `dist/web/`, a sibling of `dist/api/`.
 *
 * `fromUrl` is a parameter, not a hardcoded `import.meta.url`, so this stays
 * unit-testable without touching this repo's own real `packages/web/dist`.
 */
export function webDistCandidates(fromUrl: string = import.meta.url): string[] {
  const here = path.dirname(fileURLToPath(fromUrl));
  return [path.resolve(here, '../../web/dist'), path.resolve(here, '../web')];
}

/**
 * Gated so an operator fronting mdloop with their own reverse proxy/static
 * host can disable this and skip shipping the SPA build into this process at
 * all. Default: serve.
 */
export function webSpaServingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MDLOOP_SERVE_WEB ?? 'true').trim() !== 'false';
}

/**
 * Picks whichever of `webDistCandidates()` actually holds a built SPA, and
 * refuses to boot a UI-serving process that has none. Built on the same
 * `firstExistingRelative` idiom `packages/cli/src/local-instance.ts` uses
 * for its embedded entrypoints — one shared implementation of "try these
 * candidate paths in order, fail loud naming all of them" rather than two
 * hand-rolled loops.
 *
 * A candidate *directory* existing is not enough — `packages/web`'s
 * tsconfig sets `emitDeclarationOnly`, so `tsc --build` (i.e.
 * `pnpm typecheck`, and `make build` with it) populates `packages/web/dist`
 * with nothing but `.d.ts` files. `@fastify/static` would register against
 * that happily; every SPA route would just 404. So `exists` here checks for
 * `candidate/index.html` specifically, not just the directory, in both the
 * monorepo and installed candidate.
 *
 * Loud on purpose: a mdloop that answers `/readyz` while serving no web app
 * is the exact silent-degradation this codebase refuses elsewhere.
 */
export async function resolveWebDist(
  candidates: readonly string[] = webDistCandidates(),
  hasIndexHtml: (candidate: string) => boolean = (candidate) =>
    existsSync(path.join(candidate, 'index.html')),
): Promise<string> {
  return firstExistingRelative(
    candidates,
    'a built web SPA (see "pnpm build", or set MDLOOP_SERVE_WEB=false if a reverse proxy or ' +
      'static host serves the web UI instead — "pnpm typecheck"/"tsc --build" alone only emits ' +
      '.d.ts files for @mdloop/web, never the actual "vite build" output)',
    (candidate) => Promise.resolve(hasIndexHtml(candidate)),
  );
}

/**
 * Registers static serving plus the SPA history fallback. `/api/*` is
 * registered as a literal Fastify prefix (server.ts) so the `/api/` check
 * correctly discriminates real API routes from SPA client-side routes.
 *
 * `@fastify/static` is pinned to ^10.1.3+ in package.json — earlier versions
 * resolve 4 known high-severity path-traversal advisories (spike finding).
 */
export async function registerWebSpa(server: FastifyInstance): Promise<void> {
  const webDist = await resolveWebDist();
  await server.register(fastifyStatic, { root: webDist, wildcard: false });
  server.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      void reply.code(404).send({ error: 'not_found' });
      return;
    }
    void reply.sendFile('index.html');
  });
}
