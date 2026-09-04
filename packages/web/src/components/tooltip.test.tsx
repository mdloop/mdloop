// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Tooltip } from './tooltip.js';

afterEach(cleanup);

describe('Tooltip', () => {
  it('is closed until hovered or focused', () => {
    render(
      <Tooltip content="Only allowlisted emails can self-serve join">
        <button type="button">Allowlist</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus, not just hover — the whole point vs. title=', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Only allowlisted emails can self-serve join">
        <button type="button">Allowlist</button>
      </Tooltip>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Allowlist' }));
    expect(screen.getByRole('tooltip').textContent).toBe(
      'Only allowlisted emails can self-serve join',
    );
  });

  it('links the trigger to the bubble via aria-describedby while open', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explains the control">
        <button type="button">Do thing</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Do thing' });
    await user.tab();
    const bubble = screen.getByRole('tooltip');
    expect(trigger.getAttribute('aria-describedby')).toBe(bubble.id);
  });

  it('closes on blur (tap-elsewhere equivalent on touch)', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Tooltip content="Explains the control">
          <button type="button">Do thing</button>
        </Tooltip>
        <button type="button">Elsewhere</button>
      </>,
    );
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeDefined();
    await user.tab();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explains the control">
        <button type="button">Do thing</button>
      </Tooltip>,
    );
    await user.tab();
    expect(screen.getByRole('tooltip')).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explains the control">
        <button type="button">Do thing</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button', { name: 'Do thing' }));
    expect(screen.getByRole('tooltip')).toBeDefined();
    await user.unhover(screen.getByRole('button', { name: 'Do thing' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on a tap (click), the touch affordance with no hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Explains the control">
        <button type="button">Do thing</button>
      </Tooltip>,
    );
    // userEvent.click focuses then clicks — the tap path. Idempotent open
    // (not a toggle) so this doesn't flip straight back closed.
    await user.click(screen.getByRole('button', { name: 'Do thing' }));
    expect(screen.getByRole('tooltip')).toBeDefined();
  });
});
