import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkMarkdown,
  checkMarkdownFiles,
  type CheckResult,
  type Diagnostic,
} from '../src/checker.js';
import { makeTempRoot, writeFiles } from './helpers.js';

function check(root: string, ...files: string[]): Diagnostic[] {
  return checkMarkdownFiles(files.map((file) => join(root, file)));
}

function result(root: string, ...files: string[]): CheckResult {
  return checkMarkdown(files.map((file) => join(root, file)));
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

describe('GitHub slug compatibility', () => {
  it('accepts an anchor that uses a literal underscore', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '## scan_headings',
        '',
        '## _emphasis_',
        '',
        '[headings](#scan_headings) and [emphasis](#emphasis)',
      ].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('accepts anchors for reserved duplicate heading slugs', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Foo',
        '',
        '# Foo',
        '',
        '# Foo-1',
        '',
        '[first](#foo) and [second](#foo-1) and [third](#foo-1-1)',
      ].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('accepts an anchor derived from a link label in a heading', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['## Read [the guide](guide.md)', '', '[guide](#read-the-guide)'].join('\n'),
      'guide.md': '# The guide',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('decodes a percent-encoded anchor before comparing', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Café',
        '',
        '[same file](#caf%C3%A9) and [another file](other.md#caf%C3%A9)',
      ].join('\n'),
      'other.md': '## Café',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('compares an invalid percent-encoded anchor as written', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[cafe](other.md#caf%E9)',
      'other.md': '## Café',
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'link',
        target: 'other.md#caf%E9',
        reason: 'anchor does not exist',
      },
    ]);
  });
});

describe('reference-style target checking', () => {
  it('accepts an existing reference-style file target', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['See [the guide][docs].', '', '[docs]: docs/guide.md'].join('\n'),
      'docs/guide.md': '# Guide',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('accepts an existing reference-style image target', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['![architecture][design]', '', '[design]: images/architecture.png'].join('\n'),
      'images/architecture.png': '',
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('reports a missing reference-style file at the use line', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', 'See [the guide][docs].', '', '[docs]: docs/missing.md'].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 3,
        column: 5,
        kind: 'link',
        target: 'docs/missing.md',
        reason: 'target does not exist',
      },
    ]);
  });

  it('reports a missing reference-style image at the use line', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['![diagram][design]', '', '[design]: images/missing.png'].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 1,
        kind: 'image',
        target: 'images/missing.png',
        reason: 'target does not exist',
      },
    ]);
  });

  it('resolves a reference target relative to its Markdown file', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': [
        '# Guide',
        '',
        '[home][root] and [logo][logo]',
        '',
        '[root]: ../README.md',
        '[logo]: ../assets/logo.png',
      ].join('\n'),
      'assets/logo.png': '',
    });

    expect(check(root, 'README.md', 'docs/guide.md')).toEqual([]);
  });

  it('skips a reference-style external target without fetching it', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['[web][site]', '', '[site]: https://example.com/guide'].join('\n'),
    });

    const checked = result(root, 'README.md');
    expect(checked.diagnostics).toEqual([]);
    expect(checked.externalSkipped).toBe(1);
  });

  it('reports an undefined reference use', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': 'See [the guide][missing].' });

    expect(check(root, 'README.md')).toEqual([
      {
        file: join(root, 'README.md'),
        line: 1,
        column: 5,
        kind: 'link',
        target: 'missing',
        reason: 'reference definition does not exist',
      },
    ]);
  });

  it('does not check an unused reference definition', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['[unused]: docs/missing.md', '', 'No links here.'].join('\n'),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });

  it('reports each use of a broken reference target', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['[one][docs] and [two][docs]', '', '[docs]: docs/missing.md'].join('\n'),
    });

    expect(check(root, 'README.md').map(({ line, column, target }) => ({ line, column, target }))).toEqual([
      { line: 1, column: 1, target: 'docs/missing.md' },
      { line: 1, column: 17, target: 'docs/missing.md' },
    ]);
  });

  it('checks a reference through the first of duplicate definitions', () => {
    const firstBroken = makeTempRoot();
    writeFiles(firstBroken, {
      'README.md': [
        '[guide][docs]',
        '',
        '[docs]: docs/first-missing.md',
        '[docs]: docs/guide.md',
      ].join('\n'),
      'docs/guide.md': '# Guide',
    });
    expect(check(firstBroken, 'README.md').map((diagnostic) => diagnostic.target)).toEqual([
      'docs/first-missing.md',
    ]);

    const firstGood = makeTempRoot();
    writeFiles(firstGood, {
      'README.md': [
        '[guide][docs]',
        '',
        '[docs]: docs/guide.md',
        '[docs]: docs/second-missing.md',
      ].join('\n'),
      'docs/guide.md': '# Guide',
    });
    expect(check(firstGood, 'README.md')).toEqual([]);
  });

  it('resolves a reference label with collapsed whitespace', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['[guide][the  doc]', '', '[the doc]: docs/missing.md'].join('\n'),
    });

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

  it('checks anchors on a reference-style destination', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Project',
        '',
        '[details][guide]',
        '',
        '[guide]: docs/guide.md#installation',
      ].join('\n'),
      'docs/guide.md': '# Installation',
    });
    expect(check(root, 'README.md')).toEqual([]);

    const broken = makeTempRoot();
    writeFiles(broken, {
      'README.md': ['[details][guide]', '', '[guide]: docs/guide.md#deployment'].join('\n'),
      'docs/guide.md': '# Installation',
    });
    expect(check(broken, 'README.md')).toEqual([
      {
        file: join(broken, 'README.md'),
        line: 1,
        column: 1,
        kind: 'link',
        target: 'docs/guide.md#deployment',
        reason: 'anchor does not exist',
      },
    ]);
  });
});

describe('external skip counting', () => {
  it('counts each skipped inline external link use', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[one](https://example.com/one) and [two](http://example.com/two)',
    });

    expect(result(root, 'README.md').externalSkipped).toBe(2);
  });

  it('counts each skipped inline external image use', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '![one](https://example.com/one.png) and ![two](http://example.com/two.png)',
    });

    expect(result(root, 'README.md').externalSkipped).toBe(2);
  });

  it('counts each skipped reference-style external use', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[one][site] and [two][site] and [three](https://example.com/inline)',
        '',
        '[site]: https://example.com/docs',
      ].join('\n'),
    });

    const checked = result(root, 'README.md');
    expect(checked.externalSkipped).toBe(3);
    expect(checked.diagnostics).toEqual([]);
  });

  it('does not count an unused external definition', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['[unused]: https://example.com/unused', '', 'No links here.'].join('\n'),
    });

    expect(result(root, 'README.md').externalSkipped).toBe(0);
  });

  it('does not count external-looking text inside code', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[web](https://example.com/real)',
        '',
        '```md',
        '[fake](https://example.com/fenced)',
        '```',
        '',
        'Use `[inline](https://example.com/inline)` in prose.',
      ].join('\n'),
    });

    expect(result(root, 'README.md').externalSkipped).toBe(1);
  });

  it('does not fetch external targets', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['[web](https://192.0.2.1/unreachable)', '', '[site]: https://192.0.2.2/also-unreachable'].join(
        '\n',
      ),
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('network access attempted');
    }) as typeof fetch;
    try {
      expect(result(root, 'README.md').externalSkipped).toBe(1);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
