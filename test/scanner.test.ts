import { describe, expect, it } from 'vitest';
import { scanInlineReferences } from '../src/parser.js';

describe('inline Markdown scanning', () => {
  it('finds an inline relative file link', () => {
    expect(scanInlineReferences('See [the guide](docs/guide.md) for details.')).toEqual([
      { kind: 'link', target: 'docs/guide.md', line: 1, column: 5 },
    ]);
  });

  it('finds an inline relative image', () => {
    expect(scanInlineReferences('![architecture](assets/arch.png)')).toEqual([
      { kind: 'image', target: 'assets/arch.png', line: 1, column: 1 },
    ]);
  });

  it('does not emit the image destination twice', () => {
    const references = scanInlineReferences('![architecture](assets/arch.png)');
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({ kind: 'image', target: 'assets/arch.png' });
  });

  it('reports 1-based lines and columns for multiple references', () => {
    const markdown = ['[first](a.md) and [second](b.md)', '', '![third](c.png)'].join('\n');
    expect(scanInlineReferences(markdown)).toEqual([
      { kind: 'link', target: 'a.md', line: 1, column: 1 },
      { kind: 'link', target: 'b.md', line: 1, column: 19 },
      { kind: 'image', target: 'c.png', line: 3, column: 1 },
    ]);
  });

  it('ignores link syntax in fenced code blocks', () => {
    const markdown = ['```md', '[broken](missing.md)', '```', '[real](guide.md)'].join('\n');
    expect(scanInlineReferences(markdown)).toEqual([
      { kind: 'link', target: 'guide.md', line: 4, column: 1 },
    ]);
  });

  it('ignores link syntax in inline code', () => {
    expect(scanInlineReferences('Use `[x](missing.md)` in the docs.')).toEqual([]);
  });

  it('ignores link syntax in indented code blocks', () => {
    expect(scanInlineReferences('    [broken](missing.md)\n')).toEqual([]);
  });

  it('supports angle-bracketed destinations and optional titles', () => {
    const references = scanInlineReferences(
      '[a](<docs/my guide.md> "Guide") [b](other.md \'Other\') [c](third.md (Third))',
    );
    expect(references.map((reference) => reference.target)).toEqual([
      'docs/my guide.md',
      'other.md',
      'third.md',
    ]);
  });

  it('keeps balanced parentheses in a destination', () => {
    expect(scanInlineReferences('[function](docs/Function_(math).md)')).toEqual([
      { kind: 'link', target: 'docs/Function_(math).md', line: 1, column: 1 },
    ]);
  });

  it('ignores escaped brackets and reference-style links', () => {
    expect(scanInlineReferences('\\[not a link](missing.md) and [ref][target].')).toEqual([]);
  });
});
