import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const V1 = `# Handoff spec

The exporter batches writes every five seconds.
`;

const V2 = `# Handoff spec

The exporter batches writes every ten seconds.
`;

const V3 = `# Handoff spec

The exporter batches writes every thirty seconds.
`;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

async function uploadAndOpen(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('file-input')
    .setInputFiles([{ name: title, mimeType: 'text/markdown', buffer: Buffer.from(V1) }]);
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByText('every five seconds')).toBeVisible();
}

/** Opens the "..." menu for a home-list row and deletes it, confirming the dialog. */
async function deleteFromHome(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await page.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
}

async function dataTransferFor(page: Page, name: string, content: string) {
  return page.evaluateHandle(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/markdown' }));
      return dt;
    },
    { name, content },
  );
}

async function pasteFile(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(
    ({ name, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'text/markdown' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      window.dispatchEvent(event);
    },
    { name, content },
  );
}

test('drag-drop a file onto the viewer body opens the confirm dialog, then ships a new version', async ({
  page,
}) => {
  await login(page);
  await uploadAndOpen(page, 'handoff-drop.md');

  const dataTransfer = await dataTransferFor(page, 'handoff-drop.md', V2);
  const body = page.getByTestId('viewer-body');
  await body.dispatchEvent('dragenter', { dataTransfer });
  await body.dispatchEvent('drop', { dataTransfer });

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('handoff-drop.md');
  await dialog.getByRole('button', { name: 'Upload' }).click();

  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByText('every ten seconds')).toBeVisible();

  await deleteFromHome(page, 'handoff-drop.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('opens the Compare surface and shows the rendered diff between legs', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'handoff-compare.md');

  const dataTransfer = await dataTransferFor(page, 'handoff-compare.md', V2);
  const body = page.getByTestId('viewer-body');
  await body.dispatchEvent('dragenter', { dataTransfer });
  await body.dispatchEvent('drop', { dataTransfer });
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toBeVisible();

  // View the older version, then compare it against current.
  await page.getByTestId('version-strip').getByRole('button', { name: 'v1' }).click();
  await page.getByRole('button', { name: /Diff against current/ }).click();

  const compare = page.getByTestId('compare-surface');
  await expect(compare).toBeVisible();
  await expect(compare).toContainText('Comparing v1 → v2');
  // Rendered tab (default): word-level runs render inline — the changed word
  // shows as a <del> (old) immediately followed by an <ins> (new), not a
  // clean after-only sentence (ADR 0003 §A.2).
  await expect(compare.locator('del', { hasText: 'five' })).toBeVisible();
  await expect(compare.locator('ins', { hasText: 'ten' })).toBeVisible();

  // Source tab is the trust fallback — the raw diff-match-patch view.
  await compare.getByRole('tab', { name: 'Source' }).click();
  await expect(compare.getByTestId('compare-source')).toBeVisible();

  await compare.getByRole('button', { name: 'Close compare' }).click();
  await expect(compare).toHaveCount(0);

  await deleteFromHome(page, 'handoff-compare.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('pasting a copied file asks for confirmation, then ships a new version', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'handoff-paste.md');

  await pasteFile(page, 'handoff-paste.md', V3);

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('handoff-paste.md');
  await dialog.getByRole('button', { name: 'Upload' }).click();

  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByText('every thirty seconds')).toBeVisible();

  await deleteFromHome(page, 'handoff-paste.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('dismissing the paste confirmation makes no change', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'handoff-paste-cancel.md');

  await pasteFile(page, 'handoff-paste-cancel.md', V3);

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByText('every five seconds')).toBeVisible();
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toHaveCount(0);

  await deleteFromHome(page, 'handoff-paste-cancel.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('pressing Escape cancels the paste confirmation', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'handoff-paste-escape.md');

  await pasteFile(page, 'handoff-paste-escape.md', V3);
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  await expect(page.getByText('every five seconds')).toBeVisible();

  await deleteFromHome(page, 'handoff-paste-escape.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});
