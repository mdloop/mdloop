/**
 * Longest a document path may be, in characters. 1024 clears any real repo
 * layout with room to spare (git itself caps one path component at 255 bytes)
 * while keeping a hostile or accidental value from bloating the row and the
 * partial unique index that covers it. Mirrors `documents_path_shape_ck`
 * (migration 0032).
 */
export const MAX_DOCUMENT_PATH_LENGTH = 1024;

/**
 * Control characters (incl. NUL and DEL) — never in a legitimate repo path,
 * and exactly what makes a path render or log deceptively. Checked by
 * codepoint rather than a regex: `no-control-regex` forbids the literal
 * character class, and the escaped form reads worse than this does.
 */
function hasControlChars(path: string): boolean {
  for (const ch of path) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Is this a safe repo-relative document path (Phase 29)?
 *
 * A path is `docs/specs/auth.md` — POSIX separators, relative, filename
 * included. It records where the sync CLI found the file so mdloop can rebuild
 * the workspace structure a reader navigates by.
 *
 * **This is not a storage key and must never become one.** Blobs are addressed
 * exclusively by `VersionKey{orgId, documentId, seq}` derived from tenant
 * context, and no function anywhere accepts an outside-supplied storage path
 * (CONSTITUTION.md §3). `path` is display/organisation metadata: the workspace
 * tree and the viewer breadcrumb read it, the storage layer never does. This
 * validator is therefore NOT what keeps blobs safe — the typed-key rule is.
 * It exists so the mirrored structure is well-formed, and so a path can never
 * *look* like a filesystem escape to a future reader or to a client that
 * naively joins it onto some base of its own.
 *
 * Rejects absolute paths, `.`/`..` segments, backslashes (a Windows separator
 * would fork one file into two tree shapes), empty segments (`a//b.md`, a
 * trailing `/`), surrounding or per-segment whitespace, control characters,
 * and anything longer than `MAX_DOCUMENT_PATH_LENGTH`.
 *
 * File type is deliberately NOT constrained: "must be markdown" is ingest
 * policy for whoever writes the path, not a safety rule, and hard-coding it
 * here would make the domain the wrong place to relax it later.
 */
export function isValidDocumentPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_DOCUMENT_PATH_LENGTH) return false;
  if (path.includes('\\')) return false;
  if (hasControlChars(path)) return false;
  const segments = path.split('/');
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..' && s === s.trim());
}
