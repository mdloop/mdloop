import { describe, expect, it } from 'vitest';
import { firstExistingRelative } from './resolve-relative-asset.js';

describe('firstExistingRelative', () => {
  it('returns the first candidate an injected `exists` reports true for', async () => {
    const exists = async (candidate: string) => candidate === '/b';
    const result = await firstExistingRelative(['/a', '/b', '/c'], 'thing', exists);
    expect(result).toBe('/b');
  });

  it('checks candidates in order and stops at the first hit', async () => {
    const checked: string[] = [];
    const exists = async (candidate: string) => {
      checked.push(candidate);
      return candidate === '/a';
    };
    await firstExistingRelative(['/a', '/b'], 'thing', exists);
    expect(checked).toEqual(['/a']);
  });

  it('throws naming the label and every candidate tried when none exist', async () => {
    const exists = async () => false;
    await expect(firstExistingRelative(['/a', '/b'], 'the widget', exists)).rejects.toThrow(
      /Could not find the widget.*\/a.*\/b/s,
    );
  });

  it('defaults to a real filesystem check when no `exists` override is given', async () => {
    await expect(
      firstExistingRelative(['/definitely/does/not/exist/vorlyn-test'], 'a missing file'),
    ).rejects.toThrow(/Could not find a missing file/);
  });
});
