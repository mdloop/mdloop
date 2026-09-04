import { describe, expect, it } from 'vitest';
import { buildForms, replaceAllForms } from '../scripts/dev/rename.mjs';

/**
 * Regression cover for `pnpm rename`'s substring-mangling defect, which has
 * shipped twice: the old identifier is a literal prefix of "collaborator" /
 * "collaboration" / "collaborative", so a blind split/join rewrote 92 ordinary
 * English words into "chevronorator" and friends — including
 * `TierCeilings.maxCollaborators` and the `maxCollaborators` field on
 * `GET /org/usage`, a live API contract.
 *
 * Nothing else catches this class of bug: the mangling is self-consistent, so
 * the tree still compiles, the suite still passes, and `brand-check` sees no
 * stale identifier (there isn't one — the identifier was renamed, just inside
 * a word that merely started with it).
 *
 * The prior identifier appears as test data throughout, which is exactly the
 * case `brand-check`'s per-line allow marker exists for: these lines talk
 * *about* the old name rather than being leftovers of it.
 */
const from = buildForms('collab'); // brand-check:allow
const to = buildForms('mdloop');

const rename = (s: string): string => replaceAllForms(s, from, to);

describe('rename: word-boundary safety', () => {
  it('never rewrites an identifier that is only a prefix of a longer word', () => {
    expect(rename('collaborator')).toBe('collaborator');
    expect(rename('collaborators')).toBe('collaborators');
    expect(rename('collaboration')).toBe('collaboration');
    expect(rename('collaborating')).toBe('collaborating');
    expect(rename('collaborative')).toBe('collaborative');
    expect(rename('Collaborators')).toBe('Collaborators');
    expect(rename('maxCollaborators')).toBe('maxCollaborators');
    expect(rename('collaboratorCapLimit')).toBe('collaboratorCapLimit');
  });

  it('still renames every delimiter form the identifier legitimately takes', () => {
    expect(rename('collab')).toBe('mdloop'); // brand-check:allow
    expect(rename('@collab/domain')).toBe('@mdloop/domain'); // brand-check:allow
    expect(rename('collab_login')).toBe('mdloop_login'); // brand-check:allow
    expect(rename('collab-dev')).toBe('mdloop-dev'); // brand-check:allow
    expect(rename('collab.md')).toBe('mdloop.md'); // brand-check:allow
    expect(rename('COLLAB_DB')).toBe('MDLOOP_DB'); // brand-check:allow
  });

  it('renames across a camelCase boundary, where the next char is uppercase', () => {
    expect(rename('CollabMark')).toBe('MdloopMark');
    expect(rename('collabConfig')).toBe('mdloopConfig');
  });

  it('protects a SCREAMING_SNAKE word that merely starts with the identifier', () => {
    expect(rename('MAX_COLLABORATORS')).toBe('MAX_COLLABORATORS');
  });

  it('handles mixed real-world content in one pass', () => {
    const before =
      'import { collaboratorCapLimit } from "@collab/domain";\n' + // brand-check:allow
      '// Collaborators share a collab_login role in collab-dev.\n' + // brand-check:allow
      'const x: CollabMark = COLLAB_DB;'; // brand-check:allow
    expect(rename(before)).toBe(
      'import { collaboratorCapLimit } from "@mdloop/domain";\n' +
        '// Collaborators share a mdloop_login role in mdloop-dev.\n' +
        'const x: MdloopMark = MDLOOP_DB;',
    );
  });
});
