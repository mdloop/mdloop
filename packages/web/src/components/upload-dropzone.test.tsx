// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import { DropOverlay, UploadButton, useDropTarget } from './upload-dropzone.js';

afterEach(cleanup);

describe('UploadButton', () => {
  it('reads browsed files and reports title + content', async () => {
    const onFiles = vi.fn();
    render(<UploadButton onFiles={onFiles} />);
    const input = screen.getByTestId('file-input');
    const file = new File(['# Hello'], 'hello.md', { type: 'text/markdown' });
    await userEvent.upload(input, file);
    await waitFor(() => {
      expect(onFiles).toHaveBeenCalledWith([{ title: 'hello.md', content: '# Hello' }]);
    });
  });

  it('accepts multiple files at once', async () => {
    const onFiles = vi.fn();
    render(<UploadButton onFiles={onFiles} />);
    const input = screen.getByTestId('file-input');
    await userEvent.upload(input, [
      new File(['a'], 'a.md', { type: 'text/markdown' }),
      new File(['b'], 'b.md', { type: 'text/markdown' }),
    ]);
    await waitFor(() => {
      expect(onFiles).toHaveBeenCalledWith([
        { title: 'a.md', content: 'a' },
        { title: 'b.md', content: 'b' },
      ]);
    });
  });

  it('opens the hidden input when the button is clicked', async () => {
    render(<UploadButton onFiles={vi.fn()} />);
    const input = screen.getByTestId('file-input');
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(click).toHaveBeenCalled();
  });
});

/** Minimal host that wires `useDropTarget` onto a div the way shell.tsx
 *  wires it onto `.content` — exercises the hook + overlay together
 *  without pulling in the whole Shell page. */
function DropHost({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: { title: string; content: string }[]) => void;
  disabled?: boolean;
}): JSX.Element {
  const { active, dropTargetProps } = useDropTarget({ onFiles, disabled });
  return (
    <div data-testid="content" {...dropTargetProps}>
      {active && <DropOverlay />}
    </div>
  );
}

/** Host that wires `useDropTarget` with `onRawFiles` the way viewer.tsx
 *  wires it onto `.viewer-body` — exercises the raw-file path instead of
 *  the `onFiles` read-and-report path. */
function RawDropHost({
  onRawFiles,
  disabled = false,
}: {
  onRawFiles: (files: File[]) => void;
  disabled?: boolean;
}): JSX.Element {
  const { active, dropTargetProps } = useDropTarget({ onRawFiles, disabled });
  return (
    <div data-testid="content" {...dropTargetProps}>
      {active && <DropOverlay label="Drop to ship a new leg" hint="Replaces the current leg" />}
    </div>
  );
}

function filesDataTransfer(files: File[]): Record<string, unknown> {
  return { dataTransfer: { types: ['Files'], files } };
}

describe('useDropTarget + DropOverlay', () => {
  it('shows the overlay while a file drag is over the target', () => {
    render(<DropHost onFiles={vi.fn()} />);
    const target = screen.getByTestId('content');
    expect(screen.queryByTestId('dropzone')).toBeNull();
    fireEvent.dragEnter(target, filesDataTransfer([]));
    expect(screen.getByTestId('dropzone')).toBeDefined();
    expect(screen.getByText('Drop markdown files to upload')).toBeDefined();
  });

  it('does not flicker the overlay off when the drag passes over a child element', () => {
    render(<DropHost onFiles={vi.fn()} />);
    const target = screen.getByTestId('content');
    fireEvent.dragEnter(target, filesDataTransfer([]));
    // Simulate the pointer moving onto a descendant: dragLeave on the
    // parent fires, but a balancing dragEnter on the child follows — the
    // depth counter should keep the overlay visible throughout.
    fireEvent.dragEnter(target, filesDataTransfer([]));
    fireEvent.dragLeave(target, filesDataTransfer([]));
    expect(screen.getByTestId('dropzone')).toBeDefined();
  });

  it('hides the overlay once the drag fully leaves', () => {
    render(<DropHost onFiles={vi.fn()} />);
    const target = screen.getByTestId('content');
    fireEvent.dragEnter(target, filesDataTransfer([]));
    fireEvent.dragLeave(target, filesDataTransfer([]));
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });

  it('reads dropped files and reports title + content', async () => {
    const onFiles = vi.fn();
    render(<DropHost onFiles={onFiles} />);
    const target = screen.getByTestId('content');
    const file = new File(['# Hello'], 'hello.md', { type: 'text/markdown' });
    fireEvent.dragEnter(target, filesDataTransfer([file]));
    fireEvent.drop(target, filesDataTransfer([file]));
    await waitFor(() => {
      expect(onFiles).toHaveBeenCalledWith([{ title: 'hello.md', content: '# Hello' }]);
    });
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });

  it('tags a dropped file the client-side pre-check refuses, so it is never sent (ADR 0011)', async () => {
    const onFiles = vi.fn();
    render(<DropHost onFiles={onFiles} />);
    const target = screen.getByTestId('content');
    const renamedBinary = new File(['# Notes\u0000binary'], 'renamed.md');
    fireEvent.dragEnter(target, filesDataTransfer([renamedBinary]));
    fireEvent.drop(target, filesDataTransfer([renamedBinary]));
    await waitFor(() => {
      expect(onFiles).toHaveBeenCalledWith([
        expect.objectContaining({ title: 'renamed.md', rejection: 'control_byte_detected' }),
      ]);
    });
  });

  it('ignores drags and drops while disabled', () => {
    const onFiles = vi.fn();
    render(<DropHost onFiles={onFiles} disabled />);
    const target = screen.getByTestId('content');
    fireEvent.dragEnter(target, filesDataTransfer([]));
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });
});

describe('useDropTarget with onRawFiles', () => {
  it('hands back the raw File[] instead of reading them, when onRawFiles is set', () => {
    const onRawFiles = vi.fn();
    render(<RawDropHost onRawFiles={onRawFiles} />);
    const target = screen.getByTestId('content');
    const file = new File(['# Hello'], 'hello.md', { type: 'text/markdown' });
    fireEvent.dragEnter(target, filesDataTransfer([file]));
    fireEvent.drop(target, filesDataTransfer([file]));
    expect(onRawFiles).toHaveBeenCalledWith([file]);
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });

  it('ignores drags and drops while disabled, with onRawFiles too', () => {
    const onRawFiles = vi.fn();
    render(<RawDropHost onRawFiles={onRawFiles} disabled />);
    const target = screen.getByTestId('content');
    const file = new File(['# Hello'], 'hello.md', { type: 'text/markdown' });
    fireEvent.dragEnter(target, filesDataTransfer([file]));
    fireEvent.drop(target, filesDataTransfer([file]));
    expect(onRawFiles).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dropzone')).toBeNull();
  });
});

describe('DropOverlay with custom copy', () => {
  it('renders a caller-supplied label and hint instead of the default homepage copy', () => {
    render(<DropOverlay label="Drop to ship a new leg" hint="Replaces the current leg" />);
    expect(screen.getByText('Drop to ship a new leg')).toBeDefined();
    expect(screen.getByText('Replaces the current leg')).toBeDefined();
    expect(screen.queryByText('Drop markdown files to upload')).toBeNull();
  });
});
