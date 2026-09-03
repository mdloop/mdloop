import { describe, expect, it } from 'vitest';
import { validateMarkdownContent } from './markdown-content.js';

const encoder = new TextEncoder();

function textBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

describe('validateMarkdownContent', () => {
  it('allows plain markdown prose', () => {
    const res = validateMarkdownContent(
      textBytes('# Title\n\nSome **bold** text with a\ttab and\r\nCRLF line ending.\n'),
    );
    expect(res.ok).toBe(true);
  });

  it('allows empty content', () => {
    // Empty-file rejection is `quota.ts`'s job (`empty_file`), not this
    // validator's — it has nothing to say about zero bytes.
    expect(validateMarkdownContent(new Uint8Array(0)).ok).toBe(true);
  });

  describe('binary signature rejection', () => {
    const cases: [string, number[]][] = [
      ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]],
      ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
      ['jpeg', [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]],
      ['gif87a', [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]],
      ['gif89a', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
      ['zip_ooxml', [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]],
      ['elf', [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]],
      ['pe', [0x4d, 0x5a, 0x90, 0x00]],
      ['rtf', [0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31]],
      ['gzip', [0x1f, 0x8b, 0x08, 0x00]],
    ];

    for (const [name, bytes] of cases) {
      it(`rejects a ${name} signature`, () => {
        const res = validateMarkdownContent(new Uint8Array(bytes));
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('binary_signature_detected');
        }
      });
    }

    it('does not false-positive on markdown that merely starts with similar bytes', () => {
      // "MZ" (PE signature) is also just two capital letters — real markdown
      // starting with them must not be flagged once more than the two magic
      // bytes are present and don't continue the signature meaningfully.
      // This case starts with plain text, not the PE prefix, so it's a
      // control case proving the signature check isn't overly broad.
      const res = validateMarkdownContent(textBytes('Meeting Zone notes\n\n- item one\n'));
      expect(res.ok).toBe(true);
    });
  });

  describe('control-byte detection', () => {
    it('rejects a NUL byte hidden in otherwise-plausible text', () => {
      // Simulates the residue of a renamed binary that survived the web
      // dropzone's lossy `f.text()` decode (ADR 0011) — this is the
      // load-bearing check on today's ingest transports.
      const res = validateMarkdownContent(textBytes('# Title\u0000\nBody text'));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('control_byte_detected');
      }
    });

    it('rejects other C0 control characters', () => {
      const res = validateMarkdownContent(textBytes('body\u0001more'));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('control_byte_detected');
      }
    });

    it('rejects DEL (0x7f)', () => {
      const res = validateMarkdownContent(new Uint8Array([...textBytes('body'), 0x7f]));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('control_byte_detected');
      }
    });

    it('allows tab, LF, and CR — ordinary markdown whitespace', () => {
      const res = validateMarkdownContent(textBytes('a\tb\nc\rd'));
      expect(res.ok).toBe(true);
    });
  });

  describe('replacement-character density ceiling', () => {
    it('rejects content that is mostly U+FFFD', () => {
      const content = 'x'.repeat(10) + '�'.repeat(90);
      const res = validateMarkdownContent(textBytes(content));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('replacement_char_density_exceeded');
        if (res.error.code === 'replacement_char_density_exceeded') {
          expect(res.error.density).toBeCloseTo(0.9, 5);
        }
      }
    });

    it('allows a stray replacement character well under the ceiling', () => {
      const content = 'a'.repeat(999) + '�';
      const res = validateMarkdownContent(textBytes(content));
      expect(res.ok).toBe(true);
    });

    it('rejects exactly at the boundary above the ceiling', () => {
      // 2 in 100 chars = 2% density, above the 1% ceiling.
      const content = 'a'.repeat(98) + '�'.repeat(2);
      const res = validateMarkdownContent(textBytes(content));
      expect(res.ok).toBe(false);
    });
  });
});
