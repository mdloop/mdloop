import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from './concurrency.js';
import { resolveApiKey } from './credentials.js';
import { EndpointRefusedError } from './endpoint-trust.js';
import { sha256Hex } from './hash.js';
import type { LockInfo } from './lock.js';
import { acquireLock, releaseLock } from './lock.js';
import type { Manifest, ManifestFileEntry } from './manifest.js';
import { readManifest, writeManifest } from './manifest.js';
import type { VorlynMcpClient } from './mcp-client.js';
import { connectTrustedMcpClient } from './mcp-client.js';
import type { Io } from './output.js';
import { commitTriggerMissingHookWarning } from './trigger-drift.js';
import { walkMarkdownFiles } from './walk.js';

export interface PushOptions {
  folder: string;
  force: boolean;
  concurrency: number;
  /**
   * "What changed" note recorded on every version this run creates (ADR 0003
   * §B) — the thing that makes the reviewer's Compare surface readable.
   */
  note?: string;
  /**
   * Hook mode: suppresses the per-file
   * unchanged/pushed lines and the summary, so a routine sync costs the
   * calling agent nothing. Conflicts and failures still print — a silent
   * refusal is how sync rots — and the exit code is unchanged either way.
   */
  quiet?: boolean;
}

export interface PushSummary {
  pushed: number;
  unchanged: number;
  conflicts: number;
  failed: number;
}

export interface PushDeps {
  exit: (code: number) => void;
  /** Seam for tests that need a client whose calls reject at the transport level. */
  connect: (folder: string, endpoint: string, apiKey: string) => Promise<VorlynMcpClient>;
  /**
   * Where SIGINT/SIGTERM arrive. Injectable so the interrupt path can be
   * tested without emitting a real signal into the test runner's process.
   */
  signals: NodeJS.EventEmitter;
}

const realDeps: PushDeps = {
  exit: (code: number) => process.exit(code),
  connect: connectTrustedMcpClient,
  signals: process,
};

const decoder = new TextDecoder();

type PushFileResult =
  | { kind: 'unchanged' }
  | { kind: 'pushed'; entry: ManifestFileEntry }
  | { kind: 'conflict'; localSeq: number; serverSeq: number }
  /**
   * `message` is set for the tier-cap codes that carry a server-supplied
   * human-readable explanation (packages/mcp/src/server.ts), plus `path_taken`
   * / `invalid_path` (locally-sourced via `pathFailureMessage`, since those
   * two never carry a server `message`); every other failure keeps `message`
   * unset and `recordResult` falls back to the bare code, same as before
   * either of these existed.
   */
  | { kind: 'failed'; code: string; message?: string };

function titleFromPath(relPath: string): string {
  return path.basename(relPath, '.md');
}

/**
 * `relPath` comes from `walkMarkdownFiles`, which builds it with
 * `path.relative()` — the platform separator, so `\` on Windows. The domain
 * validator (`isValidDocumentPath`) rejects any backslash outright ("a
 * Windows separator would fork one file into two tree shapes"), so every
 * push would fail with `invalid_path` on Windows without this. Normalizing
 * at the send site, not in the manifest key format: the manifest key is
 * `relPath` as returned by `walkMarkdownFiles` and changing that would
 * orphan every already-tracked entry.
 *
 * Splits on the literal backslash character rather than `path.sep`:
 * `path.sep` reflects whatever platform *this process* is running on, so a
 * `path.sep`-based split would be a no-op when exercised from a POSIX test
 * runner (as this repo's CI is) even though the bug it fixes only manifests
 * on Windows — untestable except on real Windows hardware. Backslash is
 * never a legal character in a POSIX path segment and never appears in a
 * `path.relative()` result on any POSIX platform, so unconditionally
 * replacing it is correct on every platform, not just Windows, and is
 * directly testable here.
 */
export function toPosixPath(relPath: string): string {
  return relPath.split('\\').join('/');
}

/**
 * Friendly text for the two failure codes newly reachable once pushes send
 * `path` — same tier as the tier-cap codes' server-supplied `message`
 * (`PushFileResult` above), just sourced locally since these two are a fixed,
 * small set rather than data-dependent. Every other code still falls back to
 * the bare code in `recordResult`.
 */
const PATH_FAILURE_MESSAGES: Record<string, string> = {
  path_taken:
    'Another document already exists at this path in the project — resolve the conflict in Vorlyn or move one of them.',
  invalid_path:
    "This file's path isn't valid for Vorlyn (check for empty segments, `.`/`..`, or unusual characters).",
};

/** Server-supplied `message` (tier-cap codes) wins if present; otherwise falls
 *  back to the local lookup for the two path codes; otherwise unset, same as
 *  before either of these existed. */
function pathFailureMessage(code: string, serverMessage: string | undefined): string | undefined {
  return serverMessage ?? PATH_FAILURE_MESSAGES[code];
}

/**
 * Every thrown error becomes a code, because a throw escaping one concurrent
 * worker rejects the whole `Promise.all` and takes its siblings' unrecorded
 * results with it — including files already uploaded server-side, which would
 * then be re-created as duplicates on the next run.
 */
function failureCode(error: unknown): string {
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof errno === 'string' && errno !== '') return errno;
  // Never fall back to `error.message` here: it can quote a local file path
  // or, from a transport-level rejection, server response content — this
  // return value is printed straight to the terminal at the call site.
  return 'unknown_error';
}

/**
 * Never throws. Transport rejections, malformed tool payloads, and a file
 * walked-then-deleted (a plausible `git checkout` race) all come back as
 * `{ kind: 'failed' }` so the caller records them like any other outcome.
 */
async function pushOneFile(
  client: VorlynMcpClient,
  folder: string,
  relPath: string,
  manifest: Manifest,
  force: boolean,
  note: string | undefined,
): Promise<PushFileResult> {
  try {
    const bytes = await readFile(path.join(folder, relPath));
    const localHash = sha256Hex(bytes);
    const existing = manifest.files[relPath];

    if (existing) {
      if (existing.contentHash === localHash) {
        return { kind: 'unchanged' };
      }
      // Metadata only: `get_document_status` exists precisely so the guard
      // never downloads a whole markdown body just to read a seq.
      const status = await client.getDocumentStatus(existing.documentId);
      if (!status.ok) return { kind: 'failed', code: status.error.code };
      if (status.value.versionSeq !== existing.versionSeq && !force) {
        return {
          kind: 'conflict',
          localSeq: existing.versionSeq,
          serverSeq: status.value.versionSeq,
        };
      }
      const upload = await client.uploadDocument({
        content: decoder.decode(bytes),
        documentId: existing.documentId,
        path: toPosixPath(relPath),
        ...(note === undefined ? {} : { changeNote: note }),
      });
      if (!upload.ok) {
        const message = pathFailureMessage(upload.error.code, upload.error.message);
        return {
          kind: 'failed',
          code: upload.error.code,
          ...(message === undefined ? {} : { message }),
        };
      }
      return {
        kind: 'pushed',
        entry: {
          documentId: upload.value.documentId,
          contentHash: localHash,
          versionSeq: upload.value.versionSeq,
        },
      };
    }

    const upload = await client.uploadDocument({
      content: decoder.decode(bytes),
      title: titleFromPath(relPath),
      projectId: manifest.projectId,
      path: toPosixPath(relPath),
      ...(note === undefined ? {} : { changeNote: note }),
    });
    if (!upload.ok) {
      const message = pathFailureMessage(upload.error.code, upload.error.message);
      return {
        kind: 'failed',
        code: upload.error.code,
        ...(message === undefined ? {} : { message }),
      };
    }
    return {
      kind: 'pushed',
      entry: {
        documentId: upload.value.documentId,
        contentHash: localHash,
        versionSeq: upload.value.versionSeq,
      },
    };
  } catch (error) {
    return { kind: 'failed', code: failureCode(error) };
  }
}

/**
 * Pre-flight courtesy warning (Phase 33.D): before a batch push starts
 * uploading, say how many NEW documents it will create and how that compares
 * to the org's current headroom against its tier's doc cap — so a large
 * batch failing partway through on `doc_cap_exceeded` (now with a clear
 * message per 33.A.1, but still a mid-batch surprise) is instead something
 * the user saw coming. Advisory only: never blocks the push, and any
 * failure calling `get_org_usage` (network error, an older server that
 * doesn't have the tool yet, whatever) fails open — the actual hard
 * backstop remains the cap rejection itself if/when it's hit.
 */
export async function warnIfOverHeadroom(
  client: VorlynMcpClient,
  io: Io,
  newFileCount: number,
): Promise<void> {
  if (newFileCount === 0) return;
  let usage;
  try {
    usage = await client.getOrgUsage();
  } catch {
    return;
  }
  if (!usage.ok) return;
  const { activeDocCount, maxActiveDocs } = usage.value;
  if (maxActiveDocs === null) return;
  if (activeDocCount + newFileCount <= maxActiveDocs) return;
  io.errln(
    `warning    this push will attempt ${String(newFileCount)} new document${newFileCount === 1 ? '' : 's'}, ` +
      `but the org is already at ${String(activeDocCount)}/${String(maxActiveDocs)} documents for this tier — ` +
      'some uploads may be rejected with doc_cap_exceeded once the cap is hit.',
  );
}

function recordResult(
  io: Io,
  summary: PushSummary,
  manifest: Manifest,
  relPath: string,
  result: PushFileResult,
  quiet: boolean,
): void {
  switch (result.kind) {
    case 'unchanged':
      summary.unchanged += 1;
      if (!quiet) io.println(`unchanged  ${relPath}`);
      return;
    case 'pushed':
      summary.pushed += 1;
      manifest.files[relPath] = result.entry;
      if (!quiet) io.println(`pushed     ${relPath}`);
      return;
    case 'conflict':
      summary.conflicts += 1;
      io.errln(
        `conflict   ${relPath}: local knows seq ${String(result.localSeq)}, server is at seq ${String(result.serverSeq)} (use --force)`,
      );
      return;
    case 'failed':
      summary.failed += 1;
      // Prefer the human-readable message when one came through (tier-cap
      // codes only, per PushFileResult above); every other code still prints
      // the bare code exactly as before.
      io.errln(`failed     ${relPath}: ${result.message ?? result.code}`);
  }
}

/**
 * `vorlyn push` — one-shot sync of local `*.md` files to Vorlyn document
 * versions: no filesystem watching.
 * Lock-protected against a racing push; bounded concurrency for a first
 * bulk push of many files.
 */
export async function runPush(
  options: PushOptions,
  io: Io,
  deps: PushDeps = realDeps,
): Promise<number> {
  const manifest = await readManifest(options.folder);
  if (!manifest) {
    io.errln(`${options.folder} is not linked. Run "vorlyn link" first.`);
    return 1;
  }

  // Purely local (a few fs stats, no network) and cheap enough to check on
  // every run: catches a folder that was linked before `git init`, so the
  // commit-trigger hook was never installed and nothing has said so since.
  // Same tier as a conflict/failure line — never suppressed by --quiet, and
  // never affects the exit code.
  const driftWarning = await commitTriggerMissingHookWarning(options.folder);
  if (driftWarning) io.errln(driftWarning);

  const apiKey = await resolveApiKey(options.folder);
  if (!apiKey) {
    io.errln(
      'No API key found. Set VORLYN_API_KEY or create .vorlyn/credentials in the linked folder.',
    );
    return 1;
  }

  let lock: LockInfo;
  try {
    lock = await acquireLock(options.folder);
  } catch (error) {
    io.errln((error as Error).message);
    return 1;
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await releaseLock(options.folder, lock);
  };

  /**
   * Signals set a flag instead of exiting. Exiting from the handler kills the
   * process before the `finally` that persists the manifest, so files already
   * uploaded this run would be forgotten and re-created as duplicate
   * documents on the next push — the exact failure a Ctrl-C or a hook-timeout
   * kill used to cause. In-flight uploads are allowed to land; no new file is
   * started; the normal teardown then writes whatever `workingManifest` holds.
   * `recordResult` mutates it synchronously, so any await point (which is
   * where the write happens) sees a consistent object, never a partial one.
   *
   * A boxed flag, not a bare `let`: a primitive `let` mutated only inside a
   * closure gets narrowed by TS to the literal type of its declaration at
   * every later read in this function, since nothing in its own control flow
   * proves a reassignment happened — the signal handler runs invisibly to
   * that analysis. The property on `state` isn't narrowed the same way.
   */
  const state = { interrupted: false };
  const onSignal = (): void => {
    if (state.interrupted) {
      // Second signal: the user is done waiting. Their call — the manifest may
      // now miss an upload that was in flight.
      deps.exit(130);
      return;
    }
    state.interrupted = true;
    if (!(options.quiet ?? false)) {
      io.errln('Interrupt received — finishing in-flight uploads, then saving progress.');
    }
  };
  deps.signals.on('SIGINT', onSignal);
  deps.signals.on('SIGTERM', onSignal);

  const workingManifest: Manifest = { ...manifest, files: { ...manifest.files } };
  const summary: PushSummary = { pushed: 0, unchanged: 0, conflicts: 0, failed: 0 };

  try {
    let client: VorlynMcpClient;
    try {
      client = await deps.connect(options.folder, manifest.endpoint, apiKey);
    } catch (error) {
      if (error instanceof EndpointRefusedError) io.errln(error.message);
      else io.errln(`Could not connect to ${manifest.endpoint}: ${(error as Error).message}`);
      return 1;
    }
    try {
      const files = await walkMarkdownFiles(options.folder);
      const newFileCount = files.filter((relPath) => !workingManifest.files[relPath]).length;
      await warnIfOverHeadroom(client, io, newFileCount);
      await mapWithConcurrency(files, options.concurrency, async (relPath) => {
        if (state.interrupted) return;
        const result = await pushOneFile(
          client,
          options.folder,
          relPath,
          workingManifest,
          options.force,
          options.note,
        );
        recordResult(io, summary, workingManifest, relPath, result, options.quiet ?? false);
      });
    } finally {
      await client.close();
    }
  } finally {
    await writeManifest(options.folder, workingManifest);
    deps.signals.off('SIGINT', onSignal);
    deps.signals.off('SIGTERM', onSignal);
    await release();
  }

  if (state.interrupted) {
    io.errln(
      'Interrupted. Completed uploads are recorded in .vorlyn/manifest.json — re-run "vorlyn push" to finish.',
    );
    deps.exit(1);
    return 1;
  }

  if (!(options.quiet ?? false)) {
    io.println(
      `${String(summary.pushed)} pushed, ${String(summary.unchanged)} unchanged, ${String(summary.conflicts)} conflicts, ${String(summary.failed)} failed`,
    );
  }
  return summary.conflicts > 0 || summary.failed > 0 ? 1 : 0;
}
