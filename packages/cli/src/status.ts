import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from './concurrency.js';
import { resolveApiKey } from './credentials.js';
import { EndpointRefusedError } from './endpoint-trust.js';
import { sha256Hex } from './hash.js';
import type { Manifest } from './manifest.js';
import { readManifest } from './manifest.js';
import type { VorlynMcpClient } from './mcp-client.js';
import { connectTrustedMcpClient } from './mcp-client.js';
import type { Io } from './output.js';
import { warnIfOverHeadroom } from './push.js';
import { commitTriggerMissingHookWarning } from './trigger-drift.js';
import { walkMarkdownFiles } from './walk.js';

export interface StatusOptions {
  folder: string;
  concurrency: number;
}

export type FileStatus =
  | { kind: 'unchanged' }
  | { kind: 'modified' }
  | { kind: 'new' }
  | { kind: 'missing' }
  | { kind: 'conflicted'; localSeq: number; serverSeq: number }
  | { kind: 'failed'; code: string };

export interface StatusSummary {
  unchanged: number;
  modified: number;
  new: number;
  missing: number;
  conflicted: number;
  failed: number;
}

/**
 * Classifies one file exactly the way `pushOneFile` would decide its fate, so
 * `status` is a true dry run rather than a second opinion: the local hash gate
 * comes first (an unchanged file costs no network call, and a server that has
 * moved under an unchanged file is not a conflict — push would skip it), and
 * only a locally-modified file pays for a `get_document_status` seq check.
 */
async function statusOfFile(
  client: VorlynMcpClient,
  folder: string,
  relPath: string,
  manifest: Manifest,
  tracked: boolean,
): Promise<FileStatus> {
  const existing = manifest.files[relPath];
  if (!existing) return { kind: 'new' };
  // Tracked but gone from disk. Reported, never acted on — deletion is a
  // deliberate web/API action, never inferred from a missing file.
  if (!tracked) return { kind: 'missing' };

  const bytes = await readFile(path.join(folder, relPath));
  if (sha256Hex(bytes) === existing.contentHash) return { kind: 'unchanged' };

  const status = await client.getDocumentStatus(existing.documentId);
  if (!status.ok) return { kind: 'failed', code: status.error.code };
  if (status.value.versionSeq !== existing.versionSeq) {
    return {
      kind: 'conflicted',
      localSeq: existing.versionSeq,
      serverSeq: status.value.versionSeq,
    };
  }
  return { kind: 'modified' };
}

function report(io: Io, summary: StatusSummary, relPath: string, status: FileStatus): void {
  switch (status.kind) {
    case 'unchanged':
      summary.unchanged += 1;
      io.println(`unchanged  ${relPath}`);
      return;
    case 'modified':
      summary.modified += 1;
      io.println(`modified   ${relPath}`);
      return;
    case 'new':
      summary.new += 1;
      io.println(`new        ${relPath}`);
      return;
    case 'missing':
      summary.missing += 1;
      io.println(`missing    ${relPath} (tracked, not on disk — push never deletes)`);
      return;
    case 'conflicted':
      summary.conflicted += 1;
      io.println(
        `conflicted ${relPath} (local knows seq ${String(status.localSeq)}, server is at seq ${String(status.serverSeq)})`,
      );
      return;
    case 'failed':
      summary.failed += 1;
      io.errln(`failed     ${relPath}: ${status.code}`);
  }
}

/**
 * `vorlyn status` — what `vorlyn push` would do, without doing any of it.
 * Strictly read-only: no upload, no manifest
 * write, and deliberately no `.vorlyn/.lock` either, so asking for status
 * during an in-flight push answers instead of refusing.
 */
export async function runStatus(options: StatusOptions, io: Io): Promise<number> {
  const manifest = await readManifest(options.folder);
  if (!manifest) {
    io.errln(`${options.folder} is not linked. Run "vorlyn link" first.`);
    return 1;
  }

  // Purely local (a few fs stats, no network) and cheap enough to check on
  // every run: catches a folder that was linked before `git init`, so the
  // commit-trigger hook was never installed and nothing has said so since.
  const driftWarning = await commitTriggerMissingHookWarning(options.folder);
  if (driftWarning) io.errln(driftWarning);

  const apiKey = await resolveApiKey(options.folder);
  if (!apiKey) {
    io.errln(
      'No API key found. Set VORLYN_API_KEY or create .vorlyn/credentials in the linked folder.',
    );
    return 1;
  }

  let client: VorlynMcpClient;
  try {
    client = await connectTrustedMcpClient(options.folder, manifest.endpoint, apiKey);
  } catch (error) {
    if (error instanceof EndpointRefusedError) io.errln(error.message);
    else io.errln(`Could not connect to ${manifest.endpoint}: ${(error as Error).message}`);
    return 1;
  }

  const summary: StatusSummary = {
    unchanged: 0,
    modified: 0,
    new: 0,
    missing: 0,
    conflicted: 0,
    failed: 0,
  };

  try {
    const onDisk = await walkMarkdownFiles(options.folder);
    const onDiskSet = new Set(onDisk);
    // Tracked-but-missing files have no local path to walk to, so the report
    // covers the union of both sides, in one stable (sorted) order.
    const paths = [...new Set([...onDisk, ...Object.keys(manifest.files)])].sort();
    const results = await mapWithConcurrency(paths, options.concurrency, (relPath) =>
      statusOfFile(client, options.folder, relPath, manifest, onDiskSet.has(relPath)),
    );
    paths.forEach((relPath, i) => {
      const result = results[i];
      if (result) report(io, summary, relPath, result);
    });
    // Read-only, so unlike push there's nothing expensive about to start —
    // this is purely an extra informational line, placed after the per-file
    // listing and before the summary. Same fail-open/never-blocking contract
    // as push's version.
    await warnIfOverHeadroom(client, io, summary.new);
  } finally {
    await client.close();
  }

  io.println(
    `${String(summary.modified)} modified, ${String(summary.new)} new, ${String(summary.conflicted)} conflicted, ${String(summary.unchanged)} unchanged, ${String(summary.missing)} missing, ${String(summary.failed)} failed`,
  );
  return summary.failed > 0 ? 1 : 0;
}
