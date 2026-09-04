/**
 * Client-side upload pre-check and the friendly copy for every upload
 * refusal, server-side or client-side (ADR 0011).
 *
 * This is a UX shortcut, never an enforcement point: the server re-runs the
 * size cap (`checkUploadAllowed`) and the full content policy
 * (`validateMarkdownContent`) on every upload regardless of what happens
 * here, and a caller that skips the web app entirely is refused exactly the
 * same way. All this buys is that dragging a 40MB PDF onto the homepage says
 * so instantly instead of after a round trip.
 *
 * The domain validator is deliberately NOT imported: dependency-cruiser's
 * `web-frontend-only` rule forbids `packages/web` importing `@mdloop/domain`
 * (the web app talks HTTP and nothing else), so the two checks worth
 * duplicating are re-implemented inline here. The binary magic-byte table
 * stays server-side only — it is the most code and the least load-bearing of
 * the four checks, and duplicating it would buy nothing a control-byte scan
 * doesn't already catch for a real binary.
 */

/** Mirrors `MAX_UPLOAD_BYTES` (`packages/domain/src/quota.ts`, ADR 0011). */
export const MAX_UPLOAD_BYTES = 500 * 1024;

/**
 * C0 control characters minus tab/LF/CR, which are ordinary markdown
 * whitespace — the same exclusion the domain validator makes. These survive
 * the browser's lossy `File.text()` decode of a renamed binary, which is what
 * makes this the check worth running client-side.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Returns the refusal code for a file that cannot possibly be accepted, or
 * `undefined` to let it through to the server. Codes are the server's own, so
 * one copy map below covers both origins.
 */
export function precheckUpload(file: File, content: string): string | undefined {
  if (file.size > MAX_UPLOAD_BYTES) return 'file_too_large';
  if (CONTROL_CHARS.test(content)) return 'control_byte_detected';
  return undefined;
}

/** Sentence fragments completing "<filename> …" in an upload failure list. */
export const UPLOAD_ERROR_COPY: Record<string, string> = {
  file_too_large: 'is over the 500KB limit',
  empty_file: 'is empty',
  invalid_title: 'has an invalid name',
  // Content policy (ADR 0011). Deliberately says what to do about it rather
  // than naming the check that fired — "replacement character density" is not
  // a sentence anyone should read.
  binary_signature_detected: 'looks like a binary file, not markdown',
  control_byte_detected: 'contains binary data, not markdown text',
  replacement_char_density_exceeded: 'is not readable as text — is it a binary file?',
  invalid_utf8: 'is not valid UTF-8 text',
};

/** Copy for one refusal code, falling back for anything unmapped. */
export function uploadErrorCopy(code: string): string {
  return UPLOAD_ERROR_COPY[code] ?? 'failed';
}
