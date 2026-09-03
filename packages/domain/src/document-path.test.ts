import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_PATH_LENGTH, isValidDocumentPath } from './document-path.js';

describe('isValidDocumentPath', () => {
  it.each([
    'README.md',
    'docs/specs/auth.md',
    'docs/adr/0008-grantable-edit-rights.md',
    'a/b/c/d/e/f/g.md',
    'docs/spec with spaces.md',
    'docs/ünïcödé-plan.md',
    'notes',
    'src/a.b.c.txt',
  ])('accepts %s', (p) => {
    expect(isValidDocumentPath(p)).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(isValidDocumentPath('/docs/auth.md')).toBe(false);
    expect(isValidDocumentPath('/')).toBe(false);
  });

  it('rejects traversal in any position', () => {
    expect(isValidDocumentPath('../secrets.md')).toBe(false);
    expect(isValidDocumentPath('docs/../../etc/passwd')).toBe(false);
    expect(isValidDocumentPath('docs/..')).toBe(false);
    expect(isValidDocumentPath('..')).toBe(false);
    // A `..` SUBSTRING is not a traversal segment — this file is legitimate.
    expect(isValidDocumentPath('docs/..hidden.md')).toBe(true);
    expect(isValidDocumentPath('docs/a..b.md')).toBe(true);
  });

  it('rejects bare-dot segments', () => {
    expect(isValidDocumentPath('.')).toBe(false);
    expect(isValidDocumentPath('./auth.md')).toBe(false);
    expect(isValidDocumentPath('docs/./auth.md')).toBe(false);
    // A dotfile is a real repo path, not a bare-dot segment.
    expect(isValidDocumentPath('.vorlyn/config.json')).toBe(true);
  });

  it('rejects backslashes, so one file can never fork into two tree shapes', () => {
    expect(isValidDocumentPath('docs\\specs\\auth.md')).toBe(false);
    expect(isValidDocumentPath('docs/specs\\auth.md')).toBe(false);
    expect(isValidDocumentPath('C:\\repo\\auth.md')).toBe(false);
  });

  it('rejects empty segments', () => {
    expect(isValidDocumentPath('')).toBe(false);
    expect(isValidDocumentPath('docs//auth.md')).toBe(false);
    expect(isValidDocumentPath('docs/auth.md/')).toBe(false);
    expect(isValidDocumentPath('//')).toBe(false);
  });

  it('rejects surrounding and per-segment whitespace', () => {
    expect(isValidDocumentPath(' docs/auth.md')).toBe(false);
    expect(isValidDocumentPath('docs/auth.md ')).toBe(false);
    expect(isValidDocumentPath('docs / auth.md')).toBe(false);
    expect(isValidDocumentPath('   ')).toBe(false);
  });

  it('rejects control characters, including an embedded NUL', () => {
    expect(isValidDocumentPath('docs/auth\u0000.md')).toBe(false);
    expect(isValidDocumentPath('docs/auth\n.md')).toBe(false);
    expect(isValidDocumentPath('docs/auth\t.md')).toBe(false);
    expect(isValidDocumentPath('docs/auth\u007f.md')).toBe(false);
  });

  it('accepts exactly the max length and rejects one over', () => {
    const dir = 'd/';
    const atMax = dir + 'x'.repeat(MAX_DOCUMENT_PATH_LENGTH - dir.length);
    expect(atMax).toHaveLength(MAX_DOCUMENT_PATH_LENGTH);
    expect(isValidDocumentPath(atMax)).toBe(true);
    expect(isValidDocumentPath(`${atMax}x`)).toBe(false);
  });
});
