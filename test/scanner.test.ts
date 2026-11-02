import { describe, expect, it } from 'vitest';
import { scanInlineReferences, scanMarkdown } from '../src/parser.js';

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

describe('reference-style Markdown scanning', () => {
  function referenceUses(markdown: string) {
    return scanMarkdown(markdown).references.flatMap((reference) =>
      reference.style === 'reference'
        ? [{ kind: reference.kind, label: reference.label, line: reference.line, column: reference.column }]
        : [],
    );
  }

  function definitions(markdown: string) {
    return [...scanMarkdown(markdown).definitions.values()].map(({ label, target, line }) => ({
      label,
      target,
      line,
    }));
  }

  it('finds a full reference-style link', () => {
    const markdown = ['See [the guide][docs].', '', '[docs]: docs/guide.md'].join('\n');

    expect(referenceUses(markdown)).toEqual([{ kind: 'link', label: 'docs', line: 1, column: 5 }]);
    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'docs/guide.md', line: 3 }]);
  });

  it('finds a full reference-style image', () => {
    const markdown = ['![architecture][design]', '', '[design]: images/architecture.png'].join('\n');

    expect(referenceUses(markdown)).toEqual([
      { kind: 'image', label: 'design', line: 1, column: 1 },
    ]);
  });

  it('matches reference labels case-insensitively', () => {
    const markdown = ['[Guide][DOCS]', '', '[DoCs]: docs/guide.md'].join('\n');

    expect(referenceUses(markdown)).toEqual([{ kind: 'link', label: 'docs', line: 1, column: 1 }]);
    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'docs/guide.md', line: 3 }]);
  });

  it('trims surrounding reference label whitespace', () => {
    const markdown = ['[Guide][ docs ]', '', '[ docs ]: docs/guide.md'].join('\n');

    expect(referenceUses(markdown)).toEqual([{ kind: 'link', label: 'docs', line: 1, column: 1 }]);
    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'docs/guide.md', line: 3 }]);
  });

  it('collapses internal whitespace in reference labels', () => {
    const markdown = ['[guide][the  doc]', '', '[the\tdoc]: docs/guide.md'].join('\n');

    expect(referenceUses(markdown)).toEqual([
      { kind: 'link', label: 'the doc', line: 1, column: 1 },
    ]);
    expect(definitions(markdown)).toEqual([
      { label: 'the doc', target: 'docs/guide.md', line: 3 },
    ]);
  });

  it('does not emit a reference definition as an inline link', () => {
    const markdown = ['[guide][docs]', '', '[docs]: docs/guide.md'].join('\n');

    expect(scanInlineReferences(markdown)).toEqual([]);
    expect(referenceUses(markdown)).toEqual([{ kind: 'link', label: 'docs', line: 1, column: 1 }]);
  });

  it('uses a deterministic rule for duplicate definitions', () => {
    const markdown = ['[guide][docs]', '', '[docs]: first.md', '[docs]: second.md'].join('\n');

    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'first.md', line: 3 }]);
  });

  it('finds a collapsed reference-style link', () => {
    const markdown = ['[guide][]', '', '[guide]: docs/guide.md'].join('\n');

    expect(referenceUses(markdown)).toEqual([{ kind: 'link', label: 'guide', line: 1, column: 1 }]);
  });

  it('finds a collapsed reference-style image', () => {
    const markdown = ['![diagram][]', '', '[diagram]: images/diagram.png'].join('\n');

    expect(referenceUses(markdown)).toEqual([
      { kind: 'image', label: 'diagram', line: 1, column: 1 },
    ]);
  });

  it('finds a shortcut reference-style link', () => {
    const markdown = ['See [guide].', '', '[guide]: docs/guide.md'].join('\n');

    expect(referenceUses(markdown)).toEqual([{ kind: 'link', label: 'guide', line: 1, column: 5 }]);
  });

  it('finds a shortcut reference-style image', () => {
    const markdown = ['![diagram]', '', '[diagram]: images/diagram.png'].join('\n');

    expect(referenceUses(markdown)).toEqual([
      { kind: 'image', label: 'diagram', line: 1, column: 1 },
    ]);
  });

  it('does not treat a shortcut bracket without a definition as a reference', () => {
    expect(referenceUses('See [the notes] for details.')).toEqual([]);
  });

  it('parses angle-bracket destinations and titles in definitions', () => {
    const markdown = [
      '[a][guide] and [b][other]',
      '',
      '[guide]: <docs/my guide.md> "Guide"',
      "[other]: docs/other.md 'Other'",
    ].join('\n');

    expect(definitions(markdown)).toEqual([
      { label: 'guide', target: 'docs/my guide.md', line: 3 },
      { label: 'other', target: 'docs/other.md', line: 4 },
    ]);
  });

  it('ignores reference definitions inside fenced code', () => {
    const markdown = ['```md', '[docs]: docs/fake.md', '```', '', '[docs]: docs/real.md'].join('\n');

    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'docs/real.md', line: 5 }]);
  });

  it('ignores reference uses inside fenced code', () => {
    const markdown = [
      '[docs]: docs/guide.md',
      '',
      '```md',
      '[the guide][docs] and [docs]',
      '```',
    ].join('\n');

    expect(referenceUses(markdown)).toEqual([]);
  });

  it('ignores reference definitions and uses inside indented code', () => {
    const markdown = [
      '    [docs]: docs/fake.md',
      '    [the guide][docs]',
      '',
      '[docs]: docs/real.md',
    ].join('\n');

    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'docs/real.md', line: 4 }]);
    expect(referenceUses(markdown)).toEqual([]);
  });

  it('ignores reference-like text inside inline code', () => {
    const markdown = [
      'Use `[guide][docs]` and `[docs]: docs/fake.md` in prose.',
      '',
      '[docs]: docs/real.md',
    ].join('\n');

    expect(referenceUses(markdown)).toEqual([]);
    expect(definitions(markdown)).toEqual([{ label: 'docs', target: 'docs/real.md', line: 3 }]);
  });
});
