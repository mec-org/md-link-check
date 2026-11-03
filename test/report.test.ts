import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckResult, ExternalSummary } from '../src/checker.js';
import type { FetchLike } from '../src/external.js';
import {
  formatDiagnostic,
  formatJson,
  formatSummary,
  type JsonReport,
} from '../src/report.js';
import { run, type CliIo, type RunOptions } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';

interface CapturedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function captureRun(args: readonly string[], options: RunOptions = {}): Promise<CapturedRun> {
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
  // Every invocation gets its own temporary cache so no test reads or writes a
  // developer's real cache and calls within one test stay independent.
  const external =
    options.external === undefined
      ? undefined
      : { cachePath: join(makeTempRoot(), 'external-v1.json'), ...options.external };
  const { exitCode } = await run(
    args,
    io,
    external === undefined ? options : { ...options, external },
  );
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

/** A fetch stub that serves one 200 response per request. */
const okFetch: FetchLike = () => Promise.resolve(new Response(null, { status: 200 }));

/** A fetch stub that serves one 404 response per request. */
const missingFetch: FetchLike = () => Promise.resolve(new Response(null, { status: 404 }));

/** Builds a complete CheckResult for reporter unit tests. */
function makeResult(external: Partial<ExternalSummary> = {}): CheckResult {
  const summary: ExternalSummary = {
    enabled: false,
    occurrences: 0,
    skipped: 0,
    distinctChecked: 0,
    succeeded: 0,
    failed: 0,
    brokenOccurrences: 0,
    cache: { enabled: false, hits: 0, misses: 0, stale: 0 },
    results: [],
    ...external,
  };
  return {
    diagnostics:
      summary.brokenOccurrences > 0
        ? [
            {
              file: 'README.md',
              line: 2,
              column: 1,
              kind: 'link',
              target: 'https://example.com/missing',
              reason: 'external HTTP 404',
            },
          ]
        : [],
    filesChecked: 1,
    broken: summary.brokenOccurrences > 0 ? 1 : 0,
    externalSkipped: summary.skipped,
    external: summary,
  };
}

interface LegacyJsonDocument {
  version: number;
  ok: boolean;
  exitCode: number;
  error?: { kind: string; message: string };
  summary: { filesChecked: number; broken: number; externalSkipped: number };
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    kind: string;
    target: string;
    reason: string;
  }>;
}

/**
 * Reads only fields that predate M5. This is the compatibility test helper:
 * a pre-M5 consumer must observe exactly the same shape and values.
 */
function readLegacyFields(document: JsonReport): LegacyJsonDocument {
  return {
    version: document.version,
    ok: document.ok,
    exitCode: document.exitCode,
    ...(document.error === undefined ? {} : { error: document.error }),
    summary: {
      filesChecked: document.summary.filesChecked,
      broken: document.summary.broken,
      externalSkipped: document.summary.externalSkipped,
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

describe('text reporting', () => {
  it('existing local diagnostic formatting remains unchanged', () => {
    expect(
      formatDiagnostic({
        file: 'docs/guide.md',
        line: 12,
        column: 5,
        kind: 'link',
        target: '../api/missing.md',
        reason: 'target does not exist',
      }),
    ).toBe('docs/guide.md:12: ../api/missing.md — target does not exist');
  });

  it('external diagnostics retain file line target em dash reason', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': ['# Project', '', '[web](https://example.com/missing)'].join('\n'),
    });

    const result = await captureRun(['--external', join(root, 'README.md')], { external: { fetch: missingFetch } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.split('\n')[0]).toBe(
      `${join(root, 'README.md')}:3: https://example.com/missing — external HTTP 404`,
    );
  });

  it('text summary distinguishes skipped and checked externals', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/ok)' });

    const offline = await captureRun([join(root, 'README.md')]);
    expect(offline.stdout).toBe(
      'Checked 1 file: 0 broken targets, 1 external link skipped.\n',
    );

    const online = await captureRun(['--external', join(root, 'README.md')], {
      external: { fetch: okFetch },
    });
    expect(online.stdout).toBe(
      [
        'Checked 1 file: 0 broken targets, 0 external links skipped.',
        'External checks: 1 occurrence, 1 distinct target checked (1 succeeded, 0 failed), 0 broken occurrences.',
        '',
      ].join('\n'),
    );
  });

  it('text summary reports successful and failed distinct checks', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[one](https://example.com/ok)',
        '[two](https://example.com/ok)',
        '[three](https://example.com/missing)',
      ].join('\n'),
    });
    const fetch: FetchLike = (input) =>
      Promise.resolve(
        new Response(null, { status: String(input).endsWith('/missing') ? 404 : 200 }),
      );

    const result = await captureRun(['--external', join(root, 'README.md')], { external: { fetch } });
    expect(result.stdout).toContain(
      'External checks: 3 occurrences, 2 distinct targets checked (1 succeeded, 1 failed), 1 broken occurrence.',
    );
  });

  it('text output remains deterministic with concurrent requests', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[first](https://first.example/first)',
        '[second](https://second.example/second)',
      ].join('\n'),
    });
    const pending: Array<{ resolve(): void }> = [];
    const fetch: FetchLike = () =>
      new Promise<Response>((resolve) => {
        pending.push({
          resolve: () => resolve(new Response(null, { status: 404 })),
        });
      });

    const running = captureRun(['--external', join(root, 'README.md')], {
      external: { fetch },
    });
    while (pending.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Finish the second request before the first; document order must win.
    pending[1]?.resolve();
    pending[0]?.resolve();
    const result = await running;

    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe(
      `${join(root, 'README.md')}:1: https://first.example/first — external HTTP 404`,
    );
    expect(lines[1]).toBe(
      `${join(root, 'README.md')}:2: https://second.example/second — external HTTP 404`,
    );
  });

  it('disabled summary keeps the pre-M5 wording', () => {
    const result = makeResult({ enabled: false, occurrences: 2, skipped: 2 });
    expect(formatSummary(result)).toBe(
      'Checked 1 file: 0 broken targets, 2 external links skipped.\n',
    );
  });
});

describe('additive JSON contract', () => {
  it('external JSON additions do not remove existing fields', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[local](missing.md) and [web](https://example.com/ok)',
    });

    const result = await captureRun(['--json', '--external', join(root, 'README.md')], {
      external: { fetch: okFetch },
    });
    const document = parseJson(result.stdout);

    expect(document.version).toBe(1);
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(1);
    expect(Object.keys(document.summary).sort()).toEqual([
      'broken',
      'externalSkipped',
      'filesChecked',
    ]);
    expect(document.diagnostics).toHaveLength(1);
    expect(document.external.enabled).toBe(true);
  });

  it('existing JSON field names and types remain unchanged', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[web](https://example.com/ok)',
    });

    const result = await captureRun(['--json', join(root, 'README.md')]);
    const document = parseJson(result.stdout);
    expect(typeof document.version).toBe('number');
    expect(typeof document.ok).toBe('boolean');
    expect(typeof document.exitCode).toBe('number');
    expect(typeof document.summary.filesChecked).toBe('number');
    expect(typeof document.summary.broken).toBe('number');
    expect(typeof document.summary.externalSkipped).toBe('number');
    expect(Array.isArray(document.diagnostics)).toBe(true);
  });

  it('JSON identifies whether external checking was enabled', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/ok)' });

    const offline = parseJson((await captureRun(['--json', join(root, 'README.md')])).stdout);
    expect(offline.external.enabled).toBe(false);

    const online = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], { external: { fetch: okFetch } }))
        .stdout,
    );
    expect(online.external.enabled).toBe(true);
  });

  it('JSON reports external occurrence and distinct-target counts', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[one](https://example.com/ok)',
        '[two](https://example.com/ok)',
        '[three](https://example.com/ok)',
      ].join('\n'),
    });

    const document = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], { external: { fetch: okFetch } }))
        .stdout,
    );
    expect(document.external).toMatchObject({
      enabled: true,
      occurrences: 3,
      skipped: 0,
      distinctChecked: 1,
      succeeded: 1,
      failed: 0,
      brokenOccurrences: 0,
    });
    expect(document.external.results).toHaveLength(1);
  });

  it('JSON distinguishes successful and failed external results', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[ok](https://example.com/ok) and [bad](https://example.com/bad)',
    });
    const fetch: FetchLike = (input) =>
      Promise.resolve(new Response(null, { status: String(input).endsWith('/bad') ? 404 : 200 }));

    const document = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], { external: { fetch } })).stdout,
    );
    expect(document.external.succeeded).toBe(1);
    expect(document.external.failed).toBe(1);
    expect(document.external.results.map((target) => target.status)).toEqual([
      'succeeded',
      'failed',
    ]);
  });

  it('JSON identifies HTTP timeout and network outcomes', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[slow](https://example.com/slow) and [down](https://example.com/down)',
    });
    const timeoutFetch: FetchLike = (input, init) => {
      if (String(input).endsWith('/down')) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    };

    const document = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], {
        external: { fetch: timeoutFetch, timeoutMs: 10 },
      })).stdout,
    );
    const byStatus = Object.fromEntries(
      document.external.results.map((target) => [target.target, target]),
    );
    expect(byStatus['https://example.com/slow']?.failureKind).toBe('timeout');
    expect(byStatus['https://example.com/down']?.failureKind).toBe('network');
    expect(byStatus['https://example.com/slow']?.httpStatus).toBeUndefined();
    expect(byStatus['https://example.com/down']?.httpStatus).toBeUndefined();
  });

  it('JSON includes attempts and HTTP status when available', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/flaky)' });
    let calls = 0;
    const fetch: FetchLike = () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: calls === 1 ? 503 : 200 }));
    };

    const document = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], { external: { fetch } })).stdout,
    );
    expect(document.external.results[0]).toMatchObject({
      target: 'https://example.com/flaky',
      status: 'succeeded',
      attempts: 2,
      httpStatus: 200,
    });
  });

  it('JSON results are ordered by first occurrence', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[first](https://first.example/first)',
        '[second](https://second.example/second)',
      ].join('\n'),
    });
    const pending: Array<{ input: string; resolve(): void }> = [];
    const fetch: FetchLike = (input) =>
      new Promise<Response>((resolve) => {
        pending.push({
          input: String(input),
          resolve: () => resolve(new Response(null, { status: 200 })),
        });
      });

    const running = captureRun(['--json', '--external', join(root, 'README.md')], { external: { fetch } });
    while (pending.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    pending[1]?.resolve();
    pending[0]?.resolve();
    const document = parseJson((await running).stdout);

    expect(document.external.results.map((target) => target.target)).toEqual([
      'https://first.example/first',
      'https://second.example/second',
    ]);
  });

  it('JSON diagnostics include failed source occurrences', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '[one](https://example.com/missing)',
        '[two](https://EXAMPLE.com/missing)',
      ].join('\n'),
    });

    const document = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], {
        external: { fetch: missingFetch },
      })).stdout,
    );
    expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'https://example.com/missing',
      'https://EXAMPLE.com/missing',
    ]);
    expect(document.external.brokenOccurrences).toBe(2);
    expect(document.external.results).toHaveLength(1);
  });

  it('JSON clean external result exits 0', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/ok)' });

    const result = await captureRun(['--json', '--external', join(root, 'README.md')], {
      external: { fetch: okFetch },
    });
    const document = parseJson(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(document.ok).toBe(true);
    expect(document.exitCode).toBe(0);
  });

  it('JSON broken external result exits 1', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/missing)' });

    const result = await captureRun(['--json', '--external', join(root, 'README.md')], {
      external: { fetch: missingFetch },
    });
    const document = parseJson(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(1);
  });

  it('JSON usage error remains valid and exits 2', async () => {
    const result = await captureRun(['--json', '--external']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    const document = parseJson(result.stdout);
    expect(document.exitCode).toBe(2);
    expect(document.error).toEqual({ kind: 'usage', message: 'no input paths' });
    expect(document.diagnostics).toEqual([]);
    expect(document.external.distinctChecked).toBe(0);
    expect(document.external.results).toEqual([]);
  });

  it('JSON stdout contains exactly one document', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/ok)' });

    const result = await captureRun(['--json', '--external', join(root, 'README.md')], {
      external: { fetch: okFetch },
    });
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);
    expect(result.stdout).not.toContain('Checked ');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('existing consumers can ignore external fields', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[local](missing.md) and [web](https://example.com/ok)',
    });

    const offline = parseJson((await captureRun(['--json', join(root, 'README.md')])).stdout);
    expect(readLegacyFields(offline)).toEqual({
      version: 1,
      ok: false,
      exitCode: 1,
      summary: { filesChecked: 1, broken: 1, externalSkipped: 1 },
      diagnostics: [
        {
          file: join(root, 'README.md'),
          line: 1,
          column: 1,
          kind: 'link',
          target: 'missing.md',
          reason: 'target does not exist',
        },
      ],
    });

    const online = parseJson(
      (await captureRun(['--json', '--external', join(root, 'README.md')], {
        external: { fetch: okFetch },
      })).stdout,
    );
    const legacy = readLegacyFields(online);
    expect(legacy.version).toBe(1);
    expect(legacy.summary).toEqual({ filesChecked: 1, broken: 1, externalSkipped: 0 });
    expect(legacy.diagnostics).toHaveLength(1);
  });
});

describe('JSON serialization of external results', () => {
  it('omits unavailable HTTP status and final URL fields', () => {
    const result = makeResult({
      enabled: true,
      occurrences: 1,
      distinctChecked: 1,
      failed: 1,
      brokenOccurrences: 1,
      results: [
        {
          target: 'https://example.com/network',
          status: 'failed',
          attempts: 2,
          failureKind: 'network',
        },
      ],
    });

    const document = JSON.parse(formatJson(result, 1)) as JsonReport;
    expect(document.external.results[0]).toEqual({
      target: 'https://example.com/network',
      status: 'failed',
      attempts: 2,
      failureKind: 'network',
    });
  });

  it('serializes a successful result with attempts and HTTP status', () => {
    const result = makeResult({
      enabled: true,
      occurrences: 2,
      distinctChecked: 1,
      succeeded: 1,
      results: [
        {
          target: 'https://example.com/ok',
          status: 'succeeded',
          attempts: 1,
          httpStatus: 200,
          finalUrl: 'https://example.com/ok',
        },
      ],
    });

    const document = JSON.parse(formatJson(result, 0)) as JsonReport;
    expect(document.external.results[0]).toEqual({
      target: 'https://example.com/ok',
      status: 'succeeded',
      attempts: 1,
      httpStatus: 200,
      finalUrl: 'https://example.com/ok',
    });
  });
});
