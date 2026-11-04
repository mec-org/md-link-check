/**
 * M15 — default offline action mode.
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
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import { makeTempRoot } from './helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import { runCli } from './action-helpers.js';
import { startFixtureServer } from './server.js';
import type {
  RunInjectionState,
  SummaryOutputValues,
} from './m15-helpers.js';
import {
  SEPARATOR,
  actionAnnotations,
  annotationLineCount,
  captureSourceAction,
  cliSummary,
  createOutputPath,
  injectExternal,
  linksDocument,
  outputNamesIn,
  parseSummaryOutputs,
  portOf,
  recordingFetch,
  requireSummary,
  resetRunInjection,
  runArtifact,
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

describe('M15 default offline action mode', () => {
  it('default action mode performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    // Replace the process-wide fetch with an implementation that throws if it
    // is ever called. The wrapper's default path must not reach it, even when
    // a loopback server and a checked HTTP(S) occurrence are present.
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('the default action path must not call fetch');
    }) as typeof fetch;

    try {
      const action = await captureSourceAction({ INPUT_PATHS: file });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(action.summary).toEqual({ filesChecked: 1, broken: 0, externalSkipped: 1 });
      expect(action.stdout).toBe(cliSummary(1, 0, 1));
      expect(action.stderr).toBe('');
      expect(annotationLineCount(action.stdout)).toBe(0);
      expect(fetchCalls).toBe(0);
      expect(server.requests).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('omitted external input performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const outputPath = createOutputPath(root);
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md' },
        outputPath,
        fetchLog,
      });

      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(existsSync(fetchLog)).toBe(false);
      expect(annotationLineCount(result.stdout)).toBe(0);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 1,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external false performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const recorder = recordingFetch();
    injectExternal(runInjection, { fetch: recorder.fetch });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'false',
      });

      expect(action.exitCode).toBe(0);
      expect(recorder.calls).toEqual([]);
      expect(server.requests).toEqual([]);
      expect(action.summary).toEqual({ filesChecked: 1, broken: 0, externalSkipped: 1 });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('empty external input behaves like the default', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const recorder = recordingFetch();
    injectExternal(runInjection, { fetch: recorder.fetch });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: '',
      });

      expect(action.exitCode).toBe(0);
      expect(recorder.calls).toEqual([]);
      expect(server.requests).toEqual([]);
      expect(action.summary).toEqual({ filesChecked: 1, broken: 0, externalSkipped: 1 });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default mode leaves HTTP and HTTPS targets skipped', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const secureTarget = `https://127.0.0.1:${portOf(server.url)}/secure`;
    const file = writeMarkdown(
      root,
      linksDocument([server.urlFor('/ok'), secureTarget]),
    );

    try {
      const action = await captureSourceAction({ INPUT_PATHS: file });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(action.summary).toEqual({ filesChecked: 1, broken: 0, externalSkipped: 2 });
      expect(action.stdout).toBe(cliSummary(1, 0, 2));
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default skipped external target emits no annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));

    try {
      const action = await captureSourceAction({ INPUT_PATHS: file });

      expect(actionAnnotations(action)).toEqual([]);
      expect(annotationLineCount(action.stdout)).toBe(0);
      expect(action.stdout).not.toContain('::error ');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default skipped external target does not cause exit 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(0);
      expect(requireSummary(action).broken).toBe(0);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(0);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default skipped counts match the existing CLI classification', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const secureTarget = `https://127.0.0.1:${portOf(server.url)}/secure`;
    const file = writeMarkdown(
      root,
      linksDocument([server.urlFor('/ok'), secureTarget]),
    );
    const outputPath = createOutputPath(root);
    const cli = await runCli(['--json', '--', file], {
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cli-cache') },
    });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        GITHUB_OUTPUT: outputPath,
      });
      const document = JSON.parse(cli.stdout) as {
        summary: SummaryOutputValues;
        external: { enabled: boolean; occurrences: number; skipped: number };
      };

      expect(cli.status).toBe(0);
      expect(document.summary).toEqual(requireSummary(action));
      expect(document.external.enabled).toBe(false);
      expect(document.external.occurrences).toBe(2);
      expect(document.external.skipped).toBe(2);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 2,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default outputs match the established skipped-external summary', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(0);
      expect(requireSummary(action)).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 1,
      });
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 1,
      });
      expect(outputNamesIn(readFileSync(outputPath, 'utf8')).sort()).toEqual(
        Object.values(SUMMARY_OUTPUT_NAMES).sort(),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default mode still annotates a broken local target', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', server.urlFor('/ok')]),
    );
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        GITHUB_OUTPUT: outputPath,
      });
      const annotations = actionAnnotations(action).map(parseAnnotation);

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toEqual([
        { file, line: 3, target: 'missing.md', reason: 'target does not exist' },
      ]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]?.file).toBe(file);
      expect(annotations[0]?.line).toBe(3);
      expect(annotations[0]?.message).toBe(
        `missing.md${SEPARATOR}target does not exist`,
      );
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 1,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('local failure plus skipped external target exits 1 because of the local finding', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', server.urlFor('/ok')]),
    );

    try {
      const action = await captureSourceAction({ INPUT_PATHS: file });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toHaveLength(1);
      expect(action.diagnostics[0]?.target).toBe('missing.md');
      expect(
        action.diagnostics.some((finding) => finding.target.startsWith('http')),
      ).toBe(false);
      expect(requireSummary(action).externalSkipped).toBe(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

