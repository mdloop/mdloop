// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Meter } from './meter.js';

afterEach(cleanup);

describe('Meter', () => {
  it('renders a quiet fill below the 80% threshold', () => {
    render(<Meter label="Seats" value={7} ceiling={25} />);
    expect(screen.getByText('7 / 25')).toBeDefined();
    const track = screen.getByRole('progressbar');
    expect(track.getAttribute('aria-valuenow')).toBe('7');
    expect(track.getAttribute('aria-valuemax')).toBe('25');
    expect(screen.getByTestId('meter').className).not.toContain('meter--signal');
    expect(screen.queryByText('Approaching limit')).toBeNull();
    expect(screen.queryByText('At limit')).toBeNull();
  });

  it('turns amber and says "Approaching limit" at exactly 80%', () => {
    render(<Meter label="Guests" value={20} ceiling={25} />);
    expect(screen.getByTestId('meter').className).toContain('meter--signal');
    expect(screen.getByText('Approaching limit')).toBeDefined();
    expect(screen.queryByText('At limit')).toBeNull();
  });

  it('stays amber and says "At limit" at 100%, never using danger red', () => {
    render(<Meter label="Documents" value={5000} ceiling={5000} />);
    expect(screen.getByTestId('meter').className).toContain('meter--signal');
    expect(screen.getByText('At limit')).toBeDefined();
    expect(screen.queryByText('Approaching limit')).toBeNull();
  });

  it('clamps a value past its ceiling to 100% width and "At limit"', () => {
    render(<Meter label="Documents" value={6000} ceiling={5000} />);
    const fill = screen.getByTestId('meter').querySelector('.meter-fill');
    expect(fill).not.toBeNull();
    expect((fill as HTMLElement).style.width).toBe('100%');
    expect(screen.getByText('At limit')).toBeDefined();
  });

  it('renders an honest Unlimited row with no bar when ceiling is null', () => {
    render(<Meter label="Storage" value={1234} ceiling={null} />);
    expect(screen.getByText('Unlimited')).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByTestId('meter').className).not.toContain('meter--signal');
  });

  it('applies a custom formatter to both value and ceiling', () => {
    render(
      <Meter
        label="Storage"
        value={1024}
        ceiling={2048}
        formatter={(n) => `${(n / 1024).toFixed(1)} KB`}
      />,
    );
    expect(screen.getByText('1.0 KB / 2.0 KB')).toBeDefined();
  });
});
