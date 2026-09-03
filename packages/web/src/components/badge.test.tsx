// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge } from './badge.js';

afterEach(cleanup);

describe('Badge', () => {
  it('defaults to the neutral tone', () => {
    render(<Badge>Free</Badge>);
    expect(screen.getByText('Free').className).toBe('badge badge--neutral');
  });

  it.each([
    ['signal', 'Pending'],
    ['resolved', 'Accepted'],
    ['danger', 'Revoked'],
    ['neutral', 'Expired'],
  ] as const)('renders the %s tone class', (tone, label) => {
    render(<Badge tone={tone}>{label}</Badge>);
    expect(screen.getByText(label).className).toBe(`badge badge--${tone}`);
  });
});
