# ADR 0011 — Upload content validation and the 500KB size cap

- Status: Accepted (2026-08-04, explicit OK per CONSTITUTION §8.5 — confirmed directly with the
  product owner during the five-workstream hardening review, 2026-08-04)
- Date: 2026-08-04
- Deciders: Jasdeep (product)
- Relates to: CONSTITUTION.md §4 ("upload cap 2MB/file"), §9 ("upload (drag-drop, 2MB cap,
  quotas)"), §8.5 (ADR before deviation); ADR 0001 (immutable versions — this ADR changes
  ingest, never touches existing blobs)

## Context

The only server-side check on uploaded content today is byte size
(`checkUploadAllowed`, `packages/domain/src/quota.ts`, `MAX_UPLOAD_BYTES = 2 * 1024 * 1024`).
The `.md` restriction visible in the web UI is a client-side HTML `accept` attribute on the
file input (`upload-dropzone.tsx`) — it constrains nothing server-side. Renaming an arbitrary
binary to `.md`, or calling `POST /documents` / MCP `upload_document` directly, stores
arbitrary bytes as a "document" today. This is a live gap in shipped code, not a design
question.

### Why this isn't "markdown parsing"

CommonMark has no parse-error state: every byte sequence that decodes as text is valid
markdown. So "validate the upload is markdown" cannot mean parse-validation — there is nothing
to reject that way. What can be enforced is content _policy_: reject inputs whose byte shape
is inconsistent with being human-authored or agent-authored prose, independent of whether it
happens to parse.

### The one assumption this design depends on: no direct-to-S3 upload path

Both ingest surfaces — REST (`POST /documents`, `POST /documents/:id/versions`) and MCP
(`upload_document`) — take content as a JSON/RPC **string**, encode it server-side
(`Buffer.from(content, 'utf8')` in `document-routes.ts`; `encoder.encode(content)` in
`packages/mcp/src/server.ts`), and hand the resulting bytes to the same two use-case functions
(`uploadNewDocument`/`uploadNewVersion`, `packages/app/src/use-cases/upload.ts`), which then
call `storage.put`. There is no presigned-URL or direct-to-S3 write path anywhere in the
codebase today (`BlobUrlPort` is read-only — `signedUrlFor` — and even reads proxy through the
API in stage 1 via `ApiProxyBlobUrl`).

**This is what makes an application-layer validator an actual enforcement point rather than a
polite suggestion**: every byte that becomes a version blob passes through
`packages/app/src/use-cases/upload.ts` first. If a future phase introduces direct-to-S3
presigned uploads (a plausible cost/latency optimization at scale), this validator stops
being able to see the bytes before they land, and equivalent enforcement would need to move to
an S3-event-triggered scanner with a quarantine/delete-on-fail flow instead. Flagging this now
so it isn't rediscovered the hard way.

## Decision

### A. Four content-policy checks, unequal in practical weight

Implemented in a new pure function, `packages/domain/src/markdown-content.ts`, with no imports
beyond `@mdloop/shared` (same layering discipline as the rest of `packages/domain`):

1. **Control-byte scan** (load-bearing). NUL and other C0 control characters never appear in
   legitimate markdown. This is the check that actually catches a renamed binary uploaded
   through the web dropzone: `readAll`'s `f.text()` call already lossily decodes the file into
   _technically valid_ UTF-8 client-side before the bytes are ever sent, so by the time the
   server sees them, "is this valid UTF-8" is no longer a meaningful question — but the control
   bytes from the original binary survive that decode as literal characters.
2. **Replacement-character (U+FFFD) density ceiling** (load-bearing). The direct residue of
   the same lossy client-side decode: binary whose high bytes don't survive translation get
   replaced with U+FFFD rather than preserved as control characters. A ceiling on the fraction
   of the document that is U+FFFD catches this class independent of check 1.
3. **Binary magic-byte rejection** (defense-in-depth, first check run — cheapest). Known
   signatures for PDF, PNG, JPEG, GIF, ZIP/OOXML (`PK`), ELF, Mach-O, PE (`MZ`), RTF, gzip.
   Effective mainly for signatures whose bytes survive a lossy UTF-8 decode unchanged (`%PDF-`,
   `MZ`, `{\rtf`, `Rar!` are pure ASCII); most others are already caught by checks 1–2. Kept
   because it's unambiguous and free.
4. **Strict UTF-8** (defense-in-depth, currently inert). `new TextDecoder('utf-8', { fatal:
true })` — note the default is `fatal: false`, which silently emits replacement characters
   rather than erroring, which is exactly why check 2 exists. **This check cannot fire on
   either ingest path today**: `Buffer.from(str, 'utf8')` and `TextEncoder.encode()` always
   produce well-formed UTF-8 from a JS string by construction, so there is no way for
   genuinely malformed UTF-8 to reach the validator under the current JSON/RPC-string
   transport. It is included anyway, with a comment stating plainly that it is currently
   unreachable, so that (a) it is not misread as a live protection, (b) it is not deleted as
   dead code, and (c) it activates for free if a future change ever accepts raw bytes over the
   wire (e.g. multipart upload) instead of a JSON string.

Errors surface as new `UploadError` codes (`packages/app/src/use-cases/upload.ts`), mapped to
HTTP **415 Unsupported Media Type** in `uploadErrorStatus`
(`packages/api/src/routes/document-routes.ts`) and propagated for free on the MCP path via the
existing `errorResult(result.error.code)` mechanism.

### B. Size cap drops 2MB → 500KB

100 pages of markdown is roughly 300KB, so 500KB clears the stated worst case with headroom
while cutting the blast radius of any hostile or accidental oversized upload 4x. This value is
written into CONSTITUTION §4 and §9 and is amended by this ADR (below).

No migration and no backfill: the cap gates ingest only, and version rows are immutable
(ADR 0001) — every document already stored above 500KB stays exactly as it is.

## Constitution amendments (applied with this ADR)

- **§4 Security Non-Negotiables**: "upload cap 2MB/file" → "upload cap 500KB/file"; append a
  clause noting content-policy validation (binary/control-byte/replacement-density rejection)
  runs in the domain layer alongside the size check, not just the UI.
- **§9 MVP Scope**: "upload (drag-drop, 2MB cap, quotas)" → "upload (drag-drop, 500KB cap,
  content-validated, quotas)".

## Consequences

- `MAX_UPLOAD_BYTES` (`packages/domain/src/quota.ts`) becomes `500 * 1024`.
- Fastify's `BODY_LIMIT_BYTES` (`packages/api/src/server.ts`, currently 4MB) is lowered in
  step, so the transport-level ceiling stays a coarse outer bound consistent with the new cap
  rather than a stale, much larger number.
- `uploadErrorStatus`'s exhaustive `Record<UploadError['code'], number>` means adding the new
  error codes to the `UploadError` union is a compile error at the route until the map is
  updated — this is deliberate: it is the mechanism that guarantees no new error code can reach
  a client unmapped.
- `features/upload-quota.feature`'s existing "A file over 2MB is rejected" scenario and its
  header comment, plus the corresponding `packages/api/src/documents-api.test.ts` case, need
  updating to the new figure — they are the money-path coverage this ADR is amending, not
  separate work.
- If a future phase moves upload off the JSON/RPC-string transport (raw multipart, or a
  presigned direct-to-S3 path), re-read the "one assumption this design depends on" section
  above before assuming this validator still enforces anything.

## Alternatives considered

- **Content-type sniffing library** (e.g. `file-type`) instead of a hand-rolled magic-byte
  check: rejected for now — the signature list needed is small and static, and a dependency
  buys little over ~10 lines of byte comparisons for this specific rejection set. Revisit if
  the signature list grows unmanageably.
- **Parse-validate as markdown**: rejected — see "Why this isn't markdown parsing" above; there
  is no parse-error state to check.
- **Leave the cap at 2MB, add only content checks**: rejected — the product owner's explicit OK
  covered both changes together, and 500KB independently reduces the damage radius of anything
  that still slips past content validation.
