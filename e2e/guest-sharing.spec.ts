import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const DOC = `# Handoff spec

The exporter batches writes every five seconds.
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
  await expect(page.getByText('batches writes')).toBeVisible();
}

/**
 * The full guest round trip: owner shares to an external email, then:
 *  - the owner opening their own /g/ link (sanity-checking it) does NOT get
 *    downgraded — their session already reads this document, so it's left
 *    alone and the normal owner UI reloads;
 *  - the same link opened with no prior session (a fresh browser, simulated
 *    here by clearing cookies) redeems into a guest session, with guest
 *    chrome, comment ability, and the usual scope fence.
 */
test('guest share: create → owner-open is a no-op → redeem as guest → scope fence', async ({
  page,
}) => {
  await login(page);
  await uploadAndOpen(page, 'handoff.md');

  // Owner mints a guest share from the share panel.
  await page.getByRole('button', { name: 'Share this document' }).click();
  await page.getByLabel('Guest email').fill('ext@client.test');
  await page.getByLabel('Days of access').fill('7');
  await page.getByRole('button', { name: 'Send guest link' }).click();
  const tokenBox = page.getByTestId('guest-share-token');
  await expect(tokenBox).toBeVisible();
  const url = await tokenBox.locator('code').innerText();
  expect(url).toContain('/g/');

  // The grant list shows the guest with its expiry.
  await expect(page.getByText('ext@client.test (guest)')).toBeVisible();

  // The owner opening their own link stays the owner — no session downgrade.
  await page.goto(url);
  await expect(page.getByText('batches writes')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share this document' })).toBeVisible();
  await expect(page.getByText('Guest access — you can see only this document.')).toHaveCount(0);

  // A fresh browser (no session) redeeming the same link gets guest access.
  await page.context().clearCookies();
  await page.goto(url);
  await expect(page.getByText('Guest access — you can see only this document.')).toBeVisible();
  await expect(page.getByText('batches writes')).toBeVisible();

  // Guest chrome: no share/upload controls (guest permission caps at comment).
  await expect(page.getByRole('button', { name: 'Share this document' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New leg' })).toHaveCount(0);

  // The guest can comment on the whole document.
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByLabel('Comment', { exact: true }).fill('Looks good from the client side');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByTestId('thread')).toContainText('Looks good from the client side');

  // Scope fence: the home overview is guest-forbidden at the API.
  const res = await page.request.get('/api/overview');
  expect(res.status()).toBe(403);

  // And the app shell never renders for a guest landing on `/`.
  await page.goto('/');
  await expect(page.getByText('Open the link you were emailed')).toBeVisible();

  // Cleanup: specs share one server and one org — drop the guest cookie,
  // sign back in as the member, and delete the doc so later specs see the
  // same empty home they started from.
  await page.context().clearCookies();
  await login(page);
  await page.getByRole('button', { name: 'More actions for handoff.md' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});
