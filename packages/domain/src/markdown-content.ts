import type { Result } from '@vorlyn/shared';
import { err, ok } from '@vorlyn/shared';

/**
 * Ingest content policy (ADR 0011). This is deliberately NOT markdown
 * validation — CommonMark has no parse-error state, so every byte sequence
 * that decodes as text is "valid markdown"; there is nothing to
 * parse-reject. What this checks instead is whether the bytes look like
 * human- or agent-authored prose at all, independent of whether they parse.
 *
 * Distinct from `isValidDocumentPath`'s "File type is deliberately NOT
 * constrained" comment (`document-path.ts`) — that's about the `path`
 * field's shape (where a file lives in a repo), a display/organisation
 * concern. This is about the *content* itself, a different axis entirely;
 * the two are not in tension.
 *
 * See ADR 0011 for why checks below carry unequal practical weight: on
 * today's JSON/RPC-string ingest transport, the control-byte scan and the
 * replacement-density ceiling are the load-bearing checks (they catch the
 * residue of a browser's lossy client-side decode of a renamed binary);
 * strict-UTF-8 is included as defense-in-depth for a hypothetical future
 * raw-bytes transport but cannot fire on the transports that exist today.
 */
export type ContentError =
  | { readonly code: 'binary_signature_detected'; readonly signature: string }
  | { readonly code: 'control_byte_detected' }
  | { readonly code: 'replacement_char_density_exceeded'; readonly density: number }
  | { readonly code: 'invalid_utf8' };

/** Fraction of decoded characters that may be U+FFFD before content is rejected. */
const REPLACEMENT_DENSITY_CEILING = 0.01;

interface BinarySignature {
  readonly name: string;
  readonly bytes: readonly number[];
}

/**
 * Magic-byte table for common non-text formats. Deliberately small and
 * static rather than a `file-type`-shaped dependency — see ADR 0011
 * "Alternatives considered". Ordered roughly by how likely an accidental or
 * hostile upload is to be one of these.
 */
const BINARY_SIGNATURES: readonly BinarySignature[] = [
  { name: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif87a', bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { name: 'gif89a', bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { name: 'zip_ooxml', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'zip_empty', bytes: [0x50, 0x4b, 0x05, 0x06] },
  { name: 'zip_spanned', bytes: [0x50, 0x4b, 0x07, 0x08] },
  { name: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'macho32_le', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'macho64_le', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'macho32_be', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'macho64_be', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'macho_fat', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'pe', bytes: [0x4d, 0x5a] }, // "MZ"
  { name: 'rtf', bytes: [0x7b, 0x5c, 0x72, 0x74, 0x66] }, // "{\rtf"
  { name: 'gzip', bytes: [0x1f, 0x8b] },
];

function matchesSignature(bytes: Uint8Array, signature: BinarySignature): boolean {
  if (bytes.length < signature.bytes.length) return false;
  return signature.bytes.every((b, i) => bytes[i] === b);
}

function detectBinarySignature(bytes: Uint8Array): string | undefined {
  return BINARY_SIGNATURES.find((sig) => matchesSignature(bytes, sig))?.name;
}

/**
 * NUL and other C0 control characters (excluding tab/LF/CR, which are
 * ordinary whitespace in markdown) never appear in legitimate prose. This is
 * the check that actually catches a renamed binary uploaded through the web
 * dropzone — see ADR 0011.
 */
function hasControlBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b === 0x7f) return true;
  }
  return false;
}

export function validateMarkdownContent(bytes: Uint8Array): Result<void, ContentError> {
  const signature = detectBinarySignature(bytes);
  if (signature !== undefined) {
    return err({ code: 'binary_signature_detected', signature });
  }
  if (hasControlBytes(bytes)) {
    return err({ code: 'control_byte_detected' });
  }

  let decoded: string;
  try {
    // Currently unreachable on both ingest transports (REST and MCP both
    // hand this function bytes re-encoded from a JS string, which is always
    // well-formed UTF-8) — kept for a future raw-bytes transport. See ADR
    // 0011.
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return err({ code: 'invalid_utf8' });
  }

  if (decoded.length > 0) {
    const REPLACEMENT_CHAR = '�';
    let replacementCount = 0;
    for (const ch of decoded) {
      if (ch === REPLACEMENT_CHAR) replacementCount++;
    }
    const density = replacementCount / decoded.length;
    if (density > REPLACEMENT_DENSITY_CEILING) {
      return err({ code: 'replacement_char_density_exceeded', density });
    }
  }

  return ok(undefined);
}
