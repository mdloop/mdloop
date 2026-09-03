// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginScreen } from './login-screen.js';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('LoginScreen', () => {
  it('renders with no error banner by default', () => {
    render(<LoginScreen />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Sign in')).not.toBeNull();
  });

  it('renders the mapped sentence for a known ?authError= code, never the raw code', () => {
    render(<LoginScreen authError="invite_expired" />);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toBe('That invite has expired — ask an admin to send a new one.');
    expect(banner.textContent).not.toContain('invite_expired');
  });

  it('falls back generically for an unmapped code, never echoing it', () => {
    render(<LoginScreen authError="some_code_nobody_mapped" />);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).not.toContain('some_code_nobody_mapped');
  });

  it('strips the query string on mount so a refresh does not replay the error', () => {
    window.history.replaceState(null, '', '/?authError=seat_cap_reached');
    render(<LoginScreen authError="seat_cap_reached" />);
    expect(window.location.search).toBe('');
  });
});
