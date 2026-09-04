/**
 * Comment anchors (ARCHITECTURE.md §5). Stored as JSONB on comments; every
 * comment pins to one immutable document version. Discriminated on `type`.
 */

/** Max characters of surrounding context captured either side of a text selection. */
export const ANCHOR_CONTEXT_CHARS = 32;

/** Re-anchor confidence below this is an orphan — never a guess (Core Principle 2). */
export const REANCHOR_CONFIDENCE_FLOOR = 0.6;

/**
 * Low context "sanity floor" gate (Core Principle 2): a much lower bar than
 * REANCHOR_CONFIDENCE_FLOOR, answering a narrower question — "is this match
 * even in the plausible neighborhood?" — before a unique exact-quote hit or a
 * fuzzy bitap match is allowed to fall through to the existing
 * text-similarity-driven confidence logic. A genuine decoy elsewhere in the
 * document scores context near 0 and is rejected; a legitimate match, even
 * significantly reworded, retains enough shared local structure to clear
 * this low bar easily. Empirically tuned by sweeping 0.05-0.40 against a
 * 50-case realistic editing-session harness: 0.05-0.15 is the flat optimum
 * (0 false positives, best correct-resolution rate); 0.15 is the recommended
 * value for a small safety margin — do not change it without re-validating
 * against an equivalent harness.
 */
export const REANCHOR_CONTEXT_SANITY_FLOOR = 0.15;

export interface TextAnchor {
  readonly type: 'text';
  /** The exact selected text at comment time. */
  readonly exact: string;
  /** Up to ANCHOR_CONTEXT_CHARS immediately before the selection. */
  readonly prefix: string;
  /** Up to ANCHOR_CONTEXT_CHARS immediately after the selection. */
  readonly suffix: string;
  /** Character offsets into the version's markdown source. */
  readonly start: number;
  readonly end: number;
}

export type DiagramPartKind = 'node' | 'edge' | 'actor' | 'message';

export interface DiagramAnchor {
  readonly type: 'diagram';
  /** Index of the mermaid code block within the version's markdown source. */
  readonly blockIndex: number;
  readonly kind: DiagramPartKind;
  /**
   * Source-level stable identifier: node name ("B"), edge ("A->B"),
   * actor name ("API"), or message ordinal+text.
   */
  readonly stableId: string | { readonly index: number; readonly text: string };
}

/** Comment on the document as a whole. */
export interface DocumentAnchor {
  readonly type: 'document';
}

export type Anchor = TextAnchor | DiagramAnchor | DocumentAnchor;

export interface AnchorValidationError {
  readonly code: 'empty_selection' | 'invalid_offsets' | 'context_too_long' | 'invalid_block_index';
}

/** Validates invariants a well-formed anchor must satisfy before persistence. */
export function validateAnchor(anchor: Anchor): AnchorValidationError | undefined {
  switch (anchor.type) {
    case 'text': {
      if (anchor.exact.length === 0) return { code: 'empty_selection' };
      if (anchor.start < 0 || anchor.end <= anchor.start) return { code: 'invalid_offsets' };
      if (anchor.end - anchor.start !== anchor.exact.length) return { code: 'invalid_offsets' };
      if (
        anchor.prefix.length > ANCHOR_CONTEXT_CHARS ||
        anchor.suffix.length > ANCHOR_CONTEXT_CHARS
      ) {
        return { code: 'context_too_long' };
      }
      return undefined;
    }
    case 'diagram': {
      if (anchor.blockIndex < 0 || !Number.isInteger(anchor.blockIndex)) {
        return { code: 'invalid_block_index' };
      }
      if (typeof anchor.stableId === 'string' && anchor.stableId.length === 0) {
        return { code: 'empty_selection' };
      }
      return undefined;
    }
    case 'document':
      return undefined;
  }
}
