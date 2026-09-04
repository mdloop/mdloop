import { describe, expect, it } from 'vitest';
import { parseCallout, stripCalloutMarker } from './callouts.js';

describe('parseCallout', () => {
  it('detects each supported kind and maps a label', () => {
    expect(parseCallout('[!NOTE]\nheads up')).toEqual({
      kind: 'note',
      label: 'Note',
      body: 'heads up',
    });
    expect(parseCallout('[!TIP]\nx')?.kind).toBe('tip');
    expect(parseCallout('[!IMPORTANT]\nx')?.label).toBe('Important');
    expect(parseCallout('[!WARNING]\nx')?.kind).toBe('warning');
    expect(parseCallout('[!CAUTION]\nx')?.kind).toBe('caution');
  });

  it('is case-insensitive on the marker word', () => {
    expect(parseCallout('[!note]\nx')?.kind).toBe('note');
  });

  it('strips the marker line from the returned body', () => {
    expect(parseCallout('[!WARNING]\nline one\nline two')?.body).toBe('line one\nline two');
  });

  it('handles a marker with no body', () => {
    expect(parseCallout('[!TIP]')).toEqual({ kind: 'tip', label: 'Tip', body: '' });
  });

  it('returns null for plain blockquotes and mid-text markers', () => {
    expect(parseCallout('just a quote')).toBeNull();
    expect(parseCallout('lead in [!NOTE] not a callout')).toBeNull();
    expect(parseCallout('[!UNKNOWN]\nx')).toBeNull();
  });
});

describe('stripCalloutMarker', () => {
  it('removes a leading marker line', () => {
    expect(stripCalloutMarker('[!NOTE]\nbody')).toBe('body');
  });

  it('leaves non-callout text untouched', () => {
    expect(stripCalloutMarker('plain text')).toBe('plain text');
  });
});
