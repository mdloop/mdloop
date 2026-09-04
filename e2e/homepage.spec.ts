import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { uniqueName } from './unique.js';

/** Opens the "..." menu for a home-list row and clicks a menuitem in it. */
async function docMenuAction(page: Page, title: string, menuitem: string): Promise<void> {
  await page.getByRole('button', { name: `More actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: menuitem }).click();
}

/**
 * Below 720px the lane sidebar (Phase 39.F) is an off-canvas drawer, not a
 * permanent column — open it before any lane/project-list interaction. A
 * no-op on desktop/tablet, where the trigger is CSS-hidden and stays
 * invisible.
 */
async function openLaneDrawer(page: Page): Promise<void> {
  const trigger = page.getByLabel('Open lanes');
  if (await trigger.isVisible()) await trigger.click();
}

/**
 * Phase 4 exit gate: login → upload → organize → delete, in one browser
 * session against the real API + Postgres (loopback auth, see e2e-main.ts).
 */
test('login, upload, organize, archive and delete a document', async ({ page }) => {
  // Login through the (loopback) hosted-auth flow.
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'All documents' })).toBeVisible();

  // Upload two markdown files via the browse input.
  await page.getByTestId('file-input').setInputFiles([
    {
      name: 'runbook.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Runbook\n\nRestart the worker.'),
    },
    {
      name: 'postmortem.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Postmortem\n\nWhat happened.'),
    },
  ]);
  await expect(page.getByText('runbook.md')).toBeVisible();
  await expect(page.getByText('postmortem.md')).toBeVisible();

  // Create a project lane. Named uniquely per execution — this spec is one
  // of RESPONSIVE_SPECS (playwright.config.ts), so it can run up to three
  // times (desktop/phone/tablet) in one suite run against the same shared
  // org; a fixed "Ops" would leave a second lane with the same name behind
  // (the project itself is never deleted, only the documents filed under
  // it), and every exact-name lookup below would then match more than one
  // button.
  const projectName = uniqueName('Ops');
  await openLaneDrawer(page);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: projectName, exact: true })).toBeVisible();
  // "New project" isn't a lane selection, so the drawer (if opened) doesn't
  // auto-close — do it explicitly before touching document rows in the main
  // content, which the backdrop would otherwise block.
  await page.keyboard.press('Escape');

  // File the runbook into the project via the "..." menu's "Move to" section.
  await docMenuAction(page, 'runbook.md', projectName);

  // The project lane shows only the runbook. Scoped to the lanes nav — by
  // this point "All documents" also renders an "Open <project>" doc-group
  // header whose own accessible name is the bare project name too (real
  // ambiguity, not viewport-specific: the sidebar/drawer's lane link and the
  // group header both exist any time a project has documents grouped under
  // it). Exact match on the full unique name, not a prefix — any earlier
  // execution's own "Ops-..." lane is still on screen too (never deleted),
  // and a prefix match would be ambiguous against it.
  await openLaneDrawer(page);
  await page
    .getByRole('navigation', { name: 'Lanes' })
    .getByRole('button', { name: projectName, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page.getByText('runbook.md')).toBeVisible();
  await expect(page.getByText('postmortem.md')).not.toBeVisible();

  // Unfiled shows only the postmortem.
  await openLaneDrawer(page);
  await page.getByRole('button', { name: 'Unfiled' }).click();
  await expect(page.getByText('postmortem.md')).toBeVisible();
  await expect(page.getByText('runbook.md')).not.toBeVisible();

  // Archive the postmortem; it moves to the Archived lane.
  await docMenuAction(page, 'postmortem.md', 'Archive');
  await expect(page.getByText('postmortem.md')).not.toBeVisible();
  await openLaneDrawer(page);
  await page.getByRole('button', { name: 'Archived' }).click();
  await expect(page.getByText('postmortem.md')).toBeVisible();

  // Restore it, then delete it (confirming the dialog).
  await docMenuAction(page, 'postmortem.md', 'Restore');
  await openLaneDrawer(page);
  await page.getByRole('button', { name: 'Unfiled' }).click();
  await expect(page.getByText('postmortem.md')).toBeVisible();
  await docMenuAction(page, 'postmortem.md', 'Delete');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('postmortem.md')).not.toBeVisible();

  // The runbook survives it all.
  await openLaneDrawer(page);
  await page.getByRole('button', { name: 'All documents' }).click();
  await expect(page.getByText('runbook.md')).toBeVisible();

  // Cleanup: leave the home empty for later specs sharing this org/server.
  await docMenuAction(page, 'runbook.md', 'Delete');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('No documents yet')).toBeVisible();
});
