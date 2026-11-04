/**
 * M15 — terminal external failures, redirects and bounded retries.
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
import { existsSync } from 'node:fs';
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
import { formatAnnotations } from '../src/annotation.js';
import { makeTempRoot } from './helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import { startFixtureServer } from './server.js';
import type {
  RunInjectionState,
} from './m15-helpers.js';
import {
  SEPARATOR,
  actionAnnotations,
  annotationLineCount,
  captureSourceAction,
  createOutputPath,
  expectOutputsMatchSummary,
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

describe('M15 terminal external failures', () => {
  it('terminal external HTTP failure exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(action.stderr).toBe('');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('terminal external HTTP failure emits one annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const annotations = actionAnnotations(action).map(parseAnnotation);

      expect(action.diagnostics).toEqual([
        { file, line: 3, target, reason: 'external HTTP 404' },
      ]);
      expect(annotations).toHaveLength(1);
      expect(annotationLineCount(action.stdout)).toBe(1);
      expect(annotations[0]?.file).toBe(file);
      expect(annotations[0]?.line).toBe(3);
      expect(annotations[0]?.message).toBe(`${target}${SEPARATOR}external HTTP 404`);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('terminal external failure publishes established counts', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(requireSummary(action)).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
      expectOutputsMatchSummary(outputPath, action);
      expect(action.stdout).toContain(
        externalSummary({
          occurrences: 1,
          distinctChecked: 1,
          succeeded: 0,
          failed: 1,
          brokenOccurrences: 1,
        }),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('permanent external failure is not retried', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
      expect(action.diagnostics[0]?.reason).toBe('external HTTP 404');
      expect(action.stdout).not.toContain('after 2 attempts');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('retryable external failure stops at the established attempt ceiling', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/always-flaky');
    const file = writeMarkdown(root, linksDocument([target]));
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(1);
      expect(server.requests.map((request) => request.path)).toEqual([
        '/always-flaky',
        '/always-flaky',
      ]);
      expect(action.diagnostics).toEqual([
        {
          file,
          line: 3,
          target,
          reason: 'external HTTP 500 after 2 attempts',
        },
      ]);
      expect(actionAnnotations(action)).toHaveLength(1);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('redirect terminal failure receives the final established classification', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/redirect-to-not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(server.requests.map((request) => request.path)).toEqual([
        '/redirect-to-not-found',
        '/not-found',
      ]);
      expect(action.diagnostics).toEqual([
        { file, line: 3, target, reason: 'external HTTP 404' },
      ]);
      expect(actionAnnotations(action)).toHaveLength(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('redirect loops remain bounded', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/redirect-loop');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(server.requests).toHaveLength(6);
      expect(action.diagnostics).toEqual([
        {
          file,
          line: 3,
          target,
          reason: 'external redirect limit exceeded after 5 redirects',
        },
      ]);
      expect(actionAnnotations(action)).toHaveLength(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('exhausted timeout exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/slow');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, { timeoutMs: 50 });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(server.requests.filter((request) => request.path === '/slow')).toHaveLength(
        2,
      );
      expect(action.diagnostics).toEqual([
        {
          file,
          line: 3,
          target,
          reason: 'external request timed out after 2 attempts',
        },
      ]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('exhausted timeout emits one annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/slow');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, { timeoutMs: 50 });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const annotations = actionAnnotations(action).map(parseAnnotation);

      expect(annotations).toHaveLength(1);
      expect(annotationLineCount(action.stdout)).toBe(1);
      expect(annotations[0]?.message).toBe(
        `${target}${SEPARATOR}external request timed out after 2 attempts`,
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('network failure follows the existing bounded classification', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/drop');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(server.requests.filter((request) => request.path === '/drop')).toHaveLength(
        2,
      );
      expect(action.diagnostics[0]?.reason).toBe(
        'external network failure after 2 attempts',
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('expected external failures emit no stack trace', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(
      root,
      linksDocument([
        server.urlFor('/not-found'),
        server.urlFor('/drop'),
        server.urlFor('/always-flaky'),
      ]),
    );
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toHaveLength(3);
      expect(action.stderr).toBe('');
      expect(action.stdout).not.toMatch(/\n\s+at /);
      expect(action.stdout).not.toContain('Error:');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external failure is not reinterpreted as usage error', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(1);
      expect(action.stderr).toBe('');
      expect(action.stdout).not.toContain('Usage: md-link-check');
      expect(existsSync(outputPath)).toBe(true);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external failure annotation contains source file and line', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const [annotation] = actionAnnotations(action).map(parseAnnotation);

      expect(annotation?.file).toBe(file);
      expect(annotation?.line).toBe(3);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external failure annotation contains target and reason', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const [annotation] = actionAnnotations(action).map(parseAnnotation);

      expect(annotation?.message).toContain(target);
      expect(annotation?.message).toContain('external HTTP 404');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external annotations use the existing safe formatter', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(actionAnnotations(action)).toEqual(formatAnnotations(action.diagnostics));
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external annotation order follows structured result order', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const targets = [
      server.urlFor('/not-found'),
      server.urlFor('/always-flaky'),
      server.urlFor('/drop'),
    ];
    const file = writeMarkdown(root, linksDocument(targets));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const annotations = actionAnnotations(action).map(parseAnnotation);

      expect(action.diagnostics.map((finding) => finding.target)).toEqual(targets);
      expect(annotations.map((annotation) => annotation.message)).toEqual(
        action.diagnostics.map(
          (finding) => `${finding.target}${SEPARATOR}${finding.reason}`,
        ),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('intermediate retry failures do not produce annotations', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/flaky')]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(actionAnnotations(action)).toEqual([]);
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external annotations remain separate physical lines', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(
      root,
      linksDocument([server.urlFor('/not-found'), server.urlFor('/drop')]),
    );
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      const annotationLines = action.stdout
        .split('\n')
        .filter((line) => line.startsWith('::error '));

      expect(annotationLines).toHaveLength(2);
      for (const line of annotationLines) {
        expect(() => parseAnnotation(line)).not.toThrow();
      }
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

