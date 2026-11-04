/**
 * M15 — duplicate occurrences, ordering and cache interaction.
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { CliIo, RunOptions, RunResult } from '../src/run.js';
import { EXTERNAL_CACHE_SCHEMA_VERSION } from '../src/cache.js';
import { cachePathIn } from './external-helpers.js';
import { formatAnnotations } from '../src/annotation.js';
import { makeTempRoot } from './helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import { startFixtureServer } from './server.js';
import { waitFor } from './external-helpers.js';
import { writeCacheFile } from './external-helpers.js';
import { writeFiles } from './helpers.js';
import type {
  RunInjectionState,
} from './m15-helpers.js';
import {
  SEPARATOR,
  actionAnnotations,
  captureSourceAction,
  createOutputPath,
  externalSummary,
  injectExternal,
  linksDocument,
  parseSummaryOutputs,
  requireSummary,
  resetRunInjection,
  writeMarkdown,
} from './m15-helpers.js';

const runInjection = vi.hoisted(
  (): RunInjectionState => ({ external: undefined }),
);

vi.mock('../src/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run.js')>();
  return {
    ...actual,
    run: (
      args: readonly string[],
      io: CliIo,
      options: RunOptions = {},
    ): Promise<RunResult> => {
      const injected = runInjection.external;
      if (injected === undefined) {
        return actual.run(args, io, options);
      }
      return actual.run(args, io, {
        ...options,
        external: { ...options.external, ...injected },
      });
    },
  };
});

beforeEach(() => {
  resetRunInjection(runInjection);
});

afterEach(() => {
  resetRunInjection(runInjection);
});

describe('M15 duplicate occurrence and completion-order behavior', () => {
  it('duplicate failed occurrences produce one annotation per occurrence', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, {
      'README.md': `# Consumer\n\n[first](${target})\n[second](${target})\n`,
      'docs/other.md': `# Other\n\n[third](${target})\n`,
    });
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: root,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });
      const annotations = actionAnnotations(action).map(parseAnnotation);

      expect(action.exitCode).toBe(1);
      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
      expect(action.diagnostics).toHaveLength(3);
      expect(
        action.diagnostics.map((finding) => [finding.file, finding.line]),
      ).toEqual([
        [join(root, 'README.md'), 3],
        [join(root, 'README.md'), 4],
        [join(root, 'docs', 'other.md'), 3],
      ]);
      expect(annotations).toHaveLength(3);
      expect(annotations.map((annotation) => annotation.message)).toEqual([
        `${target}${SEPARATOR}external HTTP 404`,
        `${target}${SEPARATOR}external HTTP 404`,
        `${target}${SEPARATOR}external HTTP 404`,
      ]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(3);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('distinct and occurrence output counts remain distinguishable', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, {
      'README.md': `# Consumer\n\n[first](${target})\n[second](${target})\n`,
      'docs/other.md': `# Other\n\n[third](${target})\n`,
    });
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: root,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      // Three source occurrences, one distinct target, three broken occurrences.
      expect(action.stdout).toContain(
        externalSummary({
          occurrences: 3,
          distinctChecked: 1,
          succeeded: 0,
          failed: 1,
          brokenOccurrences: 3,
        }),
      );
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 2,
        broken: 3,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('request completion order does not change annotation order', async () => {
    const gated = await startFixtureServer();
    const instant = await startFixtureServer();
    const root = makeTempRoot();
    const firstTarget = gated.urlFor('/gate-not-found');
    const secondTarget = instant.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([firstTarget, secondTarget]));
    injectExternal(runInjection, );

    try {
      const runPromise = captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      // The second target's permanent failure is delivered while the first
      // target is still held, so completion order is the reverse of source order.
      await gated.waitForGated(1);
      await waitFor(() => instant.requests.length === 1);
      gated.releaseGated();
      const action = await runPromise;

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics.map((finding) => finding.target)).toEqual([
        firstTarget,
        secondTarget,
      ]);
      expect(
        actionAnnotations(action).map((annotation) => parseAnnotation(annotation).message),
      ).toEqual([
        `${firstTarget}${SEPARATOR}external HTTP 404`,
        `${secondTarget}${SEPARATOR}external HTTP 404`,
      ]);
    } finally {
      await gated.close();
      await instant.close();
      expect(gated.closed).toBe(true);
      expect(instant.closed).toBe(true);
    }
  });

  it('mixed local and external findings preserve result order', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const externalFailure = server.urlFor('/not-found');
    const externalSuccess = server.urlFor('/ok');
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', externalFailure, externalSuccess]),
    );
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.diagnostics.map((finding) => finding.target)).toEqual([
        'missing.md',
        externalFailure,
      ]);
      expect(actionAnnotations(action).map((annotation) => parseAnnotation(annotation).message)).toEqual([
        `missing.md${SEPARATOR}target does not exist`,
        `${externalFailure}${SEPARATOR}external HTTP 404`,
      ]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

describe('M15 cache interaction', () => {
  it('fresh cache hit avoids a loopback request', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const cachePath = cachePathIn(root);
    runInjection.external = { cachePath };

    try {
      const first = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const requestsAfterFirst = server.requests.length;
      const second = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(requestsAfterFirst).toBe(1);
      expect(server.requests).toHaveLength(requestsAfterFirst);
      expect(second.diagnostics).toEqual([]);
      expect(requireSummary(second)).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 0,
      });
      expect(existsSync(cachePath)).toBe(true);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('stale cache entry refreshes against loopback', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/ok');
    const file = writeMarkdown(root, linksDocument([target]));
    const cachePath = cachePathIn(root);
    runInjection.external = { cachePath };
    const staleCheckedAt = '2000-01-01T00:00:00.000Z';
    writeCacheFile(cachePath, {
      [target]: {
        checkedAt: staleCheckedAt,
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const document = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        entries: Record<string, { checkedAt: string; outcome: string }>;
      };
      const refreshed = document.entries[target];

      expect(action.exitCode).toBe(0);
      expect(server.requests.map((request) => request.path)).toEqual(['/ok']);
      expect(refreshed?.outcome).toBe('succeeded');
      expect(Date.parse(refreshed?.checkedAt ?? '')).toBeGreaterThan(
        Date.parse(staleCheckedAt),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('cache hit preserves the existing result classification', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    const cachePath = cachePathIn(root);
    const outputPath = createOutputPath(root);
    runInjection.external = { cachePath };

    try {
      const first = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });
      const requestsAfterFirst = server.requests.length;
      const second = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(first.diagnostics).toEqual([
        { file, line: 3, target, reason: 'external HTTP 404' },
      ]);
      expect(second.exitCode).toBe(1);
      expect(server.requests).toHaveLength(requestsAfterFirst);
      expect(second.diagnostics).toEqual([
        { file, line: 3, target, reason: 'external HTTP 404' },
      ]);
      expect(actionAnnotations(second)).toEqual(formatAnnotations(second.diagnostics));
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('malformed cache recovery remains bounded', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const cachePath = cachePathIn(root);
    writeFiles(root, { 'cache/external-v1.json': '{not a cache document' });
    runInjection.external = { cachePath };

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const document = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        version: number;
        entries: Record<string, unknown>;
      };

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(server.requests.map((request) => request.path)).toEqual(['/ok']);
      expect(document.version).toBe(EXTERNAL_CACHE_SCHEMA_VERSION);
      expect(Object.keys(document.entries)).toHaveLength(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('cache tests use temporary isolated paths', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const cachePath = cachePathIn(root);
    runInjection.external = { cachePath };

    try {
      await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(cachePath.startsWith(root)).toBe(true);
      expect(existsSync(cachePath)).toBe(true);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('cache state does not leak between action tests', async () => {
    const server = await startFixtureServer();
    const rootA = makeTempRoot();
    const rootB = makeTempRoot();
    const file = writeMarkdown(rootA, linksDocument([server.urlFor('/ok')]));
    const cacheA = cachePathIn(rootA);
    const cacheB = cachePathIn(rootB);

    try {
      runInjection.external = { cachePath: cacheA };
      await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      runInjection.external = { cachePath: cacheB };
      const second = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      // The second isolated cache starts empty, so the target is checked live.
      expect(server.requests).toHaveLength(2);
      expect(second.exitCode).toBe(0);
      expect(existsSync(cacheA)).toBe(true);
      expect(existsSync(cacheB)).toBe(true);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

