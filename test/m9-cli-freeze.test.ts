import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonReport } from '../src/report.js';
import { runCli } from './action-helpers.js';
import {
  captureRun,
  fixtureRelativeFindings,
  M9_BROKEN_FINDINGS,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';

/**
 * Frozen human-readable output for the committed fixtures. Paths are relative
 * to the fixture root because the CLI runs with the fixture as its cwd.
 */
const BROKEN_TEXT = [
  'README.md:3: docs/missing.md — target does not exist',
  'README.md:4: images/missing.png — target does not exist',
  'README.md:4: #missing-anchor — anchor does not exist',
  'README.md:5: docs/guide.md#deployment — anchor does not exist',
  'README.md:7: docs/missing.md — target does not exist',
  'README.md:7: docs/missing.md — target does not exist',
  'README.md:9: docs/missing.md — target does not exist',
  'README.md:9: images/missing.png — target does not exist',
  `${join('docs', 'guide.md')}:5: ../README.md#nope — anchor does not exist`,
  'Checked 2 files: 9 broken targets, 1 external link skipped.',
].join('\n');

const CLEAN_TEXT = 'Checked 2 files: 0 broken targets, 1 external link skipped.\n';

const USAGE_TEXT = [
  'md-link-check: no input paths',
  '',
  'Usage: md-link-check [--json] [--external] <path...>',
  'Run "md-link-check --help" for usage and exit codes.',
  '',
].join('\n');

const BROKEN_DIAGNOSTICS = [
  {
    file: 'README.md',
    line: 3,
    column: 25,
    kind: 'link',
    target: 'docs/missing.md',
    reason: 'target does not exist',
  },
  {
    file: 'README.md',
    line: 4,
    column: 1,
    kind: 'image',
    target: 'images/missing.png',
    reason: 'target does not exist',
  },
  {
    file: 'README.md',
    line: 4,
    column: 39,
    kind: 'link',
    target: '#missing-anchor',
    reason: 'anchor does not exist',
  },
  {
    file: 'README.md',
    line: 5,
    column: 1,
    kind: 'link',
    target: 'docs/guide.md#deployment',
    reason: 'anchor does not exist',
  },
  {
    file: 'README.md',
    line: 7,
    column: 1,
    kind: 'link',
    target: 'docs/missing.md',
    reason: 'target does not exist',
  },
  {
    file: 'README.md',
    line: 7,
    column: 47,
    kind: 'link',
    target: 'docs/missing.md',
    reason: 'target does not exist',
  },
  {
    file: 'README.md',
    line: 9,
    column: 1,
    kind: 'link',
    target: 'docs/missing.md',
    reason: 'target does not exist',
  },
  {
    file: 'README.md',
    line: 9,
    column: 44,
    kind: 'image',
    target: 'images/missing.png',
    reason: 'target does not exist',
  },
  {
    file: join('docs', 'guide.md'),
    line: 5,
    column: 23,
    kind: 'link',
    target: '../README.md#nope',
    reason: 'anchor does not exist',
  },
];

const DISABLED_CACHE = { enabled: false, hits: 0, misses: 0, stale: 0 };

const DISABLED_EXTERNAL = {
  enabled: false,
  occurrences: 1,
  skipped: 1,
  distinctChecked: 0,
  succeeded: 0,
  failed: 0,
  brokenOccurrences: 0,
  cache: DISABLED_CACHE,
  results: [],
};

const REPORT_KEYS = ['diagnostics', 'exitCode', 'external', 'ok', 'summary', 'version'];
const REPORT_KEYS_WITH_ERROR = [...REPORT_KEYS, 'error'].sort();
const SUMMARY_KEYS = ['broken', 'externalSkipped', 'filesChecked'];
const DIAGNOSTIC_KEYS = ['column', 'file', 'kind', 'line', 'reason', 'target'];
const EXTERNAL_KEYS = [
  'brokenOccurrences',
  'cache',
  'distinctChecked',
  'enabled',
  'failed',
  'occurrences',
  'results',
  'skipped',
  'succeeded',
];

function parseJson(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

/**
 * A pre-M9 consumer: it knows only the fields that existed before M9 and reads
 * them by name and type. It must keep parsing the post-M9 report unchanged.
 */
interface PreM9Document {
  version: number;
  ok: boolean;
  exitCode: number;
  error?: { kind: string; message: string };
  summary: { filesChecked: number; broken: number; externalSkipped: number };
  external: {
    enabled: boolean;
    occurrences: number;
    skipped: number;
    distinctChecked: number;
    succeeded: number;
    failed: number;
    brokenOccurrences: number;
    cache: { enabled: boolean; hits: number; misses: number; stale: number };
    results: unknown[];
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

function readAsPreM9Consumer(document: JsonReport): PreM9Document {
  return {
    version: document.version,
    ok: document.ok,
    exitCode: document.exitCode,
    ...(document.error === undefined
      ? {}
      : { error: { kind: document.error.kind, message: document.error.message } }),
    summary: {
      filesChecked: document.summary.filesChecked,
      broken: document.summary.broken,
      externalSkipped: document.summary.externalSkipped,
    },
    external: {
      enabled: document.external.enabled,
      occurrences: document.external.occurrences,
      skipped: document.external.skipped,
      distinctChecked: document.external.distinctChecked,
      succeeded: document.external.succeeded,
      failed: document.external.failed,
      brokenOccurrences: document.external.brokenOccurrences,
      cache: {
        enabled: document.external.cache.enabled,
        hits: document.external.cache.hits,
        misses: document.external.cache.misses,
        stale: document.external.cache.stale,
      },
      results: document.external.results,
    },
    diagnostics: document.diagnostics.map(({ file, line, column, kind, target, reason }) => ({
      file,
      line,
      column,
      kind,
      target,
      reason,
    })),
  };
}

function expectFieldTypes(document: JsonReport): void {
  expect(typeof document.version).toBe('number');
  expect(typeof document.ok).toBe('boolean');
  expect(typeof document.exitCode).toBe('number');
  for (const key of SUMMARY_KEYS) {
    expect(typeof document.summary[key as keyof JsonReport['summary']]).toBe('number');
  }
  for (const key of EXTERNAL_KEYS) {
    expect(document.external).toHaveProperty(key);
  }
  expect(typeof document.external.enabled).toBe('boolean');
  for (const key of ['occurrences', 'skipped', 'distinctChecked', 'succeeded', 'failed', 'brokenOccurrences']) {
    expect(typeof document.external[key as keyof JsonReport['external']]).toBe('number');
  }
  expect(typeof document.external.cache.enabled).toBe('boolean');
  for (const key of ['hits', 'misses', 'stale']) {
    expect(typeof document.external.cache[key as keyof typeof document.external.cache]).toBe(
      'number',
    );
  }
  expect(Array.isArray(document.external.results)).toBe(true);
  expect(Array.isArray(document.diagnostics)).toBe(true);
  for (const diagnostic of document.diagnostics) {
    expect(typeof diagnostic.file).toBe('string');
    expect(typeof diagnostic.line).toBe('number');
    expect(typeof diagnostic.column).toBe('number');
    expect(typeof diagnostic.kind).toBe('string');
    expect(typeof diagnostic.target).toBe('string');
    expect(typeof diagnostic.reason).toBe('string');
  }
}

describe('M9 frozen human-readable output', () => {
  it('clean human-readable output is byte-for-byte unchanged', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(CLEAN_TEXT);
  });

  it('broken human-readable output is byte-for-byte unchanged', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${BROKEN_TEXT}\n`);
  });

  it('usage human-readable output is byte-for-byte unchanged', async () => {
    const result = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_TEXT);
  });

  it('diagnostic lines retain file line target em dash reason', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const lines = result.stdout.trimEnd().split('\n').slice(0, -1);

    expect(lines).toHaveLength(BROKEN_DIAGNOSTICS.length);
    for (const line of lines) {
      expect(line).toMatch(/^.+:\d+: .+ — .+$/);
      expect(line).toContain(' — ');
    }
  });

  it('diagnostic ordering is byte-for-byte unchanged', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const lines = result.stdout.trimEnd().split('\n');

    expect(lines.slice(0, -1)).toEqual(BROKEN_TEXT.split('\n').slice(0, -1));
  });

  it('summary lines are byte-for-byte unchanged', async () => {
    const clean = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const broken = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });

    expect(clean.stdout).toBe(CLEAN_TEXT);
    expect(broken.stdout.trimEnd().split('\n').at(-1)).toBe(
      'Checked 2 files: 9 broken targets, 1 external link skipped.',
    );
  });

  it('stdout and stderr routing is unchanged', async () => {
    const clean = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const broken = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const usage = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(clean.stderr).toBe('');
    expect(broken.stderr).toBe('');
    expect(usage.stdout).toBe('');
    expect(usage.stderr).not.toBe('');
  });

  it('final newline behavior is unchanged', async () => {
    const clean = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const broken = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const usage = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    for (const output of [clean.stdout, broken.stdout, usage.stderr]) {
      expect(output.endsWith('\n')).toBe(true);
      expect(output.endsWith('\n\n')).toBe(false);
      expect(output).not.toContain('\r');
    }
  });
});

describe('M9 frozen JSON contract', () => {
  it('clean JSON fields are unchanged', async () => {
    const result = await runCli(['--json', '--', '.'], { cwd: M9_CLEAN_FIXTURE });
    const document = parseJson(result.stdout);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(document).toEqual({
      version: 1,
      ok: true,
      exitCode: 0,
      summary: { filesChecked: 2, broken: 0, externalSkipped: 1 },
      external: DISABLED_EXTERNAL,
      diagnostics: [],
    });
  });

  it('broken JSON fields are unchanged', async () => {
    const result = await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE });
    const document = parseJson(result.stdout);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(document).toEqual({
      version: 1,
      ok: false,
      exitCode: 1,
      summary: { filesChecked: 2, broken: 9, externalSkipped: 1 },
      external: DISABLED_EXTERNAL,
      diagnostics: BROKEN_DIAGNOSTICS,
    });
  });

  it('usage-error JSON fields are unchanged', async () => {
    const result = await runCli(['--json'], { cwd: M9_CLEAN_FIXTURE });
    const document = parseJson(result.stdout);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(document).toEqual({
      version: 1,
      ok: false,
      exitCode: 2,
      error: { kind: 'usage', message: 'no input paths' },
      summary: { filesChecked: 0, broken: 0, externalSkipped: 0 },
      external: { ...DISABLED_EXTERNAL, occurrences: 0, skipped: 0 },
      diagnostics: [],
    });
  });

  it('no existing JSON field is removed', async () => {
    const broken = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    );
    const clean = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_CLEAN_FIXTURE })).stdout,
    );

    for (const document of [broken, clean]) {
      expect(typeof document.version).toBe('number');
      for (const key of REPORT_KEYS) {
        expect(document).toHaveProperty(key);
      }
      for (const key of SUMMARY_KEYS) {
        expect(document.summary).toHaveProperty(key);
      }
      for (const key of EXTERNAL_KEYS) {
        expect(document.external).toHaveProperty(key);
      }
      for (const key of ['enabled', 'hits', 'misses', 'stale']) {
        expect(document.external.cache).toHaveProperty(key);
      }
      for (const diagnostic of document.diagnostics) {
        expect(Object.keys(diagnostic).sort()).toEqual(DIAGNOSTIC_KEYS);
      }
    }
  });

  it('no existing JSON field is renamed', async () => {
    const broken = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    );
    const usage = parseJson((await runCli(['--json'], { cwd: M9_CLEAN_FIXTURE })).stdout);

    expect(Object.keys(broken).sort()).toEqual(REPORT_KEYS);
    expect(Object.keys(usage).sort()).toEqual(REPORT_KEYS_WITH_ERROR);
    expect(Object.keys(broken.summary).sort()).toEqual(SUMMARY_KEYS);
    expect(Object.keys(broken.external).sort()).toEqual(EXTERNAL_KEYS);
    expect(Object.keys(broken.external.cache).sort()).toEqual([
      'enabled',
      'hits',
      'misses',
      'stale',
    ]);
    expect(Object.keys(broken.diagnostics[0] ?? {}).sort()).toEqual(DIAGNOSTIC_KEYS);
  });

  it('existing JSON field types are unchanged', async () => {
    const broken = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    );
    const usage = parseJson((await runCli(['--json'], { cwd: M9_CLEAN_FIXTURE })).stdout);

    expectFieldTypes(broken);
    expectFieldTypes(usage);
  });

  it('JSON diagnostic order is unchanged', async () => {
    const document = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    );

    expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual(
      M9_BROKEN_FINDINGS.map((finding) => finding.target),
    );
  });

  it('JSON diagnostic values match structured results', async () => {
    const document = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    );
    const structured = await captureRun([M9_BROKEN_FIXTURE]);

    expect(
      fixtureRelativeFindings(structured.diagnostics, M9_BROKEN_FIXTURE),
    ).toEqual(
      document.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    );
  });

  it('M9 adds no CLI JSON field', async () => {
    const clean = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_CLEAN_FIXTURE })).stdout,
    );
    const broken = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE })).stdout,
    );
    const usage = parseJson((await runCli(['--json'], { cwd: M9_CLEAN_FIXTURE })).stdout);

    expect(Object.keys(clean).sort()).toEqual(REPORT_KEYS);
    expect(Object.keys(broken).sort()).toEqual(REPORT_KEYS);
    expect(Object.keys(usage).sort()).toEqual(REPORT_KEYS_WITH_ERROR);
  });

  it('pre-M9 JSON consumer parses post-M9 output unchanged', async () => {
    const stdout = (await runCli(['--json', '--', '.'], { cwd: M9_BROKEN_FIXTURE }))
      .stdout;
    const document = parseJson(stdout);
    const legacy = readAsPreM9Consumer(document);

    expect(legacy).toEqual({
      version: 1,
      ok: false,
      exitCode: 1,
      summary: { filesChecked: 2, broken: 9, externalSkipped: 1 },
      external: DISABLED_EXTERNAL,
      diagnostics: BROKEN_DIAGNOSTICS,
    });
  });

  it('existing external JSON fields remain compatible', async () => {
    const document = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_CLEAN_FIXTURE })).stdout,
    );

    expect(document.external).toEqual(DISABLED_EXTERNAL);
    expect(Object.keys(document.external).sort()).toEqual(EXTERNAL_KEYS);
  });

  it('existing cache JSON fields remain compatible', async () => {
    const document = parseJson(
      (await runCli(['--json', '--', '.'], { cwd: M9_CLEAN_FIXTURE })).stdout,
    );

    expect(document.external.cache).toEqual(DISABLED_CACHE);
    expect(Object.keys(document.external.cache).sort()).toEqual([
      'enabled',
      'hits',
      'misses',
      'stale',
    ]);
  });
});

describe('M9 frozen exit-code contract', () => {
  it('clean CLI result remains exit 0', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });

    expect(result.status).toBe(0);
  });

  it('broken CLI result remains exit 1', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_BROKEN_FIXTURE });

    expect(result.status).toBe(1);
  });

  it('usage error remains exit 2', async () => {
    const result = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(result.status).toBe(2);
  });

  it('default skipped external target does not change exit 0', async () => {
    const result = await runCli(['--', '.'], { cwd: M9_CLEAN_FIXTURE });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 external link skipped');
  });
});
