/**
 * M16 — v0.3 direct-CLI compatibility, action annotation/output and mutation
 * contract.
 *
 * The fixture's findings are frozen in `test/m16-helpers.ts`. These tests prove
 * the direct CLI surface stayed text/JSON/exit-compatible and free of workflow
 * commands, the action emitted one annotation per finding in result order and
 * published exactly the documented outputs, the default mode performed no
 * network or cache access, external tests used loopback only, and checking a
 * read-only workspace created or modified no file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REPO_ROOT,
  runCli,
} from './action-helpers.js';
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import {
  ANNOTATION_LIMITS,
  TRUNCATION_MARKER,
  formatAnnotation,
} from '../src/annotation.js';
import { parseAnnotation } from './m11-helpers.js';
import {
  OFFLINE_GUARD_PATH,
  annotationLineCount,
  parseSummaryOutputs,
  runArtifact,
  runArtifactUnderOfflineGuard,
  splitActionOutput,
} from './m15-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { startFixtureServer } from './server.js';
import {
  M16_LOCAL_FINDINGS,
  M16_LOCAL_JSON,
  M16_LOCAL_TEXT,
  makeTreeReadOnly,
  makeTreeWritable,
  stageFixture,
  treeInventory,
} from './m16-helpers.js';

const USAGE_ERROR_TEXT =
  'md-link-check: no input paths\n\n' +
  'Usage: md-link-check [--json] [--external] <path...>\n' +
  'Run "md-link-check --help" for usage and exit codes.\n';

interface JsonReport {
  summary: { filesChecked: number; broken: number; externalSkipped: number };
  external: {
    enabled: boolean;
    occurrences: number;
    skipped: number;
    cache: { enabled: boolean };
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

function makeCleanFixture(root: string): string {
  writeFiles(root, {
    'README.md': '# Clean\n\n[guide](docs/guide.md), [details](#details)\n\n![logo](images/logo.png)\n\n## Details\n',
    'docs/guide.md': '# Guide\n\n[home](../README.md#clean)\n',
    'images/logo.png': '',
  });
  return root;
}

function readActionsYamlOutputs(): string[] {
  const metadata = readFileSync(join(REPO_ROOT, 'action.yml'), 'utf8');
  const outputsBlock = metadata.split(/^outputs:\n/m)[1]?.split(/^runs:\n/m)[0];
  if (outputsBlock === undefined) {
    throw new Error('action.yml has no outputs block');
  }
  const names: string[] = [];
  for (const line of outputsBlock.split('\n')) {
    const match = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
    if (match !== null) {
      names.push(match[1] ?? '');
    }
  }
  return names;
}

function actionAnnotations(stdout: string, findingCount: number): string[] {
  return splitActionOutput(stdout, findingCount).annotations;
}

describe('M16 v0.3 direct CLI compatibility', () => {
  it('v0.3 direct CLI text is unchanged', async () => {
    const fixture = stageFixture(makeTempRoot());
    const result = await runCli(['.'], { cwd: fixture });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(M16_LOCAL_TEXT);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toMatch(/^::/m);
  });

  it('v0.3 direct CLI JSON is unchanged', async () => {
    const fixture = stageFixture(makeTempRoot());
    const result = await runCli(['--json', '.'], { cwd: fixture });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${JSON.stringify(M16_LOCAL_JSON, null, 2)}\n`);
    expect(result.stderr).toBe('');
    expect(parseReport(result.stdout).diagnostics.length).toBe(16);
  });

  it('v0.3 direct CLI exits remain 0 1 and 2', async () => {
    const clean = makeCleanFixture(makeTempRoot());
    const fixture = stageFixture(makeTempRoot());

    const cleanRun = await runCli(['.'], { cwd: clean });
    const brokenRun = await runCli(['.'], { cwd: fixture });
    const usageRun = await runCli([], { cwd: makeTempRoot() });

    expect(cleanRun.status).toBe(0);
    expect(cleanRun.stdout).toBe('Checked 2 files: 0 broken targets, 0 external links skipped.\n');
    expect(brokenRun.status).toBe(1);
    expect(usageRun.status).toBe(2);
    expect(usageRun.stderr).toBe(USAGE_ERROR_TEXT);
  });

  it('v0.3 direct CLI emits no workflow command', async () => {
    const fixture = stageFixture(makeTempRoot());
    const outputPath = join(makeTempRoot(), 'github-output.txt');
    const result = await runCli(['.'], {
      cwd: fixture,
      env: { GITHUB_OUTPUT: outputPath },
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/^::|::error |::warning /m);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('v0.3 direct CLI writes no action output', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    writeFiles(root, { 'github-output.txt': 'keep=sentinel\n' });
    const before = treeInventory(fixture);
    const result = await runCli(['.'], {
      cwd: fixture,
      env: { GITHUB_OUTPUT: outputPath },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
    expect(treeInventory(fixture)).toEqual(before);
  });

  it('v0.3 direct CLI remains offline by default', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Offline\n\n[ok](${server.urlFor('/ok')})\n`,
    });
    const guardLog = join(root, 'guard.log');
    const cacheRoot = join(root, 'cache');
    const outputPath = join(root, 'github-output.txt');

    try {
      const result = await runCli(['--json', '.'], {
        cwd: root,
        env: {
          GITHUB_OUTPUT: outputPath,
          XDG_CACHE_HOME: cacheRoot,
          MDLC_ACCEPTANCE_GUARD_LOG: guardLog,
          MDLC_ACCEPTANCE_CACHE_ROOT: cacheRoot,
        },
        requires: [OFFLINE_GUARD_PATH],
      });
      const report = parseReport(result.stdout);

      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(existsSync(guardLog)).toBe(false);
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(cacheRoot)).toBe(false);
      expect(report.external).toMatchObject({
        enabled: false,
        occurrences: 1,
        skipped: 1,
        cache: { enabled: false },
      });
      expect(report.summary).toEqual({ filesChecked: 1, broken: 0, externalSkipped: 1 });
    } finally {
      await server.close();
    }
  });
});

describe('M16 v0.3 action annotations and outputs', () => {
  it('v0.3 action emits one annotation per broken finding', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });

    expect(result.status).toBe(1);
    expect(annotationLineCount(result.stdout)).toBe(M16_LOCAL_FINDINGS.length);
    expect(actionAnnotations(result.stdout, M16_LOCAL_FINDINGS.length)).toHaveLength(
      M16_LOCAL_FINDINGS.length,
    );
  });

  it('v0.3 annotations include file line target and reason', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });
    const parsed = actionAnnotations(result.stdout, M16_LOCAL_FINDINGS.length).map(
      (annotation) => parseAnnotation(annotation),
    );

    expect(parsed.length).toBe(M16_LOCAL_FINDINGS.length);
    for (const [index, finding] of M16_LOCAL_FINDINGS.entries()) {
      expect(parsed[index]?.file).toBe(finding.file);
      expect(parsed[index]?.line).toBe(finding.line);
      expect(parsed[index]?.message).toBe(`${finding.target} — ${finding.reason}`);
    }
  });

  it('v0.3 annotation order matches structured result order', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });
    const parsed = actionAnnotations(result.stdout, M16_LOCAL_FINDINGS.length).map(
      (annotation) => parseAnnotation(annotation),
    );

    expect(
      parsed.map((annotation) => [annotation.file, annotation.line, annotation.message]),
    ).toEqual(
      M16_LOCAL_FINDINGS.map((finding) => [
        finding.file,
        finding.line,
        `${finding.target} — ${finding.reason}`,
      ]),
    );
  });

  it('v0.3 clean run emits no annotation', async () => {
    const root = makeTempRoot();
    const fixture = makeCleanFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });

    expect(result.status).toBe(0);
    expect(annotationLineCount(result.stdout)).toBe(0);
    expect(result.stdout).toBe('Checked 2 files: 0 broken targets, 0 external links skipped.\n');
  });

  it('v0.3 usage error emits no broken-link annotation', async () => {
    const root = makeTempRoot();
    const fixture = makeCleanFixture(root);
    const outputPath = join(root, 'github-output.txt');
    writeFiles(root, { 'github-output.txt': 'keep=sentinel\n' });
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '' },
      outputPath,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_ERROR_TEXT);
    expect(`${result.stdout}${result.stderr}`).not.toContain('::error ');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('v0.3 skipped external occurrences emit no annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });
    const outputPath = join(root, 'github-output.txt');

    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.' },
        outputPath,
        cacheHome: join(root, 'cache-home'),
      });
      const annotations = actionAnnotations(result.stdout, M16_LOCAL_FINDINGS.length);

      expect(result.status).toBe(1);
      expect(server.requests).toEqual([]);
      expect(annotations).toHaveLength(16);
      expect(annotations.join('\n')).not.toContain(server.url);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 4,
        broken: 16,
        externalSkipped: 4,
      });
    } finally {
      await server.close();
    }
  });

  it('v0.3 terminal external failures emit annotations', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });
    const outputPath = join(root, 'github-output.txt');

    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });
      const expected = 18;
      const annotations = actionAnnotations(result.stdout, expected).map((annotation) =>
        parseAnnotation(annotation),
      );

      expect(result.status).toBe(1);
      expect(annotations).toHaveLength(expected);
      expect(annotations.filter((annotation) => annotation.message.includes('/fail'))).toHaveLength(2);
      expect(annotations.filter((annotation) => annotation.message.includes('/ok'))).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('v0.3 annotation values remain safely escaped and bounded', () => {
    const finding = {
      file: 'docs/a,b:c%0A.md',
      line: 3,
      target: '#anchor%0A::error',
      reason: 'reason with % and \r\n line breaks',
    };
    const annotation = formatAnnotation(finding);
    const parsed = parseAnnotation(annotation);

    expect(annotation).not.toContain('\n');
    expect(annotation).not.toContain('\r');
    expect(parsed.file).toBe(finding.file);
    expect(parsed.line).toBe(3);
    expect(parsed.message).toBe(`${finding.target} — ${finding.reason}`);

    const long = formatAnnotation({
      file: 'x'.repeat(10_000),
      line: 1,
      target: 't'.repeat(20_000),
      reason: 'r'.repeat(20_000),
    });
    expect(long).not.toContain('\n');
    expect(long.startsWith('::error file=')).toBe(true);
    expect(long.endsWith(TRUNCATION_MARKER)).toBe(true);
    const property = /^::error file=([^,]*,)?line=/.exec(long)?.[1] ?? '';
    expect(property.length).toBeLessThanOrEqual(ANNOTATION_LIMITS.file + 1);
    expect(ANNOTATION_LIMITS.message).toBe(16_384);
    expect(ANNOTATION_LIMITS.file).toBe(4_096);
  });

  it('v0.3 clean run publishes every documented output', async () => {
    const root = makeTempRoot();
    const fixture = makeCleanFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });
    const text = readFileSync(outputPath, 'utf8');

    expect(result.status).toBe(0);
    expect(parseSummaryOutputs(text)).toEqual({ filesChecked: 2, broken: 0, externalSkipped: 0 });
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(3);
  });

  it('v0.3 broken run publishes every documented output', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(result.status).toBe(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 4,
      broken: 16,
      externalSkipped: 4,
    });
  });

  it('v0.3 offline run publishes established skipped counts', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(result.status).toBe(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).externalSkipped).toBe(4);
  });

  it('v0.3 external run publishes established checked counts', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });
    const outputPath = join(root, 'github-output.txt');

    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(1);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 4,
        broken: 18,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('v0.3 output values match structured summaries', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const jsonRun = await runCli(['--json', '.'], { cwd: fixture });
    const report = parseReport(jsonRun.stdout);
    await runArtifact({ cwd: fixture, inputs: { INPUT_PATHS: '.' }, outputPath });

    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(report.summary);
  });

  it('v0.3 output names match action metadata', () => {
    expect(readActionsYamlOutputs().sort()).toEqual(
      Object.values(SUMMARY_OUTPUT_NAMES).sort(),
    );
  });

  it('v0.3 output environment-file encoding remains valid', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    await runArtifact({ cwd: fixture, inputs: { INPUT_PATHS: '.' }, outputPath });
    const text = readFileSync(outputPath, 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    const records = text.split('\n').filter((line) => line !== '');
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatch(/^(?:files-checked|broken|external-skipped)=(?:0|[1-9][0-9]*)$/);
    }
    expect(parseSummaryOutputs(text)).toEqual({
      filesChecked: 4,
      broken: 16,
      externalSkipped: 4,
    });
  });

  it('v0.3 adds removes and renames no established output', () => {
    const expected = ['files-checked', 'broken', 'external-skipped'];
    expect(readActionsYamlOutputs().sort()).toEqual([...expected].sort());
    expect(Object.values(SUMMARY_OUTPUT_NAMES).sort()).toEqual([...expected].sort());
  });

  it('v0.3 clean action exits 0', async () => {
    const root = makeTempRoot();
    const fixture = makeCleanFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });
    expect(result.status).toBe(0);
  });

  it('v0.3 broken action exits 1', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });
    expect(result.status).toBe(1);
  });

  it('v0.3 usage error exits 2', async () => {
    const root = makeTempRoot();
    const fixture = makeCleanFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '' },
      outputPath: join(root, 'github-output.txt'),
    });
    expect(result.status).toBe(2);
  });

  it('v0.3 broken exit retains annotations and outputs', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(result.status).toBe(1);
    expect(annotationLineCount(result.stdout)).toBe(16);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(16);
  });

  it('v0.3 diagnostic text remains unchanged', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(root, 'github-output.txt'),
    });
    expect(splitActionOutput(result.stdout, M16_LOCAL_FINDINGS.length).cli).toBe(
      M16_LOCAL_TEXT,
    );
  });

  it('v0.3 usage text remains unchanged', async () => {
    const root = makeTempRoot();
    const fixture = makeCleanFixture(root);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '' },
      outputPath: join(root, 'github-output.txt'),
    });
    expect(splitActionOutput(result.stdout, 0).cli).toBe('');
    expect(result.stderr).toBe(USAGE_ERROR_TEXT);
  });
});

describe('M16 v0.3 offline and external mode guards', () => {
  it('v0.3 default action performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': `# Offline\n\n[ok](${server.urlFor('/ok')})\n` });

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });
      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(existsSync(join(root, 'fetch.log'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('v0.3 default action performs no DNS or socket access', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Offline\n\n[ok](https://example.com/never-requested)\n',
    });
    const { result, guardLog } = await runArtifactUnderOfflineGuard(root, {
      INPUT_PATHS: 'README.md',
    });

    expect(result.status).toBe(0);
    expect(existsSync(guardLog)).toBe(false);
    expect(result.stdout).toBe(
      'Checked 1 file: 0 broken targets, 1 external link skipped.\n',
    );
  });

  it('v0.3 default action does not access the external cache', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Offline\n\n[ok](https://example.com/never-requested)\n',
    });
    const { result, guardLog, cacheFile } = await runArtifactUnderOfflineGuard(root, {
      INPUT_PATHS: 'README.md',
    });

    expect(result.status).toBe(0);
    expect(existsSync(cacheFile)).toBe(false);
    expect(existsSync(guardLog)).toBe(false);
  });

  it('v0.3 external tests use loopback only', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    stageFixture(root, { externalBaseUrl: server.url });
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: join(root, 'fixture'),
        inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'true' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });
      const logged = readFileSync(fetchLog, 'utf8')
        .split('\n')
        .filter((line) => line !== '');

      expect(result.status).toBe(1);
      expect(logged.length).toBeGreaterThan(0);
      for (const line of logged) {
        expect(line).toMatch(/^allowed http:\/\/127\.0\.0\.1:\d+\//);
      }
      expect(logged.some((line) => line.startsWith('refused '))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('v0.3 external success remains clean', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Clean\n\n[ok](${server.urlFor('/ok')})\n`,
    });
    const outputPath = join(root, 'github-output.txt');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(0);
      expect(annotationLineCount(result.stdout)).toBe(0);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('v0.3 terminal external failure exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Broken\n\n[missing](${server.urlFor('/not-found')})\n`,
    });

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });
      expect(result.status).toBe(1);
      expect(annotationLineCount(result.stdout)).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('v0.3 retry success produces no final annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Flaky\n\n[ok](${server.urlFor('/flaky')})\n`,
    });

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(0);
      expect(annotationLineCount(result.stdout)).toBe(0);
      expect(server.requests.filter((request) => request.path === '/flaky')).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('v0.3 retry exhaustion produces one final finding per occurrence', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/always-flaky');
    writeFiles(root, {
      'README.md': `# Exhausted\n\n[one](${target}) and [two](${target})\n`,
    });

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog: join(root, 'fetch.log'),
        cacheHome: join(root, 'cache-home'),
      });
      const annotations = actionAnnotations(result.stdout, 2).map((annotation) =>
        parseAnnotation(annotation),
      );

      expect(result.status).toBe(1);
      expect(annotations).toHaveLength(2);
      expect(annotations.every((annotation) => annotation.message.includes(target))).toBe(true);
      expect(server.requests.filter((request) => request.path === '/always-flaky')).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('v0.3 external cache tests use isolated temporary paths', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });
    const cacheHome = join(root, 'cache-home');
    const before = treeInventory(fixture);

    try {
      await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'true' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog: join(root, 'fetch.log'),
        cacheHome,
      });
      expect(existsSync(join(cacheHome, 'md-link-check', 'external-v1.json'))).toBe(true);
      expect(treeInventory(fixture)).toEqual(before);
    } finally {
      await server.close();
    }
  });

  it('checking a read-only fixture creates no file', async () => {
    const fixture = stageFixture(makeTempRoot());
    const before = treeInventory(fixture);
    makeTreeReadOnly(fixture);
    try {
      const result = await runCli(['.'], { cwd: fixture });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe(M16_LOCAL_TEXT);
    } finally {
      makeTreeWritable(fixture);
    }
    expect(treeInventory(fixture)).toEqual(before);
  });

  it('checking a read-only fixture modifies no file', async () => {
    const fixture = stageFixture(makeTempRoot());
    const before = treeInventory(fixture);
    makeTreeReadOnly(fixture);
    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.' },
        outputPath: join(makeTempRoot(), 'github-output.txt'),
      });
      expect(result.status).toBe(1);
    } finally {
      makeTreeWritable(fixture);
    }
    expect(treeInventory(fixture)).toEqual(before);
  });

  it('offline action checking creates no cache in the checked repository', async () => {
    const fixture = makeCleanFixture(makeTempRoot());
    const evidenceRoot = makeTempRoot();
    const before = treeInventory(fixture);
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath: join(evidenceRoot, 'github-output.txt'),
      cacheHome: join(evidenceRoot, 'cache-home'),
    });

    expect(result.status).toBe(0);
    expect(treeInventory(fixture)).toEqual(before);
    expect(existsSync(join(fixture, 'node_modules'))).toBe(false);
    expect(existsSync(join(fixture, 'md-link-check'))).toBe(false);
  });

  it('CLI output is written only to configured process streams', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const before = treeInventory(root);
    const result = await runCli(['.'], { cwd: fixture });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(M16_LOCAL_TEXT);
    expect(result.stderr).toBe('');
    expect(treeInventory(root)).toEqual(before);
  });

  it('action outputs are written only to configured GITHUB_OUTPUT file', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'configured-output.txt');
    const before = treeInventory(fixture);
    await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(existsSync(outputPath)).toBe(true);
    expect(treeInventory(fixture)).toEqual(before);
    expect(treeInventory(root)['configured-output.txt']).toBeDefined();
  });

  it('acceptance evidence is stored outside the checked repository', () => {
    const report = readFileSync(join(REPO_ROOT, 'docs', 'm16-acceptance.md'), 'utf8');

    expect(report).toContain('outside the checked repository');
    expect(report).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//);
    expect(report).not.toMatch(/\/tmp\/[A-Za-z0-9._-]+\//);
  });
});
