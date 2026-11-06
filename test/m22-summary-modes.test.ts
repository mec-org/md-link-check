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
 * expected summary, CLI text, annotation line and output record is an independent
 * hard-coded oracle from `test/m22-helpers.ts`; none is rendered by the
 * production formatter under test.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessResult } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { runArtifactUnderOfflineGuard } from './m15-helpers.js';
import {
  OFFLINE_EXPECTATION,
  UNAVAILABLE_WARNING,
  actionStdout,
  annotationLines,
  externalExpectation,
  externalFixture,
  fixtureExternalTargets,
  invokeArtifact,
  invokeSourceAction,
  offlineFixture,
  readFetchLog,
  summaryDiagnostics,
  summaryOccurrences,
  warningLines,
  type ModeExpectation,
} from './m22-helpers.js';
import { startFixtureServer } from './server.js';

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

      // The whole invocation, including the later summary formatting and
      // append, caused exactly the frozen transport count: one GET per distinct
      // target and no retry of the terminal 404. The differential below repeats
      // the same fixture without a summary destination and proves the summary
      // path adds no request of its own.
      expect(result.status).toBe(1);
      expect(server.requests.map((request) => `${request.method} ${request.path}`).sort()).toEqual([
        'GET /not-found',
        'GET /ok',
      ]);
      expect(readFetchLog(fetchLog)).toHaveLength(2);

      const summary = readFileSync(summaryPath, 'utf8');
      expect(summary).toBe(expectation.summary);
      expect(summaryOccurrences(summary)).toBe(1);

      const requestsAfterSummaryRun = server.requests.length;
      expect(requestsAfterSummaryRun).toBe(2);

      // Differential control: the same fixture and transport without any summary
      // destination (the M21 absent case) performs the same two requests. The
      // summary invocation therefore added no fetch, retry or revalidation.
      const withoutSummary = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath: undefined,
        outputPath: join(root, 'no-summary-output.txt'),
        fetchLog: join(root, 'no-summary-fetch.log'),
        cacheHome: join(root, 'no-summary-cache'),
      });
      expect(withoutSummary.result.status).toBe(1);
      expect(withoutSummary.result.stdout).toBe(
        `${actionStdout(expectation)}${UNAVAILABLE_WARNING}`,
      );
      expect(server.requests.length).toBe(requestsAfterSummaryRun + 2);
      expect(
        server.requests
          .slice(requestsAfterSummaryRun)
          .map((request) => `${request.method} ${request.path}`)
          .sort(),
      ).toEqual(['GET /not-found', 'GET /ok']);
      expect(readFetchLog(join(root, 'no-summary-fetch.log'))).toHaveLength(2);
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
