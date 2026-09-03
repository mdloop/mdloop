import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DOC = `# Payment design

The payment flow retries twice before failing.

Balances are computed as materialized views.
`;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

/**
 * Below ~899px the comment rail collapses into a floating "Show comments"
 * pill (`rail-fab`, `viewer.tsx`) showing the open count — threads aren't
 * interactively visible until it's tapped open. A no-op at desktop/tablet
 * widths, where the rail is already showing and the trigger doesn't render.
 */
async function openCommentRail(page: Page): Promise<void> {
  // exact: true matters here, not just style — "Show comments as a list" and
  // "Show comments as bubbles" (the desktop/tablet mode-toggle buttons) both
  // contain "Show comments" as a substring, so a non-exact match is ambiguous
  // even though only the rail-fab trigger is ever actually visible at once.
  const trigger = page.getByLabel('Show comments', { exact: true });
  if (await trigger.isVisible()) await trigger.click();
}

async function selectText(page: Page, needle: string): Promise<void> {
  await page.evaluate((text) => {
    const content = document.querySelector('[data-testid="viewer-content"]');
    if (!content) throw new Error('no viewer content');
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      content.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return;
    }
    throw new Error(`text not found: ${text}`);
  }, needle);
}

test('comment lifecycle: select → comment → reply → resolve → minimap → deep link', async ({
  page,
}) => {
  await login(page);

  // Upload and open the document.
  await page
    .getByTestId('file-input')
    .setInputFiles([{ name: 'payment.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC) }]);
  await page.getByRole('button', { name: 'payment.md', exact: true }).click();
  await expect(page.getByText('retries twice before failing')).toBeVisible();

  // Select text → composer quotes it → comment. This one gets resolved below.
  await selectText(page, 'retries twice');
  await expect(page.getByTestId('composer')).toBeVisible();
  await expect(page.getByTestId('composer')).toContainText('retries twice');
  await page.getByLabel('Comment', { exact: true }).fill('Should this be three retries?');
  await page.getByRole('button', { name: 'Post', exact: true }).click();

  // Thread appears, text is highlighted, minimap shows one open tick.
  const thread = page.getByTestId('thread').filter({ hasText: 'Should this be three retries?' });
  await expect(thread).toContainText('Should this be three retries?');
  await expect(page.locator('mark.anchor-mark')).toHaveCount(1);
  await expect(page.locator('.minimap-tick--open')).toHaveCount(1);

  // Reply — the minimap tick turns into the replied lane. Threads aren't
  // interactively visible below ~899px until the rail is opened (see
  // openCommentRail) — the toContainText/minimap checks above pass either
  // way (DOM presence, not visibility), but every click/fill on a thread
  // from here on needs the rail actually open, and it stays open for the
  // rest of this test once opened.
  await openCommentRail(page);
  await thread.getByLabel(/Reply to:/).fill('Yes, per the SLA doc');
  await thread.getByLabel(/Reply to:/).press('Enter');
  await expect(thread).toContainText('Yes, per the SLA doc');
  await expect(page.locator('.minimap-tick--replied')).toHaveCount(1);

  // A second, still-open comment — used below to prove deep links still work
  // for open threads once the first one leaves the Open filter.
  await selectText(page, 'materialized views');
  await page.getByLabel('Comment', { exact: true }).fill('Refresh cadence?');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByTestId('thread')).toHaveCount(2);

  // Resolve the first thread. The default (unfiltered) rail shows open and
  // resolved threads together — narrowing to the "Open" filter chip is what
  // drops it off the rail and the minimap; the "Resolved" chip count picks
  // it up instead.
  await thread.getByRole('button', { name: 'Resolve this thread' }).click();
  const filters = page.getByRole('group', { name: 'Comment filters' });
  await filters.getByRole('button', { name: /^Open/ }).click();
  await expect(page.getByTestId('thread')).toHaveCount(1);
  await expect(page.locator('mark.anchor-mark')).toHaveCount(1);
  await expect(filters.getByRole('button', { name: 'Resolved 1' })).toBeVisible();

  // Switch to the Resolved filter to see it: checkmark, no Resolve control.
  await filters.getByRole('button', { name: 'Resolved 1' }).click();
  const resolvedThread = page.getByTestId('thread');
  await expect(resolvedThread).toContainText('Should this be three retries?');
  await expect(resolvedThread.getByRole('button', { name: 'Resolve this thread' })).toHaveCount(0);
  await expect(page.locator('.minimap-tick--resolved')).toHaveCount(1);

  // Back to Open, then deep link: reload with #c=<commentId> for the
  // still-open comment → thread selected + highlighted.
  await filters.getByRole('button', { name: /^Open/ }).click();
  const url = page.url();
  // Every thread — open and resolved alike — keeps a permanent in-content
  // mark, so `mark.anchor-mark` isn't unique at this point; the thread
  // itself (now uniquely "Refresh cadence?" under the Open filter) is.
  const commentId = await page.getByTestId('thread').getAttribute('data-thread-id');
  // A hash-only page.goto is a same-document navigation in Chromium (no
  // popstate fires), so the app never re-parses the route. Navigate away
  // first to force a genuine full load, matching a real permalink open.
  await page.goto('about:blank');
  await page.goto(`${url}#c=${commentId ?? ''}`);
  await expect(page.locator('.thread--selected')).toContainText('Refresh cadence?');
  await expect(page.locator('mark.anchor-mark--selected')).toHaveCount(1);

  // Homepage rollup shows both signals on the document row: one comment is
  // still open (the deep-linked one), the other resolved.
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await expect(page.getByText('1 open · 1 resolved')).toBeVisible();

  // Cleanup: leave the home empty for later specs sharing this org/server.
  await page.getByRole('button', { name: 'More actions for payment.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('second open comment appears in the open minimap lane', async ({ page }) => {
  await login(page);
  await page
    .getByTestId('file-input')
    .setInputFiles([{ name: 'balances.md', mimeType: 'text/markdown', buffer: Buffer.from(DOC) }]);
  await page.getByRole('button', { name: 'balances.md', exact: true }).click();
  await expect(page.getByText('materialized views')).toBeVisible();
  await selectText(page, 'materialized views');
  await page.getByLabel('Comment', { exact: true }).fill('Refresh cadence?');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.locator('.minimap-tick--open')).toHaveCount(1);
  await expect(page.locator('mark.anchor-mark--open')).toHaveCount(1);

  // Cleanup: leave the home empty for later specs sharing this org/server.
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await page.getByRole('button', { name: 'More actions for balances.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('path-backed document shows a quiet folder breadcrumb above the title', async ({ page }) => {
  await login(page);

  // REST document upload never accepts `path` — only the MCP `upload_document`
  // tool can set it (Document.path is CLI-owned, CONSTITUTION.md §3) — so a
  // real browser-driven upload can't produce a path-backed doc. Seed one
  // directly through the use case, same escape hatch as
  // e2e-main.ts's `/test-support/seed-member-comment` (comment-search-mentions.spec.ts).
  const seedRes = await page.request.post('/api/test-support/seed-document-path', {
    data: { title: 'auth.md', content: DOC, path: 'docs/specs/auth.md' },
  });
  if (!seedRes.ok()) throw new Error(`seed-document-path failed: ${seedRes.status()}`);
  const { id: documentId } = (await seedRes.json()) as { id: string };

  await page.goto(`/d/${documentId}`);
  await expect(page.getByText('retries twice before failing')).toBeVisible();

  const breadcrumb = page.getByTestId('breadcrumb');
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb).toContainText('docs');
  await expect(breadcrumb).toContainText('specs');
  await expect(breadcrumb).not.toContainText('auth.md');

  // Cleanup: leave the home empty for later specs sharing this org/server.
  await page.getByRole('button', { name: 'Back to documents' }).click();
  await page.getByRole('button', { name: 'More actions for auth.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});
