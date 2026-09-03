import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const V1 = `# Deploy notes

The cache is flushed nightly by the cron worker.

Rollbacks require a manual approval step.
`;

/** V2 removes the entire sentence the suggestion below anchors to, so the
 *  accept's re-anchor lands below the confidence floor and must be refused. */
const V2 = `# Deploy notes

Everything here was rewritten from scratch after the incident review.

Rollbacks require a manual approval step.
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
  await expect(page.getByText('flushed nightly')).toBeVisible();
}

/** Opens the "..." menu for a home-list row and deletes it, confirming the dialog. */
async function deleteFromHome(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await page.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
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

/** Select `needle`, flip the composer into suggestion mode, propose `replacement`. */
async function postSuggestion(
  page: Page,
  needle: string,
  body: string,
  replacement: string,
): Promise<void> {
  await selectText(page, needle);
  await expect(page.getByTestId('composer')).toBeVisible();
  await page.getByLabel('Comment', { exact: true }).fill(body);
  await page.getByRole('button', { name: 'Suggest an edit' }).click();
  const proposed = page.getByLabel('Proposed replacement text');
  await expect(proposed).toHaveValue(needle); // prefilled with the anchored text
  await proposed.fill(replacement);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
}

test('suggestion lifecycle: propose → accept → applied once a matching edit lands', async ({
  page,
}) => {
  await login(page);
  await uploadAndOpen(page, 'suggest-accept.md');

  await postSuggestion(
    page,
    'flushed nightly',
    'Hourly is what ops actually runs.',
    'flushed hourly',
  );

  const thread = page.getByTestId('thread').filter({ hasText: 'ops actually runs' });
  await expect(thread.getByTestId('suggestion-block')).toContainText('Suggestion · open');
  await expect(thread.getByTestId('suggestion-block')).toContainText('flushed hourly');

  await thread.getByRole('button', { name: 'Accept', exact: true }).click();

  // Accept is metadata-only (ADR 0007): the outcome flips immediately, but
  // nothing is minted, spliced, or re-anchored — no version link yet.
  const status = thread.getByTestId('suggestion-block').locator('.suggestion-status-text');
  await expect(status).toContainText('Suggestion accepted');
  await expect(status).not.toContainText('→');
  await expect(thread.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toHaveCount(0);

  // Someone applies the edit for real and ships it as a new version — the
  // lazy re-anchor pass (triggered by the thread refetch after any upload)
  // notices the resolved range now reads exactly what was proposed and
  // materializes the applied link; nothing explicit "applies" it.
  const dataTransfer = await page.evaluateHandle(
    (content) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], 'suggest-accept.md', { type: 'text/markdown' }));
      return dt;
    },
    V1.replace('flushed nightly', 'flushed hourly'),
  );
  const body = page.getByTestId('viewer-body');
  await body.dispatchEvent('dragenter', { dataTransfer });
  await body.dispatchEvent('drop', { dataTransfer });
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toBeVisible();
  await expect(page.getByText('The cache is flushed hourly by the cron worker.')).toBeVisible();

  await expect(status).toContainText('Suggestion accepted → v2');

  // The applied-version link is collapsed behind the status row.
  await expect(thread.getByRole('button', { name: 'Applied as v2' })).toHaveCount(0);
  await thread.getByRole('button', { name: /Suggestion accepted/ }).click();
  await expect(thread.getByRole('button', { name: 'Applied as v2' })).toBeVisible();

  await deleteFromHome(page, 'suggest-accept.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('rejecting a suggestion records the outcome and mints nothing', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'suggest-reject.md');

  await postSuggestion(page, 'manual approval', 'Automate this instead.', 'automated policy');

  const thread = page.getByTestId('thread').filter({ hasText: 'Automate this instead' });
  await thread.getByRole('button', { name: 'Reject', exact: true }).click();

  await expect(thread.getByTestId('suggestion-block')).toContainText('Suggestion rejected');
  await expect(thread.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  // No version was minted.
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toHaveCount(0);

  await deleteFromHome(page, 'suggest-reject.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('an accepted suggestion stays pending when a later edit does not match the proposal', async ({
  page,
}) => {
  await login(page);
  await uploadAndOpen(page, 'suggest-orphan.md');

  await postSuggestion(page, 'flushed nightly', 'Tighten the wording.', 'purged nightly');

  const thread = page.getByTestId('thread').filter({ hasText: 'Tighten the wording' });
  await thread.getByRole('button', { name: 'Accept', exact: true }).click();
  const status = thread.getByTestId('suggestion-block').locator('.suggestion-status-text');
  await expect(status).toContainText('Suggestion accepted');

  // Ship a V2 that rewrites the anchored sentence away entirely — unrelated
  // to the proposal, so the lazy re-anchor pass (ADR 0007) has nothing to
  // match on the next thread refetch.
  const dataTransfer = await page.evaluateHandle((content) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], 'suggest-orphan.md', { type: 'text/markdown' }));
    return dt;
  }, V2);
  const body = page.getByTestId('viewer-body');
  await body.dispatchEvent('dragenter', { dataTransfer });
  await body.dispatchEvent('drop', { dataTransfer });
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByTestId('version-strip').getByText('v2', { exact: true })).toBeVisible();

  // Nothing guessed: still accepted, still no applied version link.
  await expect(status).toContainText('Suggestion accepted');
  await expect(status).not.toContainText('→');
  await expect(thread.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);

  await deleteFromHome(page, 'suggest-orphan.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

/**
 * The guest boundary, in-browser (same session-swap trick as review.spec.ts):
 * a guest with a comment grant can author a suggestion, but never sees
 * accept/reject — those render only for the owner/org-admin `edit` signal,
 * mirroring the server-side gate on uploadNewVersion.
 */
test('a guest can propose a suggestion but sees no accept or reject', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'suggest-guest.md');

  // An owner-authored suggestion the guest will look at but must not act on.
  await postSuggestion(page, 'manual approval', 'Owner proposes this.', 'sign-off');

  await page.getByRole('button', { name: 'Share this document' }).click();
  await page.getByLabel('Guest email').fill('client@consulting.test');
  await page.getByLabel('Days of access').fill('7');
  await page.getByRole('button', { name: 'Send guest link' }).click();
  const tokenBox = page.getByTestId('guest-share-token');
  await expect(tokenBox).toBeVisible();
  const url = await tokenBox.locator('code').innerText();

  // Redeem the guest link as a fresh identity: the owner's own session
  // already reads this document, so redeeming would leave it untouched
  // (see guest-sharing.spec.ts) — clear cookies first to get the guest swap.
  await page.context().clearCookies();
  await page.goto(url);
  await expect(page.getByText('Guest access — you can see only this document.')).toBeVisible();

  const ownerThread = page.getByTestId('thread').filter({ hasText: 'Owner proposes this' });
  await expect(ownerThread.getByTestId('suggestion-block')).toContainText('Suggestion · open');
  await expect(ownerThread.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await expect(ownerThread.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);

  // The guest's own suggestion goes through the ordinary comment path.
  await postSuggestion(page, 'flushed nightly', 'Guest proposes this.', 'flushed weekly');
  const guestThread = page.getByTestId('thread').filter({ hasText: 'Guest proposes this' });
  await expect(guestThread.getByTestId('suggestion-block')).toContainText('Suggestion · open');
  await expect(guestThread.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);

  // Cleanup: back to the owner session, delete the doc.
  await page.context().clearCookies();
  await login(page);
  await deleteFromHome(page, 'suggest-guest.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});
