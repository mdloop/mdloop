import { describe, expect, it } from 'vitest';
import type { ProjectTreeDocumentDto } from './api/client.js';
import { buildPathTree, isRootLevelPath } from './path-tree.js';

function doc(overrides: Partial<ProjectTreeDocumentDto> = {}): ProjectTreeDocumentDto {
  return {
    id: 'd1',
    title: 'Untitled',
    path: null,
    openCommentCount: 0,
    reviewStatus: 'draft',
    ...overrides,
  };
}

describe('buildPathTree', () => {
  it('nests documents that share a folder path', () => {
    const tree = buildPathTree([
      doc({ id: 'a', title: 'a.md', path: 'docs/specs/a.md' }),
      doc({ id: 'b', title: 'b.md', path: 'docs/specs/b.md' }),
    ]);

    expect(tree.rootDocs).toEqual([]);
    expect(tree.folders).toHaveLength(1);
    const docsFolder = tree.folders[0]!;
    expect(docsFolder.name).toBe('docs');
    expect(docsFolder.path).toBe('docs');
    expect(docsFolder.docs).toEqual([]);
    expect(docsFolder.folders).toHaveLength(1);

    const specsFolder = docsFolder.folders[0]!;
    expect(specsFolder.name).toBe('specs');
    expect(specsFolder.path).toBe('docs/specs');
    expect(specsFolder.docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(specsFolder.folders).toEqual([]);
  });

  it('treats a null path as a root-level, ungrouped document', () => {
    const tree = buildPathTree([doc({ id: 'x', title: 'Manual upload', path: null })]);

    expect(tree.folders).toEqual([]);
    expect(tree.rootDocs.map((d) => d.id)).toEqual(['x']);
  });

  it('treats a single-segment path as a root file with no folder wrapper', () => {
    const tree = buildPathTree([doc({ id: 'r', title: 'README.md', path: 'README.md' })]);

    expect(tree.folders).toEqual([]);
    expect(tree.rootDocs.map((d) => d.id)).toEqual(['r']);
  });

  it('aggregates openCommentCount bottom-up across multiple levels', () => {
    const tree = buildPathTree([
      doc({ id: 'a', title: 'a.md', path: 'docs/specs/a.md', openCommentCount: 2 }),
      doc({ id: 'b', title: 'b.md', path: 'docs/specs/b.md', openCommentCount: 3 }),
      doc({ id: 'c', title: 'c.md', path: 'docs/guide/c.md', openCommentCount: 1 }),
    ]);

    const docsFolder = tree.folders.find((f) => f.name === 'docs')!;
    const specsFolder = docsFolder.folders.find((f) => f.name === 'specs')!;
    const guideFolder = docsFolder.folders.find((f) => f.name === 'guide')!;

    expect(specsFolder.openCommentCount).toBe(5);
    expect(guideFolder.openCommentCount).toBe(1);
    // docs/ aggregates both its children folders: 2 + 3 + 1.
    expect(docsFolder.openCommentCount).toBe(6);
  });

  it('mixes null-path, single-segment, and nested docs in one input', () => {
    const tree = buildPathTree([
      doc({ id: 'manual', title: 'manual.md', path: null, openCommentCount: 1 }),
      doc({ id: 'readme', title: 'README.md', path: 'README.md', openCommentCount: 4 }),
      doc({ id: 'nested', title: 'auth.md', path: 'docs/specs/auth.md', openCommentCount: 2 }),
    ]);

    expect(tree.rootDocs.map((d) => d.id).sort()).toEqual(['manual', 'readme'].sort());
    expect(tree.folders).toHaveLength(1);
    expect(tree.folders[0]!.name).toBe('docs');
    expect(tree.folders[0]!.openCommentCount).toBe(2);
  });

  it('sorts folders by name and docs by title within a folder', () => {
    const tree = buildPathTree([
      doc({ id: 'z', title: 'zeta.md', path: 'notes/zeta.md' }),
      doc({ id: 'a', title: 'alpha.md', path: 'notes/alpha.md' }),
    ]);

    const notes = tree.folders[0]!;
    expect(notes.docs.map((d) => d.id)).toEqual(['a', 'z']);
  });

  // Phase 34.C — generic overload for doc shapes other than
  // ProjectTreeDocumentDto (the home lane's OverviewDocumentDto, which has
  // no `openCommentCount`).
  it('accepts a doc shape with an explicit open-comment accessor (generic overload)', () => {
    interface HomeDoc {
      id: string;
      title: string;
      path: string | null;
      open: number;
    }
    const homeDoc = (overrides: Partial<HomeDoc>): HomeDoc => ({
      id: 'd1',
      title: 'Untitled',
      path: null,
      open: 0,
      ...overrides,
    });

    const tree = buildPathTree(
      [
        homeDoc({ id: 'a', title: 'a.md', path: 'docs/a.md', open: 2 }),
        homeDoc({ id: 'b', title: 'b.md', path: 'docs/b.md', open: 3 }),
      ],
      (d) => d.open,
    );

    expect(tree.folders).toHaveLength(1);
    const docs = tree.folders[0]!;
    expect(docs.name).toBe('docs');
    expect(docs.openCommentCount).toBe(5);
    expect(docs.docs.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('isRootLevelPath', () => {
  it('is true for null and single-segment paths, false for anything nested', () => {
    expect(isRootLevelPath(null)).toBe(true);
    expect(isRootLevelPath('README.md')).toBe(true);
    expect(isRootLevelPath('docs/README.md')).toBe(false);
    expect(isRootLevelPath('docs/specs/a.md')).toBe(false);
  });
});
