import { useState } from 'react';
import type { JSX } from 'react';
import { IconCheck, IconPlus } from './icons.js';

export interface ProjectFormProps {
  onCreate: (input: { name: string; color: string }) => void;
  onCancel: () => void;
  /** Present when editing an existing project instead of creating a new one. */
  initial?: { name: string; color: string };
}

/** Palette offered for new projects — distinct hues that read on chalk. */
export const PROJECT_COLORS = ['#2456e6', '#0e7490', '#15803d', '#a16207', '#b91c1c', '#7c3aed'];

export function ProjectForm({ onCreate, onCancel, initial }: ProjectFormProps): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? PROJECT_COLORS[0] ?? '#2456e6');

  function submit(): void {
    if (name.trim().length === 0) return;
    onCreate({ name: name.trim(), color });
  }

  return (
    <div className="project-form" data-testid="project-form">
      <input
        type="text"
        placeholder="Project name"
        aria-label="Project name"
        value={name}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="color-swatches" role="group" aria-label="Project color">
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="color-swatch"
            style={{ background: c }}
            aria-label={`Color ${c}`}
            aria-pressed={c === color}
            title={`Color ${c}`}
            onClick={() => {
              setColor(c);
            }}
          />
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary"
        title={initial ? 'Save project' : 'Add project'}
        onClick={submit}
      >
        {initial ? <IconCheck size={14} /> : <IconPlus size={14} />}
        {initial ? 'Save' : 'Add'}
      </button>
    </div>
  );
}
