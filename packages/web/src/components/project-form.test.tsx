// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_COLORS, ProjectForm } from './project-form.js';

afterEach(cleanup);

describe('ProjectForm', () => {
  it('creates with the typed name and default color', async () => {
    const onCreate = vi.fn();
    render(<ProjectForm onCreate={onCreate} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('Project name'), 'Ops docs');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onCreate).toHaveBeenCalledWith({ name: 'Ops docs', color: PROJECT_COLORS[0] });
  });

  it('submits on Enter with a picked color', async () => {
    const onCreate = vi.fn();
    render(<ProjectForm onCreate={onCreate} onCancel={vi.fn()} />);
    const green = PROJECT_COLORS[2] ?? '';
    await userEvent.click(screen.getByRole('button', { name: `Color ${green}` }));
    await userEvent.type(screen.getByLabelText('Project name'), 'Deploys{Enter}');
    expect(onCreate).toHaveBeenCalledWith({ name: 'Deploys', color: green });
  });

  it('does not create with an empty name', async () => {
    const onCreate = vi.fn();
    render(<ProjectForm onCreate={onCreate} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    render(<ProjectForm onCreate={vi.fn()} onCancel={onCancel} />);
    await userEvent.type(screen.getByLabelText('Project name'), '{Escape}');
    expect(onCancel).toHaveBeenCalled();
  });
});
