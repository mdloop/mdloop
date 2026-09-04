import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const V1 = `# Payment design

The payment flow retries twice before failing.

Balances are computed as materialized views.
`;

const V2 = `# Payment design

Intro paragraph added at the top.

The payment flow retries three times before failing.

Balances are computed as materialized views.
`;

const V3 = `# Payment design

Everything about retries is gone now.

Balances are computed as materialized views.
`;

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

test('re-upload keeps comments honest: badge, diff, then orphan', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'All documents' }).waitFor();

  await page
    .getByTestId('file-input')
    .setInputFiles([{ name: 'reanchor.md', mimeType: 'text/markdown', buffer: Buffer.from(V1) }]);
  await page.getByRole('button', { name: 'reanchor.md', exact: true }).click();
  await expect(page.getByText('retries twice before failing')).toBeVisible();

  // Comment on the retry sentence on v1.
  await selectText(page, 'retries twice before failing');
  await page.getByLabel('Comment', { exact: true }).fill('Confirm the retry count');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByTestId('thread')).toContainText('Confirm the retry count');

  // Upload v2 (reworded) through the viewer.
  await page
    .getByTestId('version-file-input')
    .setInputFiles([{ name: 'reanchor.md', mimeType: 'text/markdown', buffer: Buffer.from(V2) }]);
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toBeVisible();

  // The comment re-anchored: confidence badge + highlight on the new wording.
  await expect(page.locator('.thread-badge')).toContainText('Moved — check this still fits');
  await expect(page.locator('mark.anchor-mark')).toContainText('retries three times');

  // "changed since v1" opens the Compare surface with the old and new wording.
  await page.getByRole('button', { name: 'changed since v1' }).click();
  const compare = page.getByTestId('compare-surface');
  await expect(compare).toContainText('Comparing v1 → v2');
  await compare.getByRole('tab', { name: 'Source' }).click();
  const source = compare.getByTestId('compare-source');
  await expect(source.locator('del').first()).toBeVisible();
  await expect(source.locator('ins').filter({ hasText: 'Intro paragraph' })).toBeVisible();
  await compare.getByRole('button', { name: 'Close compare' }).click();

  // Upload v3 which deletes the sentence: honest orphan, no highlight.
  await page
    .getByTestId('version-file-input')
    .setInputFiles([{ name: 'reanchor.md', mimeType: 'text/markdown', buffer: Buffer.from(V3) }]);
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByTestId('version-strip').getByText('v3', { exact: true })).toBeVisible();
  await expect(page.getByText('original text no longer present')).toBeVisible();
  await expect(page.locator('.minimap-tick--orphan')).toHaveCount(1);
  await expect(page.locator('mark.anchor-mark')).toHaveCount(0);

  // Cleanup: leave the home empty for later specs sharing this org/server.
  await page.getByRole('button', { name: 'mdloop — back to home' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await page.getByRole('button', { name: 'More actions for reanchor.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});
