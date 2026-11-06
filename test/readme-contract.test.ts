import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_CACHE_CLOCK_SKEW_MS,
  EXTERNAL_CACHE_FRESHNESS_MS,
  EXTERNAL_CACHE_MAX_ENTRIES,
  EXTERNAL_CACHE_MAX_FILE_BYTES,
  EXTERNAL_CACHE_MAX_URL_LENGTH,
  EXTERNAL_CACHE_SCHEMA_VERSION,
} from '../src/cache.js';
import {
  DEFAULT_EXTERNAL_CONCURRENCY,
  DEFAULT_EXTERNAL_MAX_ATTEMPTS,
  DEFAULT_EXTERNAL_MAX_REDIRECTS,
  DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY,
  DEFAULT_EXTERNAL_TIMEOUT_MS,
} from '../src/external.js';
import { runCli, REPO_ROOT } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

function readmeText(): string {
  return readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
}

/** Returns the body of one level-2 README section, without its heading. */
function section(title: string): string {
  const lines = readmeText().split('\n');
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) {
    throw new Error(`README has no "## ${title}" section`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function codeBlocks(markdown: string, language: string): string[] {
  const pattern = new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g');
  return [...markdown.matchAll(pattern)].map((match) => match[1] ?? '');
}

function jsonBlocks(markdown: string): unknown[] {
  return codeBlocks(markdown, 'json').map((block) => JSON.parse(block) as unknown);
}

const REPORT_KEYS = ['diagnostics', 'exitCode', 'external', 'ok', 'summary', 'version'];
const REPORT_KEYS_WITH_ERROR = [...REPORT_KEYS, 'error'].sort();

interface JsonDiagnostic {
  file: string;
  line: number;
  column: number;
  kind: string;
  target: string;
  reason: string;
}

function isJsonReport(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).version === 1 &&
    typeof (value as Record<string, unknown>).summary === 'object' &&
    (value as Record<string, unknown>).summary !== null
  );
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validates one README JSON report against the current version 1 schema and
 * its internal cross-field invariants.
 */
function validateReport(document: Record<string, unknown>): void {
  const keys = Object.keys(document).sort();
  if ('error' in document) {
    expect(keys).toEqual(REPORT_KEYS_WITH_ERROR);
    const error = document.error as Record<string, unknown>;
    expect(['usage', 'internal']).toContain(error.kind);
    expect(typeof error.message).toBe('string');
    expect(document.exitCode).toBe(2);
    expect(document.ok).toBe(false);
  } else {
    expect(keys).toEqual(REPORT_KEYS);
  }

  expect(document.version).toBe(1);
  expect(typeof document.ok).toBe('boolean');
  expect([0, 1, 2]).toContain(document.exitCode);
  expect(document.ok).toBe(document.exitCode === 0);

  const summary = document.summary as Record<string, unknown>;
  expect(Object.keys(summary).sort()).toEqual(['broken', 'externalSkipped', 'filesChecked']);
  expect(integer(summary.filesChecked)).toBe(true);
  expect(integer(summary.broken)).toBe(true);
  expect(integer(summary.externalSkipped)).toBe(true);

  const external = document.external as Record<string, unknown>;
  expect(Object.keys(external).sort()).toEqual([
    'brokenOccurrences',
    'cache',
    'distinctChecked',
    'enabled',
    'failed',
    'occurrences',
    'results',
    'skipped',
    'succeeded',
  ]);
  expect(typeof external.enabled).toBe('boolean');
  for (const key of [
    'occurrences',
    'skipped',
    'distinctChecked',
    'succeeded',
    'failed',
    'brokenOccurrences',
  ]) {
    expect(integer(external[key]), `external.${key}`).toBe(true);
  }
  const cache = external.cache as Record<string, unknown>;
  expect(Object.keys(cache).sort()).toEqual(['enabled', 'hits', 'misses', 'stale']);
  expect(typeof cache.enabled).toBe('boolean');
  expect(integer(cache.hits)).toBe(true);
  expect(integer(cache.misses)).toBe(true);
  expect(integer(cache.stale)).toBe(true);

  const results = external.results as Array<Record<string, unknown>>;
  expect(Array.isArray(results)).toBe(true);
  for (const result of results) {
    expect(['succeeded', 'failed']).toContain(result.status);
    expect(typeof result.target).toBe('string');
    expect(integer(result.attempts)).toBe(true);
    for (const key of Object.keys(result)) {
      expect([
        'attempts',
        'failureKind',
        'finalUrl',
        'httpStatus',
        'redirectCount',
        'source',
        'status',
        'target',
      ]).toContain(key);
    }
  }

  const diagnostics = document.diagnostics as JsonDiagnostic[];
  expect(Array.isArray(diagnostics)).toBe(true);
  expect(summary.broken).toBe(diagnostics.length);
  for (const diagnostic of diagnostics) {
    expect(Object.keys(diagnostic).sort()).toEqual([
      'column',
      'file',
      'kind',
      'line',
      'reason',
      'target',
    ]);
    expect(typeof diagnostic.file).toBe('string');
    expect(integer(diagnostic.line)).toBe(true);
    expect(integer(diagnostic.column)).toBe(true);
    expect(['link', 'image']).toContain(diagnostic.kind);
    expect(typeof diagnostic.target).toBe('string');
    expect(typeof diagnostic.reason).toBe('string');
  }

  if (external.enabled === true) {
    expect(summary.externalSkipped).toBe(0);
    expect(external.skipped).toBe(0);
  } else {
    expect(external.skipped).toBe(summary.externalSkipped);
    expect(external.occurrences).toBe(summary.externalSkipped);
    expect(external.distinctChecked).toBe(0);
    expect(external.succeeded).toBe(0);
    expect(external.failed).toBe(0);
    expect(external.brokenOccurrences).toBe(0);
    expect(external.results).toEqual([]);
  }
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('M8 README contract', () => {
  it('README CLI clean example matches current output', async () => {
    const quickStart = section('Quick start');
    const markdownBlocks = codeBlocks(quickStart, 'markdown');
    const textBlocks = codeBlocks(quickStart, 'text');
    expect(markdownBlocks).toHaveLength(1);
    expect(textBlocks).toHaveLength(2);

    const root = makeTempRoot();
    writeFiles(root, { 'docs/guide.md': markdownBlocks[0] ?? '' });
    const result = await runCli(['docs'], { cwd: root });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(textBlocks[0]);
  });

  it('README CLI broken example matches current output', async () => {
    const quickStart = section('Quick start');
    const markdownBlocks = codeBlocks(quickStart, 'markdown');
    const textBlocks = codeBlocks(quickStart, 'text');

    const root = makeTempRoot();
    writeFiles(root, {
      'docs/guide.md': `${markdownBlocks[0] ?? ''}\n[API](api.md)\n`,
    });
    const result = await runCli(['docs'], { cwd: root });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(textBlocks[1]);
  });

  it('README JSON example parses under the current schema', async () => {
    const blocks = jsonBlocks(readmeText());
    const reportBlocks = blocks.filter(isJsonReport);
    expect(reportBlocks.length).toBeGreaterThanOrEqual(3);
    for (const report of reportBlocks) {
      validateReport(report);
    }

    const cleanReport = reportBlocks.find(
      (report) => report.ok === true && (report.diagnostics as unknown[]).length === 0,
    );
    const brokenReport = reportBlocks.find(
      (report) => report.exitCode === 1 && Array.isArray(report.diagnostics),
    );
    const usageReport = reportBlocks.find(
      (report) => (report.error as Record<string, unknown> | undefined)?.kind === 'usage',
    );
    const externalReport = reportBlocks.find(
      (report) => (report.external as Record<string, unknown>).enabled === true,
    );
    expect(cleanReport).toBeDefined();
    expect(brokenReport).toBeDefined();
    expect(usageReport).toBeDefined();
    expect(externalReport).toBeDefined();

    // The clean example is a real run of the shape the README describes.
    const cleanRoot = makeTempRoot();
    writeFiles(cleanRoot, {
      'README.md':
        '[guide](docs/guide.md)\n\n[one](https://example.com/one) and [two](https://example.com/two)\n',
      'docs/guide.md': '[three](https://example.com/three)\n',
    });
    const cleanRun = await runCli(['--json', '.'], { cwd: cleanRoot });
    expect(cleanRun.status).toBe(0);
    expect(parseJson(cleanRun.stdout)).toEqual(cleanReport);

    // The broken example is reproducible too: line 12, column 5, one missing
    // relative file and three skipped external occurrences.
    const brokenRoot = makeTempRoot();
    writeFiles(brokenRoot, {
      'README.md':
        '# Docs\n\n[guide](docs/guide.md)\n\n[one](https://example.com/one) and [two](https://example.com/two)\n',
      'docs/guide.md': [
        '# Guide',
        '',
        '## Details',
        '',
        'Some text.',
        '',
        'More text.',
        '',
        'Even more.',
        '',
        'Then:',
        'Use [missing](../api/missing.md).',
        'See [more](https://example.com/more).',
        '',
      ].join('\n'),
    });
    const brokenRun = await runCli(['--json', '.'], { cwd: brokenRoot });
    expect(brokenRun.status).toBe(1);
    expect(parseJson(brokenRun.stdout)).toEqual(brokenReport);

    const usageRun = await runCli(['--json'], { cwd: makeTempRoot() });
    expect(usageRun.status).toBe(2);
    expect(parseJson(usageRun.stdout)).toEqual(usageReport);

    // The cache document example keeps its own versioned shape.
    const cacheBlocks = blocks.filter(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        'entries' in (block as Record<string, unknown>),
    );
    expect(cacheBlocks).toHaveLength(1);
    const cacheDocument = cacheBlocks[0] as Record<string, unknown>;
    expect(cacheDocument.version).toBe(EXTERNAL_CACHE_SCHEMA_VERSION);
    expect(typeof cacheDocument.entries).toBe('object');
  });

  it('README action example uses a tagged-ref placeholder', () => {
    const readme = readmeText();
    const actionBlocks = codeBlocks(readme, 'yaml').filter((block) =>
      block.includes('uses: mec-org/md-link-check@'),
    );
    expect(actionBlocks).toHaveLength(1);
    const block = actionBlocks[0] ?? '';

    const usesLines = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(?:- )?uses: mec-org\/md-link-check@/.test(line));
    expect(usesLines.length).toBeGreaterThanOrEqual(1);
    for (const line of usesLines) {
      expect(line).toMatch(/^(?:- )?uses: mec-org\/md-link-check@<[A-Za-z][A-Za-z0-9_-]*>$/);
    }
    expect(readme).toContain('no v0.3 release tag exists yet');
    expect(readme).toContain('`v0.2.0` tag exists');
    expect(readme).toContain('M16 creates no tag or release');
    expect(readme).toContain('`<tag>` is a placeholder');
    expect(readme).not.toContain('no release tag exists yet');
  });

  it('README does not claim npm publication', () => {
    const readme = readmeText();
    expect(readme).toContain('not published to npm');
    expect(readme).toContain('no npm release');
    expect(readme).toMatch(/no supported `npm install` of `md-link-check`/);
    expect(readme).not.toMatch(/\bnpm (?:install|i|add) md-link-check\b/);
    expect(readme).not.toMatch(/\bavailable on npm\b/i);
    expect(readme).not.toMatch(/\bis published to npm\b/i);

    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      private?: boolean;
      dependencies?: Record<string, string>;
    };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('README external example is clearly opt-in', () => {
    const readme = readmeText();
    expect(readme).toContain('## Opt-in external checking');
    expect(readme).toContain('`--external` is the only way the CLI performs network access.');
    expect(readme).toContain('Omitting the flag keeps a run fully offline');

    const actionBlock = codeBlocks(readme, 'yaml').find((block) =>
      block.includes('uses: mec-org/md-link-check@'),
    );
    expect(actionBlock).toContain('external: false');

    const ciSection = section('CI');
    expect(ciSection).toContain('add `--external` only when the job may access the network');
  });

  it('README cache defaults match exported constants', () => {
    const readme = readmeText();

    expect(EXTERNAL_CACHE_FRESHNESS_MS).toBe(24 * 60 * 60 * 1_000);
    expect(readme).toContain('24 hours');
    expect(readme).toContain('schema version `1`');
    expect(readme).toContain('external-v1.json');
    expect(readme).toContain('$XDG_CACHE_HOME/md-link-check/external-v1.json');
    expect(readme).toContain('~/.cache/md-link-check/external-v1.json');
    expect(readme).toContain('LOCALAPPDATA');

    expect(EXTERNAL_CACHE_MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(readme).toContain('5 MiB');
    expect(readme).toContain('8 KiB');
    expect(EXTERNAL_CACHE_MAX_URL_LENGTH).toBe(8 * 1024);
    expect(EXTERNAL_CACHE_MAX_ENTRIES).toBe(10_000);
    expect(readme).toContain('10,000 entries');
    expect(EXTERNAL_CACHE_CLOCK_SKEW_MS).toBe(60_000);
    expect(readme).toContain('60-second clock skew');
    expect(readme).toContain('exactly 24 hours old is still fresh');
    expect(readme).toContain('deleting the cache file clears it');
    expect(readme).toContain('Without `--external` the cache is never read or written');
  });

  it('README external defaults match exported constants', () => {
    const readme = readmeText();

    expect(DEFAULT_EXTERNAL_TIMEOUT_MS).toBe(5_000);
    expect(readme).toContain('timeout: 5 seconds per HTTP request');
    expect(DEFAULT_EXTERNAL_MAX_ATTEMPTS).toBe(2);
    expect(readme).toContain('attempts: 2 total');
    expect(DEFAULT_EXTERNAL_CONCURRENCY).toBe(4);
    expect(readme).toContain('at most 4 requests in flight');
    expect(DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY).toBe(1);
    expect(readme).toContain('at most 1 request in flight per host origin');
    expect(DEFAULT_EXTERNAL_MAX_REDIRECTS).toBe(5);
    expect(readme).toContain('At most 5 redirects are followed per attempt');
    expect(readme).toContain('request method: `GET`');
    expect(readme).toContain('success: final status `200` through `399`');
    expect(readme).toContain('retry delay: none (0 ms');
  });
});
