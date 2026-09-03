import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DOC = `# Handoff notes

Nothing interesting here yet.
`;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

async function uploadAndOpen(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('file-input')
    .setInputFiles([{ name: title, mimeType: 'text/markdown', buffer: Buffer.from(DOC) }]);
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByText('Nothing interesting here yet')).toBeVisible();
  const docMatch = /\/d\/([^/]+)/.exec(page.url());
  if (!docMatch?.[1]) throw new Error('could not read document id from the viewer URL');
  return docMatch[1];
}

/** Opens the "..." menu for a home-list row and deletes it, confirming the dialog. */
async function deleteFromHome(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await page.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
}

/** The CSRF double-submit token (Phase 24) — read straight off the
 *  non-httpOnly `vorlyn_csrf` cookie the way the SPA's own fetch client does
 *  (api/client.ts `readCookie`), since `page.request` doesn't run that
 *  client-side echo itself. */
async function csrfHeader(page: Page): Promise<{ 'x-csrf-token': string }> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((c) => c.name === 'vorlyn_csrf');
  if (!csrf) throw new Error('no vorlyn_csrf cookie — not signed in?');
  return { 'x-csrf-token': csrf.value };
}

/** Seeds a whole-document top-level comment as the signed-in admin, straight
 *  through the real HTTP API — bulk-seeding this way (rather than clicking
 *  "Add comment" through the UI 9+ times) is how reanchor/version-upload
 *  specs' sibling bulk-data needs get handled elsewhere in this suite. */
async function seedComment(page: Page, documentId: string, body: string): Promise<void> {
  const res = await page.request.post(`/api/documents/${documentId}/comments`, {
    headers: await csrfHeader(page),
    data: { body, anchor: { type: 'document' } },
  });
  if (!res.ok()) throw new Error(`seedComment failed: ${res.status()}`);
}

test('rail comment search appears past the thread-count threshold and filters to a match', async ({
  page,
}) => {
  await login(page);
  const documentId = await uploadAndOpen(page, 'search-threshold.md');

  // railSearchable is `threads.length > 8` (viewer.tsx) — 9 top-level open
  // threads clears it. One carries a marker nothing else does.
  for (let i = 1; i <= 8; i += 1) {
    await seedComment(page, documentId, `Filler thread number ${String(i)}`);
  }
  await seedComment(page, documentId, 'The zzzflagword marks this one thread only');

  await page.reload();
  const rail = page.getByLabel('Search comments');
  await expect(rail).toBeVisible();
  await expect(page.getByTestId('thread')).toHaveCount(9);

  // A query matching only the marked thread narrows the rail to just it.
  await rail.fill('zzzflagword');
  await expect(page.getByTestId('thread')).toHaveCount(1);
  await expect(page.getByTestId('thread')).toContainText('zzzflagword marks this one thread');

  // A query matching nothing shows the honest empty state, not a blank rail.
  await rail.fill('no-such-word-anywhere');
  await expect(page.getByTestId('thread')).toHaveCount(0);
  await expect(page.getByText('No loaded threads match')).toBeVisible();

  // Clearing the query restores the full rail.
  await rail.fill('');
  await expect(page.getByTestId('thread')).toHaveCount(9);

  await deleteFromHome(page, 'search-threshold.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('@mention picker offers a doc participant and the posted comment highlights it', async ({
  page,
}) => {
  await login(page);
  const documentId = await uploadAndOpen(page, 'mention-thread.md');

  // Seed a comment "from" a second real org member the loopback e2e auth can
  // never sign in as (see e2e-main.ts's `mentionBuddy` bootstrap and the
  // comment on e2e/invite-accept.spec.ts explaining why) — this is what
  // makes them a doc-scoped @mention candidate (viewer.tsx `mentionCandidates`
  // only offers the doc owner or someone who has already commented/replied).
  const seedRes = await page.request.post('/api/test-support/seed-member-comment', {
    data: { documentId, body: 'Kicking off the thread' },
  });
  if (!seedRes.ok()) throw new Error(`seed-member-comment failed: ${seedRes.status()}`);

  await page.reload();
  await expect(page.getByTestId('thread')).toContainText('Kicking off the thread');

  // Open the whole-document composer and type a partial @token.
  await page.getByRole('button', { name: 'Add comment' }).click();
  const composerBox = page.getByLabel('Comment', { exact: true });
  await composerBox.fill('Thanks @Ment');

  const menu = page.getByRole('listbox', { name: 'Mention someone' });
  await expect(menu).toBeVisible();
  const option = menu.getByRole('option', { name: '@Mention Buddy' });
  await expect(option).toBeVisible();
  await option.click();

  // Picking splices in the whitespace-stripped token (mentionInsertText).
  await expect(composerBox).toHaveValue('Thanks @MentionBuddy ');

  await page.getByRole('button', { name: 'Post', exact: true }).click();

  // The stored, server-resolved mention renders as a quiet highlight — only
  // real, resolved mentions get the `data-testid="mention"` treatment.
  const posted = page.getByTestId('thread').filter({ hasText: 'Thanks @MentionBuddy' });
  await expect(posted.getByTestId('mention')).toContainText('@MentionBuddy');

  await deleteFromHome(page, 'mention-thread.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});
