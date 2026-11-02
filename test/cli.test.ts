import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeTempRoot, writeFiles } from './helpers.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function runCli(root: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { cwd: root, encoding: 'utf8' });
}

interface JsonDocument {
  version: number;
  ok: boolean;
  exitCode: number;
  summary: {
    filesChecked: number;
    broken: number;
    externalSkipped: number;
  };
  diagnostics: Array<{ file: string; line: number; target: string; reason: string }>;
}

function parseJson(stdout: string): JsonDocument {
  return JSON.parse(stdout) as JsonDocument;
}

describe('CLI', () => {
  it('clean inputs exit 0', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': '# Guide',
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Checked 1 file: 0 broken targets, 0 external links skipped.\n');
    expect(result.stderr).toBe('');
  });

  it('broken targets exit 1', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[guide](docs/missing.md)' });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('README.md:1: docs/missing.md — target does not exist');
    expect(result.stdout).toContain('Checked 1 file: 1 broken target, 0 external links skipped.');
    expect(result.stderr).toBe('');
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
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'first.md:1: one.md — target does not exist',
      'second.md:1: two.md — target does not exist',
      'Checked 2 files: 2 broken targets, 0 external links skipped.',
    ]);
  });

  it('diagnostic includes source file, line, target, and reason', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', '[guide](docs/missing.md)', ''].join('\n'),
    });

    const result = runCli(root, ['README.md']);
    expect(result.stdout.split('\n')[0]).toBe(
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
    expect(result.stdout.split('\n')[0]).toBe(
      `${join('docs', 'guide.md')}:1: ../missing.md — target does not exist`,
    );
  });

  it('valid same-file and cross-file anchors exit 0', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Project',
        '',
        '[same file](#project) and [another file](docs/guide.md#installation)',
      ].join('\n'),
      'docs/guide.md': '# Installation',
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Checked 1 file: 0 broken targets, 0 external links skipped.\n');
    expect(result.stderr).toBe('');
  });

  it('missing same-file anchor exits 1', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', '[missing](#installation)'].join('\n'),
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('#installation');
  });

  it('missing cross-file anchor exits 1', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[missing](docs/guide.md#deployment)',
      'docs/guide.md': '# Installation',
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('docs/guide.md#deployment');
  });

  it('anchor diagnostic includes source file line target and reason', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', '[missing](#installation)'].join('\n'),
    });

    const result = runCli(root, ['README.md']);
    expect(result.stdout.split('\n')[0]).toBe(
      'README.md:3: #installation — anchor does not exist',
    );
  });

  it('code examples containing fake links and headings exit 0', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Real heading',
        '',
        '```md',
        '# Fake heading',
        '[fake](#fake-heading)',
        '```',
        '',
        '    # Indented fake heading',
        '    [fake](#indented-fake-heading)',
        '',
        '`# Inline fake` and `[fake](#inline-fake)`',
        '',
        '[real](#real-heading)',
      ].join('\n'),
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Checked 1 file: 0 broken targets, 0 external links skipped.\n');
    expect(result.stderr).toBe('');
  });
});

describe('text output', () => {
  it('formats a diagnostic as file line target em dash reason', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[guide](docs/missing.md)' });

    const result = runCli(root, ['README.md']);
    expect(result.stdout.split('\n')[0]).toBe(
      'README.md:1: docs/missing.md — target does not exist',
    );
  });

  it('text diagnostics are emitted in deterministic order', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'b.md': '[b](b-missing.md)',
      'a.md': '[a](a-missing.md)',
    });

    const result = runCli(root, ['.']);
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'a.md:1: a-missing.md — target does not exist',
      'b.md:1: b-missing.md — target does not exist',
      'Checked 2 files: 2 broken targets, 0 external links skipped.',
    ]);
  });

  it('text mode reports the skipped external count', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[one](https://example.com/one) and [two](http://example.com/two)',
    });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      'Checked 1 file: 0 broken targets, 2 external links skipped.',
    );
  });

  it('clean text mode reports zero broken targets', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 broken targets');
    expect(result.stdout).toContain('0 external links skipped');
  });

  it('broken text mode retains all diagnostics', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[one](one.md) and [two](two.md)',
    });

    const result = runCli(root, ['README.md']);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('README.md:1: one.md — target does not exist');
    expect(lines[1]).toBe('README.md:1: two.md — target does not exist');
    expect(lines[2]).toBe('Checked 1 file: 2 broken targets, 0 external links skipped.');
  });
});

describe('JSON output', () => {
  it('json mode emits one valid JSON document for a clean tree', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': '# Guide',
    });

    const result = runCli(root, ['--json', 'README.md']);
    const document = parseJson(result.stdout);
    expect(document).toEqual({
      version: 1,
      ok: true,
      exitCode: 0,
      summary: { filesChecked: 1, broken: 0, externalSkipped: 0 },
      diagnostics: [],
    });
    expect(result.stderr).toBe('');
  });

  it('json mode emits structured diagnostics for broken targets', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', 'See [the guide](docs/missing.md).'].join('\n'),
    });

    const result = runCli(root, ['--json', 'README.md']);
    const document = parseJson(result.stdout);
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(1);
    expect(document.diagnostics).toEqual([
      {
        file: 'README.md',
        line: 3,
        target: 'docs/missing.md',
        reason: 'target does not exist',
      },
    ]);
  });

  it('json mode includes files checked broken and external skipped counts', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'a.md': ['# A', '', '[web](https://example.com/a) and [broken](missing.md)'].join('\n'),
      'b.md': '[web](http://example.com/b)',
    });

    const result = runCli(root, ['--json', 'a.md', 'b.md']);
    const document = parseJson(result.stdout);
    expect(document.summary).toEqual({ filesChecked: 2, broken: 1, externalSkipped: 2 });
    expect(result.status).toBe(1);
  });

  it('json diagnostics preserve deterministic order', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'b.md': '[b](b-missing.md)',
      'a.md': '[a](a-missing.md)',
    });

    const result = runCli(root, ['--json', '.']);
    const document = parseJson(result.stdout);
    expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'a-missing.md',
      'b-missing.md',
    ]);
  });

  it('json mode emits no human-readable lines on stdout', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[one](one.md) and [two](two.md)' });

    const result = runCli(root, ['--json', 'README.md']);
    expect(result.stdout.trim()).toMatch(/^\{[\s\S]*\}$/);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout).not.toContain('Checked ');
    expect(result.stdout).not.toContain('—');
  });

  it('json clean result exits 0', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = runCli(root, ['--json', 'README.md']);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout).exitCode).toBe(0);
    expect(parseJson(result.stdout).ok).toBe(true);
  });

  it('json broken result exits 1', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[guide](missing.md)' });

    const result = runCli(root, ['--json', 'README.md']);
    expect(result.status).toBe(1);
    expect(parseJson(result.stdout).exitCode).toBe(1);
    expect(parseJson(result.stdout).ok).toBe(false);
  });

  it('json usage error exits 2 and remains valid JSON', () => {
    const root = makeTempRoot();

    const result = runCli(root, ['--json']);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    const document = parseJson(result.stdout);
    expect(document.version).toBe(1);
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(2);
    expect(document.summary).toEqual({ filesChecked: 0, broken: 0, externalSkipped: 0 });
    expect(document.diagnostics).toEqual([
      { file: '', line: 0, target: '', reason: 'no input paths' },
    ]);
  });

  it('json flag accepts one or more paths', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'first.md': '# First', 'second.md': '# Second' });

    const result = runCli(root, ['--json', 'first.md', 'second.md']);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout).summary.filesChecked).toBe(2);
  });

  it('json and text modes report the same findings and counts', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Project',
        '',
        '[web](https://example.com/a) and [ref][site] and [broken](missing.md)',
        '',
        '[site]: http://example.com/b',
      ].join('\n'),
    });

    const text = runCli(root, ['README.md']);
    const json = runCli(root, ['--json', 'README.md']);
    const document = parseJson(json.stdout);
    expect(text.status).toBe(1);
    expect(json.status).toBe(1);
    expect(document.summary).toEqual({
      filesChecked: 1,
      broken: 1,
      externalSkipped: 2,
    });
    expect(document.diagnostics[0]?.target).toBe('missing.md');
    expect(text.stdout.split('\n')[0]).toBe(
      'README.md:3: missing.md — target does not exist',
    );
  });

  it('text and JSON modes report the same skipped count', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[inline](https://example.com/a) and [ref][site]',
        '',
        '[site]: http://example.com/b',
      ].join('\n'),
    });

    const text = runCli(root, ['README.md']);
    const json = runCli(root, ['--json', 'README.md']);
    const textCount = /(\d+) external links skipped/.exec(text.stdout)?.[1];
    expect(textCount).toBe('2');
    expect(parseJson(json.stdout).summary.externalSkipped).toBe(2);
  });
});

describe('exit codes and usage', () => {
  it('no input paths exit 2', () => {
    const root = makeTempRoot();

    const result = runCli(root, []);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no input paths');
    expect(result.stderr).toContain('Usage: md-link-check [--json] <path...>');
  });

  it('unknown option exits 2', () => {
    const root = makeTempRoot();

    const result = runCli(root, ['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown option "--bogus"');
  });

  it('usage errors do not print a stack trace', () => {
    const root = makeTempRoot();

    const result = runCli(root, ['--bogus']);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain('node:');
    expect(result.stderr).not.toContain('stack');
  });

  it('help text documents syntax and exit codes', () => {
    const root = makeTempRoot();

    const result = runCli(root, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('md-link-check [--json] [--] <path...>');
    expect(result.stdout).toContain('Exit codes:');
    expect(result.stdout).toContain('2  usage error');
  });

  it('double dash permits a path beginning with a hyphen', () => {
    const root = makeTempRoot();
    writeFiles(root, { '-notes.md': '[missing](missing.md)' });

    const result = runCli(root, ['--', '-notes.md']);
    expect(result.status).toBe(1);
    expect(result.stdout.split('\n')[0]).toBe(
      '-notes.md:1: missing.md — target does not exist',
    );
  });

  it('unreadable input path is a usage error', () => {
    const root = makeTempRoot();

    const result = runCli(root, ['missing.md']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cannot access input path "missing.md"');
  });

  it('json unreadable input path remains valid JSON', () => {
    const root = makeTempRoot();

    const result = runCli(root, ['--json', 'missing.md']);
    expect(result.status).toBe(2);
    const document = parseJson(result.stdout);
    expect(document.exitCode).toBe(2);
    expect(document.diagnostics[0]?.reason).toContain('cannot access input path "missing.md"');
  });
});
