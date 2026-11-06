/**
 * M22 — existing transport policy drives the summary unchanged.
 *
 * This in-packet suite exercises the existing redirect, retry, timeout and cache
 * behavior through the real action path with a writable temporary
 * `GITHUB_STEP_SUMMARY` file. It adds no transport behavior: every scenario uses
 * the repository's existing loopback fixture routes on an OS-assigned ephemeral
 * port, freezes the existing request counts and classifications, and proves the
 * appended summary mirrors the authentic run result.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliIo, RunOptions, RunResult } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import {
  injectExternal,
  resetRunInjection,
  type RunInjectionState,
} from './m15-helpers.js';
import {
  invokeArtifact,
  invokeSourceAction,
  readFetchLog,
  summaryOccurrences,
  warningLines,
} from './m22-helpers.js';
import { startFixtureServer } from './server.js';

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

/** The clean external-mode text lines, independently hard-coded. */
const CLEAN_EXTERNAL_CLI_TEXT =
  'Checked 1 file: 0 broken targets, 0 external links skipped.\n' +
  'External checks: 1 occurrence, 1 distinct target checked (1 succeeded, 0 failed), 0 broken occurrences.\n';

/** The clean summary, independently hard-coded. */
const CLEAN_SUMMARY = [
  '## Results',
  '',
  '- Checked: 1',
  '- Broken: 0',
  '- External skipped: 0',
  '',
].join('\n');

/** The clean action output records, independently hard-coded. */
const CLEAN_OUTPUTS = 'files-checked=1\nbroken=0\nexternal-skipped=0\n';

/** A one-target fixture whose link starts on line 3. */
function singleLinkFixture(target: string): Record<string, string> {
  return { 'README.md': `# Transport fixture\n\n[target](${target})\n` };
}

interface TimeoutExpectation {
  readonly cliText: string;
  readonly annotation: string;
  readonly summary: string;
  readonly outputs: string;
}

/** The exact exhausted-timeout result of the existing transport policy. */
function timeoutExpectation(baseUrl: string): TimeoutExpectation {
  const port = new URL(baseUrl).port;
  const target = `${baseUrl}/slow`;
  const reason = 'external request timed out after 2 attempts';
  return {
    cliText: [
      `README.md:3: ${target} — ${reason}`,
      'Checked 1 file: 1 broken target, 0 external links skipped.',
      'External checks: 1 occurrence, 1 distinct target checked (0 succeeded, 1 failed), 1 broken occurrence.',
      '',
    ].join('\n'),
    annotation: `::error file=README.md,line=3::${target} — ${reason}`,
    summary: [
      '## Results',
      '',
      '- Checked: 1',
      '- Broken: 1',
      '- External skipped: 0',
      '',
      '## Diagnostics',
      '',
      `- README.md:3: http\\://127.0.0.1\\:${port}/slow — ${reason}`,
      '',
    ].join('\n'),
    outputs: 'files-checked=1\nbroken=1\nexternal-skipped=0\n',
  };
}

describe('M22 transport policy stays authoritative for the summary', () => {
  it('redirect policy and summary stay unchanged', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, singleLinkFixture(server.urlFor('/redirect')));
    const outputPath = join(root, 'github-output.txt');
    const summaryPath = join(root, 'step-summary.md');
    const fetchLog = join(root, 'fetch.log');

    try {
      const { result } = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath,
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });

      // The existing policy follows the 302 once and keeps the final success.
      expect(result.status).toBe(0);
      expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        'GET /redirect',
        'GET /ok',
      ]);
      expect(readFetchLog(fetchLog)).toHaveLength(2);
      expect(result.stdout).toBe(CLEAN_EXTERNAL_CLI_TEXT);
      expect(result.stderr).toBe('');
      expect(readFileSync(outputPath, 'utf8')).toBe(CLEAN_OUTPUTS);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(CLEAN_SUMMARY);
      expect(summaryOccurrences(summary)).toBe(1);
      expect(warningLines(`${result.stdout}${result.stderr}`)).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('retry policy and summary stay unchanged', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, singleLinkFixture(server.urlFor('/flaky')));
    const outputPath = join(root, 'github-output.txt');
    const summaryPath = join(root, 'step-summary.md');
    const fetchLog = join(root, 'fetch.log');

    try {
      const { result } = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath,
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });

      // The first 500 is retried once under the existing policy, then succeeds.
      expect(result.status).toBe(0);
      expect(server.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        'GET /flaky',
        'GET /flaky',
      ]);
      expect(readFetchLog(fetchLog)).toHaveLength(2);
      expect(result.stdout).toBe(CLEAN_EXTERNAL_CLI_TEXT);
      expect(result.stderr).toBe('');
      expect(readFileSync(outputPath, 'utf8')).toBe(CLEAN_OUTPUTS);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(CLEAN_SUMMARY);
      expect(summaryOccurrences(summary)).toBe(1);
      expect(warningLines(`${result.stdout}${result.stderr}`)).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('exhausted timeout policy and summary stay unchanged', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    const target = server.urlFor('/slow');
    writeFiles(fixture, singleLinkFixture(target));
    const expectation = timeoutExpectation(server.url);
    const outputPath = join(root, 'github-output.txt');
    const summaryPath = join(root, 'step-summary.md');
    // The test-only transport option only shortens the existing default timeout;
    // the retry count, classification and reason vocabulary are unchanged.
    injectExternal(runInjection, { timeoutMs: 50 });

    try {
      const invocation = await invokeSourceAction({
        fixture,
        external: 'true',
        summaryPath,
        outputPath,
        cacheHome: join(root, 'cache-home'),
      });
      const { result } = invocation;

      expect(result.exitCode).toBe(1);
      expect(result.summary).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
      expect(result.diagnostics).toEqual([
        {
          file: 'README.md',
          line: 3,
          target,
          reason: 'external request timed out after 2 attempts',
        },
      ]);
      expect(server.requests.filter((request) => request.path === '/slow')).toHaveLength(2);
      expect(invocation.stdout).toBe(
        `${expectation.cliText}${expectation.annotation}\n`,
      );
      expect(invocation.stderr).toBe('');
      expect(readFileSync(outputPath, 'utf8')).toBe(expectation.outputs);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(expectation.summary);
      expect(summaryOccurrences(summary)).toBe(1);
      expect(warningLines(`${invocation.stdout}${invocation.stderr}`)).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('fresh cache suppresses the request without changing the summary', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, singleLinkFixture(server.urlFor('/ok')));
    const cacheHome = join(root, 'cache-home');
    const firstFetchLog = join(root, 'first-fetch.log');
    const secondFetchLog = join(root, 'second-fetch.log');

    try {
      const first = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath: join(root, 'first-summary.md'),
        outputPath: join(root, 'first-output.txt'),
        fetchLog: firstFetchLog,
        cacheHome,
      });
      const firstSummary = readFileSync(join(root, 'first-summary.md'), 'utf8');

      const second = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath: join(root, 'second-summary.md'),
        outputPath: join(root, 'second-output.txt'),
        fetchLog: secondFetchLog,
        cacheHome,
      });
      const secondSummary = readFileSync(join(root, 'second-summary.md'), 'utf8');

      // The fresh cache entry answers the second run with no network request.
      expect(first.result.status).toBe(0);
      expect(second.result.status).toBe(0);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
      expect(readFetchLog(firstFetchLog)).toHaveLength(1);
      expect(existsSync(secondFetchLog)).toBe(false);
      expect(existsSync(join(cacheHome, 'md-link-check', 'external-v1.json'))).toBe(true);

      // The cached classification leaves both the CLI text and summary unchanged.
      expect(first.result.stdout).toBe(CLEAN_EXTERNAL_CLI_TEXT);
      expect(second.result.stdout).toBe(CLEAN_EXTERNAL_CLI_TEXT);
      expect(firstSummary).toBe(CLEAN_SUMMARY);
      expect(secondSummary).toBe(CLEAN_SUMMARY);
      expect(summaryOccurrences(secondSummary)).toBe(1);
      expect(warningLines(`${second.result.stdout}${second.result.stderr}`)).toEqual([]);
      expect(readFileSync(join(root, 'second-output.txt'), 'utf8')).toBe(CLEAN_OUTPUTS);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});
