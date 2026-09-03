// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import type * as calloutsModule from '../callouts.js';
import { parseCallout } from '../callouts.js';
import { MarkdownView } from './markdown-view.js';

const NODE_SVG =
  '<svg><g class="node" id="flowchart-A-1"><rect></rect></g><g class="node" id="flowchart-B-1"><rect></rect></g></svg>';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: NODE_SVG })),
  },
}));

/* Spied, not replaced: every test below wants the real callout parser. Only the
   guard test swaps in a throw, with mockImplementationOnce. */
vi.mock('../callouts.js', async () => {
  const actual = await vi.importActual<typeof calloutsModule>('../callouts.js');
  return { ...actual, parseCallout: vi.fn(actual.parseCallout) };
});

afterEach(cleanup);

describe('MarkdownView', () => {
  it('renders a GitHub callout with a label and no marker text', () => {
    const { container } = render(
      <MarkdownView dark={false} source={'> [!WARNING]\n> mind the gap'} />,
    );
    const callout = screen.getByTestId('callout');
    expect(callout.className).toContain('callout--warning');
    expect(screen.getByText('Warning')).toBeDefined();
    expect(callout.textContent).toContain('mind the gap');
    expect(callout.textContent).not.toContain('[!WARNING]');
    expect(container.querySelector('.callout-label')?.textContent).toBe('Warning');
  });

  it('leaves a plain blockquote as a blockquote', () => {
    const { container } = render(<MarkdownView dark={false} source={'> just a quote'} />);
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(screen.queryByTestId('callout')).toBeNull();
  });

  it('renders mermaid fences as diagrams, not highlighted code', () => {
    const { container } = render(
      <MarkdownView dark={false} source={'```mermaid\ngraph TD; A-->B;\n```'} />,
    );
    expect(screen.getByTestId('mermaid-block')).toBeDefined();
    expect(container.querySelector('code.hljs')).toBeNull();
  });

  it('applies hljs highlighting to fenced code blocks', () => {
    const { container } = render(<MarkdownView dark={false} source={'```js\nconst x = 1;\n```'} />);
    expect(container.querySelector('code.hljs')).not.toBeNull();
    expect(container.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('tints the diagram part matching an open comment anchor', async () => {
    const { container } = render(
      <MarkdownView
        dark={false}
        source={'```mermaid\ngraph TD; A-->B;\n```'}
        openDiagramAnchors={[{ type: 'diagram', blockIndex: 0, kind: 'node', stableId: 'B' }]}
      />,
    );
    await waitFor(() => {
      expect(
        container.querySelector('#flowchart-B-1')?.classList.contains('has-open-comment'),
      ).toBe(true);
    });
    expect(container.querySelector('#flowchart-A-1')?.classList.contains('has-open-comment')).toBe(
      false,
    );
  });

  it('leaves diagram parts untinted once their thread resolves', async () => {
    const { container, rerender } = render(
      <MarkdownView
        dark={false}
        source={'```mermaid\ngraph TD; A-->B;\n```'}
        openDiagramAnchors={[{ type: 'diagram', blockIndex: 0, kind: 'node', stableId: 'A' }]}
      />,
    );
    await waitFor(() => {
      expect(
        container.querySelector('#flowchart-A-1')?.classList.contains('has-open-comment'),
      ).toBe(true);
    });
    rerender(<MarkdownView dark={false} source={'```mermaid\ngraph TD; A-->B;\n```'} />);
    await waitFor(() => {
      expect(
        container.querySelector('#flowchart-A-1')?.classList.contains('has-open-comment'),
      ).toBe(false);
    });
  });

  it('falls back to the diagram source when mermaid cannot render it', async () => {
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Parse error on line 1'));
    const { container } = render(
      <MarkdownView dark={false} source={'```mermaid\ngraph TD; A--@@-->B;\n```'} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.mermaid-fallback')).not.toBeNull();
    });
    // The unrenderable source is still readable — the reader can see what the
    // author meant, and the page is otherwise untouched.
    expect(container.querySelector('.mermaid-fallback')?.textContent).toContain('graph TD');
    expect(screen.queryByTestId('mermaid-block')).toBeNull();
  });

  it('clears a stale fallback once a corrected diagram renders (regression)', async () => {
    // A diagram fails on one leg…
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error('Parse error on line 1'));
    const { container, rerender } = render(
      <MarkdownView dark={false} source={'```mermaid\ngraph TD; A--@@-->B;\n```'} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.mermaid-fallback')).not.toBeNull();
    });

    // …and is fixed on the next one. The fallback used to latch on forever:
    // `failed` was set on error and never cleared on a later success, so a
    // corrected diagram kept showing its old broken source.
    rerender(<MarkdownView dark={false} source={'```mermaid\ngraph TD; A-->B;\n```'} />);
    await waitFor(() => {
      expect(container.querySelector('.mermaid-fallback')).toBeNull();
    });
    // And it actually paints — the recovered container is not left empty.
    expect(screen.getByTestId('mermaid-block').querySelector('svg')).not.toBeNull();
  });

  it('degrades a callout to a plain blockquote when the callout logic throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(parseCallout).mockImplementationOnce(() => {
      throw new Error('unexpected child shape');
    });
    const { container } = render(
      <MarkdownView dark={false} source={'> [!WARNING]\n> mind the gap'} />,
    );
    // No throw escaped into the tree; the words survived, only the styling
    // went missing.
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(screen.queryByTestId('callout')).toBeNull();
    expect(container.textContent).toContain('mind the gap');
    spy.mockRestore();
  });
});

describe('source offset tagging (sourceOffsetsPlugin)', () => {
  it('tags plain and bold text runs with their raw source offsets', () => {
    const source = 'plain **bold** tail';
    const { container } = render(<MarkdownView dark={false} source={source} />);
    const p = container.querySelector('p');
    if (!p) throw new Error('setup');
    const spans = [...p.querySelectorAll<HTMLElement>('[data-src-start]')];
    // "plain ", "bold" (inside <strong>), " tail" — three tagged leaves.
    expect(spans).toHaveLength(3);
    for (const span of spans) {
      const start = Number(span.dataset.srcStart);
      const end = Number(span.dataset.srcEnd);
      expect(source.slice(start, end)).toBe(span.textContent);
    }
    const boldSpan = p.querySelector<HTMLElement>('strong span[data-src-start]');
    expect(boldSpan?.textContent).toBe('bold');
    expect(source.slice(Number(boldSpan?.dataset.srcStart), Number(boldSpan?.dataset.srcEnd))).toBe(
      'bold',
    );
  });

  it('tags a fenced code block coarsely on the <code> element, surviving highlight', () => {
    const source = '```js\nconst x = 1;\n```';
    const { container } = render(<MarkdownView dark={false} source={source} />);
    const code = container.querySelector<HTMLElement>('code.hljs');
    if (!code) throw new Error('setup');
    const start = Number(code.dataset.srcStart);
    const end = Number(code.dataset.srcEnd);
    expect(Number.isFinite(start)).toBe(true);
    expect(Number.isFinite(end)).toBe(true);
    // Coarse whole-block range: the fenced code node's own position covers
    // the entire fence (opening ``` through closing ```), not per-token.
    expect(source.slice(start, end)).toBe(source);
    // rehype-highlight retokenized the children into hljs spans — the
    // data-src-* attributes on <code> itself must have survived that.
    expect(code.querySelector('.hljs-keyword')).not.toBeNull();
  });

  it('does not tag mermaid fence content (handled by the diagram anchor system)', () => {
    const source = '```mermaid\ngraph TD; A-->B;\n```';
    render(<MarkdownView dark={false} source={source} />);
    // MermaidBlock drops arbitrary props; the mermaid container itself
    // carries no data-src-* attribute (existing, intentional behavior).
    expect(screen.getByTestId('mermaid-block').hasAttribute('data-src-start')).toBe(false);
  });
});
