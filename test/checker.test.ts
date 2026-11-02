import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMarkdownFiles, type Diagnostic } from '../src/checker.js';
import { makeTempRoot, writeFiles } from './helpers.js';

function check(root: string, ...files: string[]): Diagnostic[] {
  return checkMarkdownFiles(files.map((file) => join(root, file)));
}

describe('relative target checking', () => {
  it('accepts an existing relative file', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': '# Guide',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('accepts an existing relative directory', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[docs](docs/) and [docs without a trailing slash](docs)',
      'docs/guide.md': '# Guide',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('accepts an existing relative image', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '![architecture](assets/architecture.png)',
      'assets/architecture.png': '',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('reports a missing relative file', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[guide](docs/missing.md)' });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'link',
        target: 'docs/missing.md',
        reason: 'target does not exist',
      },
    ]);
  });

  it('reports a missing relative directory', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[docs](missing-directory/)' });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'link',
        target: 'missing-directory/',
        reason: 'target does not exist',
      },
    ]);
  });

  it('reports a missing relative image', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '![logo](assets/missing.png)' });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'image',
        target: 'assets/missing.png',
        reason: 'target does not exist',
      },
    ]);
  });

  it('resolves targets relative to the source Markdown file', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': 'Back to [the logo](../assets/logo.png) and [intro](intro.md).',
      'docs/intro.md': '# Intro',
      'assets/logo.png': '',
    });

    expect(check(root, 'README.md', 'docs/guide.md', 'docs/intro.md')).toEqual([]);
  });

  it('reports every broken target instead of stopping at the first', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[one](one.md) and [two](two.md)' });

    expect(check(root, 'README.md').map((diagnostic) => diagnostic.target)).toEqual([
      'one.md',
      'two.md',
    ]);
  });

  it('keeps validating a relative path when the target also has a fragment', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md#installation) and [broken](docs/missing.md#x)',
      'docs/guide.md': '# Installation',
    });

    expect(check(root, 'README.md').map((diagnostic) => diagnostic.target)).toEqual([
      'docs/missing.md#x',
    ]);
  });

  it('skips external and root-relative targets', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[web](https://example.com/guide.md)',
        '[mail](mailto:someone@example.com)',
        '[root](/docs/guide.md)',
      ].join(' '),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });
});

describe('same-file anchors', () => {
  it('accepts an existing same-file anchor', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Installation', '', '[jump](#installation)'].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('reports a missing same-file anchor', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Installation', '', '[jump](#install)'].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 3,
        column: 1,
        kind: 'link',
        target: '#install',
        reason: 'anchor does not exist',
      },
    ]);
  });

  it('accepts a duplicate heading anchor with suffix', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Repeat',
        '',
        'Between the headings.',
        '',
        '## Repeat',
        '',
        '[first](#repeat) and [second](#repeat-1)',
      ].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('reports every missing same-file anchor', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[one](#one) and [two](#two)' });

    expect(check(root, 'README.md').map((diagnostic) => diagnostic.target)).toEqual([
      '#one',
      '#two',
    ]);
  });
});

describe('anchor code exclusions', () => {
  it('ignores anchor links inside fenced code', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Real',
        '',
        '```md',
        '[fake](#missing)',
        '```',
        '',
        '~~~',
        '[also fake](#tilde-missing)',
        '~~~',
        '',
        '[real](#real)',
      ].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('ignores anchor links inside indented code', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Real', '', '    [fake](#missing)', '', '[real](#real)'].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('ignores anchor links inside inline code', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Real',
        '',
        'Use `[fake](#missing)` in prose.',
        '',
        '[real](#real)',
      ].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('a fake heading inside code does not satisfy an anchor', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Real',
        '',
        '```md',
        '# fake',
        '```',
        '',
        '[fake](#fake)',
      ].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 7,
        column: 1,
        kind: 'link',
        target: '#fake',
        reason: 'anchor does not exist',
      },
    ]);
  });
});

describe('cross-file anchors', () => {
  it('accepts an existing anchor in another Markdown file', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', '[details](docs/guide.md#installation)'].join('\n'),
      'docs/guide.md': '# Installation',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('reports a missing anchor in another Markdown file', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[details](docs/guide.md#deployment)',
      'docs/guide.md': '# Installation',
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'link',
        target: 'docs/guide.md#deployment',
        reason: 'anchor does not exist',
      },
    ]);
  });

  it('resolves an anchored Markdown path relative to the source file', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Project',
      'docs/guide.md': ['# Guide', '', '[back home](../README.md#project)'].join('\n'),
    });

    expect(check(root, 'docs/guide.md')).toEqual([]);
  });

  it('reports a missing target file without a second anchor diagnostic', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[details](docs/missing.md#installation)',
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'link',
        target: 'docs/missing.md#installation',
        reason: 'target does not exist',
      },
    ]);
  });

  it('does not validate anchors for an existing non-Markdown target', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[data](assets/data.txt#section)',
      'assets/data.txt': 'section: raw data',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('does not validate anchors for a directory target', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[docs](docs/#section)',
      'docs/guide.md': '# Guide',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('does not leak duplicate heading state between target files', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[first](a.md#repeat) and [second](b.md#repeat)',
      'a.md': '# Repeat',
      'b.md': '# Repeat',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('checks every link to the same cached target document', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[good](docs/guide.md#installation) and [bad](docs/guide.md#deployment)',
      'docs/guide.md': '# Installation',
    });

    expect(check(root, 'README.md').map((diagnostic) => diagnostic.target)).toEqual([
      'docs/guide.md#deployment',
    ]);
  });
});
