import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMarkdownFiles } from '../src/discovery.js';
import { makeTempRoot, writeFiles } from './helpers.js';

describe('Markdown discovery', () => {
  it('recursively discovers Markdown files in deterministic order', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'b.md': '',
      'a.md': '',
      'README.markdown': '',
      'notes.txt': '',
      'nested/z.md': '',
      'nested/deeper/y.md': '',
    });

    const expected = [
      join(root, 'README.markdown'),
      join(root, 'a.md'),
      join(root, 'b.md'),
      join(root, 'nested/deeper/y.md'),
      join(root, 'nested/z.md'),
    ];
    expect(discoverMarkdownFiles([root])).toEqual(expected);
    expect(discoverMarkdownFiles([root])).toEqual(expected);
  });

  it('does not traverse git metadata or node_modules', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '',
      '.git/hidden.md': '',
      'node_modules/package/readme.md': '',
      'docs/guide.md': '',
    });

    expect(discoverMarkdownFiles([root])).toEqual([
      join(root, 'README.md'),
      join(root, 'docs/guide.md'),
    ]);
  });

  it('checks an explicitly supplied file and removes duplicates', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '', 'notes.txt': '' });

    expect(discoverMarkdownFiles([join(root, 'README.md'), root, join(root, 'notes.txt')])).toEqual([
      join(root, 'README.md'),
      join(root, 'notes.txt'),
    ]);
  });
});
