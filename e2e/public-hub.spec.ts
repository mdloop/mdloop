import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueSlug } from './unique.js';

const DOC = `# Public hub doc

Content visible to the world once published.
`;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

/** The CSRF double-submit token (Phase 24) — read straight off the
 *  non-httpOnly `vorlyn_csrf` cookie the way the SPA's own fetch client does
 *  (see api/client.ts `readCookie`), since `page.request` doesn't run that
 *  client-side echo itself. */
async function csrfHeader(page: Page): Promise<{ 'x-csrf-token': string }> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'vorlyn_csrf');
  if (!csrf) throw new Error('no vorlyn_csrf cookie — not signed in?');
  return { 'x-csrf-token': csrf.value };
}

/**
 * Public Docs Hub browse (ADR 0004 / Phase 22, e2e gap closed in Phase 24.G):
 * there is deliberately no publish button in the web UI yet (Phase 23) — the
 * only way to publish is the admin-only `POST /public-hub/documents` route
 * (packages/api/src/routes/public-hub-admin-routes.ts), gated on the actor
 * being an admin of the org configured as `PUBLIC_HUB_ORG_ID` (the e2e harness
 * pre-provisions the loopback identity's org into that config slot — see
 * e2e-main.ts). This proves: seed via that admin API, then browse `/hub` and
 * `/hub/:slug` with no session at all, and confirm the surface is genuinely
 * read-only (no Viewer, no comment/thread/anchor chrome — public-doc-viewer.tsx
 * never renders <Viewer>).
 */
test('public hub: publish via admin API, browse unauthenticated, read-only render', async ({
  page,
}) => {
  await login(page);

  // Upload a doc as the admin, then open it to read its id off the URL
  // (`/d/:id/:slug?` — app.tsx routeFromLocation).
  await page
    .getByTestId('file-input')
    .setInputFiles([
      { name: 'hub-source.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC) },
    ]);
  await page.getByRole('button', { name: 'hub-source.md', exact: true }).click();
  await expect(page.getByText('Content visible to the world')).toBeVisible();
  const docMatch = /\/d\/([^/]+)/.exec(page.url());
  if (!docMatch?.[1]) throw new Error('could not read document id from the viewer URL');
  const documentId = docMatch[1];

  // Unique per execution: this spec is one of RESPONSIVE_SPECS
  // (playwright.config.ts), so it can run up to three times
  // (desktop/phone/tablet) in one suite run against the same shared org.
  // `unpublish` hard-deletes the row and `publish` upserts on conflict
  // (packages/persistence/src/repositories/pg-repositories.ts), so a fixed
  // slug across executions is actually safe as long as this test's own
  // cleanup ran — but a unique slug per execution means it's safe even if
  // it didn't, matching the "prefer unique fixtures over relying on
  // cleanup" approach used elsewhere in this suite.
  const slug = uniqueSlug('e2e-public-hub-doc');
  const publishRes = await page.request.post('/api/public-hub/documents', {
    headers: await csrfHeader(page),
    data: { documentId, slug, title: 'Public hub doc' },
  });
  expect(publishRes.ok()).toBe(true);

  // Drop the session entirely — /hub and /hub/:slug take no cookie at all.
  await page.context().clearCookies();
  await page.goto('/hub');
  await expect(page.getByRole('heading', { name: 'Public docs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Public hub doc' })).toBeVisible();

  await page.getByRole('button', { name: 'Public hub doc' }).click();
  await expect(page).toHaveURL(new RegExp(`/hub/${slug}$`));
  // The meta title (`hub-doc-title`) renders above the markdown content,
  // which in this fixture also opens with its own `# Public hub doc` — two
  // same-text h1s by design (published title is independent of content), so
  // pin to the first (the meta title) rather than asserting a unique match.
  await expect(page.getByRole('heading', { name: 'Public hub doc' }).first()).toBeVisible();
  await expect(page.getByText('Content visible to the world once published.')).toBeVisible();

  // Read-only, no tenant chrome: PublicDocViewer never renders <Viewer>, so
  // none of its comment/thread/anchor/keyboard-shortcut affordances exist.
  await expect(page.getByTestId('thread')).toHaveCount(0);
  await expect(page.getByTestId('composer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share this document' })).toHaveCount(0);
  await expect(page.getByTestId('version-strip')).toHaveCount(0);

  // A slug with no published doc behind it is an honest "not published", not
  // a crash or a leak of unrelated content.
  await page.goto('/hub/does-not-exist');
  await expect(page.getByText("This document isn't published")).toBeVisible();

  // Cleanup: unpublish, then delete the source document, so later specs
  // sharing this org/server see the same empty home they started with.
  await login(page);
  const unpublishRes = await page.request.delete(`/api/public-hub/documents/${slug}`, {
    headers: await csrfHeader(page),
  });
  expect(unpublishRes.ok()).toBe(true);
  await page.getByRole('button', { name: 'More actions for hub-source.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});
