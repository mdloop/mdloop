import { defineConfig, devices } from '@playwright/test';

// Deliberately off the dev-server defaults (3000/5173) so `pnpm test:e2e` never
// collides with a `pnpm dev` already running in this repo.
const API_PORT = 3100;
const WEB_PORT = 5273;

// Phase 39.F: pins responsive behavior with real Playwright runs instead of
// leaving it to a one-time manual pass. Deliberately a named subset, not
// every spec — this repo runs e2e with `workers: 1, fullyParallel: false`,
// so running the whole suite at three viewports would triple an already-
// serial run. The specs below cover the areas the responsive audit actually
// touched or flagged: Shell + the new mobile lane drawer (homepage.spec.ts,
// the headline 39.F fix), the settings rail's below-720px drill-down
// (org-settings.spec.ts), the viewer's already-best-covered mobile chrome
// (viewer.spec.ts), and the public hub — logged-out, and per the design
// plan's own note, the screen most likely to be opened on a phone from a
// shared link (public-hub.spec.ts).
const RESPONSIVE_SPECS = [
  '**/homepage.spec.ts',
  '**/org-settings.spec.ts',
  // A cross-org operator/admin console has no spec file in this repo (it is
  // not core — CONSTITUTION §7) — a glob matching zero files here would be a
  // silent no-op gate, so it's omitted rather than left dangling.
  '**/viewer.spec.ts',
  '**/public-hub.spec.ts',
];

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Chromium-based mobile emulation, not Playwright's `devices['iPhone
    // 13']`/`devices['iPad Mini']` presets — those default to WebKit, and
    // only Chromium is installed in this environment (matching `desktop`
    // above, which is Chrome-only already). Viewport + touch/mobile flags
    // are what actually exercise the CSS breakpoints under test; the exact
    // browser engine isn't the thing being pinned here.
    {
      name: 'phone',
      testMatch: RESPONSIVE_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 }, // iPhone 13-ish, the <720px band
        screen: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      },
    },
    {
      name: 'tablet',
      testMatch: RESPONSIVE_SPECS,
      use: {
        ...devices['Desktop Chrome'],
        // Portrait, the width the settings-rail contract names explicitly
        // (720–899px band) and the more common way an iPad opens a web app.
        viewport: { width: 768, height: 1024 },
        screen: { width: 768, height: 1024 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm typecheck && node packages/api/dist/e2e-main.js',
      url: `http://localhost:${String(API_PORT)}/healthz`,
      env: { PORT: String(API_PORT), WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: false,
      timeout: 120_000,
      // Without this, Playwright SIGKILLs the process group on teardown by
      // default (docs: "If unspecified, the process group is forcefully
      // SIGKILLed"), which never gives e2e-main.ts's SIGTERM handler a
      // chance to run — so the ephemeral test database and the temp blob
      // storage directory it creates are silently leaked, one of each per
      // run, forever. SIGTERM first, 5s grace period to drop the DB and
      // close the pool, then SIGKILL as a backstop if it hangs.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: `pnpm --filter @vorlyn/web dev --port ${String(WEB_PORT)} --strictPort`,
      url: `http://localhost:${String(WEB_PORT)}`,
      env: { API_PROXY_TARGET: `http://localhost:${String(API_PORT)}` },
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
