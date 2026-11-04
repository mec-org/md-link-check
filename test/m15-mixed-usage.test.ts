/**
 * M15 — mixed local/external findings, usage errors and exits.
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
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
import { startFixtureServer } from './server.js';
import { writeFiles } from './helpers.js';
import type {
  RunInjectionState,
} from './m15-helpers.js';
import {
  actionAnnotations,
  annotationLineCount,
  captureSourceAction,
  createOutputPath,
  expectOutputsMatchSummary,
  injectExternal,
  linksDocument,
  parseSummaryOutputs,
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

describe('M15 mixed local and external findings', () => {
  it('broken local target plus external success exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', server.urlFor('/ok')]),
    );
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics.map((finding) => finding.target)).toEqual([
        'missing.md',
      ]);
      expect(actionAnnotations(action)).toHaveLength(1);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('clean local targets plus external failure exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': linksDocument([server.urlFor('/not-found')]),
      'docs/guide.md': '# Guide\n',
    });
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: root,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics.map((finding) => finding.target)).toEqual([
        server.urlFor('/not-found'),
      ]);
      expect(actionAnnotations(action)).toHaveLength(1);
      expect(requireSummary(action)).toEqual({
        filesChecked: 2,
        broken: 1,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('local and external failures together exit 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const externalTarget = server.urlFor('/not-found');
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', externalTarget]),
    );
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics.map((finding) => finding.target)).toEqual([
        'missing.md',
        externalTarget,
      ]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(2);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('mixed findings produce matching annotations and outputs', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const externalTarget = server.urlFor('/not-found');
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', externalTarget, 'other.md']),
    );
    const outputPath = createOutputPath(root);
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(actionAnnotations(action)).toEqual(formatAnnotations(action.diagnostics));
      expectOutputsMatchSummary(outputPath, action);
      expect(action.exitCode).toBe(action.diagnostics.length === 0 ? 0 : 1);
      expect(action.diagnostics).toHaveLength(3);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('repeated mixed runs produce deterministic results', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const externalTarget = server.urlFor('/not-found');
    const file = writeMarkdown(
      root,
      linksDocument(['missing.md', externalTarget]),
    );
    const firstOutput = createOutputPath(root, '');
    injectExternal(runInjection, { cachePath: false });
    const first = await captureSourceAction({
      INPUT_PATHS: file,
      INPUT_EXTERNAL: 'true',
      GITHUB_OUTPUT: firstOutput,
    });
    const secondOutput = join(root, 'second-output.txt');
    writeFileSync(secondOutput, '');
    const second = await captureSourceAction({
      INPUT_PATHS: file,
      INPUT_EXTERNAL: 'true',
      GITHUB_OUTPUT: secondOutput,
    });

    try {
      expect(second.exitCode).toBe(first.exitCode);
      expect(second.stdout).toBe(first.stdout);
      expect(second.diagnostics).toEqual(first.diagnostics);
      expect(parseSummaryOutputs(readFileSync(secondOutput, 'utf8'))).toEqual(
        parseSummaryOutputs(readFileSync(firstOutput, 'utf8')),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

describe('M15 usage and exit interaction', () => {
  it('clean offline action exits 0', async () => {
    const root = makeTempRoot();
    const file = writeMarkdown(root, '# Consumer\n\n[guide](guide.md)\n');
    writeFiles(root, { 'guide.md': '# Guide\n' });

    const action = await captureSourceAction({ INPUT_PATHS: file });

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(actionAnnotations(action)).toEqual([]);
  });

  it('clean external action exits 0', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, '# Consumer\n');
    writeFiles(root, { 'guide.md': '# Guide\n' });
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('broken offline action exits 1', async () => {
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument(['missing.md']));

    const action = await captureSourceAction({ INPUT_PATHS: file });

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(1);
  });

  it('broken external action exits 1', async () => {
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
      expect(action.diagnostics).toHaveLength(1);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('missing paths exits 2 without fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const recorder = recordingFetch();
    injectExternal(runInjection, { fetch: recorder.fetch });
    const outputPath = createOutputPath(root, 'keep=sentinel\n');

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: '',
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(2);
      expect(action.diagnostics).toEqual([]);
      expect(action.stdout).toBe('');
      expect(action.stderr).toContain('md-link-check: no input paths');
      expect(recorder.calls).toEqual([]);
      expect(server.requests).toEqual([]);
      expect(annotationLineCount(action.stdout)).toBe(0);
      expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('invalid external input exits 2 without fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const recorder = recordingFetch();
    injectExternal(runInjection, { fetch: recorder.fetch });
    const outputPath = createOutputPath(root, 'keep=sentinel\n');

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'yes',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(2);
      expect(action.diagnostics).toEqual([]);
      expect(action.stderr).toContain(
        'md-link-check: invalid action input "external": expected "true" or "false"',
      );
      expect(recorder.calls).toEqual([]);
      expect(server.requests).toEqual([]);
      expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('usage error emits no broken-link annotation', async () => {
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument(['missing.md']));

    const action = await captureSourceAction({
      INPUT_PATHS: file,
      INPUT_EXTERNAL: 'not-a-boolean',
    });

    expect(action.exitCode).toBe(2);
    expect(action.stdout).toBe('');
    expect(`${action.stdout}${action.stderr}`).not.toContain('::error ');
  });

  it('usage output behavior remains the established M13 policy', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');

    const action = await captureSourceAction({
      INPUT_PATHS: '',
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(2);
    expect(action.summary).toBeNull();
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });
});

