/**
 * Architecture boundaries (CONSTITUTION.md §3, §5).
 * Dependency rule: web|api|mcp -> app -> domain. persistence implements app ports.
 * Nothing imports upward; domain imports nothing but itself and shared.
 *
 * Note on matching: declared workspace deps resolve through pnpm symlinks to
 * their real packages/<name> paths; undeclared ones stay as the bare
 * "@mdloop/<name>" specifier. Rules match both spellings.
 */
const pkgs = (names) => `^packages/(${names})/|(^|/)@mdloop/(${names})$`;

module.exports = {
  forbidden: [
    {
      name: 'domain-imports-nothing',
      severity: 'error',
      comment: 'domain must stay pure: no app/persistence/api/mcp/web imports',
      from: { path: '^packages/domain' },
      to: { path: pkgs('app|persistence|api|mcp|web|cli') },
    },
    {
      name: 'app-only-domain-shared',
      severity: 'error',
      comment: 'app (use-cases/ports) may import only domain and shared',
      from: { path: '^packages/app' },
      to: { path: pkgs('persistence|api|mcp|web|cli') },
    },
    {
      name: 'persistence-no-transports',
      severity: 'error',
      from: { path: '^packages/persistence' },
      to: { path: pkgs('api|mcp|web|cli') },
    },
    {
      name: 'api-isolated',
      severity: 'error',
      from: { path: '^packages/api' },
      to: { path: pkgs('mcp|web|cli') },
    },
    {
      name: 'mcp-isolated',
      severity: 'error',
      from: { path: '^packages/mcp' },
      to: { path: pkgs('api|web|cli') },
    },
    {
      name: 'web-frontend-only',
      severity: 'error',
      comment: 'web talks HTTP, never imports server packages',
      from: { path: '^packages/web' },
      to: { path: pkgs('api|mcp|persistence|app|domain|cli') },
    },
    {
      name: 'cli-http-only',
      severity: 'error',
      comment:
        'cli is an MCP HTTP client only — no app/domain/api/mcp imports. ' +
        '"mdloop open" (Phase E) is the one deliberate exception to "no server-side imports": it ' +
        'directly drives an embedded Postgres (startEmbeddedPostgres/migrate, @mdloop/persistence) ' +
        'to set up the local instance it then spawns as separate OS processes — it never imports ' +
        'app/domain/api/mcp code, only persistence. @mdloop/api is a real dependency too, but only ' +
        'for import.meta.resolve() to locate its build output on disk to spawn — a runtime string ' +
        'resolution, not a static import, so it never shows up as a graph edge here.',
      from: { path: '^packages/cli' },
      to: { path: pkgs('app|domain|api|mcp') },
    },
    {
      name: 'jobs-no-transports',
      severity: 'error',
      comment:
        'jobs is a standalone process like api/mcp (the scheduler, running against app+persistence) — it may import app/domain/shared/persistence but not any other transport',
      from: { path: '^packages/jobs' },
      to: { path: pkgs('api|mcp|web|cli') },
    },
    {
      name: 'nothing-imports-jobs',
      severity: 'error',
      comment: 'jobs is a leaf process — nothing else in the dependency graph may import it',
      from: { pathNot: '^packages/jobs' },
      to: { path: pkgs('jobs') },
    },
    {
      name: 'shared-imports-nothing',
      severity: 'error',
      from: { path: '^packages/shared' },
      to: { path: pkgs('domain|app|persistence|api|mcp|web|cli') },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Keeps generated/compiled build output (e.g. packages/web/dist/assets/
    // Vite bundle chunks, every package's own tsc dist/) out of the crawl.
    // Does NOT rely on this to hide cross-package edges — see
    // .dependency-cruiser.tsconfig.json's own comment for why that used to
    // happen and how the `paths` mapping there fixes it at the resolution
    // layer instead.
    exclude: { path: '/dist/' },
    tsPreCompilationDeps: true,
    // A dedicated resolution-only tsconfig, NOT the real build's
    // tsconfig.json (a pure project-references file with no compilerOptions
    // of its own) — see .dependency-cruiser.tsconfig.json's header comment.
    tsConfig: { fileName: '.dependency-cruiser.tsconfig.json' },
  },
};
