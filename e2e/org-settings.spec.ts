import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueEmail } from './unique.js';

/**
 * Phase 15 exit gate: org invite/join flow, admin side. Real API + real
 * Postgres (loopback auth, see e2e-main.ts) — the e2e identity is always
 * admin of its own org on first sign-in, which is what lets it reach this
 * screen at all.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();
}

/**
 * Below 720px `SettingsLayout` (Phase 39.A) shows content (defaulting to
 * Overview) before the rail — a "Sections" back-button reveals the rail so a
 * different section can be picked. The `catch` no-ops this on desktop/tablet,
 * where the rail is already visible alongside content and the button doesn't
 * render at all (same pattern as admin-console.spec.ts's `loginAsOperator`).
 */
async function openSectionsIndex(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Sections' })
    .click({ timeout: 1000 })
    .catch(() => undefined);
}

test('invite lifecycle: send, list, copy link, revoke', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Org settings' })).toBeVisible();

  // Phase 39.C: the invite form lives behind the rail now, not on load.
  await openSectionsIndex(page);
  await page.getByRole('button', { name: 'Members' }).click();

  // Send an invite. `exact: true` matters for real, not just style: the
  // Members table on this same screen (Phase 39.C) has a "Role for <name>"
  // select per row, and the shared e2e org has real named members by this
  // point in the suite — a substring match on "Role" is ambiguous the
  // moment any member row exists, not a viewport-specific issue.
  //
  // The email is unique per execution: this spec is one of RESPONSIVE_SPECS
  // (playwright.config.ts), so it can run up to three times
  // (desktop/phone/tablet) in one suite run against the same shared org. A
  // fixed address would, on the second execution, match more than one
  // `.invite-row` below once an earlier execution's own (now-revoked)
  // invite to that email is still in the list — revoking doesn't remove the
  // row, only flips its status — and it would also 500 outright if that
  // earlier execution failed before reaching its own revoke step, since the
  // DB only allows one live (unrevoked, unaccepted) invite per email per
  // org (org_invites_live_email_idx).
  const inviteEmail = uniqueEmail('friend');
  await page.getByLabel('Email to invite').fill(inviteEmail);
  await page.getByLabel('Role', { exact: true }).selectOption('member');
  await page.getByRole('button', { name: 'Send invite' }).click();

  // One-time accept link is shown, pointing at our own invite-accept card
  // first (Phase 38.C), not straight at the WorkOS hosted-auth round trip.
  const tokenBox = page.getByTestId('invite-token');
  await expect(tokenBox).toContainText(inviteEmail);
  await expect(tokenBox.locator('code')).toContainText('/invite/accept?token=');

  // The invite shows up in the pending list. Scoped to this row (not the
  // whole list) — the shared e2e org can carry other pending invites too,
  // so neither this nor the revoke assertion below assumes it's the only
  // one.
  const inviteList = page.getByTestId('invite-list');
  const inviteRow = inviteList.locator('.invite-row', { hasText: inviteEmail });
  await expect(inviteRow).toContainText('Pending');

  // Revoke it — opens a confirm dialog, then status flips and the row's
  // revoke control disappears.
  await inviteRow.getByRole('button', { name: 'Revoke' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(inviteRow).toContainText('Revoked');
  await expect(inviteRow.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
});

test('allowlist: add and remove an entry', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  // Phase 39.C: the allowlist form lives behind the rail now, not on load.
  await openSectionsIndex(page);
  await page.getByRole('button', { name: 'Access' }).click();

  await page.getByLabel('Email to allow').fill('ok@example.com');
  await page.getByRole('button', { name: 'Add to allowlist' }).click();

  const allowlist = page.getByTestId('allowlist-list');
  await expect(allowlist).toContainText('ok@example.com');

  await allowlist.getByRole('button', { name: 'Remove' }).click();
  await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(allowlist).not.toContainText('ok@example.com');
});

test('provisioning mode toggle persists across reload', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();

  // Phase 39.C: the provisioning toggle lives behind the rail now, not on load.
  await openSectionsIndex(page);
  await page.getByRole('button', { name: 'Access' }).click();

  const allowlistBtn = page.getByRole('button', { name: 'Allowlist', exact: true });
  const openBtn = page.getByRole('button', { name: 'Open', exact: true });

  await allowlistBtn.click();
  await expect(allowlistBtn).toHaveAttribute('aria-pressed', 'true');

  // A reload remounts the screen, so the rail resets to its default
  // (Overview) section — re-enter Access before checking the toggle again.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Org settings' })).toBeVisible();
  await openSectionsIndex(page);
  await page.getByRole('button', { name: 'Access' }).click();
  await expect(page.getByRole('button', { name: 'Allowlist', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await openBtn.click();
  await expect(openBtn).toHaveAttribute('aria-pressed', 'true');
});

/**
 * Phase 39.C: Overview's usage ledger reads real numbers from `GET
 * /org/usage`, not placeholders. Overview is the default section, so no
 * rail click is needed to reach it.
 *
 * Seats was the original choice here (provably non-zero — the signed-in
 * admin themselves counts towards `memberCount`) but that reasoning missed
 * a real dependency: this shared e2e org is deliberately kept on the Team
 * tier throughout the suite (`e2e-main.ts` bootstrap — "every other spec
 * assumes effectively-unlimited seats/docs/versions"), and Team's seat
 * ceiling is unlimited (`maxCollaborators: null`, `packages/domain/src/tier.ts`), so
 * the Seats meter renders `Meter`'s honest "Unlimited" row, never a
 * progressbar with a real number. Assert *that* instead — it's not a lesser
 * check, it's the actually-true one for this org's fixed tier. Documents
 * has a real ceiling on Team (5,000) but no non-zero-value guarantee this
 * test can rely on the same way Seats' member count can, so it stays out of
 * this assertion.
 */
test('overview usage meters show real numbers', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Org settings' })).toBeVisible();

  const seatsMeter = page.locator('.settings-usage-lanes .meter', { hasText: 'Seats' });
  await expect(seatsMeter).toBeVisible();
  await expect(seatsMeter.getByText('Unlimited')).toBeVisible();
});
