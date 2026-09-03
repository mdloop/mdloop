import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, JSX } from 'react';
import { precheckUpload } from '../upload-precheck.js';
import { IconUpload } from './icons.js';

export interface UploadFile {
  title: string;
  content: string;
  /**
   * Set when the client-side pre-check refused the file (ADR 0011) — the
   * caller reports it and never sends the bytes. Absent means "worth
   * sending", not "valid": the server is still the enforcement point and
   * re-runs the full content policy on everything that arrives.
   */
  rejection?: string;
}

export interface UploadDropzoneProps {
  /** Required for `UploadButton`, which always reads files itself. Optional
   *  for `useDropTarget` callers that instead pass `onRawFiles` — when both
   *  are omitted `onDrop` has nothing to call and is a no-op. */
  onFiles?: (files: UploadFile[]) => void;
  /** When provided, `onDrop` hands back the raw `File[]` instead of reading
   *  them into `{title, content}[]` and calling `onFiles` — for callers
   *  (the viewer) that need the `File` itself, e.g. for a confirm-dialog
   *  title or a later `.text()` read of their own. Skips `readAll`/`onFiles`
   *  entirely when set; `onFiles` keeps working unchanged when it's not. */
  onRawFiles?: (files: File[]) => void;
  disabled?: boolean;
}

async function readAll(list: FileList | File[]): Promise<UploadFile[]> {
  return Promise.all(
    [...list].map(async (f) => {
      const content = await f.text();
      const rejection = precheckUpload(f, content);
      return rejection === undefined
        ? { title: f.name, content }
        : { title: f.name, content, rejection };
    }),
  );
}

/** Drag depth counter + the shared file-reading path for both the
 *  page-level drop target and the browse button — one `onFiles` contract,
 *  two entry points. A plain dragenter/dragleave depth counter (rather than
 *  a single active flag) is what keeps the overlay from flickering as the
 *  pointer crosses child elements inside the drop target: dragleave fires
 *  every time the pointer passes over a descendant, but enter/leave stay
 *  balanced across the whole subtree. */
export function useDropTarget({ onFiles, onRawFiles, disabled }: UploadDropzoneProps): {
  active: boolean;
  dropTargetProps: {
    onDragEnter: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
} {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  function hasFiles(e: DragEvent): boolean {
    return [...e.dataTransfer.types].includes('Files');
  }

  function onDragEnter(e: DragEvent): void {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setActive(true);
  }

  function onDragOver(e: DragEvent): void {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
  }

  function onDragLeave(e: DragEvent): void {
    if (disabled || !hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setActive(false);
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    depth.current = 0;
    setActive(false);
    if (disabled || e.dataTransfer.files.length === 0) return;
    if (onRawFiles) {
      onRawFiles([...e.dataTransfer.files]);
      return;
    }
    void readAll(e.dataTransfer.files).then(onFiles);
  }

  return { active, dropTargetProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

export interface DropOverlayProps {
  label?: string;
  hint?: string;
}

/** Full-area overlay shown by the caller while a file drag is active over
 *  the drop target — the drag handling itself lives in `useDropTarget`
 *  since the drop target is the whole content area, not this element.
 *  `label`/`hint` default to the homepage's copy so existing callers are
 *  unaffected; other drop targets (the viewer) pass their own. */
export function DropOverlay({
  label = 'Drop markdown files to upload',
  hint = 'Markdown files, up to 500 KB each — 100 uploads per week',
}: DropOverlayProps): JSX.Element {
  return (
    <div className="drop-overlay" data-testid="dropzone">
      <div>{label}</div>
      <div className="dropzone-hint">{hint}</div>
    </div>
  );
}

/** Labeled button + hidden multi-file input — the click-to-browse upload
 *  entry point, rendered in page chrome (top-right of the lane header). */
export function UploadButton({ onFiles, disabled }: UploadDropzoneProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  function onChange(e: ChangeEvent<HTMLInputElement>): void {
    if (e.target.files && e.target.files.length > 0) {
      void readAll(e.target.files).then(onFiles);
      e.target.value = '';
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={disabled}
        title="Upload markdown files"
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <IconUpload size={14} />
        Upload
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,text/markdown,text/plain"
        multiple
        hidden
        data-testid="file-input"
        onChange={onChange}
      />
    </>
  );
}
