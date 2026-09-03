import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Vite's default envDir is its own project root (packages/web/), but this
  // repo keeps a single .env at the monorepo root (same file api/mcp read
  // via plain process.env) — without this, VITE_-prefixed vars there are
  // silently invisible to Vite no matter how many times the dev server
  // restarts. Found via a VITE_-prefixed var (Phase 38.B, now removed with
  // the billing vertical) never reaching import.meta.env.
  envDir: '../..',
  server: {
    proxy: {
      // The SPA talks same-origin `/api/*`; dev + e2e proxy to the API
      // server. packages/api/src/server.ts genuinely mounts routes under
      // `/api` in Fastify itself, and that's a pure passthrough in prod too,
      // so no rewrite here: the path the browser calls is the literal path
      // the origin matches, same shape in dev and prod.
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: false,
      },
      // Public Docs Hub (ADR 0004): its own top-level surface, not nested
      // under /api — it gets a distinct cache policy in prod (60s edge TTL
      // vs /api/*'s no caching).
      '/public': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
