/**
 * M15 — loopback enforcement and external-enabled success.
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
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
import { makeTempRoot } from './helpers.js';
import { runCli } from './action-helpers.js';
import { startFixtureServer } from './server.js';
import { writeFiles } from './helpers.js';
import type {
  RunInjectionState,
} from './m15-helpers.js';
import {
  actionAnnotations,
  actionCliText,
  annotationLineCount,
  captureSourceAction,
  cliSummary,
  createOutputPath,
  expectOutputsMatchSummary,
  externalSummary,
  injectExternal,
  linksDocument,
  parseSummaryOutputs,
  portOf,
  recordingFetch,
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

describe('M15 loopback-only enforcement', () => {
  it('external tests bind only to loopback', async () => {
    const server = await startFixtureServer();
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external tests use ephemeral ports', async () => {
    const first = await startFixtureServer();
    const second = await startFixtureServer();
    try {
      const firstPort = Number(portOf(first.url));
      const secondPort = Number(portOf(second.url));
      expect(firstPort).toBeGreaterThan(0);
      expect(secondPort).toBeGreaterThan(0);
      expect(firstPort).not.toBe(secondPort);
    } finally {
      await first.close();
      await second.close();
      expect(first.closed).toBe(true);
      expect(second.closed).toBe(true);
    }
  });

  it('external tests perform no public DNS lookup', () => {
    // The suite guard rejects the non-loopback name synchronously, before the
    // built-in fetch can resolve it.
    expect(() => {
      void globalThis.fetch('http://not-a-loopback-host.invalid/page');
    }).toThrow(/test fetch guard: refused non-loopback request/);
  });

  it('network guard rejects a non-loopback target', () => {
    // TEST-NET-2 address literal: rejected by the guard with no DNS or socket.
    expect(() => {
      void globalThis.fetch('http://198.51.100.7/page');
    }).toThrow(/test fetch guard: refused non-loopback request/);
  });

  it('source action external tests contact only loopback', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    const recorder = recordingFetch();
    injectExternal(runInjection, { fetch: recorder.fetch });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(recorder.calls.length).toBeGreaterThan(0);
      for (const call of recorder.calls) {
        expect(new URL(call).hostname).toBe('127.0.0.1');
      }
      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('every local test server closes cleanly', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      expect(action.exitCode).toBe(0);
    } finally {
      await server.close();
    }
    expect(server.closed).toBe(true);
  });

  it('every local test socket closes cleanly', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/slow')]));
    injectExternal(runInjection, { timeoutMs: 25 });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });
      expect(action.exitCode).toBe(1);
    } finally {
      await server.close();
    }
    expect(server.closed).toBe(true);
  });
});

describe('M15 external-enabled success', () => {
  it('external true checks a loopback successful target', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const recorder = recordingFetch();
    injectExternal(runInjection, { fetch: recorder.fetch });
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(recorder.calls).toHaveLength(1);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
      expect(action.stdout).toBe(
        cliSummary(1, 0, 0) +
          externalSummary({
            occurrences: 1,
            distinctChecked: 1,
            succeeded: 1,
            failed: 0,
            brokenOccurrences: 0,
          }),
      );
      expectOutputsMatchSummary(outputPath, action);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('successful external check exits 0 when local targets are clean', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': linksDocument([server.urlFor('/ok')]),
      'docs/guide.md': '# Guide\n\n[top](#guide)\n',
    });
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: root,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(requireSummary(action)).toEqual({
        filesChecked: 2,
        broken: 0,
        externalSkipped: 0,
      });
      expect(server.requests.map((request) => request.path)).toEqual(['/ok']);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('successful external check emits no annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(actionAnnotations(action)).toEqual([]);
      expect(annotationLineCount(action.stdout)).toBe(0);
      expect(action.stdout).not.toContain('::error ');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('successful external check publishes established counts', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
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
        broken: 0,
        externalSkipped: 0,
      });
      expectOutputsMatchSummary(outputPath, action);
      expect(action.stdout).toContain(
        externalSummary({
          occurrences: 1,
          distinctChecked: 1,
          succeeded: 1,
          failed: 0,
          brokenOccurrences: 0,
        }),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('successful redirect follows existing policy', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/redirect')]));
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(server.requests.map((request) => request.path)).toEqual([
        '/redirect',
        '/ok',
      ]);
      expect(action.stdout).toContain(
        externalSummary({
          occurrences: 1,
          distinctChecked: 1,
          succeeded: 1,
          failed: 0,
          brokenOccurrences: 0,
        }),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('retryable failure followed by success remains clean', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/flaky')]));
    injectExternal(runInjection, );
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(actionAnnotations(action)).toEqual([]);
      expect(server.requests.map((request) => request.path)).toEqual([
        '/flaky',
        '/flaky',
      ]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(0);
      expect(action.stdout).toContain('1 succeeded, 0 failed');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('successful external check preserves unchanged CLI output', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    injectExternal(runInjection, );
    const cli = await runCli(['--external', '--', file], {
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cli-cache') },
    });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(cli.status).toBe(0);
      expect(actionCliText(action)).toBe(cli.stdout);
      expect(action.stderr).toBe(cli.stderr);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external success does not create a broken count', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.diagnostics).toEqual([]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(0);
      expect(action.stdout).not.toMatch(/^\S+:\d+: /m);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('duplicate external targets are checked once under existing policy', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/ok');
    const file = writeMarkdown(
      root,
      linksDocument([`${target}#one`, `${target}#two`, target]),
    );
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(server.requests.map((request) => request.path)).toEqual(['/ok']);
      expect(action.stdout).toContain(
        externalSummary({
          occurrences: 3,
          distinctChecked: 1,
          succeeded: 1,
          failed: 0,
          brokenOccurrences: 0,
        }),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
  it('query distinctions remain distinct under existing normalization', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(
      root,
      linksDocument([
        `${server.urlFor('/ok')}?a=1`,
        `${server.urlFor('/ok')}?b=2`,
        `${server.urlFor('/ok')}?a=1#fragment`,
      ]),
    );
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(0);
      expect(server.requestTargets).toEqual(['/ok?a=1', '/ok?b=2']);
      expect(action.stdout).toContain(
        externalSummary({
          occurrences: 3,
          distinctChecked: 2,
          succeeded: 2,
          failed: 0,
          brokenOccurrences: 0,
        }),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

