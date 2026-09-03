import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, precheckUpload, uploadErrorCopy } from './upload-precheck.js';

/** `File` with a chosen byte size without materializing the bytes. */
function fileOfSize(bytes: number, name = 'big.md'): File {
  const file = new File(['x'], name, { type: 'text/markdown' });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

const small = (name = 'notes.md'): File => new File(['x'], name, { type: 'text/markdown' });

describe('precheckUpload', () => {
  it('lets ordinary markdown through, tabs and newlines included', () => {
    expect(precheckUpload(small(), '# Title\n\n- a\tb\r\n- c')).toBeUndefined();
  });

  it('refuses a file over the cap, and accepts one exactly at it', () => {
    expect(precheckUpload(fileOfSize(MAX_UPLOAD_BYTES + 1), '# Big')).toBe('file_too_large');
    expect(precheckUpload(fileOfSize(MAX_UPLOAD_BYTES), '# Big')).toBeUndefined();
  });

  it('refuses content carrying C0 control bytes — a renamed binary after the browser decode', () => {
    expect(precheckUpload(small(), '# Notes\u0000binary')).toBe('control_byte_detected');
    expect(precheckUpload(small(), 'text\u001fmore')).toBe('control_byte_detected');
    expect(precheckUpload(small(), 'text\u007f')).toBe('control_byte_detected');
  });

  it('leaves the binary-signature table to the server (ADR 0011) rather than duplicating it', () => {
    // A PDF whose bytes happen to decode cleanly passes the client check and
    // is refused server-side instead — the client is UX, not enforcement.
    expect(precheckUpload(small('report.md'), '%PDF-1.7 clean text tail')).toBeUndefined();
  });
});

describe('uploadErrorCopy', () => {
  it('has plain-language copy for every server-side upload refusal code', () => {
    for (const code of [
      'file_too_large',
      'empty_file',
      'invalid_title',
      'binary_signature_detected',
      'control_byte_detected',
      'replacement_char_density_exceeded',
      'invalid_utf8',
    ]) {
      expect(uploadErrorCopy(code)).not.toBe('failed');
    }
  });

  it('falls back rather than showing a raw code for anything unmapped', () => {
    expect(uploadErrorCopy('some_future_code')).toBe('failed');
  });
});
