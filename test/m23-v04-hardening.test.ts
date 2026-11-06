/**
 * M23 — v0.4 hardening through the real action path.
 *
 * One deterministic multi-file fixture (built by `test/m23-helpers.ts`) spans
 * more than fifty findings, relative file links, relative image links,
 * same-file and cross-file anchors, repeated headings, duplicated missing
 * targets, skipped HTTP(S) links and loopback external classifications. The
 * tests run the committed `action-dist/index.cjs` bundle as a child process
 * exactly as a GitHub runner would, and use the in-process orchestration seam
 * only where the authentic structured result is needed for the comparison.
 *
 * Every expectation here is an independent oracle: fixture findings, counts,
 * CLI text, annotation lines, output bytes and the escaped summary entries are
 * derived from the fixture definition, not from the formatter under test.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, runAction, runCli } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { M17_ACTION_OUTPUTS, M17_ACTION_STDOUT, M17_CLI_JSON, M17_CLI_TEXT, M17_FINDINGS, M17_SUMMARY, runM17Action } from './m17-helpers.js';
import { stageFixture } from './m16-helpers.js';
import { runArtifactUnderOfflineGuard } from './m15-helpers.js';
import {
  PROXY_ISOLATION,
  UNAVAILABLE_WARNING,
  WRITE_FAILED_WARNING,
  invokeArtifact,
  invokeSourceAction,
  readFetchLog,
  warningLines,
} from './m22-helpers.js';
import {
  ESCAPING_FINDINGS,
  ESCAPING_SUMMARY,
  M23_BASE_SHA,
  M23_EXTERNAL_COUNTS,
  M23_OFFLINE_COUNTS,
  escapingFixture,
  escapeSummaryValueOracle,
  expectedActionStdout,
  expectedAnnotation,
  expectedOutputs,
  expectedSummary,
  expectedSummaryDiagnostic,
  externalFindings,
  hardeningFixture,
  listedDiagnostics,
  offlineFindings,
  summaryOccurrences,
} from './m23-helpers.js';
import { startFixtureServer } from './server.js';

/** The exact CLI usage-error stderr for an invalid action input (frozen M17). */
const M17_ACTION_INPUT_ERROR_STDERR = readFileSync(
  join(REPO_ROOT, 'test', 'fixtures', 'm17-v03', 'action-input-error.stderr.txt'),
  'utf8',
);

/** The exact usage-error summary fragment of the M21 action path. */
const USAGE_SUMMARY = '## Results\n\n- Outcome: usage error\n- Link check: not performed\n';

/** Writes a fixture tree and returns its root. */
function stageHardeningFixture(root: string, baseUrl: string): string {
  const fixture = join(root, 'fixture');
  writeFiles(fixture, hardeningFixture(baseUrl));
  return fixture;
}

describe('M23 v0.4 hardening', () => {
  it('formats a multi-file run with more than fifty findings', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageHardeningFixture(root, server.url);
    // Each invocation writes to its own fresh destinations. The exactly-once
    // summary claim is therefore self-evident per invocation: neither run can
    // append to (or be truncated by) the other's file.
    const sourceSummaryPath = join(root, 'source-step-summary.md');
    const sourceOutputPath = join(root, 'source-github-output.txt');
    const actionSummaryPath = join(root, 'action-step-summary.md');
    const actionOutputPath = join(root, 'action-github-output.txt');
    const findings = offlineFindings();

    try {
      // The in-process seam supplies the authentic structured result: counts,
      // ordered findings and the broken-count invariant are asserted against
      // the fixture oracle before the summary is inspected.
      const source = await invokeSourceAction({
        fixture,
        external: undefined,
        summaryPath: sourceSummaryPath,
        outputPath: sourceOutputPath,
        cacheHome: join(root, 'source-cache'),
      });
      expect(source.result.exitCode).toBe(1);
      expect(source.result.outcome).toBe('checked');
      expect(source.result.summary).toEqual(M23_OFFLINE_COUNTS);
      expect(source.result.summary?.broken).toBe(source.result.diagnostics.length);
      expect(source.result.diagnostics).toEqual(findings);
      const sourceSummary = readFileSync(sourceSummaryPath, 'utf8');
      expect(summaryOccurrences(sourceSummary)).toBe(1);
      expect(sourceSummary).toBe(expectedSummary(M23_OFFLINE_COUNTS, findings));
      expect(readFileSync(sourceOutputPath, 'utf8')).toBe(
        expectedOutputs(M23_OFFLINE_COUNTS),
      );

      // The committed artifact is the customer-visible action path, writing to
      // its own paths, which do not exist until this invocation.
      expect(existsSync(actionSummaryPath)).toBe(false);
      expect(existsSync(actionOutputPath)).toBe(false);
      const artifact = await invokeArtifact({
        fixture,
        external: undefined,
        summaryPath: actionSummaryPath,
        outputPath: actionOutputPath,
        fetchLog: join(root, 'offline-fetch.log'),
        cacheHome: join(root, 'artifact-cache'),
      });
      expect(artifact.result.status).toBe(1);
      expect(artifact.result.stderr).toBe('');
      expect(readFileSync(actionOutputPath, 'utf8')).toBe(
        expectedOutputs(M23_OFFLINE_COUNTS),
      );
      expect(server.requests).toEqual([]);

      const summary = readFileSync(actionSummaryPath, 'utf8');
      expect(summaryOccurrences(summary)).toBe(1);
      expect(summary).toContain(
        '- Checked: 3\n- Broken: 67\n- External skipped: 2\n',
      );

      // Exactly the first fifty findings are listed, in result order, with the
      // independent M18 oracle applied to each value.
      const listed = listedDiagnostics(summary);
      expect(listed).toHaveLength(50);
      expect(listed).toEqual(
        findings.slice(0, 50).map(expectedSummaryDiagnostic),
      );
      expect(listed[0]).toBe(
        '- README.md:4: docs/missing.md — target does not exist',
      );
      expect(listed[49]).toBe(
        '- docs/extra.md:8: gone06.md — target does not exist',
      );

      // Finding 51 is disclosed only by count, never listed.
      expect(summary).not.toContain('gone07.md');
      expect(summary.endsWith('\n\n67 total diagnostics; 17 not listed.\n')).toBe(
        true,
      );
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('preserves result order across files images and anchors', async () => {
    const root = makeTempRoot();
    const fixture = stageHardeningFixture(root, 'http://127.0.0.1:9');
    const summaryPath = join(root, 'step-summary.md');
    const outputPath = join(root, 'github-output.txt');
    const findings = offlineFindings();

    const { result, stdout, stderr } = await invokeSourceAction({
      fixture,
      external: undefined,
      summaryPath,
      outputPath,
      cacheHome: join(root, 'cache'),
    });

    // The run's authentic structured order is the fixture's document order:
    // README.md (file, image, same-file anchor, cross-file anchor, 40 file
    // links), then docs/extra.md (10 files and 2 duplicates), then
    // docs/guide.md (a missing repeated-heading anchor and 10 images).
    expect(result.diagnostics).toEqual(findings);
    expect(result.summary).toEqual(M23_OFFLINE_COUNTS);
    expect(stdout).toBe(
      expectedActionStdout(findings, M23_OFFLINE_COUNTS, false),
    );
    expect(stderr).toBe('');

    const targets = result.diagnostics.map((finding) => finding.target);
    const sortedTargets = [...targets].sort();
    expect(targets).not.toEqual(sortedTargets);

    // Duplicates are genuine findings, not deduplicated results.
    expect(targets.filter((target) => target === 'gone01.md')).toHaveLength(3);

    // The summary lists the exact prefix of the same order, with no sorting,
    // grouping or mutation; images and anchors remain distinguishable by both
    // target and reason.
    const summary = readFileSync(summaryPath, 'utf8');
    expect(listedDiagnostics(summary)).toEqual(
      findings.slice(0, 50).map(expectedSummaryDiagnostic),
    );
    expect(result.diagnostics[1]).toEqual({
      file: 'README.md',
      line: 5,
      target: 'images/missing.png',
      reason: 'target does not exist',
    });
    expect(result.diagnostics[2]).toEqual({
      file: 'README.md',
      line: 6,
      target: '#no-such-heading',
      reason: 'anchor does not exist',
    });
    expect(result.diagnostics[56]).toEqual({
      file: 'docs/guide.md',
      line: 8,
      target: '#repeat-2',
      reason: 'anchor does not exist',
    });

    // The JSON surface keeps the existing kind classification: one README
    // image and ten guide images are images, while file links and anchors stay
    // links with their unchanged reasons.
    const jsonRun = await runCli(['--json', '--', '.'], { cwd: fixture });
    expect(jsonRun.status).toBe(1);
    expect(jsonRun.stderr).toBe('');
    const report = JSON.parse(jsonRun.stdout) as {
      diagnostics: Array<{
        file: string;
        line: number;
        kind: 'link' | 'image';
        target: string;
        reason: string;
      }>;
    };
    expect(
      report.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    ).toEqual(findings);
    expect(report.diagnostics.map((diagnostic) => diagnostic.kind).slice(0, 4)).toEqual([
      'link',
      'image',
      'link',
      'link',
    ]);
    expect(
      report.diagnostics.filter((diagnostic) => diagnostic.kind === 'image'),
    ).toHaveLength(11);
    expect(
      report.diagnostics
        .filter((diagnostic) => diagnostic.reason === 'anchor does not exist')
        .map((diagnostic) => `${diagnostic.file}:${diagnostic.line}`),
    ).toEqual(['README.md:6', 'README.md:7', 'docs/guide.md:8']);
  });

  it('escapes every listed diagnostic value in the integrated summary', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, escapingFixture());
    const sourceSummaryPath = join(root, 'source-step-summary.md');
    const sourceOutputPath = join(root, 'source-github-output.txt');
    const actionSummaryPath = join(root, 'action-step-summary.md');
    const actionOutputPath = join(root, 'action-github-output.txt');

    const source = await invokeSourceAction({
      fixture,
      external: undefined,
      summaryPath: sourceSummaryPath,
      outputPath: sourceOutputPath,
      cacheHome: join(root, 'source-cache'),
    });
    expect(source.result.diagnostics).toEqual(ESCAPING_FINDINGS);
    const sourceSummary = readFileSync(sourceSummaryPath, 'utf8');
    expect(summaryOccurrences(sourceSummary)).toBe(1);
    expect(sourceSummary).toBe(ESCAPING_SUMMARY);

    // The hard-coded expected bytes are independently oracled by
    // `expectedSummary`, which uses the documented escaping table. Applying the
    // oracle to the fixture proves the C0 control (rendered as the six-character
    // escape `\\u0001`) agrees between the hard-coded bytes and the oracle.
    expect(
      expectedSummary(
        { filesChecked: 2, broken: 2, externalSkipped: 0 },
        ESCAPING_FINDINGS,
      ),
    ).toBe(ESCAPING_SUMMARY);

    // The same oracle applied to the control-character file name is compared
    // directly with the hard-coded escape. Both contain the six visible
    // characters backslash-u-0001; neither contains the raw C0 byte.
    expect(escapeSummaryValueOracle(ESCAPING_FINDINGS[1]?.file ?? '')).toBe(
      'docs/weird\\|line\\nbreak\\ttab\\`tick\\*\\[x\\]&amp;&lt;y&gt;\\u0001.md',
    );

    expect(existsSync(actionSummaryPath)).toBe(false);
    expect(existsSync(actionOutputPath)).toBe(false);
    const artifact = await invokeArtifact({
      fixture,
      external: undefined,
      summaryPath: actionSummaryPath,
      outputPath: actionOutputPath,
      fetchLog: join(root, 'fetch.log'),
      cacheHome: join(root, 'artifact-cache'),
    });
    expect(artifact.result.status).toBe(1);
    expect(artifact.result.stderr).toBe('');

    const summary = readFileSync(actionSummaryPath, 'utf8');
    expect(summaryOccurrences(summary)).toBe(1);
    expect(summary).toBe(ESCAPING_SUMMARY);

    // Explicit structure proof in addition to exact bytes: the escaped values
    // added no heading, list row, link or HTML structure, and no diagnostic
    // value leaked a raw line break or control character into the fragment.
    const lines = summary.split('\n');
    expect(lines.filter((line) => line.startsWith('# '))).toEqual([]);
    expect(lines.filter((line) => line.startsWith('## '))).toEqual([
      '## Results',
      '## Diagnostics',
    ]);
    const diagnostics = listedDiagnostics(summary);
    expect(diagnostics).toHaveLength(2);
    for (const entry of diagnostics) {
      expect(entry).not.toContain('](');
      expect(entry).not.toContain('<a ');
      expect(entry).not.toContain('<img ');
      expect(entry).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
    }
    // The line break, tab and C0 control from the file name are represented by
    // their visible escapes, not by raw control bytes.
    expect(diagnostics[1]).toContain('\\n');
    expect(diagnostics[1]).toContain('\\t');
    expect(diagnostics[1]).toContain('\\u0001');
  });

  it('preserves offline external classification without fetching', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageHardeningFixture(root, server.url);
    const summaryPath = join(root, 'step-summary.md');
    const outputPath = join(root, 'github-output.txt');
    const findings = offlineFindings();

    const { result, guardLog, cacheFile } = await runArtifactUnderOfflineGuard(
      fixture,
      { INPUT_PATHS: '.' },
      {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    );

    // The established guard records and refuses every practical network and
    // audit-cache entry point, so a missing log is executable no-network proof,
    // not merely an empty server request list.
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(existsSync(guardLog)).toBe(false);
    expect(existsSync(cacheFile)).toBe(false);
    expect(server.requests).toEqual([]);

    const summary = readFileSync(summaryPath, 'utf8');
    expect(summaryOccurrences(summary)).toBe(1);
    expect(summary).toContain(
      '- Checked: 3\n- Broken: 67\n- External skipped: 2\n',
    );
    // The two HTTP(S) occurrences are skipped, not invented findings: no
    // external URL appears and the listed diagnostics are all local.
    expect(summary).not.toContain(server.url);
    expect(summary).not.toContain('/not-found');
    expect(listedDiagnostics(summary)).toEqual(
      findings.slice(0, 50).map(expectedSummaryDiagnostic),
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(expectedOutputs(M23_OFFLINE_COUNTS));
  });

  it('preserves external classifications with a loopback server', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageHardeningFixture(root, server.url);
    const summaryPath = join(root, 'step-summary.md');
    const outputPath = join(root, 'github-output.txt');
    const findings = externalFindings(server.url);

    try {
      const summaryRun = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath,
        outputPath,
        fetchLog: join(root, 'summary-fetch.log'),
        cacheHome: join(root, 'summary-cache'),
      });

      // Existing classifications are unchanged: one healthy 200 and one
      // terminal 404, each checked once, with no retry of the permanent
      // failure. Every attempt is a loopback GET.
      expect(summaryRun.result.status).toBe(1);
      expect(summaryRun.result.stderr).toBe('');
      expect(
        server.requests.map((request) => `${request.method} ${request.path}`).sort(),
      ).toEqual(['GET /not-found', 'GET /ok']);
      const attempts = readFetchLog(join(root, 'summary-fetch.log'));
      expect(attempts).toHaveLength(2);
      for (const attempt of attempts) {
        expect(attempt.decision).toBe('allowed');
        expect(new URL(attempt.url).origin).toBe(server.url);
      }
      expect(server.requests).toHaveLength(2);

      const summary = readFileSync(summaryPath, 'utf8');
      expect(summaryOccurrences(summary)).toBe(1);
      expect(summary).toContain(
        '- Checked: 3\n- Broken: 68\n- External skipped: 0\n',
      );
      const listed = listedDiagnostics(summary);
      expect(listed).toEqual(findings.slice(0, 50).map(expectedSummaryDiagnostic));
      const externalEntry = expectedSummaryDiagnostic(findings[4]!);
      expect(externalEntry).toContain('not\\-found');
      expect(listed).toContain(externalEntry);
      expect(summary).not.toContain('/ok');
      expect(readFileSync(outputPath, 'utf8')).toBe(
        expectedOutputs(M23_EXTERNAL_COUNTS),
      );

      // Differential control: the same fixture without a summary destination
      // performs exactly the same two requests and nothing more. Formatting and
      // appending the summary therefore added no transport of its own.
      const requestsAfterSummaryRun = server.requests.length;
      const noSummary = await invokeArtifact({
        fixture,
        external: 'true',
        summaryPath: undefined,
        outputPath: join(root, 'no-summary-output.txt'),
        fetchLog: join(root, 'no-summary-fetch.log'),
        cacheHome: join(root, 'no-summary-cache'),
      });
      expect(noSummary.result.status).toBe(1);
      expect(noSummary.result.stdout).toBe(
        `${expectedActionStdout(findings, M23_EXTERNAL_COUNTS, true)}${UNAVAILABLE_WARNING}`,
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

  it('preserves v03 action surfaces while adding the summary', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const summaryPath = join(root, 'step-summary.md');
    const outputPath = join(root, 'github-output.txt');

    // Frozen v0.3 CLI text and JSON, from the checked-in historical fixture.
    const cliText = await runCli(['--', '.'], { cwd: fixture });
    expect(cliText.status).toBe(1);
    expect(cliText.stderr).toBe('');
    expect(cliText.stdout).toBe(M17_CLI_TEXT);

    const cliJson = await runCli(['--json', '--', '.'], { cwd: fixture });
    expect(cliJson.status).toBe(1);
    expect(cliJson.stderr).toBe('');
    expect(cliJson.stdout).toBe(M17_CLI_JSON);

    // The action's printed bytes, annotation lines and outputs are exactly the
    // frozen v0.3 bytes, in order; only the summary file is new.
    const action = await runM17Action({
      cwd: fixture,
      outputPath,
      stepSummaryPath: summaryPath,
    });
    expect(action.status).toBe(1);
    expect(action.stdout).toBe(M17_ACTION_STDOUT);
    expect(action.stderr).toBe('');
    expect(action.stdout.slice(0, M17_CLI_TEXT.length)).toBe(M17_CLI_TEXT);
    expect(action.stdout.slice(M17_CLI_TEXT.length)).toBe(
      M17_FINDINGS.map(expectedAnnotation).join('\n') + '\n',
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(M17_ACTION_OUTPUTS);

    const summary = readFileSync(summaryPath, 'utf8');
    expect(summaryOccurrences(summary)).toBe(1);
    expect(summary).toBe(expectedSummary(M17_SUMMARY, M17_FINDINGS));
    expect(listedDiagnostics(summary)).toHaveLength(M17_FINDINGS.length);

    // Clean and usage outcomes keep exits 0 and 2 while the summary stays
    // action-only.
    const cleanRoot = join(root, 'clean');
    writeFiles(cleanRoot, { 'README.md': '# Clean fixture\n' });
    const cleanSummary = join(root, 'clean-summary.md');
    const clean = await runAction({
      cwd: cleanRoot,
      inputs: { INPUT_PATHS: '.' },
      env: { GITHUB_OUTPUT: join(root, 'clean-output.txt'), GITHUB_STEP_SUMMARY: cleanSummary },
    });
    expect(clean.status).toBe(0);
    expect(clean.stderr).toBe('');
    expect(clean.stdout).toBe(
      'Checked 1 file: 0 broken targets, 0 external links skipped.\n',
    );
    expect(readFileSync(cleanSummary, 'utf8')).toBe(
      expectedSummary({ filesChecked: 1, broken: 0, externalSkipped: 0 }, []),
    );

    const usageSummary = join(root, 'usage-summary.md');
    const usage = await runAction({
      cwd: cleanRoot,
      inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'maybe' },
      env: { GITHUB_OUTPUT: join(root, 'usage-output.txt'), GITHUB_STEP_SUMMARY: usageSummary },
    });
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toBe(M17_ACTION_INPUT_ERROR_STDERR);
    expect(readFileSync(usageSummary, 'utf8')).toBe(USAGE_SUMMARY);

    // Direct CLI runs write no step summary even when the destination and the
    // surrounding GitHub environment variables exist.
    const directSummary = join(root, 'direct-summary.md');
    const directOutput = join(root, 'direct-output.txt');
    writeFileSync(directSummary, 'prior unrelated step summary\n');
    writeFileSync(directOutput, 'keep=sentinel\n');
    const direct = await runCli(['--', '.'], {
      cwd: fixture,
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: directSummary,
        GITHUB_OUTPUT: directOutput,
      },
    });
    expect(direct.status).toBe(1);
    expect(direct.stdout).toBe(M17_CLI_TEXT);
    expect(direct.stderr).toBe('');
    expect(readFileSync(directSummary, 'utf8')).toBe('prior unrelated step summary\n');
    expect(readFileSync(directOutput, 'utf8')).toBe('keep=sentinel\n');
  });

  it('keeps summary failure secondary', async () => {
    const root = makeTempRoot();
    const fixture = stageHardeningFixture(root, 'http://127.0.0.1:9');
    const findings = offlineFindings();
    const outputPath = join(root, 'github-output.txt');
    const summaryDirectory = join(root, 'summary-directory');
    mkdirSync(summaryDirectory);

    const result = await runAction({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'false' },
      env: {
        ...PROXY_ISOLATION,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryDirectory,
      },
      cacheHome: join(root, 'cache-home'),
    });

    // The deterministic unwritable destination (a directory) causes exactly one
    // warning after the unchanged action stdout. The original exit, printed
    // diagnostics, annotations and outputs stay authoritative.
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `${expectedActionStdout(findings, M23_OFFLINE_COUNTS, false)}${WRITE_FAILED_WARNING}`,
    );
    expect(warningLines(result.stdout)).toEqual([WRITE_FAILED_WARNING.slice(0, -1)]);
    expect(readFileSync(outputPath, 'utf8')).toBe(expectedOutputs(M23_OFFLINE_COUNTS));
    expect(() => readFileSync(summaryDirectory, 'utf8')).toThrow();
  });

  it('starts from the authorized M23 base', () => {
    // The committed manifest pins the exact authorized base and its blob
    // hashes, so the scope check works in a shallow CI checkout where the base
    // commit itself is unavailable. This test keeps the base visible in the
    // hardening packet without depending on Git ancestry.
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'test', 'm23-base-manifest.json'), 'utf8'),
    ) as { base?: string; algorithm?: string };
    expect(manifest.base).toBe(M23_BASE_SHA);
    expect(manifest.algorithm).toBe('git-blob-sha1');
  });
});
