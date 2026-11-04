/**
 * M15 — action metadata, scope and policy freezes.
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
import { execFileSync } from 'node:child_process';
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
import { DEFAULT_EXTERNAL_CONCURRENCY } from '../src/external.js';
import { DEFAULT_EXTERNAL_MAX_ATTEMPTS } from '../src/external.js';
import { DEFAULT_EXTERNAL_MAX_REDIRECTS } from '../src/external.js';
import { DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY } from '../src/external.js';
import { DEFAULT_EXTERNAL_PER_HOST_DELAY_MS } from '../src/external.js';
import { DEFAULT_EXTERNAL_TIMEOUT_MS } from '../src/external.js';
import { EXTERNAL_CACHE_FRESHNESS_MS } from '../src/cache.js';
import { EXTERNAL_CACHE_MAX_ENTRIES } from '../src/cache.js';
import { EXTERNAL_CACHE_MAX_FILE_BYTES } from '../src/cache.js';
import { EXTERNAL_CACHE_MAX_URL_LENGTH } from '../src/cache.js';
import { EXTERNAL_CACHE_SCHEMA_VERSION } from '../src/cache.js';
import { REPO_ROOT } from './action-helpers.js';
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import { makeTempRoot } from './helpers.js';
import { optionalScalar } from './action-helpers.js';
import { readActionArtifactText } from './action-helpers.js';
import { readActionMetadata } from './action-helpers.js';
import { readScopeReport } from './action-helpers.js';
import { requireMapping } from './action-helpers.js';
import { requireScalar } from './action-helpers.js';
import { startFixtureServer } from './server.js';
import type {
  RunInjectionState,
} from './m15-helpers.js';
import {
  M15_BASE_SHA,
  captureSourceAction,
  commitAvailable,
  createOutputPath,
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

describe('M15 metadata, scope and policy freeze', () => {
  it('paths input remains unchanged', () => {
    const inputs = readActionMetadata().inputs;
    const paths = requireMapping(inputs, 'paths');

    expect([...inputs.keys()].sort()).toEqual(['external', 'paths']);
    expect(optionalScalar(paths, 'required') ?? 'false').toBe('true');
    expect(requireScalar(paths, 'description')).toContain('Newline-delimited');
    expect(optionalScalar(paths, 'default')).toBeUndefined();
  });

  it('external input remains unchanged', () => {
    const inputs = readActionMetadata().inputs;
    const external = requireMapping(inputs, 'external');

    expect(optionalScalar(external, 'default')).toBe('false');
    expect(optionalScalar(external, 'required') ?? 'false').toBe('false');
    expect(requireScalar(external, 'description')).toContain('HTTP(S) targets');
  });

  it('M13 output metadata remains unchanged', () => {
    const outputs = requireMapping(readActionMetadata().fields, 'outputs');

    expect([...outputs.keys()].sort()).toEqual(
      Object.values(SUMMARY_OUTPUT_NAMES).sort(),
    );
    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(requireScalar(requireMapping(outputs, name), 'description')).not.toBe('');
    }
  });

  it('M15 removes no output', () => {
    const outputs = requireMapping(readActionMetadata().fields, 'outputs');

    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(outputs.has(name)).toBe(true);
    }
  });

  it('M15 renames no output', () => {
    const outputs = requireMapping(readActionMetadata().fields, 'outputs');

    expect([...outputs.keys()].sort()).toEqual(
      Object.values(SUMMARY_OUTPUT_NAMES).sort(),
    );
  });

  it('M15 adds no output', () => {
    const outputs = requireMapping(readActionMetadata().fields, 'outputs');

    expect(outputs.size).toBe(3);
  });

  it('external output values retain established string types', async () => {
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
      const records = readFileSync(outputPath, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const separator = line.indexOf('=');
          expect(separator).toBeGreaterThan(0);
          return { name: line.slice(0, separator), value: line.slice(separator + 1) };
        });

      expect(action.exitCode).toBe(1);
      expect(records.map((record) => record.name).sort()).toEqual(
        Object.values(SUMMARY_OUTPUT_NAMES).sort(),
      );
      for (const record of records) {
        expect(typeof record.value).toBe('string');
        expect(record.value).toMatch(/^(?:0|[1-9][0-9]*)$/);
      }
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('output environment-file protocol remains valid', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    const outputPath = createOutputPath(root, 'keep=existing\n');
    injectExternal(runInjection, );

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: file,
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });
      const text = readFileSync(outputPath, 'utf8');

      expect(action.exitCode).toBe(1);
      expect(text.startsWith('keep=existing\n')).toBe(true);
      expect(text.endsWith('\n')).toBe(true);
      expect(text).not.toContain('\r');
      expect(parseSummaryOutputs(text, { allowPreexisting: ['keep'] })).toEqual(
        requireSummary(action),
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('package retains zero runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const lockfile = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { dependencies?: Record<string, string> }> };

    expect(manifest.dependencies ?? {}).toEqual({});
    expect(lockfile.packages?.['']?.dependencies ?? {}).toEqual({});
  });

  it('M15 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M15 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M15 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(
      report.changed.filter((path) => path.startsWith('.github/workflows/')),
    ).toEqual([]);
  });

  it('M15 creates no tag release or npm publication', () => {
    const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { private?: boolean; publishConfig?: unknown };

    expect(tags.trim()).toBe('');
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
    expect(readActionArtifactText()).not.toContain('npm publish');
  });

  it.skipIf(!commitAvailable(M15_BASE_SHA))(
    'M15 work is based on the authorized commit',
    () => {
      expect(() =>
        execFileSync('git', ['merge-base', '--is-ancestor', M15_BASE_SHA, 'HEAD'], {
          cwd: REPO_ROOT,
          stdio: 'ignore',
        }),
      ).not.toThrow();
      const changed = execFileSync('git', ['diff', '--name-only', M15_BASE_SHA], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((path) => path !== '');
      expect(
        changed.filter(
          (path) => path.startsWith('.github/') || path.startsWith('.project/'),
        ),
      ).toEqual([]);
    },
  );

  it('M15 preserves existing transport and cache constants', () => {
    expect(DEFAULT_EXTERNAL_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_EXTERNAL_MAX_ATTEMPTS).toBe(2);
    expect(DEFAULT_EXTERNAL_CONCURRENCY).toBe(4);
    expect(DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY).toBe(1);
    expect(DEFAULT_EXTERNAL_PER_HOST_DELAY_MS).toBe(0);
    expect(DEFAULT_EXTERNAL_MAX_REDIRECTS).toBe(5);
    expect(EXTERNAL_CACHE_SCHEMA_VERSION).toBe(1);
    expect(EXTERNAL_CACHE_FRESHNESS_MS).toBe(24 * 60 * 60 * 1_000);
    expect(EXTERNAL_CACHE_MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(EXTERNAL_CACHE_MAX_ENTRIES).toBe(10_000);
    expect(EXTERNAL_CACHE_MAX_URL_LENGTH).toBe(8 * 1024);
  });
});
