/**
 * M16 — v0.3 committed artifact, scope and immutable-release contract.
 *
 * The scope check compares the current tree with a committed manifest of the
 * authorized base (`test/m16-base-manifest.json`, generated from
 * 4c821d201072b3fe00ebd053605e95cf7d5e8a93). It therefore works in a shallow
 * CI checkout without fetching history, but still reports every added,
 * modified or deleted path against the base.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ARTIFACT_PATH,
  REPO_ROOT,
  copyActionRuntime,
  runActionBuild,
} from './action-helpers.js';
import { isPinnedCharterFile } from './charter-pins.js';
import {
  annotationLineCount,
  parseSummaryOutputs,
  runArtifact,
  splitActionOutput,
} from './m15-helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { startFixtureServer } from './server.js';
import {
  M16_BASE_SHA,
  M16_LOCAL_FINDINGS,
  M16_LOCAL_TEXT,
  stageFixture,
} from './m16-helpers.js';

interface BaseManifest {
  base: string;
  algorithm: string;
  paths: Record<string, string>;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readBaseManifest(): BaseManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'test', 'm16-base-manifest.json'), 'utf8'),
  ) as BaseManifest;
}

/** Every path changed from the authorized base, including the working tree. */
function changedPathsSinceBase(): string[] {
  const manifest = readBaseManifest();
  expect(manifest.base).toBe(M16_BASE_SHA);
  expect(manifest.algorithm).toBe('git-blob-sha1');

  const current = new Map<string, string>();
  for (const line of git(['ls-tree', '-r', 'HEAD']).split('\n')) {
    if (line === '') {
      continue;
    }
    const match = /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(line);
    expect(match, `unexpected git ls-tree line: ${line}`).not.toBeNull();
    current.set(match?.[2] ?? '', match?.[1] ?? '');
  }

  const changed = new Set<string>();
  for (const [path, hash] of Object.entries(manifest.paths)) {
    if (current.get(path) !== hash) {
      changed.add(path);
    }
  }
  for (const path of current.keys()) {
    if (!(path in manifest.paths)) {
      changed.add(path);
    }
  }
  for (const line of git([
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--no-renames',
  ]).split('\n')) {
    if (line !== '') {
      changed.add(line.slice(3));
    }
  }
  return [...changed].sort();
}

const ALLOWED_PATH =
  /^(?:src\/.+|test\/.+|docs\/.+|README\.md|action\.yml|action-dist\/index\.cjs)$/;

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH.test(path);
}

/**
 * Paths changed against the base that no allow rule accepts. The two
 * owner-approved v0.4 charter files are allowed only when their bytes still
 * match the pinned blob hashes in `test/charter-pins.ts`; a change to either
 * file is reported like any other out-of-scope change.
 */
function changedPathViolations(
  changed: readonly string[],
  root: string = REPO_ROOT,
): string[] {
  return changed.filter(
    (path) => !isAllowedPath(path) && !isPinnedCharterFile(path, root),
  );
}

/**
 * The owner-approved v0.3 tag and its M16 commit (owner decision, 2026-11-06).
 * A shallow CI checkout carries no tags; a full checkout may carry exactly this
 * tag. Any other `v0.3*` tag remains a release this milestone must not create.
 */
const OWNER_APPROVED_V03_TAG = 'v0.3.0';
const OWNER_APPROVED_V03_TAG_COMMIT =
  '4438906e6e6085c941faf3117c2aaca1824a073d';

describe('M16 v0.3 committed artifact', () => {
  it('v0.3 checked-in artifact handles the multi-file fixture', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });
    const { cli, annotations } = splitActionOutput(
      result.stdout,
      M16_LOCAL_FINDINGS.length,
    );

    expect(result.status).toBe(1);
    expect(cli).toBe(M16_LOCAL_TEXT);
    expect(annotations).toHaveLength(M16_LOCAL_FINDINGS.length);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 4,
      broken: 16,
      externalSkipped: 4,
    });
  });

  it('v0.3 checked-in artifact emits expected annotations and outputs', async () => {
    const root = makeTempRoot();
    const fixture = stageFixture(root);
    const outputPath = join(root, 'github-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });
    const parsed = splitActionOutput(result.stdout, M16_LOCAL_FINDINGS.length)
      .annotations.map((annotation) => parseAnnotation(annotation));

    expect(parsed.map((annotation) => annotation.file)).toEqual(
      M16_LOCAL_FINDINGS.map((finding) => finding.file),
    );
    expect(parsed.map((annotation) => annotation.line)).toEqual(
      M16_LOCAL_FINDINGS.map((finding) => finding.line),
    );
    expect(parsed.map((annotation) => annotation.message)).toEqual(
      M16_LOCAL_FINDINGS.map((finding) => `${finding.target} — ${finding.reason}`),
    );
  });

  it('v0.3 checked-in artifact default mode performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = stageFixture(root, { externalBaseUrl: server.url });
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.' },
        outputPath: join(root, 'github-output.txt'),
        fetchLog,
        cacheHome: join(root, 'cache-home'),
      });

      expect(result.status).toBe(1);
      expect(annotationLineCount(result.stdout)).toBe(16);
      expect(server.requests).toEqual([]);
      expect(existsSync(fetchLog)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('v0.3 checked-in artifact works from a separate consumer workspace', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer');
    stageFixture(consumer);
    const fixture = join(consumer, 'fixture');
    const outputPath = join(root, 'consumer-output.txt');
    const result = await runArtifact({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.' },
      artifactPath,
      outputPath,
    });

    expect(result.status).toBe(1);
    expect(annotationLineCount(result.stdout)).toBe(16);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 4,
      broken: 16,
      externalSkipped: 4,
    });
    expect(existsSync(join(actionCheckout, 'node_modules'))).toBe(false);
    expect(existsSync(join(consumer, 'node_modules'))).toBe(false);
    expect(existsSync(join(actionCheckout, 'tsconfig.json'))).toBe(false);
  });

  it('v0.3 checked-in action artifact is current', async () => {
    const result = await runActionBuild(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('action entrypoint is reproducible');
    expect(result.stderr).toBe('');
  });

  it('v0.3 action entrypoint rebuild is byte reproducible', async () => {
    const before = readFileSync(ACTION_ARTIFACT_PATH);
    const result = await runActionBuild([]);
    const after = readFileSync(ACTION_ARTIFACT_PATH);

    expect(result.status).toBe(0);
    expect(after.equals(before)).toBe(true);
    expect(after.toString('utf8')).not.toContain(REPO_ROOT);
    expect(after.toString('utf8')).not.toMatch(/\b20[0-9]{2}-[0-9]{2}-[0-9]{2}T/);
  });

  it('v0.3 action reproducibility check leaves no diff', async () => {
    const result = await runActionBuild(['--check']);
    expect(result.status).toBe(0);
    expect(git(['status', '--porcelain', '--', 'action-dist/index.cjs']).trim()).toBe('');
  });

  it('v0.3 stale action artifact is rejected', async () => {
    const root = makeTempRoot();
    const stale = join(root, 'index.cjs');
    copyFileSync(ACTION_ARTIFACT_PATH, stale);
    appendFileSync(stale, '\n// stale artifact\n');

    const result = await runActionBuild(['--check', '--artifact', stale]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('action artifact is stale');
    expect(result.stderr).toContain('npm run build:action');
  });
});

describe('M16 v0.3 changed-path scope', () => {
  it('v0.3 changes only permitted paths', () => {
    const changed = changedPathsSinceBase();

    expect(changedPathViolations(changed)).toEqual([]);
  });

  it('pinned charter files pass only with the owner-approved content', () => {
    const differing = makeTempRoot();
    writeFiles(differing, { 'PROJECT.md': '# Modified charter\n' });
    const pinned = makeTempRoot();
    writeFiles(pinned, {
      'PROJECT.md': readFileSync(join(REPO_ROOT, 'PROJECT.md'), 'utf8'),
      'ROADMAP.md': readFileSync(join(REPO_ROOT, 'ROADMAP.md'), 'utf8'),
    });

    // The exact owner-approved bytes are accepted, so the pin is not a blanket
    // exemption: the same paths with different content are reported.
    expect(changedPathViolations(['PROJECT.md', 'ROADMAP.md'], pinned)).toEqual([]);
    expect(isPinnedCharterFile('PROJECT.md', differing)).toBe(false);
    expect(changedPathViolations(['PROJECT.md'], differing)).toEqual(['PROJECT.md']);

    // The pin never widens any path other than the two charter files.
    expect(isPinnedCharterFile('README.md', pinned)).toBe(false);
  });

  it('v0.3 changes no path under github metadata', () => {
    const changed = changedPathsSinceBase();
    expect(changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('v0.3 changes no path under project metadata', () => {
    const changed = changedPathsSinceBase();
    expect(changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('v0.3 changes no package scripts or project files other than an owner-approved charter', () => {
    const changed = changedPathsSinceBase();
    for (const protectedPath of [
      'package.json',
      'package-lock.json',
      'PRD.md',
      'CONTRIBUTING.md',
      'scripts/build-action.mjs',
      'scripts/check-scope.mjs',
    ]) {
      expect(changed).not.toContain(protectedPath);
    }
  });

  it('v0.3 adds no workflow', () => {
    const changed = changedPathsSinceBase();
    expect(changed.filter((path) => path.startsWith('.github/workflows/'))).toEqual([]);
  });

  it('v0.3 retains zero runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { private?: boolean; dependencies?: Record<string, string> };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies ?? {}).toEqual({});

    const listed = execFileSync('npm', ['ls', '--omit=dev', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const tree = JSON.parse(listed) as { dependencies?: Record<string, unknown> };
    expect(tree.dependencies ?? {}).toEqual({});
  });

  it('v0.3 creates no tag release or npm publication', () => {
    // A shallow CI checkout may carry no local tags. When this checkout has a
    // v0.3 tag, it must be exactly the single owner-approved v0.3.0 tag at the
    // M16 commit; any other v0.3 tag is a release this milestone must not
    // create.
    const tags = git(['tag', '--list', 'v0.3*']).trim();
    if (tags !== '') {
      expect(tags).toBe(OWNER_APPROVED_V03_TAG);
      expect(git(['rev-parse', `${OWNER_APPROVED_V03_TAG}^{commit}`]).trim()).toBe(
        OWNER_APPROVED_V03_TAG_COMMIT,
      );
    }
    expect(existsSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'))).toBe(false);
    // M23 aligned the README with the tags that exist: the owner-approved
    // v0.3.0 tag is named with its pinned commit, and no v0.4 tag is claimed.
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('M16 creates no tag or release');
    expect(readme).toContain('The `v0.3.0` tag exists');
    expect(readme).toContain(OWNER_APPROVED_V03_TAG_COMMIT);
    expect(readme).not.toMatch(/v0\.4\.0/);
  });
});
