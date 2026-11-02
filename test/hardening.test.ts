import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMarkdown } from '../src/checker.js';
import { collectHeadingSlugs } from '../src/headings.js';
import { run, type CliIo } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';

interface CapturedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
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
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    kind: string;
    target: string;
    reason: string;
  }>;
}

function captureRun(args: readonly string[]): CapturedRun {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
  };
  const exitCode = run(args, io);
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): JsonDocument {
  return JSON.parse(stdout) as JsonDocument;
}

function parseTextOutput(stdout: string): {
  findings: Array<{ file: string; line: number; target: string; reason: string }>;
  summary: { filesChecked: number; broken: number; externalSkipped: number };
} {
  const lines = stdout.replace(/\n$/, '').split('\n');
  const summaryLine = lines.pop() ?? '';
  const summaryMatch =
    /^Checked (\d+) files?: (\d+) broken targets?, (\d+) external links? skipped\.$/.exec(summaryLine);
  expect(summaryMatch, `unexpected summary line: ${summaryLine}`).not.toBeNull();

  const findings = lines.map((line) => {
    const match = /^(.*):(\d+): (.*?) — (.*)$/.exec(line);
    expect(match, `unexpected diagnostic line: ${line}`).not.toBeNull();
    return {
      file: match?.[1] ?? '',
      line: Number(match?.[2] ?? 0),
      target: match?.[3] ?? '',
      reason: match?.[4] ?? '',
    };
  });

  return {
    findings,
    summary: {
      filesChecked: Number(summaryMatch?.[1] ?? 0),
      broken: Number(summaryMatch?.[2] ?? 0),
      externalSkipped: Number(summaryMatch?.[3] ?? 0),
    },
  };
}

/**
 * Writes a docs-shaped fixture with inline links, images, a reference use, a
 * missing file, a missing same-file anchor, and one external link.
 *
 * This is a synthetic fixture, not copied from the owner's dsh-copilot
 * documentation and free of confidential content. It locks the end-to-end
 * determinism contract that the real-docs run will use.
 */
function writeDocsFixture(root: string): void {
  writeFiles(root, {
    'README.md': [
      '# Project',
      '',
      'See [the guide](docs/guide.md), [missing](docs/missing.md),',
      '![logo](assets/logo.png), [web](https://example.com/guide),',
      '[ref][api], and [same](#project).',
      '',
      '[api]: docs/api.md',
    ].join('\n'),
    'docs/guide.md': [
      '# Guide',
      '',
      '## Installation',
      '',
      '[home](../README.md#project) and [details](#installation)',
      'and [missing](#deployment).',
    ].join('\n'),
    'assets/logo.png': '',
  });
}

describe('M3 end-to-end stability', () => {
  it('real docs fixture produces deterministic diagnostics', () => {
    const root = makeTempRoot();
    writeDocsFixture(root);

    const firstText = captureRun([root]);
    const secondText = captureRun([root]);
    const firstJson = captureRun(['--json', root]);
    const secondJson = captureRun(['--json', root]);

    expect(firstText.exitCode).toBe(1);
    expect(secondText).toEqual(firstText);
    expect(firstJson.exitCode).toBe(1);
    expect(secondJson).toEqual(firstJson);
    expect(parseJson(firstJson.stdout).diagnostics).toHaveLength(3);
  });

  it('text and JSON modes report equivalent findings', () => {
    const root = makeTempRoot();
    writeDocsFixture(root);

    const text = captureRun([root]);
    const json = captureRun(['--json', root]);
    const document = parseJson(json.stdout);
    const parsedText = parseTextOutput(text.stdout);

    expect(json.exitCode).toBe(text.exitCode);
    expect(parsedText.findings).toEqual(
      document.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    );
    expect(parsedText.summary).toEqual(document.summary);
  });

  it('two identical runs preserve diagnostic order', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'a.md': '# A\n\n[one](one.md) and [two](two.md)',
      'b.md': '# B\n\n[three](three.md) and [four](four.md)',
    });

    const first = captureRun(['--json', root]);
    const second = captureRun(['--json', root]);

    expect(first.stdout).toBe(second.stdout);
    expect(parseJson(first.stdout).diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'one.md',
      'two.md',
      'three.md',
      'four.md',
    ]);
  });

  it('clean supported fixture exits 0', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Clean\n\n[guide](docs/guide.md), [same](#clean) and [web](https://example.com).',
      'docs/guide.md': '# Guide',
    });

    const result = captureRun([root]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('Checked 2 files: 0 broken targets, 1 external link skipped.\n');
    expect(result.stderr).toBe('');
  });

  it('broken supported fixture exits 1', () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[missing](docs/missing.md)' });

    const result = captureRun([root]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('docs/missing.md — target does not exist');
    expect(result.stderr).toBe('');
  });

  it('usage error exits 2', () => {
    const result = captureRun([]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('no input paths');
  });

  it('external links are counted without network access', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[one](https://example.com/one) and [two][site]',
        '',
        '[site]: http://example.com/two',
      ].join('\n'),
    });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('network access attempted');
    }) as typeof fetch;
    try {
      const result = captureRun(['--json', root]);
      expect(result.exitCode).toBe(0);
      expect(parseJson(result.stdout).summary.externalSkipped).toBe(2);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('package has no runtime dependencies', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(packageJson.optionalDependencies ?? {}).toEqual({});
    expect(packageJson.peerDependencies ?? {}).toEqual({});
  });
});

describe('M3 supported-form hardening', () => {
  it('inline links images references and anchors coexist in one document', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Overview',
        '',
        '[file](docs/guide.md), ![logo](assets/logo.png), [same](#details),',
        '[cross](docs/guide.md#installation), [ref][guide-ref],',
        '[external](https://example.com/x)',
        '',
        '## Details',
        '',
        '[guide-ref]: docs/guide.md',
      ].join('\n'),
      'docs/guide.md': '# Guide\n\n## Installation',
      'assets/logo.png': '',
    });

    const result = checkMarkdown([join(root, 'README.md')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.externalSkipped).toBe(1);
  });

  it('same-file and cross-file anchors coexist with file targets', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Project',
        '',
        '[file](docs/guide.md) and [same](#project)',
        'and [cross](docs/guide.md#installation).',
        '',
        '![logo](assets/logo.png)',
      ].join('\n'),
      'docs/guide.md': '# Guide\n\n## Installation',
      'assets/logo.png': '',
    });

    const result = checkMarkdown([join(root, 'README.md')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.externalSkipped).toBe(0);
  });

  it('code examples do not create links headings or reference definitions', () => {
    const root = makeTempRoot();
    const markdown = [
      '# Real',
      '',
      '```md',
      '# Fenced fake',
      '[fenced](missing.md)',
      '[fenced-ref]: missing.md',
      '```',
      '',
      '~~~',
      '# Tilde fake',
      '[tilde](missing.md)',
      '~~~',
      '',
      '    # Indented fake',
      '    [indented](missing.md)',
      '',
      'Use `[inline](missing.md)` and `[inline-ref]: missing.md` in prose.',
      '',
      '[real](#real)',
    ].join('\n');
    writeFiles(root, { 'README.md': markdown });

    const result = checkMarkdown([join(root, 'README.md')]);
    expect(result.diagnostics).toEqual([]);
    expect(result.externalSkipped).toBe(0);
    expect(collectHeadingSlugs(markdown)).toEqual(['real']);
  });

  it('json output remains valid when diagnostics contain special characters', () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[weird](<docs/"quoted" \\ café.md>) and [dash](<docs/—.md>)',
    });

    const result = captureRun(['--json', root]);
    const document = parseJson(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'docs/"quoted" \\ café.md',
      'docs/—.md',
    ]);
  });
});
