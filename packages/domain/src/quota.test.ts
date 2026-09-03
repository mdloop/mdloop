import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, checkUploadAllowed } from './quota.js';

describe('checkUploadAllowed', () => {
  it('allows a normal upload', () => {
    expect(checkUploadAllowed(1024).ok).toBe(true);
  });

  it('allows exactly the max size', () => {
    expect(checkUploadAllowed(MAX_UPLOAD_BYTES).ok).toBe(true);
  });

  it('rejects empty and oversized files', () => {
    const empty = checkUploadAllowed(0);
    expect(!empty.ok && empty.error.code).toBe('empty_file');
    const big = checkUploadAllowed(MAX_UPLOAD_BYTES + 1);
    expect(!big.ok && big.error.code).toBe('file_too_large');
  });
});
