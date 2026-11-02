import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTempRoot, writeFiles } from './helpers.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8' });
}

describe('CLI', () => {
  it('clean tree exits 0', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': '# Guide',
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('broken file link exits 1', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[guide](docs/missing.md)' });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('docs/missing.md');
  });

  it('broken image exits 1', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '![logo](assets/missing.png)' });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('assets/missing.png');
  });

  it('multiple input paths are checked', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'first.md': '[one](one.md)',
      'second.md': '[two](two.md)',
    });

    const result = runCli(root, ['first.md', 'second.md']);
    expect(result.status).toBe(1);
    expect(result.stdout.trim().split('\n')).toHaveLength(2);
    expect(result.stdout).toContain('first.md:1: one.md');
    expect(result.stdout).toContain('second.md:1: two.md');
  });

  it('diagnostic includes source file, line, target, and reason', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', '[guide](docs/missing.md)', ''].join('\n'),
    });

    const result = runCli(root, ['README.md']);
    expect(result.stdout.trim()).toBe(
      'README.md:3: docs/missing.md — target does not exist',
    );
  });

  it('checks Markdown below a directory input', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': '[broken](../missing.md)',
    });

    const result = runCli(root, ['.']);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe(
      `${join('docs', 'guide.md')}:1: ../missing.md — target does not exist`,
    );
  });
});
