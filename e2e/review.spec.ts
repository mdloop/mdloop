import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DOC = `# Runbook

Restart the worker before redeploying.
`;

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

async function uploadAndOpen(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('file-input')
    .setInputFiles([{ name: title, mimeType: 'text/markdown', buffer: Buffer.from(DOC) }]);
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByText('Restart the worker')).toBeVisible();
}

/** Opens the "..." menu for a home-list row and deletes it, confirming the dialog. */
async function deleteFromHome(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await page.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
}

/** Opens the identity dropdown and navigates to the admin-only org settings screen. */
async function openOrgSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Org settings' })).toBeVisible();
}

/**
 * The e2e loopback identity is always admin/owner of its own org on first
 * sign-in (same as org-settings.spec.ts) — the reviewer picker's "Members"
 * list includes the caller themselves (listUsers has no self-exclusion), so
 * requesting yourself as reviewer is both a legitimate scenario (a solo
 * admin double-checking their own doc) and the only same-org second
 * "identity" a single-session e2e run can reach without the guest swap
 * trick below.
 */
test('sign-off: request self as reviewer, approve, status chip flips', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'signoff.md');

  const chip = page.getByRole('button', { name: 'No review' });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.getByTestId('review-panel')).toBeVisible();

  await page.getByLabel('Reviewer').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await expect(page.getByTestId('review-panel')).toContainText('Awaiting');

  await expect(page.getByRole('button', { name: 'In review' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();

  await expect(page.getByRole('button', { name: 'Approved' })).toBeVisible();
  await expect(page.getByTestId('review-panel')).toContainText('Approved');

  await deleteFromHome(page, 'signoff.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});

test('hard gate blocks approval while a comment is open, soft is the default', async ({ page }) => {
  await login(page);

  // Flip the org to the hard gate. Phase 39.C: the sign-off gate toggle
  // lives in the Access rail section now, not visible on load.
  await openOrgSettings(page);
  await page.getByRole('button', { name: 'Access' }).click();
  await page.getByRole('button', { name: 'Hard' }).click();
  await expect(page.getByRole('button', { name: 'Hard' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'mdloop — back to home' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await uploadAndOpen(page, 'gated.md');

  // An open comment on the whole document.
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByLabel('Comment', { exact: true }).fill('one open thread');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByTestId('thread')).toHaveCount(1);

  await page.getByRole('button', { name: 'No review' }).click();
  await page.getByLabel('Reviewer').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Request', exact: true }).click();

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('soft-gate-warning')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('open comment');
  await expect(page.getByRole('button', { name: 'In review' })).toBeVisible();

  // Resolve the comment, then approval goes through.
  await page.getByTestId('thread').getByRole('button', { name: 'Resolve this thread' }).click();
  await page.getByRole('button', { name: 'In review' }).click();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Approved' })).toBeVisible();

  // Reset the org back to soft — other specs share this org and assume the
  // default gate.
  await deleteFromHome(page, 'gated.md');
  await openOrgSettings(page);
  await page.getByRole('button', { name: 'Access' }).click();
  await page.getByRole('button', { name: 'Soft' }).click();
  await expect(page.getByRole('button', { name: 'Soft' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'mdloop — back to home' }).click();
});

/**
 * A guest is a real second identity in the same org (Phase 18) — the one
 * true way an e2e run reaches "someone other than the owner" in-browser
 * (see guest-sharing.spec.ts). Requesting a guest reviewer and approving as
 * that guest proves the whole guest-sign-off story end to end: the verdict
 * is annotation, never a document mutation, so it stays inside the guest's
 * read+comment cap.
 */
test('a guest with a comment share can be requested and approve', async ({ page }) => {
  await login(page);
  await uploadAndOpen(page, 'client-review.md');

  await page.getByRole('button', { name: 'Share this document' }).click();
  await page.getByLabel('Guest email').fill('client@consulting.test');
  await page.getByLabel('Days of access').fill('7');
  await page.getByRole('button', { name: 'Send guest link' }).click();
  const tokenBox = page.getByTestId('guest-share-token');
  await expect(tokenBox).toBeVisible();
  const url = await tokenBox.locator('code').innerText();

  await page.getByRole('button', { name: 'No review' }).click();
  await page.getByLabel('Reviewer').selectOption({ label: 'client@consulting.test (guest)' });
  await page.getByRole('button', { name: 'Request', exact: true }).click();
  await expect(page.getByTestId('review-panel')).toContainText('client@consulting.test');

  // Redeem the guest link as a fresh identity: the owner's own session
  // already reads this document, so redeeming would leave it untouched
  // (see guest-sharing.spec.ts) — clear cookies first to get the guest swap.
  await page.context().clearCookies();
  await page.goto(url);
  await expect(page.getByText('Guest access — you can see only this document.')).toBeVisible();

  await expect(page.getByRole('button', { name: 'In review' })).toBeVisible();
  await page.getByRole('button', { name: 'Request changes' }).click();
  await expect(page.getByRole('button', { name: 'Changes requested' })).toBeVisible();

  // Cleanup: back to the owner session, delete the doc.
  await page.context().clearCookies();
  await login(page);
  await deleteFromHome(page, 'client-review.md');
  await expect(page.getByText('No documents yet')).toBeVisible();
});
