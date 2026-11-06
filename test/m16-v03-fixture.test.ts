/**
 * M16 — v0.3 multi-file fixture regression.
 *
 * One repository-contained fixture exercises several Markdown files, broken
 * and valid files, images, heading anchors, duplicate headings, explicit HTML
 * anchors, supported raw HTML links and images, reference-style targets,
 * skipped external occurrences, and loopback external success and terminal
 * failure. Every surface is compared against the same frozen finding list:
 * text, JSON, workflow annotations, action outputs and exits.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runArtifact } from './m15-helpers.js';
import {
  splitActionOutput,
  parseSummaryOutputs,
} from './m15-helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import { runCli } from './action-helpers.js';
import { makeTempRoot } from './helpers.js';
import { startFixtureServer } from './server.js';
import {
  M16_LOCAL_FINDINGS,
  M16_LOCAL_JSON,
  M16_LOCAL_TEXT,
  m16ExternalFindings,
  parseTextDiagnostics,
  stageFixture,
} from './m16-helpers.js';

interface JsonReport {
  version: number;
  ok: boolean;
  exitCode: number;
  summary: { filesChecked: number; broken: number; externalSkipped: number };
  external: {
    enabled: boolean;
    occurrences: number;
    skipped: number;
    distinctChecked: number;
    succeeded: number;
    failed: number;
    brokenOccurrences: number;
  };
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    kind: string;
    target: string;
    reason: string;
  }>;
}

function parseReport(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

function projectDiagnostics(report: JsonReport) {
  return report.diagnostics.map(({ file, line, target, reason }) => ({
    file,
    line,
    target,
    reason,
  }));
}

describe('M16 v0.3 multi-file fixture', () => {
  it('v0.3 fixture checks several Markdown files', async () => {
    const fixture = stageFixture(makeTempRoot());
    const result = await runCli(['--json', '.'], { cwd: fixture });
    const report = parseReport(result.stdout);

    expect(result.status).toBe(1);
    expect(report.summary.filesChecked).toBe(4);
    expect(new Set(report.diagnostics.map((diagnostic) => diagnostic.file))).toEqual(
      new Set(['README.md', 'docs/api.md', 'docs/guide.md', 'docs/plan/notes.md']),
    );
  });

  it('v0.3 fixture reports several findings', async () => {
    const fixture = stageFixture(makeTempRoot());
    const result = await runCli(['--json', '.'], { cwd: fixture });

    expect(result.status).toBe(1);
    expect(parseReport(result.stdout)).toEqual(M16_LOCAL_JSON);
    expect(M16_LOCAL_FINDINGS).toHaveLength(16);
  });

  it('v0.3 fixture reports broken files images and anchors', async () => {
    const fixture = stageFixture(makeTempRoot());
    const report = parseReport((await runCli(['--json', '.'], { cwd: fixture })).stdout);

    const fileFindings = report.diagnostics.filter(
      (diagnostic) => diagnostic.reason === 'target does not exist' && diagnostic.kind === 'link',
    );
    const imageFindings = report.diagnostics.filter(
      (diagnostic) => diagnostic.kind === 'image',
    );
    const anchorFindings = report.diagnostics.filter(
      (diagnostic) => diagnostic.reason === 'anchor does not exist',
    );

    expect(fileFindings.map((diagnostic) => diagnostic.target).sort()).toEqual(
      [
        '../missing-plan.md',
        'docs/missing-raw.md',
        'docs/missing-ref.md',
        'docs/missing.md',
        'missing-api.md',
      ].sort(),
    );
    expect(imageFindings.map((diagnostic) => diagnostic.target).sort()).toEqual(
      ['../images/missing-logo.png', 'images/missing-raw.png', 'images/missing.png'].sort(),
    );
    expect(anchorFindings.map((diagnostic) => diagnostic.target).sort()).toEqual(
      [
        '#duplicate-2',
        '#installation-1',
        '#missing-anchor',
        '../README.md#missing',
        '../guide.md#plan-notes',
        'docs/guide.md#deployment',
        'guide.md#installation-1',
        'guide.md#not-a-heading',
      ].sort(),
    );
  });

  it('v0.3 fixture combines Markdown and supported raw HTML', async () => {
    const fixture = stageFixture(makeTempRoot());
    const report = parseReport((await runCli(['--json', '.'], { cwd: fixture })).stdout);
    const targets = new Set(report.diagnostics.map((diagnostic) => diagnostic.target));
    const kindsByTarget = new Map(
      report.diagnostics.map((diagnostic) => [diagnostic.target, diagnostic.kind]),
    );

    expect(kindsByTarget.get('docs/missing-raw.md')).toBe('link');
    expect(kindsByTarget.get('images/missing-raw.png')).toBe('image');
    expect(kindsByTarget.get('docs/missing-ref.md')).toBe('link');

    for (const validTarget of [
      'docs/api.md',
      'docs/guide.md#installation',
      'docs/guide.md#explicit-target',
      'docs/api.md#api-explicit',
      '#m16-multi-file-fixture',
      '#duplicate',
      '#duplicate-1',
      '#explicit-one',
      'images/logo.png',
      'plan/notes.md#plan-notes',
    ]) {
      expect(targets.has(validTarget)).toBe(false);
    }

    const readme = readFileSync(join(fixture, 'README.md'), 'utf8');
    expect(readme).toContain('<a href="docs/api.md">');
    expect(readme).toContain('<img src="images/logo.png"');
    expect(readme).toContain('<a id="explicit-one"></a>');
  });

  it('v0.3 fixture combines local and external results', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });
    const outputPath = join(root, 'github-output.txt');
    const fetchLog = join(root, 'fetch.log');
    const expectedFindings = m16ExternalFindings(server.url);

    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });
      const { cli, annotations } = splitActionOutput(
        result.stdout,
        expectedFindings.length,
      );

      expect(result.status).toBe(1);
      expect(parseTextDiagnostics(cli)).toEqual(expectedFindings);
      expect(annotations).toHaveLength(expectedFindings.length);
      expect(annotations.map((annotation) => parseAnnotation(annotation))).toEqual(
        expectedFindings.map((finding) =>
          expect.objectContaining({
            file: finding.file,
            line: finding.line,
            message: `${finding.target} — ${finding.reason}`,
          }),
        ),
      );
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 4,
        broken: 18,
        externalSkipped: 0,
      });
      expect(cli).toContain('Checked 4 files: 18 broken targets, 0 external links skipped.');
      expect(cli).toContain(
        'External checks: 4 occurrences, 2 distinct targets checked (1 succeeded, 1 failed), 2 broken occurrences.',
      );
      expect(
        server.requests
          .map((request) => request.path)
          .sort(),
      ).toEqual(['/fail', '/ok']);
      expect(readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
      expect(readFileSync(fetchLog, 'utf8')).toContain('allowed http://127.0.0.1:');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('v0.3 fixture preserves deterministic result order', async () => {
    const fixture = stageFixture(makeTempRoot());
    const first = await runCli(['.'], { cwd: fixture });
    const second = await runCli(['.'], { cwd: fixture });
    const firstJson = await runCli(['--json', '.'], { cwd: fixture });
    const secondJson = await runCli(['--json', '.'], { cwd: fixture });

    expect(first.status).toBe(1);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toBe(M16_LOCAL_TEXT);
    expect(firstJson.stdout).toBe(secondJson.stdout);
    expect(parseTextDiagnostics(first.stdout)).toEqual(M16_LOCAL_FINDINGS);
    expect(projectDiagnostics(parseReport(firstJson.stdout))).toEqual(M16_LOCAL_FINDINGS);
  });

  it('v0.3 fixture text JSON annotations and outputs agree', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const textRun = await runCli(['.'], { cwd: fixture });
    const jsonRun = await runCli(['--json', '.'], { cwd: fixture });
    const report = parseReport(jsonRun.stdout);
    const outputPath = join(root, 'github-output.txt');

    const actionRun = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
      cacheHome: join(root, 'cache-home'),
    });
    const { cli, annotations } = splitActionOutput(
      actionRun.stdout,
      M16_LOCAL_FINDINGS.length,
    );

    expect(textRun.status).toBe(1);
    expect(jsonRun.status).toBe(1);
    expect(actionRun.status).toBe(1);
    expect(parseTextDiagnostics(textRun.stdout)).toEqual(
      projectDiagnostics(report),
    );
    expect(cli).toBe(textRun.stdout);
    expect(annotations.map((annotation) => parseAnnotation(annotation))).toEqual(
      M16_LOCAL_FINDINGS.map((finding) =>
        expect.objectContaining({
          file: finding.file,
          line: finding.line,
          message: `${finding.target} — ${finding.reason}`,
        }),
      ),
    );
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(
      report.summary,
    );
  });

  it('v0.3 fixture preserves duplicate occurrence behavior', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });

    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'true' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });
      const expectedFindings = m16ExternalFindings(server.url);
      const { annotations } = splitActionOutput(result.stdout, expectedFindings.length);
      const parsed = annotations.map((annotation) => parseAnnotation(annotation));
      const duplicateFailures = parsed.filter(
        (annotation) => annotation.message === `http://127.0.0.1:${new URL(server.url).port}/fail — external HTTP 404`,
      );

      expect(result.status).toBe(1);
      expect(duplicateFailures).toHaveLength(2);
      expect(new Set(duplicateFailures.map((annotation) => annotation.line))).toEqual(
        new Set([11]),
      );
      expect(
        server.requests.filter((request) => request.path === '/fail'),
      ).toHaveLength(1);
      expect(
        parseTextDiagnostics(
          splitActionOutput(result.stdout, expectedFindings.length).cli,
        ).filter((finding) => finding.target.endsWith('/fail')),
      ).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('v0.3 fixture remains deterministic across repeated runs', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const firstOutput = join(root, 'output-1.txt');
    const secondOutput = join(root, 'output-2.txt');

    const firstCli = await runCli(['.'], { cwd: fixture });
    const secondCli = await runCli(['.'], { cwd: fixture });
    const firstAction = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: firstOutput,
      cacheHome: join(root, 'cache-1'),
    });
    const secondAction = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: secondOutput,
      cacheHome: join(root, 'cache-2'),
    });

    expect(secondCli.stdout).toBe(firstCli.stdout);
    expect(firstCli.stderr).toBe('');
    expect(secondCli.stderr).toBe('');
    expect(secondAction.stdout).toBe(firstAction.stdout);
    expect(secondAction.stderr).toBe('');
    expect(readFileSync(secondOutput, 'utf8')).toBe(readFileSync(firstOutput, 'utf8'));
    expect(firstAction.stdout.startsWith(firstCli.stdout)).toBe(true);
  });
});
