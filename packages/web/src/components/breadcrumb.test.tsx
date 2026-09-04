// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Breadcrumb } from './breadcrumb.js';

afterEach(cleanup);

describe('Breadcrumb', () => {
  it('renders every folder segment in order and drops the filename', () => {
    render(<Breadcrumb path="docs/specs/auth.md" />);
    const breadcrumb = screen.getByTestId('breadcrumb');
    const items = [...breadcrumb.querySelectorAll('.breadcrumb-item')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('docs');
    expect(items[1]?.textContent).toContain('specs');
    expect(breadcrumb.textContent).not.toContain('auth.md');
  });

  it('renders nothing for a root-level file with no folders', () => {
    const { container } = render(<Breadcrumb path="README.md" />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('breadcrumb')).toBeNull();
  });

  it('splits unusual segments (spaces, mixed case) correctly', () => {
    render(<Breadcrumb path="my folder/Sub Dir/notes and ideas.md" />);
    const breadcrumb = screen.getByTestId('breadcrumb');
    const items = [...breadcrumb.querySelectorAll('.breadcrumb-item')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('my folder');
    expect(items[1]?.textContent).toContain('Sub Dir');
    expect(breadcrumb.textContent).not.toContain('notes and ideas.md');
  });

  it('never attaches a click handler or link — path is CLI-owned and read-only', () => {
    render(<Breadcrumb path="docs/specs/auth.md" />);
    const breadcrumb = screen.getByTestId('breadcrumb');
    expect(breadcrumb.querySelector('a')).toBeNull();
    expect(breadcrumb.querySelector('button')).toBeNull();
  });
});
