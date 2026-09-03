import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('matches the well-known FIPS 180-2 test vector for "abc"', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches node:crypto for arbitrary content', () => {
    const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
    const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(sha256Hex(bytes)).toBe(expected);
  });

  it('is deterministic', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes.slice()));
  });

  it('differs for different content', () => {
    const a = sha256Hex(new TextEncoder().encode('a'));
    const b = sha256Hex(new TextEncoder().encode('b'));
    expect(a).not.toBe(b);
  });
});
