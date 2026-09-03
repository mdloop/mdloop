import type { DiagramAnchorDto } from '../api/client.js';

/**
 * Stable anchor for a clicked element inside a rendered mermaid SVG
 * (spike 02). Mermaid embeds source-level identifiers in its DOM ids:
 * node ids like "flowchart-B-1", edge ids like "L_A_B_0"; sequence actors
 * carry their name as text, messages are addressed by ordinal + text.
 */
export function diagramAnchorFromTarget(
  target: Element,
  blockIndex: number,
): (DiagramAnchorDto & { el: Element }) | undefined {
  const node = target.closest('g.node');
  if (node) {
    const m = /flowchart-(.+)-\d+$/.exec(node.id);
    return {
      type: 'diagram',
      blockIndex,
      kind: 'node',
      stableId: m?.[1] ?? node.id,
      el: node,
    };
  }

  const edge = target.closest('.edgePaths path, path.flowchart-link');
  if (edge) {
    const m = /L[_-](.+?)[_-](.+?)[_-]\d+$/.exec(edge.id);
    return {
      type: 'diagram',
      blockIndex,
      kind: 'edge',
      stableId: m?.[1] !== undefined && m[2] !== undefined ? `${m[1]}->${m[2]}` : edge.id,
      el: edge,
    };
  }

  const actor = target.closest('g[class*="actor"], rect.actor, text.actor');
  if (actor) {
    const name = actor.textContent.trim() || (actor.getAttribute('name') ?? '');
    if (name.length > 0) {
      return { type: 'diagram', blockIndex, kind: 'actor', stableId: name, el: actor };
    }
  }

  if (target instanceof SVGElement && target.classList.contains('messageText')) {
    const svg = target.ownerSVGElement;
    if (svg) {
      const all = [...svg.querySelectorAll('text.messageText')];
      return {
        type: 'diagram',
        blockIndex,
        kind: 'message',
        stableId: { index: all.indexOf(target), text: target.textContent.trim() },
        el: target,
      };
    }
  }
  return undefined;
}

/**
 * Locate the SVG part matching a diagram anchor — the inverse of
 * diagramAnchorFromTarget. Used to tint parts that already carry an open
 * comment (spike 02 selectors, mirrored exactly so both stay in sync).
 */
export function findDiagramPart(svg: Element, anchor: DiagramAnchorDto): Element | undefined {
  if (anchor.kind === 'node') {
    return [...svg.querySelectorAll('g.node')].find((n) => {
      const m = /flowchart-(.+)-\d+$/.exec(n.id);
      return (m?.[1] ?? n.id) === anchor.stableId;
    });
  }
  if (anchor.kind === 'edge') {
    return [...svg.querySelectorAll('.edgePaths path, path.flowchart-link')].find((e) => {
      const m = /L[_-](.+?)[_-](.+?)[_-]\d+$/.exec(e.id);
      const id = m?.[1] !== undefined && m[2] !== undefined ? `${m[1]}->${m[2]}` : e.id;
      return id === anchor.stableId;
    });
  }
  if (anchor.kind === 'actor') {
    return [...svg.querySelectorAll('g[class*="actor"], rect.actor, text.actor')].find((a) => {
      const name = a.textContent.trim() || (a.getAttribute('name') ?? '');
      return name === anchor.stableId;
    });
  }
  // 'message': stableId is always the {index, text} shape for this kind.
  const stableId = anchor.stableId;
  if (typeof stableId === 'string') return undefined;
  return [...svg.querySelectorAll('text.messageText')][stableId.index];
}

/** Human label for a diagram anchor, shown as the thread quote. */
export function diagramAnchorLabel(anchor: DiagramAnchorDto): string {
  const id =
    typeof anchor.stableId === 'string'
      ? anchor.stableId
      : `#${String(anchor.stableId.index + 1)} "${anchor.stableId.text}"`;
  return `${anchor.kind} ${id}`;
}
