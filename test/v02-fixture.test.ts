import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMarkdown } from '../src/checker.js';
import { scanHtml } from '../src/parser.js';
import { readFileSync } from 'node:fs';
import { runCli } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

/**
 * The README lines of a combined v0.2 fixture. It exercises Markdown and raw
 * HTML targets, same-file and cross-file heading anchors, literal explicit
 * anchors, reference-style links, external targets, and code exclusions in one
 * document. It is synthetic and contains no content from the private docs.
 */
const FIXTURE_LINES = [
  '# Overview',
  '',
  '[guide](docs/guide.md), ![logo](assets/logo.png), [same](#details),',
  '[same explicit](#local-id), [cross](docs/guide.md#installation),',
  '[cross explicit](docs/guide.md#explicit),',
  '[missing file](docs/missing.md),',
  '[missing same anchor](#nope),',
  '[missing cross anchor](docs/guide.md#nope),',
  '[ref guide][guide-ref], [external](https://example.com/one),',
  '<a id="local-id"></a>',
  '<a name="local-name"></a>',
  '<a href="docs/guide.md#explicit">raw link</a>',
  '<a href="missing.md">raw missing</a>',
  '<a href="https://example.com/two">raw external</a>',
  '<img src="assets/logo.png" alt="logo">',
  '<img src="assets/missing.png" alt="missing">',
  '<img src="https://example.com/image.png" alt="external">',
  '',
  '## Details',
  '',
  '```markdown',
  '[fenced](missing.md) <a href="missing.md"> <img src="missing.png">',
  '```',
  '',
  '    [indented](missing.md)',
  '',
  'Use `[inline](missing.md)` and `<a href="missing.md">` in prose.',
  '',
  '[guide-ref]: docs/guide.md',
  '',
];

const FIXTURE_FILES: Record<string, string> = {
  'README.md': FIXTURE_LINES.join('\n'),
  'docs/guide.md': '# Guide\n\n## Installation\n\n<a id="explicit"></a>\n',
  'assets/logo.png': '',
};

const BROKEN_TARGETS = [
  'docs/missing.md',
  '#nope',
  'docs/guide.md#nope',
  'missing.md',
  'assets/missing.png',
];

function makeFixture(): string {
  const root = makeTempRoot();
  writeFiles(root, FIXTURE_FILES);
  return root;
}

function checkFixture(root: string) {
  return checkMarkdown([join(root, 'README.md'), join(root, 'docs', 'guide.md')]);
}

describe('M8 complete v0.2 supported-form fixture', () => {
  it('v0.2 fixture combines Markdown and raw HTML targets', () => {
    const root = makeFixture();
    const result = checkFixture(root);

    expect(result.filesChecked).toBe(2);
    expect(result.broken).toBe(5);
    expect(result.externalSkipped).toBe(3);
    expect(result.diagnostics.map((diagnostic) => diagnostic.target)).toEqual(BROKEN_TARGETS);
  });

  it('v0.2 fixture resolves heading and explicit HTML anchors', () => {
    const root = makeFixture();
    const result = checkFixture(root);
    const targets = result.diagnostics.map((diagnostic) => diagnostic.target);

    for (const cleanTarget of [
      '#details',
      '#local-id',
      'docs/guide.md#installation',
      'docs/guide.md#explicit',
    ]) {
      expect(targets).not.toContain(cleanTarget);
    }
    expect(targets).toContain('#nope');
    expect(targets).toContain('docs/guide.md#nope');
  });

  it('v0.2 fixture resolves same-file and cross-file anchors', () => {
    const root = makeFixture();
    const result = checkFixture(root);
    const reasons = new Map(
      result.diagnostics.map((diagnostic) => [diagnostic.target, diagnostic.reason]),
    );

    // Same-file heading and explicit anchor, and cross-file heading and
    // explicit anchors resolve; missing ones are reported at their use line.
    expect(reasons.has('#details')).toBe(false);
    expect(reasons.has('#local-id')).toBe(false);
    expect(reasons.has('docs/guide.md#installation')).toBe(false);
    expect(reasons.has('docs/guide.md#explicit')).toBe(false);
    expect(reasons.get('#nope')).toBe('anchor does not exist');
    expect(reasons.get('docs/guide.md#nope')).toBe('anchor does not exist');
  });

  it('v0.2 fixture checks raw HTML links and images', () => {
    const root = makeFixture();
    const result = checkFixture(root);
    const rawTargets = result.diagnostics.filter(
      (diagnostic) => diagnostic.target === 'missing.md' || diagnostic.target === 'assets/missing.png',
    );

    expect(rawTargets).toEqual([
      {
        file: join(root, 'README.md'),
        line: 13,
        column: 1,
        kind: 'link',
        target: 'missing.md',
        reason: 'target does not exist',
      },
      {
        file: join(root, 'README.md'),
        line: 16,
        column: 1,
        kind: 'image',
        target: 'assets/missing.png',
        reason: 'target does not exist',
      },
    ]);
    // The valid raw HTML link and image produce no finding.
    expect(result.diagnostics.map((diagnostic) => diagnostic.line)).not.toContain(12);
    expect(result.diagnostics.map((diagnostic) => diagnostic.line)).not.toContain(15);
  });

  it('v0.2 fixture ignores supported-looking HTML inside code', () => {
    const root = makeFixture();
    const markdown = readFileSync(join(root, 'README.md'), 'utf8');
    const html = scanHtml(markdown);
    const result = checkFixture(root);

    expect(html.anchors.map((anchor) => anchor.value)).toEqual(['local-id', 'local-name']);
    expect(html.references.map((reference) => reference.target)).toEqual([
      'docs/guide.md#explicit',
      'missing.md',
      'https://example.com/two',
      'assets/logo.png',
      'assets/missing.png',
      'https://example.com/image.png',
    ]);
    // The fenced, indented and inline fakes on lines 22, 25 and 27 are masked.
    expect(result.diagnostics.map((diagnostic) => diagnostic.line)).toEqual([6, 7, 8, 13, 16]);
    expect(result.externalSkipped).toBe(3);
  });

  it('v0.2 fixture skips external Markdown and HTML targets offline', () => {
    const root = makeFixture();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('network access attempted');
    }) as typeof fetch;
    try {
      const result = checkFixture(root);

      expect(result.external.enabled).toBe(false);
      expect(result.external.occurrences).toBe(3);
      expect(result.external.skipped).toBe(3);
      expect(result.external.distinctChecked).toBe(0);
      expect(result.external.results).toEqual([]);
      expect(result.diagnostics.map((diagnostic) => diagnostic.target)).not.toContain(
        'https://example.com/one',
      );
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('v0.2 fixture reports every broken local supported target', () => {
    const root = makeFixture();
    const result = checkFixture(root);

    expect(result.diagnostics).toEqual([
      {
        file: join(root, 'README.md'),
        line: 6,
        column: 1,
        kind: 'link',
        target: 'docs/missing.md',
        reason: 'target does not exist',
      },
      {
        file: join(root, 'README.md'),
        line: 7,
        column: 1,
        kind: 'link',
        target: '#nope',
        reason: 'anchor does not exist',
      },
      {
        file: join(root, 'README.md'),
        line: 8,
        column: 1,
        kind: 'link',
        target: 'docs/guide.md#nope',
        reason: 'anchor does not exist',
      },
      {
        file: join(root, 'README.md'),
        line: 13,
        column: 1,
        kind: 'link',
        target: 'missing.md',
        reason: 'target does not exist',
      },
      {
        file: join(root, 'README.md'),
        line: 16,
        column: 1,
        kind: 'image',
        target: 'assets/missing.png',
        reason: 'target does not exist',
      },
    ]);
  });

  it('v0.2 fixture retains deterministic diagnostic order', async () => {
    const root = makeFixture();
    const first = checkFixture(root);
    const second = checkFixture(root);
    expect(second).toEqual(first);
    expect(first.diagnostics.map((diagnostic) => diagnostic.line)).toEqual([6, 7, 8, 13, 16]);

    const cliFirst = await runCli(['.'], { cwd: root });
    const cliSecond = await runCli(['.'], { cwd: root });
    expect(cliFirst.status).toBe(1);
    expect(cliSecond).toEqual(cliFirst);
    expect(cliFirst.stdout).toBe(
      [
        'README.md:6: docs/missing.md — target does not exist',
        'README.md:7: #nope — anchor does not exist',
        'README.md:8: docs/guide.md#nope — anchor does not exist',
        'README.md:13: missing.md — target does not exist',
        'README.md:16: assets/missing.png — target does not exist',
        'Checked 2 files: 5 broken targets, 3 external links skipped.',
        '',
      ].join('\n'),
    );
  });

  it('v0.2 fixture preserves file line target and reason', () => {
    const root = makeFixture();
    const result = checkFixture(root);

    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.file).toBe(join(root, 'README.md'));
      expect(diagnostic.line).toBeGreaterThan(0);
      expect(diagnostic.column).toBeGreaterThan(0);
      expect(['link', 'image']).toContain(diagnostic.kind);
      expect(diagnostic.target).not.toBe('');
      expect(['target does not exist', 'anchor does not exist']).toContain(diagnostic.reason);
    }
  });

  it('v0.2 fixture emits backward-compatible JSON', async () => {
    const root = makeFixture();
    const result = await runCli(['--json', '.'], { cwd: root });
    expect(result.status).toBe(1);

    const document = JSON.parse(result.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      summary: { filesChecked: number; broken: number; externalSkipped: number };
      external: { enabled: boolean; occurrences: number; skipped: number; results: unknown[] };
      diagnostics: Array<{
        file: string;
        line: number;
        column: number;
        kind: string;
        target: string;
        reason: string;
      }>;
    };

    // Pre-M5 fields keep their names, types and meaning.
    expect(document.version).toBe(1);
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(1);
    expect(document.summary).toEqual({ filesChecked: 2, broken: 5, externalSkipped: 3 });
    expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual(BROKEN_TARGETS);
    for (const diagnostic of document.diagnostics) {
      expect(Object.keys(diagnostic).sort()).toEqual([
        'column',
        'file',
        'kind',
        'line',
        'reason',
        'target',
      ]);
    }

    // The additive external object is present and describes the offline run.
    expect(document.external.enabled).toBe(false);
    expect(document.external.occurrences).toBe(3);
    expect(document.external.skipped).toBe(3);
    expect(document.external.results).toEqual([]);
  });
});
