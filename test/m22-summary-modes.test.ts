/**
 * M22 — offline and external-mode summary coverage.
 *
 * The action summary must mirror the run in both action modes without changing
 * any established surface. This suite exercises the real action path with a
 * temporary `GITHUB_STEP_SUMMARY` file:
 *
 * - the committed `action-dist/index.cjs` bundle in a child process for the
 *   customer-visible bytes, outputs and exit code;
 * - the in-process `runAction` orchestration seam where the test also needs the
 *   authentic structured `RunResult` to compare the run's counts and ordered
 *   findings with the appended summary.
 *
 * Default mode includes HTTP and HTTPS targets and is run under the repository's
 * offline guard, which records and refuses every practical network entry point
 * and every filesystem access beneath the audit cache root. External mode
 * enables the canonical `external: true` input and contacts only a test-owned
 * loopback HTTP server on an operating-system-assigned ephemeral port. Every
 * expected summary, CLI text, annotation line and output record below is an
 * independent hard-coded oracle; none is rendered by the production formatter
 * under test.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction as runSourceAction } from '../src/action-runner.js';
import type { CliIo, RunResult } from '../src/run.js';
import { runAction, type ProcessResult } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { runArtifactUnderOfflineGuard } from './m15-helpers.js';
import { startFixtureServer } from './server.js';

/** Proxy variables a hosted runner could inject; removed for every run. */
const PROXY_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/** Proxy variables as explicit child-environment removals. */
const PROXY_ISOLATION: Record<string, undefined> = Object.fromEntries(
  PROXY_VARIABLES.map((name) => [name, undefined]),
);

/** The three authoritative M17 counts of one completed check. */
interface Counts {
  readonly filesChecked: number;
  readonly broken: number;
  readonly externalSkipped: number;
}

/** One broken finding, independently expected from the fixture. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

/** The complete independently expected result of one mode. */
interface ModeExpectation {
  readonly counts: Counts;
  readonly findings: readonly Finding[];
  readonly cliText: string;
  readonly annotations: readonly string[];
  readonly listedDiagnostics: readonly string[];
  readonly summary: string;
  readonly outputs: string;
}

/**
 * The default offline fixture. Line 3 resolves, line 4 is a missing local
 * target, lines 5 and 6 are HTTP and HTTPS targets that default mode must skip
 * without fetching, line 7 is a missing anchor, and the second file contributes
 * one more local finding after the first file's result order.
 */
function offlineFixture(baseUrl: string): Record<string, string> {
  const secureTarget = `https://127.0.0.1:${new URL(baseUrl).port}/secure`;
  return {
    'README.md': [
      '# M22 offline fixture',
      '',
      '[guide](docs/guide.md)',
      '[missing](docs/missing.md)',
      `[site](${baseUrl}/ok)`,
      `[secure](${secureTarget})`,
      '[anchor](#no-such-heading)',
      '',
    ].join('\n'),
    'docs/guide.md': '# Guide\n\n[back](../README.md)\n[gone](not-there.md)\n',
  };
}

/**
 * The external fixture. Lines 3 and 4 are the loopback server's existing healthy
 * and broken routes; lines 5 and 6 keep local findings after and around the
 * external result so the summary's document-order diagnostics are observable.
 */
function externalFixture(baseUrl: string): Record<string, string> {
  return {
    'README.md': [
      '# M22 external fixture',
      '',
      `[healthy](${baseUrl}/ok)`,
      `[broken](${baseUrl}/not-found)`,
      '[missing](docs/missing.md)',
      '[guide](docs/guide.md)',
      '',
    ].join('\n'),
    'docs/guide.md': '# Guide\n\n[back](../README.md)\n[gone](not-there.md)\n',
  };
}

const OFFLINE_LISTED_DIAGNOSTICS = [
  '- README.md:4: docs/missing.md — target does not exist',
  '- README.md:7: \\#no\\-such\\-heading — anchor does not exist',
  '- docs/guide.md:4: not\\-there.md — target does not exist',
] as const;

const OFFLINE_EXPECTATION: ModeExpectation = {
  counts: { filesChecked: 2, broken: 3, externalSkipped: 2 },
  findings: [
    { file: 'README.md', line: 4, target: 'docs/missing.md', reason: 'target does not exist' },
    { file: 'README.md', line: 7, target: '#no-such-heading', reason: 'anchor does not exist' },
    { file: 'docs/guide.md', line: 4, target: 'not-there.md', reason: 'target does not exist' },
  ],
  cliText: [
    'README.md:4: docs/missing.md — target does not exist',
    'README.md:7: #no-such-heading — anchor does not exist',
    'docs/guide.md:4: not-there.md — target does not exist',
    'Checked 2 files: 3 broken targets, 2 external links skipped.',
    '',
  ].join('\n'),
  annotations: [
    '::error file=README.md,line=4::docs/missing.md — target does not exist',
    '::error file=README.md,line=7::#no-such-heading — anchor does not exist',
    '::error file=docs/guide.md,line=4::not-there.md — target does not exist',
  ],
  listedDiagnostics: OFFLINE_LISTED_DIAGNOSTICS,
  summary: [
    '## Results',
    '',
    '- Checked: 2',
    '- Broken: 3',
    '- External skipped: 2',
    '',
    '## Diagnostics',
    '',
    ...OFFLINE_LISTED_DIAGNOSTICS,
    '',
  ].join('\n'),
  outputs: 'files-checked=2\nbroken=3\nexternal-skipped=2\n',
};

/**
 * The external-mode expectation. The loopback URL is built from the actual bound
 * address and ephemeral port; the summary applies the established M18 escaping
 * to that URL by hand, so the oracle stays independent of the formatter.
 */
function externalExpectation(baseUrl: string): ModeExpectation {
  const port = new URL(baseUrl).port;
  const brokenTarget = `${baseUrl}/not-found`;
  const listedDiagnostics = [
    `- README.md:4: http\\://127.0.0.1\\:${port}/not\\-found — external HTTP 404`,
    '- README.md:5: docs/missing.md — target does not exist',
    '- docs/guide.md:4: not\\-there.md — target does not exist',
  ];
  return {
    counts: { filesChecked: 2, broken: 3, externalSkipped: 0 },
    findings: [
      { file: 'README.md', line: 4, target: brokenTarget, reason: 'external HTTP 404' },
      { file: 'README.md', line: 5, target: 'docs/missing.md', reason: 'target does not exist' },
      { file: 'docs/guide.md', line: 4, target: 'not-there.md', reason: 'target does not exist' },
    ],
    cliText: [
      `README.md:4: ${brokenTarget} — external HTTP 404`,
      'README.md:5: docs/missing.md — target does not exist',
      'docs/guide.md:4: not-there.md — target does not exist',
      'Checked 2 files: 3 broken targets, 0 external links skipped.',
      'External checks: 2 occurrences, 2 distinct targets checked (1 succeeded, 1 failed), 1 broken occurrence.',
      '',
    ].join('\n'),
    annotations: [
      `::error file=README.md,line=4::${brokenTarget} — external HTTP 404`,
      '::error file=README.md,line=5::docs/missing.md — target does not exist',
      '::error file=docs/guide.md,line=4::not-there.md — target does not exist',
    ],
    listedDiagnostics,
    summary: [
      '## Results',
      '',
      '- Checked: 2',
      '- Broken: 3',
      '- External skipped: 0',
      '',
      '## Diagnostics',
      '',
      ...listedDiagnostics,
      '',
    ].join('\n'),
    outputs: 'files-checked=2\nbroken=3\nexternal-skipped=0\n',
  };
}

/** The exact stdout of one action run: unchanged CLI text, then annotations. */
function actionStdout(expectation: ModeExpectation): string {
  return `${expectation.cliText}${expectation.annotations.join('\n')}\n`;
}

/** Complete warning lines in one captured stream. */
function warningLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('::warning::'));
}

/** Physical annotation lines in one captured stream, in order. */
function annotationLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('::error '));
}

/** Occurs exactly once when exactly one summary fragment was appended. */
function summaryOccurrences(summary: string): number {
  return summary.split('## Results').length - 1;
}

/** The listed diagnostics of one hard-coded summary, in order. */
function summaryDiagnostics(summary: string): string[] {
  const marker = '## Diagnostics\n\n';
  const start = summary.indexOf(marker);
  if (start === -1) {
    return [];
  }
  return summary
    .slice(start + marker.length)
    .split('\n')
    .filter((line) => line.startsWith('- '));
}

/** Every HTTP(S) target written in one fixture's Markdown files. */
function fixtureExternalTargets(fixture: string): string[] {
  const targets: string[] = [];
  for (const file of ['README.md', 'docs/guide.md']) {
    const contents = readFileSync(join(fixture, file), 'utf8');
    for (const match of contents.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
      const target = match[1];
      if (target !== undefined) {
        targets.push(target);
      }
    }
  }
  return targets;
}

interface SourceInvocationOptions {
  readonly fixture: string;
  readonly external: 'true' | 'false' | undefined;
  readonly summaryPath: string;
  readonly outputPath: string;
  readonly cacheHome: string;
}

interface SourceInvocation {
  readonly result: RunResult;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the in-process action orchestration against a fixture, with the process
 * working directory temporarily moved into that fixture exactly as the action
 * child's `cwd` is. Process-wide cache and proxy variables are isolated and
 * restored; the action's own inputs, summary and output arrive through the
 * environment object the wrapper already takes.
 */
async function invokeSourceAction(
  options: SourceInvocationOptions,
): Promise<SourceInvocation> {
  writeFileSync(options.summaryPath, '');
  writeFileSync(options.outputPath, '');
  const environment: NodeJS.ProcessEnv = {
    INPUT_PATHS: '.',
    GITHUB_OUTPUT: options.outputPath,
    GITHUB_STEP_SUMMARY: options.summaryPath,
  };
  if (options.external !== undefined) {
    environment.INPUT_EXTERNAL = options.external;
  }

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

  const savedCacheHome = process.env.XDG_CACHE_HOME;
  const savedProxy = PROXY_VARIABLES.map(
    (name) => [name, process.env[name]] as const,
  );
  const savedCwd = process.cwd();
  process.env.XDG_CACHE_HOME = options.cacheHome;
  for (const name of PROXY_VARIABLES) {
    delete process.env[name];
  }
  process.chdir(options.fixture);
  try {
    const result = await runSourceAction(environment, io);
    return { result, stdout, stderr };
  } finally {
    process.chdir(savedCwd);
    for (const [name, value] of savedProxy) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    if (savedCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = savedCacheHome;
    }
  }
}

interface ArtifactInvocationOptions {
  readonly fixture: string;
  readonly external: 'true' | 'false' | undefined;
  readonly summaryPath: string;
  readonly outputPath: string;
  readonly fetchLog: string;
  readonly cacheHome: string;
}

interface ArtifactInvocation {
  readonly result: ProcessResult;
}

/**
 * Runs the committed action bundle exactly as the hosted runner does, with a
 * writable temporary summary and output file, a fresh cache home and the
 * loopback-only fetch guard. Proxy variables from the host are removed so they
 * cannot redirect the fixture traffic.
 */
async function invokeArtifact(
  options: ArtifactInvocationOptions,
): Promise<ArtifactInvocation> {
  writeFileSync(options.summaryPath, '');
  writeFileSync(options.outputPath, '');
  const inputs: Record<string, string | undefined> = { INPUT_PATHS: '.' };
  if (options.external !== undefined) {
    inputs.INPUT_EXTERNAL = options.external;
  }
  const result = await runAction({
    cwd: options.fixture,
    inputs,
    env: {
      ...PROXY_ISOLATION,
      GITHUB_OUTPUT: options.outputPath,
      GITHUB_STEP_SUMMARY: options.summaryPath,
    },
    fetchLog: options.fetchLog,
    cacheHome: options.cacheHome,
  });
  return { result };
}

/** Parses the loopback-only action fetch guard's log, one entry per attempt. */
function readFetchLog(path: string): Array<{ decision: string; url: string }> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const separator = line.indexOf(' ');
      return {
        decision: line.slice(0, separator),
        url: line.slice(separator + 1),
      };
    });
}

/** Asserts the complete, independently expected action surfaces of one run. */
function expectEstablishedSurfaces(
  result: ProcessResult,
  expectation: ModeExpectation,
  outputPath: string,
  summaryPath: string,
): void {
  expect(result.timedOut).toBe(false);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe(actionStdout(expectation));
  expect(result.stderr).toBe('');
  expect(warningLines(`${result.stdout}${result.stderr}`)).toEqual([]);
  expect(annotationLines(result.stdout)).toEqual(expectation.annotations);
  expect(readFileSync(outputPath, 'utf8')).toBe(expectation.outputs);

  const summary = readFileSync(summaryPath, 'utf8');
  expect(summary).toBe(expectation.summary);
  expect(summaryOccurrences(summary)).toBe(1);
}

describe('M22 offline and external-mode summary coverage', () => {
  it('default offline action attempts no HTTP or HTTPS request', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, offlineFixture(server.url));
    const outputPath = join(fixture, 'github-output.txt');
    const summaryPath = join(fixture, 'step-summary.md');
    writeFileSync(outputPath, '');
    writeFileSync(summaryPath, '');

    try {
      // The action input `external` is omitted, which is the canonical default:
      // no `--external`, so no HTTP(S) transport may be attempted at all. The
      // offline guard records and refuses every network and audit-cache access,
      // so a missing guard log is the no-fetch proof, not the server's count.
      const { result, guardLog } = await runArtifactUnderOfflineGuard(
        fixture,
        { INPUT_PATHS: 'README.md\ndocs/guide.md' },
        {
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
        },
      );

      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe(actionStdout(OFFLINE_EXPECTATION));
      expect(result.stderr).toBe('');
      expect(server.requests).toEqual([]);
      expect(existsSync(guardLog)).toBe(false);

      // A writable destination receives exactly one summary and no warning.
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(OFFLINE_EXPECTATION.summary);
      expect(summaryOccurrences(summary)).toBe(1);
      expect(warningLines(`${result.stdout}${result.stderr}`)).toEqual([]);
      expect(readFileSync(outputPath, 'utf8')).toBe(OFFLINE_EXPECTATION.outputs);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default offline summary matches the run', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, offlineFixture(server.url));
    const outputPath = join(root, 'github-output.txt');
    const summaryPath = join(root, 'step-summary.md');

    try {
      const invocation = await invokeSourceAction({
        fixture,
        external: undefined,
        summaryPath,
        outputPath,
        cacheHome: join(root, 'cache-home'),
      });
      const { result } = invocation;

      // The structured result is the authentic run: its three counts and its
      // ordered findings are the independent oracle for the summary below.
      expect(result.exitCode).toBe(1);
      expect(result.outcome).toBe('checked');
      expect(result.summary).toEqual(OFFLINE_EXPECTATION.counts);
      expect(result.summary?.broken).toBe(result.diagnostics.length);
      expect(result.diagnostics).toEqual(OFFLINE_EXPECTATION.findings);
      expect(invocation.stdout).toBe(actionStdout(OFFLINE_EXPECTATION));
      expect(invocation.stderr).toBe('');
      expect(server.requests).toEqual([]);

      // Skipped external targets keep their existing classification: they are
      // counted as skipped, produce no broken finding and no diagnostic entry.
      expect(result.summary?.externalSkipped).toBe(2);
      for (const finding of result.diagnostics) {
        expect(finding.target.startsWith('http://')).toBe(false);
        expect(finding.target.startsWith('https://')).toBe(false);
      }

      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(OFFLINE_EXPECTATION.summary);
      expect(summaryOccurrences(summary)).toBe(1);
      expect(warningLines(`${invocation.stdout}${invocation.stderr}`)).toEqual([]);
      expect(summaryDiagnostics(summary)).toEqual(
        OFFLINE_EXPECTATION.listedDiagnostics,
      );
      expect(readFileSync(outputPath, 'utf8')).toBe(OFFLINE_EXPECTATION.outputs);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external action uses only a loopback server', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, externalFixture(server.url));
    const fetchLog = join(root, 'fetch.log');
    const cacheHome = join(root, 'cache-home');

    try {
      const { result } = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath: join(root, 'step-summary.md'),
        outputPath: join(root, 'github-output.txt'),
        fetchLog,
        cacheHome,
      });

      // The fixture's only external targets are the server's own loopback URLs,
      // and every HTTP(S) attempt the action made is logged as allowed loopback.
      expect(result.status).toBe(1);
      expect(fixtureExternalTargets(fixture)).toEqual([
        server.urlFor('/ok'),
        server.urlFor('/not-found'),
      ]);
      const attempts = readFetchLog(fetchLog);
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(attempt.decision).toBe('allowed');
        expect(new URL(attempt.url).origin).toBe(server.url);
        expect(new URL(attempt.url).hostname).toBe('127.0.0.1');
      }
      expect(attempts.some((attempt) => attempt.decision === 'refused')).toBe(false);
      expect(server.requests.map((request) => `${request.method} ${request.path}`).sort()).toEqual([
        'GET /not-found',
        'GET /ok',
      ]);

      // The isolated cache location is the temporary one, created by this run.
      expect(existsSync(join(cacheHome, 'md-link-check', 'external-v1.json'))).toBe(true);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('external summary matches the run', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, externalFixture(server.url));
    const expectation = externalExpectation(server.url);
    const outputPath = join(root, 'github-output.txt');
    const summaryPath = join(root, 'step-summary.md');

    try {
      const invocation = await invokeSourceAction({
        fixture,
        external: 'true',
        summaryPath,
        outputPath,
        cacheHome: join(root, 'cache-home'),
      });
      const { result } = invocation;

      // The structured result keeps the existing classifications and reasons:
      // one healthy loopback route, one broken HTTP 404, and the local findings
      // in document order around them.
      expect(result.exitCode).toBe(1);
      expect(result.outcome).toBe('checked');
      expect(result.summary).toEqual(expectation.counts);
      expect(result.summary?.broken).toBe(result.diagnostics.length);
      expect(result.diagnostics).toEqual(expectation.findings);
      expect(server.requests.map((request) => request.path).sort()).toEqual([
        '/not-found',
        '/ok',
      ]);

      // The summary carries exactly the same counts and the same ordered fields.
      expect(invocation.stdout).toBe(actionStdout(expectation));
      expect(invocation.stderr).toBe('');
      expect(readFileSync(outputPath, 'utf8')).toBe(expectation.outputs);
      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(expectation.summary);
      expect(summaryOccurrences(summary)).toBe(1);
      expect(warningLines(`${invocation.stdout}${invocation.stderr}`)).toEqual([]);
      expect(summaryDiagnostics(summary)).toHaveLength(expectation.findings.length);
      expect(summaryDiagnostics(summary)).toEqual(expectation.listedDiagnostics);

      // The healthy target never appears as a diagnostic, and the broken one
      // retains its file, line, target and reason in the summary entry.
      expect(summary).not.toContain('/ok');
      expect(summary).toContain(
        `- README.md:4: http\\://127.0.0.1\\:${new URL(server.url).port}/not\\-found — external HTTP 404`,
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('summary generation performs no additional external request', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, externalFixture(server.url));
    const expectation = externalExpectation(server.url);
    const fetchLog = join(root, 'fetch.log');
    const outputPath = join(root, 'github-output.txt');
    const summaryPath = join(root, 'step-summary.md');

    try {
      const { result } = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath,
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });

      // Frozen from the existing transport policy: one GET per distinct target,
      // and the terminal 404 is not retried. The summary is only formatted and
      // appended after these requests have completed.
      expect(result.status).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(readFetchLog(fetchLog)).toHaveLength(2);

      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(expectation.summary);
      expect(summaryOccurrences(summary)).toBe(1);

      // Reading the appended summary and re-reading the transport evidence
      // shows no fetch, retry or cache revalidation was added by formatting.
      expect(server.requests).toHaveLength(2);
      expect(readFetchLog(fetchLog)).toHaveLength(2);
      expect(server.requests.map((request) => request.path).sort()).toEqual([
        '/not-found',
        '/ok',
      ]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('both summary modes preserve established action surfaces', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const offlineFixtureRoot = join(root, 'offline');
    const externalFixtureRoot = join(root, 'external');
    writeFiles(offlineFixtureRoot, offlineFixture(server.url));
    writeFiles(externalFixtureRoot, externalFixture(server.url));

    try {
      const offlineOutput = join(root, 'offline-output.txt');
      const offlineSummary = join(root, 'offline-summary.md');
      const offline = await invokeArtifact({
        fixture: offlineFixtureRoot,
        external: undefined,
        summaryPath: offlineSummary,
        outputPath: offlineOutput,
        fetchLog: join(root, 'offline-fetch.log'),
        cacheHome: join(root, 'offline-cache'),
      });

      const externalOutput = join(root, 'external-output.txt');
      const externalSummary = join(root, 'external-summary.md');
      const external = await invokeArtifact({
        fixture: externalFixtureRoot,
        external: 'true',
        summaryPath: externalSummary,
        outputPath: externalOutput,
        fetchLog: join(root, 'external-fetch.log'),
        cacheHome: join(root, 'external-cache'),
      });

      // Exactly the same CLI text, annotation bytes, ordering, output records
      // and exits as before the summary existed; the only new file is the
      // summary, appended exactly once with no warning.
      expectEstablishedSurfaces(
        offline.result,
        OFFLINE_EXPECTATION,
        offlineOutput,
        offlineSummary,
      );
      expectEstablishedSurfaces(
        external.result,
        externalExpectation(server.url),
        externalOutput,
        externalSummary,
      );

      // The offline run stayed offline while both fixtures point at the server.
      expect(existsSync(join(root, 'offline-fetch.log'))).toBe(false);
      expect(server.requests.map((request) => request.path).sort()).toEqual([
        '/not-found',
        '/ok',
      ]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});
