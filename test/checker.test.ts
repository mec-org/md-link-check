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

  it('validates only the path part of a target with a fragment', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md#installation) and [broken](docs/missing.md#x)',
      'docs/guide.md': '# Guide',
    });

    expect(check(root, 'README.md').map((diagnostic) => diagnostic.target)).toEqual([
      'docs/missing.md#x',
    ]);
  });

  it('skips external, fragment-only and root-relative targets', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[web](https://example.com/guide.md)',
        '[mail](mailto:someone@example.com)',
        '[section](#installation)',
        '[root](/docs/guide.md)',
      ].join(' '),
    });

    expect(check(root, 'README.md')).toEqual([]);
  });
});
