import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/external.js';
import type { BrokenLinkResult } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import {
  captureRun,
  fixtureRelativeFindings,
  M9_BROKEN_FINDINGS,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
  parseTextFindings,
} from './m9-helpers.js';

const EXPECTED_BROKEN_FINDINGS = M9_BROKEN_FINDINGS;
const BROKEN_SUMMARY = 'Checked 2 files: 9 broken targets, 1 external link skipped.';

/** Projects structured findings onto fixture-relative paths for assertion. */
function relativeFindings(diagnostics: readonly BrokenLinkResult[]) {
  return fixtureRelativeFindings(diagnostics, M9_BROKEN_FIXTURE);
}

describe('M9 in-process structured result', () => {
  it('in-process run exposes ordered broken-link results', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);

    expect(result.exitCode).toBe(1);
    expect(relativeFindings(result.diagnostics)).toEqual(EXPECTED_BROKEN_FINDINGS);
  });

  it('structured result includes file line target and reason', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);

    expect(result.diagnostics).toHaveLength(EXPECTED_BROKEN_FINDINGS.length);
    for (const finding of result.diagnostics) {
      expect(Object.keys(finding).sort()).toEqual(['file', 'line', 'reason', 'target']);
      expect(typeof finding.file).toBe('string');
      expect(Number.isInteger(finding.line)).toBe(true);
      expect(typeof finding.target).toBe('string');
      expect(typeof finding.reason).toBe('string');
    }
  });

  it('structured result preserves the CLI diagnostic order', async () => {
    const text = await captureRun([M9_BROKEN_FIXTURE]);
    const parsed = parseTextFindings(text.stdout);

    expect(parsed.summary).toBe(BROKEN_SUMMARY);
    expect(
      text.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    ).toEqual(parsed.findings);
    expect(relativeFindings(text.diagnostics)).toEqual(EXPECTED_BROKEN_FINDINGS);
  });

  it('structured result includes every reported broken link', async () => {
    const text = await captureRun([M9_BROKEN_FIXTURE]);
    const json = await captureRun(['--json', M9_BROKEN_FIXTURE]);
    const document = JSON.parse(json.stdout) as {
      summary: { broken: number };
      diagnostics: Array<{ file: string; line: number; target: string; reason: string }>;
    };
    const jsonFindings = document.diagnostics.map(({ file, line, target, reason }) => ({
      file: relative(M9_BROKEN_FIXTURE, file),
      line,
      target,
      reason,
    }));

    expect(document.summary.broken).toBe(EXPECTED_BROKEN_FINDINGS.length);
    expect(relativeFindings(text.diagnostics)).toEqual(jsonFindings);
    expect(jsonFindings).toHaveLength(EXPECTED_BROKEN_FINDINGS.length);
  });

  it('structured result is empty for a clean check', async () => {
    const result = await captureRun([M9_CLEAN_FIXTURE]);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toBe(
      'Checked 2 files: 0 broken targets, 1 external link skipped.\n',
    );
  });

  it('structured result is empty for a usage error', async () => {
    const text = await captureRun([]);
    const json = await captureRun(['--json']);

    expect(text.exitCode).toBe(2);
    expect(text.diagnostics).toEqual([]);
    expect(json.exitCode).toBe(2);
    expect(json.diagnostics).toEqual([]);
  });

  it('structured result does not include summary lines', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const textFindings = parseTextFindings(result.stdout).findings;

    expect(result.diagnostics).toHaveLength(textFindings.length);
    expect(result.diagnostics.every((finding) => typeof finding === 'object')).toBe(true);
    expect(result.diagnostics.some((finding) => typeof finding === 'string')).toBe(false);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(textFindings.length + 1);
  });

  it('structured result keeps duplicate source occurrences distinct', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const duplicates = result.diagnostics
      .filter((finding) => finding.target === 'docs/missing.md')
      .map((finding) => finding.line);

    expect(duplicates).toEqual([3, 7, 7, 9]);
  });

  it('structured result covers Markdown and raw HTML findings', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const rawHtmlLines = result.diagnostics
      .filter(
        (finding) =>
          finding.line === 9 &&
          (finding.target === 'docs/missing.md' || finding.target === 'images/missing.png'),
      )
      .map((finding) => finding.target);

    expect(rawHtmlLines).toEqual(['docs/missing.md', 'images/missing.png']);
  });

  it('structured result covers file image and anchor findings', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const targets = result.diagnostics.map((finding) => finding.target);
    const reasons = new Set(result.diagnostics.map((finding) => finding.reason));

    expect(targets).toContain('docs/missing.md');
    expect(targets).toContain('images/missing.png');
    expect(targets).toContain('#missing-anchor');
    expect(targets).toContain('docs/guide.md#deployment');
    expect(reasons).toEqual(new Set(['target does not exist', 'anchor does not exist']));
  });

  it('structured result uses one-based source lines', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);

    expect(result.diagnostics[0]?.line).toBe(3);
    expect(result.diagnostics.every((finding) => finding.line >= 1)).toBe(true);
  });

  it('action consumption cannot mutate CLI result order', async () => {
    const first = await captureRun([M9_BROKEN_FIXTURE]);

    expect(Object.isFrozen(first.diagnostics)).toBe(true);
    expect(first.diagnostics.every((finding) => Object.isFrozen(finding))).toBe(true);
    expect(() => (first.diagnostics as BrokenLinkResult[]).reverse()).toThrow(TypeError);

    const mutable = first.diagnostics[0] as
      | { -readonly [Key in keyof BrokenLinkResult]: BrokenLinkResult[Key] }
      | undefined;
    expect(mutable).toBeDefined();
    expect(() => {
      if (mutable === undefined) {
        throw new Error('missing finding');
      }
      mutable.line = 99;
    }).toThrow(TypeError);

    const second = await captureRun([M9_BROKEN_FIXTURE]);
    expect(relativeFindings(second.diagnostics)).toEqual(EXPECTED_BROKEN_FINDINGS);
  });
});

describe('M9 structured ordering fixtures', () => {
  it('multiple files retain existing result order', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const files = result.diagnostics.map((finding) =>
      relative(M9_BROKEN_FIXTURE, finding.file),
    );

    expect([...new Set(files)]).toEqual(['README.md', join('docs', 'guide.md')]);
  });

  it('multiple diagnostics in one file retain source order', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const lines = result.diagnostics
      .filter((finding) => relative(M9_BROKEN_FIXTURE, finding.file) === 'README.md')
      .map((finding) => finding.line);

    expect(lines).toEqual([3, 4, 4, 5, 7, 7, 9, 9]);
  });

  it('Markdown and raw HTML findings retain existing order', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);
    const markdownIndex = result.diagnostics.findIndex(
      (finding) => finding.line === 3 && finding.target === 'docs/missing.md',
    );
    const rawHtmlIndex = result.diagnostics.findIndex(
      (finding) => finding.line === 9 && finding.target === 'docs/missing.md',
    );

    expect(markdownIndex).toBeGreaterThanOrEqual(0);
    expect(rawHtmlIndex).toBeGreaterThan(markdownIndex);
  });

  it('reference and inline findings retain existing order', async () => {
    const json = await captureRun(['--json', M9_BROKEN_FIXTURE]);
    const document = JSON.parse(json.stdout) as {
      diagnostics: Array<{ line: number; column: number; target: string }>;
    };
    const lineSeven = document.diagnostics.filter((diagnostic) => diagnostic.line === 7);

    // The inline use comes before the reference-style use that follows it.
    expect(lineSeven.map((diagnostic) => diagnostic.target)).toEqual([
      'docs/missing.md',
      'docs/missing.md',
    ]);
    expect(lineSeven.map((diagnostic) => diagnostic.column)).toEqual([1, 47]);

    const structured = await captureRun([M9_BROKEN_FIXTURE]);
    expect(
      structured.diagnostics
        .filter((finding) => finding.line === 7)
        .map((finding) => finding.target),
    ).toEqual(['docs/missing.md', 'docs/missing.md']);
  });

  it('structured text and JSON diagnostics share one order', async () => {
    const text = await captureRun([M9_BROKEN_FIXTURE]);
    const json = await captureRun(['--json', M9_BROKEN_FIXTURE]);
    const document = JSON.parse(json.stdout) as {
      diagnostics: Array<{ file: string; line: number; target: string; reason: string }>;
    };
    const parsed = parseTextFindings(text.stdout);
    const jsonFindings = document.diagnostics.map(({ file, line, target, reason }) => ({
      file: relative(M9_BROKEN_FIXTURE, file),
      line,
      target,
      reason,
    }));

    expect(
      text.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    ).toEqual(parsed.findings);
    expect(relativeFindings(text.diagnostics)).toEqual(jsonFindings);
  });
});

describe('M9 exit and error contract', () => {
  it('clean CLI result remains exit 0', async () => {
    const result = await captureRun([M9_CLEAN_FIXTURE]);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('broken CLI result remains exit 1', async () => {
    const result = await captureRun([M9_BROKEN_FIXTURE]);

    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).not.toEqual([]);
  });

  it('usage error remains exit 2', async () => {
    const result = await captureRun(['--bogus']);

    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual([]);
  });

  it('default skipped external target does not change exit 0', async () => {
    const result = await captureRun([M9_CLEAN_FIXTURE]);

    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
    expect(result.stdout).toContain('1 external link skipped');
  });

  it('enabled broken external target changes exit status through a finding', async () => {
    const root = makeTempRoot();
    const target = 'https://example.com/m9-missing';
    writeFiles(root, { 'README.md': `# External\n\n[missing](${target})\n` });
    const fetch: FetchLike = () => Promise.resolve(new Response(null, { status: 404 }));

    const result = await captureRun(['--external', join(root, 'README.md')], {
      external: { fetch, cachePath: false },
    });

    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toEqual([
      {
        file: join(root, 'README.md'),
        line: 3,
        target,
        reason: 'external HTTP 404',
      },
    ]);
  });
});
