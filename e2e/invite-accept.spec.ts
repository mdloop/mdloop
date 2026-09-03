import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * In-app landing for an invite link (`/invite/accept?token=`) — since Phase
 * 38.C this is the primary destination invite emails open (previously they
 * linked straight to WorkOS, skipping our branding for the common,
 * anonymous case), and remains the fallback for one opened while already
 * signed in. There's no endpoint to preview invite details without
 * redeeming, so this only proves the handoff is wired correctly for both
 * session states — the actual redemption (a brand-new WorkOS identity
 * landing in the inviting org) is a backend-only round trip the loopback
 * e2e auth can't simulate with a second distinct identity, so it's covered
 * by packages/persistence/src/org-invites.feature.test.ts instead.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

test('invite accept link renders for an anonymous visitor, ahead of the login screen', async ({
  page,
}) => {
  // No login() call — this is the primary case an emailed invite link hits.
  // Before the Phase 38.C fix, the anonymous-session gate in app.tsx ran
  // first and this would silently show LoginScreen instead, dropping the
  // token.
  await page.goto('/invite/accept?token=e2e-test-token-123');
  await expect(page.getByText("You've been invited to join an organization.")).toBeVisible();

  const continueLink = page.getByTestId('invite-accept-continue');
  await expect(continueLink).toHaveAttribute('href', '/api/auth/login?invite=e2e-test-token-123');
});

test('invite accept link hands off to the auth round trip when already signed in', async ({
  page,
}) => {
  await login(page);

  await page.goto('/invite/accept?token=e2e-test-token-123');
  await expect(page.getByText("You've been invited to join an organization.")).toBeVisible();

  const continueLink = page.getByTestId('invite-accept-continue');
  await expect(continueLink).toHaveAttribute('href', '/api/auth/login?invite=e2e-test-token-123');

  // Backing out returns to the app instead of following the link.
  await page.getByRole('button', { name: 'Back to Vorlyn' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
});

test('an unmatched path shows a real 404, not a silent home redirect', async ({ page }) => {
  await page.goto('/this-path-does-not-exist');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to Vorlyn' }).click();
  await expect(page).toHaveURL('/');
});
