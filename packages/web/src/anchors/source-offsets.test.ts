import { describe, expect, it, vi } from 'vitest';
import { sourceOffsetsPlugin } from './source-offsets.js';

/* The plugin duck-types the slice of hast it needs (see the file header), so
   these fixtures are hand-built plain objects, same as what the real tree is. */
interface TestNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TestNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function run(tree: TestNode): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (sourceOffsetsPlugin() as (t: any) => void)(tree);
}

describe('sourceOffsetsPlugin', () => {
  it('wraps a positioned text run in a data-src-* span', () => {
    const tree: TestNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            {
              type: 'text',
              value: 'hello',
              position: { start: { offset: 0 }, end: { offset: 5 } },
            },
          ],
        },
      ],
    };
    run(tree);
    const wrapper = tree.children?.[0]?.children?.[0];
    expect(wrapper?.tagName).toBe('span');
    expect(wrapper?.properties).toEqual({ 'data-src-start': '0', 'data-src-end': '5' });
  });

  it('leaves a text run with no source position alone', () => {
    const tree: TestNode = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'injected' }] },
      ],
    };
    run(tree);
    expect(tree.children?.[0]?.children?.[0]?.type).toBe('text');
  });

  it('degrades to an untagged tree instead of throwing the render down', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hostile: TestNode = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          get children(): TestNode[] {
            throw new TypeError('malformed node');
          },
        },
      ],
    };
    // This runs inside react-markdown's render: a throw here would take the
    // whole document out over a decoration nothing needs to read the words.
    expect(() => {
      run(hostile);
    }).not.toThrow();

    // …and it still reports, opaquely: a static name, no node content.
    const reported = spy.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .find((s) => s.includes('client_error'));
    expect(reported).toContain('source-offsets');
    expect(reported).not.toContain('malformed node');
    spy.mockRestore();
  });

  it('keeps the tagging it managed before the bad node', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good: TestNode = {
      type: 'element',
      tagName: 'p',
      children: [
        { type: 'text', value: 'fine', position: { start: { offset: 0 }, end: { offset: 4 } } },
      ],
    };
    const tree: TestNode = {
      type: 'root',
      children: [
        good,
        {
          type: 'element',
          tagName: 'p',
          get children(): TestNode[] {
            throw new TypeError('malformed node');
          },
        },
      ],
    };
    run(tree);
    // walk mutates in place and every tag is independent, so a partial walk is
    // a fine outcome — earlier runs stay anchored.
    expect(good.children?.[0]?.tagName).toBe('span');
    spy.mockRestore();
  });
});
