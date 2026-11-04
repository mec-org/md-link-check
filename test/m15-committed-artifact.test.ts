/**
 * M15 — committed action bundle interaction and freshness.
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
import { appendFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  describe,
  expect,
  it,
} from 'vitest';
import { ACTION_ARTIFACT_PATH } from './action-helpers.js';
import { REPO_ROOT } from './action-helpers.js';
import { copyActionRuntime } from './action-helpers.js';
import { makeTempRoot } from './helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import { readActionArtifactText } from './action-helpers.js';
import { runActionBuild } from './action-helpers.js';
import { startFixtureServer } from './server.js';
import { writeFiles } from './helpers.js';
import {
  SEPARATOR,
  annotationLineCount,
  cliSummary,
  createOutputPath,
  linksDocument,
  parseSummaryOutputs,
  portOf,
  runArtifact,
  runArtifactUnderOfflineGuard,
  writeMarkdown,
} from './m15-helpers.js';

describe('M15 committed artifact interaction', () => {
  it('checked-in artifact default mode performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const cacheHome = join(root, 'cache-home');
    const fetchLog = join(root, 'fetch.log');

    try {
      const omitted = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md' },
        fetchLog,
        cacheHome,
      });
      const disabled = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'false' },
        fetchLog,
        cacheHome,
      });

      expect(omitted.status).toBe(0);
      expect(disabled.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(existsSync(fetchLog)).toBe(false);
      expect(annotationLineCount(omitted.stdout)).toBe(0);
      expect(annotationLineCount(disabled.stdout)).toBe(0);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('checked-in artifact preserves skipped external results', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const secureTarget = `https://127.0.0.1:${portOf(server.url)}/secure`;
    writeMarkdown(root, linksDocument([server.urlFor('/ok'), secureTarget]));
    const outputPath = createOutputPath(root);

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'false' },
        outputPath,
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(result.stdout).toBe(cliSummary(1, 0, 2));
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

  it('checked-in artifact external success exits 0', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const outputPath = createOutputPath(root);
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(0);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
      expect(annotationLineCount(result.stdout)).toBe(0);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 0,
      });
      expect(readFileSync(fetchLog, 'utf8')).toContain('allowed http://127.0.0.1:');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('checked-in artifact terminal external failure annotates counts and exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeMarkdown(root, linksDocument([target]));
    const outputPath = createOutputPath(root);
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });
      const annotationLines = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('::error '));
      const [annotation] = annotationLines.map(parseAnnotation);

      expect(result.status).toBe(1);
      expect(server.requests).toEqual([{ method: 'GET', path: '/not-found' }]);
      expect(result.stdout).toContain(
        `README.md:3: ${target}${SEPARATOR}external HTTP 404`,
      );
      expect(annotationLines).toHaveLength(1);
      expect(annotation?.file).toBe('README.md');
      expect(annotation?.line).toBe(3);
      expect(annotation?.message).toBe(`${target}${SEPARATOR}external HTTP 404`);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
      expect(readFileSync(fetchLog, 'utf8')).toContain('allowed http://127.0.0.1:');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('checked-in artifact usage error exits 2 without request', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'maybe' },
        outputPath,
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(2);
      expect(server.requests).toEqual([]);
      expect(existsSync(fetchLog)).toBe(false);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'md-link-check: invalid action input "external": expected "true" or "false"',
      );
      expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
      expect(`${result.stdout}${result.stderr}`).not.toContain('::error ');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('checked-in artifact external tests contact only loopback', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
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
      expect(server.closed).toBe(true);
    }
  });

  it('checked-in artifact works from a separate consumer workspace', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const consumer = join(root, 'consumer-workspace');
    const artifactPath = copyActionRuntime(actionCheckout);
    writeMarkdown(consumer, linksDocument([server.urlFor('/ok')]));
    const outputPath = join(root, 'consumer-output.txt');

    try {
      const result = await runArtifact({
        cwd: consumer,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath,
        cacheHome: join(root, 'cache-home'),
        artifactPath,
      });

      expect(result.status).toBe(0);
      expect(existsSync(join(actionCheckout, 'node_modules'))).toBe(false);
      expect(existsSync(join(consumer, 'node_modules'))).toBe(false);
      expect(existsSync(join(consumer, 'github-output.txt'))).toBe(false);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default mode performs no DNS or socket access', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const secureTarget = `https://127.0.0.1:${portOf(server.url)}/secure`;
    writeMarkdown(root, linksDocument([server.urlFor('/ok'), secureTarget]));

    try {
      const { result, guardLog } = await runArtifactUnderOfflineGuard(root, {
        INPUT_PATHS: 'README.md',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(cliSummary(1, 0, 2));
      expect(server.requests).toEqual([]);
      expect(existsSync(guardLog)).toBe(false);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('default mode does not read or write the external cache', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const sentinel = '{"keep":"sentinel"}\n';
    const cacheFile = join(root, 'audit-cache', 'md-link-check', 'external-v1.json');
    writeFiles(root, { 'audit-cache/md-link-check/external-v1.json': sentinel });

    try {
      const { result, guardLog } = await runArtifactUnderOfflineGuard(root, {
        INPUT_PATHS: 'README.md',
      });

      expect(result.status).toBe(0);
      expect(readFileSync(cacheFile, 'utf8')).toBe(sentinel);
      expect(existsSync(guardLog)).toBe(false);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('offline guard control observes network access', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/ok');
    writeMarkdown(root, linksDocument([target]));

    try {
      const { result, guardLog } = await runArtifactUnderOfflineGuard(root, {
        INPUT_PATHS: 'README.md',
        INPUT_EXTERNAL: 'true',
      });

      // The guard refuses the loopback request too, proving it is live; the
      // resulting network failure is the existing bounded classification.
      expect(result.status).toBe(1);
      expect(existsSync(guardLog)).toBe(true);
      expect(readFileSync(guardLog, 'utf8')).toContain('"api":"fetch"');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});

describe('M15 committed artifact freshness', () => {
  it('checked-in action artifact is current', async () => {
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('action entrypoint is reproducible');
    expect(result.stderr).toBe('');
  });

  it('action entrypoint rebuild is byte reproducible', async () => {
    const root = makeTempRoot();
    const first = join(root, 'first.cjs');
    const second = join(root, 'second.cjs');

    const firstBuild = await runActionBuild(['--outfile', first]);
    expect(firstBuild.status, firstBuild.stderr).toBe(0);
    const secondBuild = await runActionBuild(['--outfile', second]);
    expect(secondBuild.status, secondBuild.stderr).toBe(0);

    const firstBytes = readFileSync(first);
    const secondBytes = readFileSync(second);
    expect(firstBytes.length).toBeGreaterThan(0);
    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(firstBytes.equals(readFileSync(ACTION_ARTIFACT_PATH))).toBe(true);
  });

  it('action reproducibility check leaves no diff', async () => {
    const check = await runActionBuild(['--check']);
    const status = execFileSync('git', ['status', '--porcelain', '--', 'action-dist/index.cjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    expect(check.status, check.stderr).toBe(0);
    expect(status).toBe('');
  });

  it('stale action artifact is rejected', async () => {
    const root = makeTempRoot();
    const stale = join(root, 'index.cjs');
    copyFileSync(ACTION_ARTIFACT_PATH, stale);
    appendFileSync(stale, '\n// stale artifact\n');

    const result = await runActionBuild(['--check', '--artifact', stale]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('action artifact is stale');
    expect(result.stderr).toContain(stale);
  });

  it('checked-in entrypoint contains no absolute worktree path or timestamp', () => {
    const artifact = readActionArtifactText();

    expect(artifact).not.toContain(REPO_ROOT);
    expect(artifact).not.toMatch(/\/home\//);
    expect(artifact).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

