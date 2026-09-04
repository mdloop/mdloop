import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Result } from '@mdloop/shared';
import { err, ok } from '@mdloop/shared';
import { lookupFolderProject, recordFolderProject } from './folder-projects.js';
import type { Io } from './output.js';
import { resolveProjectForFolder } from './project-resolution.js';
import type { ResolvableProject, ResolveProjectInput } from './project-resolution.js';

function collectIo(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { println: (l: string) => out.push(l), errln: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** A fake `createProject` that records every call it receives and, by default, "creates" a
 *  project with a fixed id — matching this file's "no server needed" fixture-only approach. */
function trackingCreateProject(
  impl: (name: string, color?: string) => Promise<Result<ResolvableProject, { code: string }>> = (
    name,
    color,
  ) => Promise.resolve(ok({ id: 'proj_created', name, color: color ?? 'blue' })),
): { createProject: ResolveProjectInput['createProject']; calls: string[] } {
  const calls: string[] = [];
  return {
    createProject: (name, color) => {
      calls.push(name);
      return impl(name, color);
    },
    calls,
  };
}

describe('resolveProjectForFolder', () => {
  let dataDir: string;
  let folder: string;
  const endpointOrigin = 'http://127.0.0.1:3000';

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-resolution-data-'));
    folder = await mkdtemp(path.join(tmpdir(), 'mdloop-cli-resolution-folder-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });

  it('step 1, mapping hit: reuses the recorded project id without ever calling createProject', async () => {
    const name = path.basename(folder);
    await recordFolderProject(dataDir, folder, {
      projectId: 'proj_mapped',
      projectName: name,
      endpointOrigin,
      linkedAt: new Date().toISOString(),
    });
    const projects: ResolvableProject[] = [{ id: 'proj_mapped', name, color: 'blue' }];
    const { createProject, calls } = trackingCreateProject();
    const { io } = collectIo();

    const result = await resolveProjectForFolder(
      { folder, dataDir, endpointOrigin, projects, createProject },
      io,
    );

    expect(result).toEqual(ok('proj_mapped'));
    expect(calls).toHaveLength(0);
  });

  it('step 1, stale mapping (project deleted server-side): falls through to name-matching/create', async () => {
    const name = path.basename(folder);
    await recordFolderProject(dataDir, folder, {
      projectId: 'proj_deleted',
      projectName: name,
      endpointOrigin,
      linkedAt: new Date().toISOString(),
    });
    // `proj_deleted` is absent from the `projects` list below — simulating it
    // having been deleted server-side since the mapping was recorded.
    const { createProject, calls } = trackingCreateProject();
    const { io } = collectIo();

    const result = await resolveProjectForFolder(
      { folder, dataDir, endpointOrigin, projects: [], createProject },
      io,
    );

    expect(result).toEqual(ok('proj_created'));
    expect(calls).toEqual([name]);
  });

  it('step 2, exactly one name match: reuses it, records a fresh mapping, never creates', async () => {
    const name = path.basename(folder);
    const projects: ResolvableProject[] = [{ id: 'proj_match', name, color: 'red' }];
    const { createProject, calls } = trackingCreateProject();
    const { io } = collectIo();

    const result = await resolveProjectForFolder(
      { folder, dataDir, endpointOrigin, projects, createProject },
      io,
    );

    expect(result).toEqual(ok('proj_match'));
    expect(calls).toHaveLength(0);
    const mapping = await lookupFolderProject(dataDir, folder, endpointOrigin);
    expect(mapping?.projectId).toBe('proj_match');
  });

  it('step 2, more than one name match: picks the first, warns naming the chosen id and the others, never creates', async () => {
    const name = path.basename(folder);
    const projects: ResolvableProject[] = [
      { id: 'proj_first', name, color: 'red' },
      { id: 'proj_second', name, color: 'green' },
      { id: 'proj_third', name, color: 'blue' },
    ];
    const { createProject, calls } = trackingCreateProject();
    const { io, err: errLines } = collectIo();

    const result = await resolveProjectForFolder(
      { folder, dataDir, endpointOrigin, projects, createProject },
      io,
    );

    expect(result).toEqual(ok('proj_first'));
    expect(calls).toHaveLength(0);
    expect(
      errLines.some(
        (l) => l.includes('proj_first') && l.includes('proj_second') && l.includes('proj_third'),
      ),
    ).toBe(true);
  });

  it('step 3, no match: calls createProject named after the folder, uses its result, records the mapping', async () => {
    const projects: ResolvableProject[] = [];
    const { createProject, calls } = trackingCreateProject();
    const { io } = collectIo();

    const result = await resolveProjectForFolder(
      { folder, dataDir, endpointOrigin, projects, createProject },
      io,
    );

    expect(result).toEqual(ok('proj_created'));
    expect(calls).toEqual([path.basename(folder)]);
    const mapping = await lookupFolderProject(dataDir, folder, endpointOrigin);
    expect(mapping?.projectId).toBe('proj_created');
  });

  it('propagates a createProject error code verbatim', async () => {
    const projects: ResolvableProject[] = [];
    const { createProject } = trackingCreateProject(() =>
      Promise.resolve(err({ code: 'invalid_name' })),
    );
    const { io } = collectIo();

    const result = await resolveProjectForFolder(
      { folder, dataDir, endpointOrigin, projects, createProject },
      io,
    );

    expect(result).toEqual(err('invalid_name'));
  });

  it('records the mapping against the given endpointOrigin, missed by a later run against a different origin', async () => {
    const projects: ResolvableProject[] = [];
    const { createProject } = trackingCreateProject();
    const { io } = collectIo();

    await resolveProjectForFolder({ folder, dataDir, endpointOrigin, projects, createProject }, io);

    expect(await lookupFolderProject(dataDir, folder, endpointOrigin)).toBeDefined();
    expect(await lookupFolderProject(dataDir, folder, 'http://127.0.0.1:9999')).toBeUndefined();
  });
});
