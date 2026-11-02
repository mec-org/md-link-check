import { describe, expect, it } from 'vitest';
import { collectHeadingSlugs, scanHeadings } from '../src/headings.js';

/** Reduces headings to `[level, line, text]` tuples for compact assertions. */
function headingLines(markdown: string): Array<[number, number, string]> {
  return scanHeadings(markdown).map((heading) => [heading.level, heading.line, heading.text]);
}

describe('heading collection', () => {
  it('collects ATX headings levels one through six', () => {
    const markdown = [
      '# One',
      '## Two',
      '### Three',
      '#### Four',
      '##### Five',
      '###### Six',
    ].join('\n');

    expect(headingLines(markdown)).toEqual([
      [1, 1, 'One'],
      [2, 2, 'Two'],
      [3, 3, 'Three'],
      [4, 4, 'Four'],
      [5, 5, 'Five'],
      [6, 6, 'Six'],
    ]);
  });

  it('collects an ATX heading with optional closing hashes', () => {
    const markdown = ['## Closed ##', '# Open#', '### Spaced ###   '].join('\n');

    expect(headingLines(markdown)).toEqual([
      [2, 1, 'Closed'],
      [1, 2, 'Open#'],
      [3, 3, 'Spaced'],
    ]);
  });

  it('collects equals setext headings', () => {
    expect(headingLines('Title\n=====\n\nAnother\n=')).toEqual([
      [1, 1, 'Title'],
      [1, 4, 'Another'],
    ]);
  });

  it('collects hyphen setext headings', () => {
    expect(headingLines('Subtitle\n---')).toEqual([[2, 1, 'Subtitle']]);
  });

  it('does not collect seven or more hashes as an ATX heading', () => {
    expect(scanHeadings('####### Not a heading')).toEqual([]);
  });

  it('does not treat a horizontal rule without preceding text as a setext heading', () => {
    expect(scanHeadings('---')).toEqual([]);
    expect(scanHeadings('Text\n\n---')).toEqual([]);
    expect(scanHeadings('***\n---')).toEqual([]);
  });
});

describe('heading slugs', () => {
  it('lowercases heading slugs', () => {
    expect(collectHeadingSlugs('# HELLO World')).toEqual(['hello-world']);
  });

  it('drops punctuation except hyphens', () => {
    expect(collectHeadingSlugs('# Hello, World!')).toEqual(['hello-world']);
    expect(collectHeadingSlugs('# Already-Hyphenated')).toEqual(['already-hyphenated']);
  });

  it('converts spaces to hyphens', () => {
    expect(collectHeadingSlugs('# Hello World')).toEqual(['hello-world']);
    expect(collectHeadingSlugs('# A  Double  Space')).toEqual(['a--double--space']);
  });

  it('suffixes repeated headings with -1 and -2', () => {
    const markdown = [
      '# Repeat',
      '',
      'Text between the headings.',
      '',
      '## Repeat',
      '',
      '### Repeat',
    ].join('\n');

    expect(collectHeadingSlugs(markdown)).toEqual(['repeat', 'repeat-1', 'repeat-2']);
    expect(collectHeadingSlugs('# Repeat\n## Repeat')).toEqual(['repeat', 'repeat-1']);
  });

  it('suffixes headings that collide after punctuation removal', () => {
    const markdown = ['# Repeat', '', '# Repeat!', '', '# "Repeat"'].join('\n');

    expect(collectHeadingSlugs(markdown)).toEqual(['repeat', 'repeat-1', 'repeat-2']);
  });

  it('restarts duplicate numbering for each Markdown document', () => {
    expect(collectHeadingSlugs('# Repeat\n\n# Repeat')).toEqual(['repeat', 'repeat-1']);
    expect(collectHeadingSlugs('# Repeat')).toEqual(['repeat']);
  });
});

describe('heading code exclusions', () => {
  it('ignores ATX headings inside fenced code', () => {
    const markdown = [
      '```md',
      '# Fake ATX',
      '```',
      '',
      '~~~',
      '# Also fake',
      '~~~',
      '',
      '# Real',
    ].join('\n');

    expect(headingLines(markdown)).toEqual([[1, 9, 'Real']]);
  });

  it('ignores setext headings inside fenced code', () => {
    const markdown = [
      '```md',
      'Fake title',
      '===',
      '```',
      '',
      '~~~',
      'Also fake',
      '---',
      '~~~',
      '',
      '# Real',
    ].join('\n');

    expect(headingLines(markdown)).toEqual([[1, 11, 'Real']]);
  });

  it('ignores headings inside indented code', () => {
    const markdown = ['    # Fake ATX', '', '    Fake setext', '    ===', '', '# Real'].join('\n');

    expect(headingLines(markdown)).toEqual([[1, 6, 'Real']]);
  });

  it('ignores heading-like inline code', () => {
    const markdown = [
      'Use `# not a heading` in prose.',
      '',
      '`# also not a heading`',
      '',
      '`Underlined code is not a heading`',
      '---',
      '',
      '# Real heading',
    ].join('\n');

    expect(headingLines(markdown)).toEqual([[1, 8, 'Real heading']]);
  });
});
