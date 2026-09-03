// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DiagramAnchorDto } from '../api/client.js';
import { findDiagramPart } from './diagram.js';

function svg(html: string): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.innerHTML = html;
  return el;
}

describe('findDiagramPart', () => {
  it('finds a node by its stable id, ignoring the mermaid render suffix', () => {
    const el = svg(
      '<g class="node" id="flowchart-A-1"></g><g class="node" id="flowchart-B-2"></g>',
    );
    const anchor: DiagramAnchorDto = {
      type: 'diagram',
      blockIndex: 0,
      kind: 'node',
      stableId: 'B',
    };
    const part = findDiagramPart(el, anchor);
    expect(part?.id).toBe('flowchart-B-2');
  });

  it('finds an edge by its from->to stable id', () => {
    const el = svg('<g class="edgePaths"><path id="L_A_B_0"></path></g>');
    const anchor: DiagramAnchorDto = {
      type: 'diagram',
      blockIndex: 0,
      kind: 'edge',
      stableId: 'A->B',
    };
    const part = findDiagramPart(el, anchor);
    expect(part?.id).toBe('L_A_B_0');
  });

  it('finds an actor by its rendered name', () => {
    const el = svg('<text class="actor">Alice</text><text class="actor">Bob</text>');
    const anchor: DiagramAnchorDto = {
      type: 'diagram',
      blockIndex: 0,
      kind: 'actor',
      stableId: 'Bob',
    };
    expect(findDiagramPart(el, anchor)?.textContent).toBe('Bob');
  });

  it('finds a message by its ordinal index', () => {
    const el = svg('<text class="messageText">hello</text><text class="messageText">world</text>');
    const anchor: DiagramAnchorDto = {
      type: 'diagram',
      blockIndex: 0,
      kind: 'message',
      stableId: { index: 1, text: 'world' },
    };
    expect(findDiagramPart(el, anchor)?.textContent).toBe('world');
  });

  it('returns undefined when nothing matches', () => {
    const el = svg('<g class="node" id="flowchart-A-1"></g>');
    const anchor: DiagramAnchorDto = {
      type: 'diagram',
      blockIndex: 0,
      kind: 'node',
      stableId: 'Z',
    };
    expect(findDiagramPart(el, anchor)).toBeUndefined();
  });
});
