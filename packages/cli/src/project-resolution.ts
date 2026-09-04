import path from 'node:path';
import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import { lookupFolderProject, recordFolderProject } from './folder-projects.js';
import type { Io } from './output.js';

/** The minimal slice of `mcp-client.ts`'s `McpProject`/`MdloopMcpClient` this file needs — named
 *  locally so it doesn't have to import the concrete types just to describe the seam. */
export interface ResolvableProject {
  id: string;
  name: string;
  color: string;
}

export interface ResolveProjectInput {
  folder: string;
  dataDir: string;
  endpointOrigin: string;
  /** Already fetched by the caller (`link.ts` already calls `listProjects()` for its own
   *  validation) — resolution never makes its own extra round trip for this. */
  projects: ResolvableProject[];
  createProject: (
    name: string,
    color?: string,
  ) => Promise<Result<ResolvableProject, { code: string }>>;
}

/**
 * "Smart about reuse-vs-create" — the logic `mdloop link`'s auto-provision
 * path (and so `mdloop open`, and `mdloop-ensure.sh`) defers to whenever a
 * folder has no manifest yet. Reuse always wins over creating a duplicate,
 * checked in this fixed order:
 *
 * 1. A remembered mapping for this exact folder (`folder-projects.ts`,
 *    keyed by realpath) whose project still exists server-side — the
 *    common case on every run after the first for a given folder.
 * 2. A live project whose name matches `path.basename(folder)` — the first
 *    time this folder is ever seen, but the project already exists (someone
 *    created it by hand, or a previous mapping was lost). Project names are
 *    not unique (no `(org_id, name)` constraint at any layer): more than
 *    one match picks the oldest (`list_projects` preserves `created_at`
 *    order) and warns naming every candidate, rather than refusing — this
 *    is what keeps the no-human-interaction goal holding even in the
 *    ambiguous case, and is safe because auto-provisioning only ever runs
 *    against a local endpoint (`link.ts`'s `isLocalEndpoint` guard).
 * 3. Otherwise, create one named after the folder.
 *
 * Whichever path resolves, the mapping is (re)recorded before returning, so
 * the next run for this folder always hits step 1.
 *
 * Deliberately does NOT handle "this folder already has a manifest" — that
 * case is `existing.projectId`, checked directly by `link.ts` before this
 * function is ever called; a manifest is a stronger signal than anything
 * this file could reconstruct; reaching here at all means the folder is new.
 */
export async function resolveProjectForFolder(
  input: ResolveProjectInput,
  io: Io,
): Promise<Result<string, string>> {
  const mapped = await lookupFolderProject(input.dataDir, input.folder, input.endpointOrigin);
  if (mapped && input.projects.some((p) => p.id === mapped.projectId)) {
    return ok(mapped.projectId);
  }

  const name = path.basename(path.resolve(input.folder));
  const [chosen, ...rest] = input.projects.filter((p) => p.name === name);

  let projectId: string;
  let projectName: string;
  if (chosen && rest.length === 0) {
    projectId = chosen.id;
    projectName = chosen.name;
  } else if (chosen) {
    const others = rest.map((p) => p.id).join(', ');
    io.errln(
      `Warning: ${String(rest.length + 1)} existing projects are named "${name}" — reusing the oldest (${chosen.id}). ` +
        `Others: ${others}. Pass --project <id> instead if you meant a different one.`,
    );
    projectId = chosen.id;
    projectName = chosen.name;
  } else {
    const created = await input.createProject(name);
    if (!created.ok) return err(created.error.code);
    projectId = created.value.id;
    projectName = created.value.name;
  }

  await recordFolderProject(input.dataDir, input.folder, {
    projectId,
    projectName,
    endpointOrigin: input.endpointOrigin,
    linkedAt: new Date().toISOString(),
  });
  return ok(projectId);
}
