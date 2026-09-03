import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_TITLE_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  isValidDocumentTitle,
  isValidProjectColor,
  isValidProjectName,
} from './project.js';

describe('isValidProjectColor', () => {
  it.each(['#6366f1', '#000000', '#abcdef'])('accepts %s', (c) => {
    expect(isValidProjectColor(c)).toBe(true);
  });

  it.each(['#ABCDEF', '6366f1', '#fff', '#12345g', '', 'red'])('rejects %s', (c) => {
    expect(isValidProjectColor(c)).toBe(false);
  });
});

describe('isValidProjectName', () => {
  it('accepts a normal name', () => {
    expect(isValidProjectName('Docs Q3')).toBe(true);
  });

  it('rejects empty and whitespace-only names', () => {
    expect(isValidProjectName('')).toBe(false);
    expect(isValidProjectName('   ')).toBe(false);
  });

  it('rejects names beyond the max length', () => {
    expect(isValidProjectName('x'.repeat(MAX_PROJECT_NAME_LENGTH))).toBe(true);
    expect(isValidProjectName('x'.repeat(MAX_PROJECT_NAME_LENGTH + 1))).toBe(false);
  });
});

describe('isValidDocumentTitle', () => {
  it('accepts a normal title', () => {
    expect(isValidDocumentTitle('runbook.md')).toBe(true);
  });

  it('rejects empty and oversized titles', () => {
    expect(isValidDocumentTitle('  ')).toBe(false);
    expect(isValidDocumentTitle('x'.repeat(MAX_DOCUMENT_TITLE_LENGTH + 1))).toBe(false);
  });
});
