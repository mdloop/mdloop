import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

/** Same escape hatch as comment-search-mentions.spec.ts / public-hub.spec.ts:
 *  the SPA's own fetch client reads this non-httpOnly cookie and rides it as
 *  a header on every mutation; a raw `page.request` call has to do the same
 *  by hand since it bypasses that client entirely. */
async function csrfHeader(page: Page): Promise<{ 'x-csrf-token': string }> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'mdloop_csrf');
  if (!csrf) throw new Error('no mdloop_csrf cookie — not signed in?');
  return { 'x-csrf-token': csrf.value };
}

async function createProject(page: Page, name: string): Promise<string> {
  const res = await page.request.post('/api/projects', {
    headers: await csrfHeader(page),
    data: { name },
  });
  if (!res.ok()) throw new Error(`create project failed: ${res.status()}`);
  const project = (await res.json()) as { id: string };
  return project.id;
}

/** REST document upload never accepts `path` — only the MCP `upload_document`
 *  tool can set it (Document.path is CLI-owned, CONSTITUTION.md §3), so a
 *  real browser-driven upload can never produce a path-backed doc for this
 *  spec to read. Seeded directly through the use case via the e2e-only
 *  `/test-support/seed-document-path` route (see e2e-main.ts), same escape
 *  hatch `/test-support/seed-member-comment` already established. */
async function seedPathDoc(
  page: Page,
  input: { title: string; path: string; projectId: string },
): Promise<string> {
  const res = await page.request.post('/api/test-support/seed-document-path', {
    data: {
      title: input.title,
      content: `# ${input.title}\n`,
      path: input.path,
      projectId: input.projectId,
    },
  });
  if (!res.ok()) throw new Error(`seed-document-path failed: ${res.status()}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/** The tree view has no delete affordance by design (minimal, click-to-open
 *  rows) — cleanup for seeded tree docs goes through the real DELETE route
 *  instead of the UI. */
async function deleteDocument(page: Page, id: string): Promise<void> {
  const res = await page.request.delete(`/api/documents/${id}`, {
    headers: await csrfHeader(page),
  });
  if (!res.ok()) throw new Error(`delete document failed: ${res.status()}`);
}

/**
 * Phase 29 web half exit gate: the project tree renders folders from seeded
 * repo paths, its collapse state survives a reload, and a project with only
 * manually-uploaded (no-path) docs keeps showing today's flat list.
 */
test('project tree renders folders, persists collapse, and falls back for path-less projects', async ({
  page,
}) => {
  await login(page);

  const treeProjectId = await createProject(page, 'Tree Project');
  const authId = await seedPathDoc(page, {
    title: 'auth.md',
    path: 'docs/specs/auth.md',
    projectId: treeProjectId,
  });
  const setupId = await seedPathDoc(page, {
    title: 'setup.md',
    path: 'docs/guide/setup.md',
    projectId: treeProjectId,
  });

  await page.reload();
  // Scoped to the sidebar rail: Phase 33.F/G later added a second, functionally
  // equivalent "Open <project>" entry point on the home lane's group header,
  // which shares this same accessible name and would otherwise make this
  // locator ambiguous (strict-mode violation).
  const lanes = page.getByRole('navigation', { name: 'Lanes' });
  await lanes.getByRole('button', { name: /^Tree Project/ }).click();
  await expect(page.getByRole('heading', { name: 'Tree Project' })).toBeVisible();

  // Folders from the seeded paths, not a flat list of the two documents.
  await expect(page.getByText('docs', { exact: true })).toBeVisible();
  await expect(page.getByText('specs', { exact: true })).toBeVisible();
  await expect(page.getByText('guide', { exact: true })).toBeVisible();
  await expect(page.getByText('auth.md')).toBeVisible();
  await expect(page.getByText('setup.md')).toBeVisible();

  // Collapse the "docs" folder — its children drop out of view.
  await page.getByTitle('docs', { exact: true }).click();
  await expect(page.getByText('specs', { exact: true })).not.toBeVisible();
  await expect(page.getByText('auth.md')).not.toBeVisible();

  // Collapse state is keyed by project id in localStorage, so it survives a
  // full reload without the server remembering anything.
  await page.reload();
  await lanes.getByRole('button', { name: /^Tree Project/ }).click();
  await expect(page.getByRole('heading', { name: 'Tree Project' })).toBeVisible();
  await expect(page.getByText('specs', { exact: true })).not.toBeVisible();

  // A project with only manually-uploaded (no-path) documents still gets
  // today's flat, checkbox-driven list — the fallback path.
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Flat Project');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Flat Project', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Flat Project/ }).click();
  await expect(page.getByRole('heading', { name: 'Flat Project' })).toBeVisible();

  await page
    .getByTestId('file-input')
    .setInputFiles([
      { name: 'readme.md', mimeType: 'text/markdown', buffer: Buffer.from('# Readme\n') },
    ]);
  await expect(page.getByText('readme.md')).toBeVisible();
  // The flat list's per-row kebab menu — absent from the tree view entirely —
  // is the clearest signal this project fell back to DocumentList.
  await expect(page.getByLabel('More actions for readme.md')).toBeVisible();

  // Cleanup: leave documents empty for later specs sharing this org/server
  // (the two projects themselves are left in place — homepage.spec.ts's
  // "Ops" project sets that same precedent, only documents get swept).
  await page.getByRole('button', { name: 'More actions for readme.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();

  await deleteDocument(page, authId);
  await deleteDocument(page, setupId);
});
