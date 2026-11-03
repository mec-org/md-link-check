import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZED_BASE_SHA,
  REPO_ROOT,
  copyActionRuntime,
  readActionArtifactText,
  readScopeReport,
  runAction,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

function baseCommitAvailable(): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${AUTHORIZED_BASE_SHA}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

interface PackageManifest {
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageManifest;
}

describe('action scope guard', () => {
  it('action work adds no workflow', async () => {
    const report = await readScopeReport();
    expect(report.violations).toEqual([]);
    expect(report.changed.filter((path) => path.startsWith('.github/workflows/'))).toEqual([]);
  });

  it('action work changes no path under github metadata', async () => {
    const report = await readScopeReport();
    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('action work changes no path under project metadata', async () => {
    const report = await readScopeReport();
    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('package retains zero runtime dependencies', () => {
    const manifest = readPackageJson();
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.devDependencies?.esbuild).toBe('0.28.2');

    const lockfile = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { dependencies?: Record<string, string> }> };
    expect(lockfile.packages?.['']?.dependencies ?? {}).toEqual({});

    const listed = JSON.parse(
      execFileSync('npm', ['ls', '--omit=dev', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as { dependencies?: Record<string, unknown> };
    expect(listed.dependencies ?? {}).toEqual({});
  });

  it.skipIf(!baseCommitAvailable())(
    'scope baseline manifest matches the authorized base',
    () => {
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, 'test', 'm7-base-metadata.json'), 'utf8'),
      ) as { base: string; algorithm: string; paths: Record<string, string> };

      expect(manifest.base).toBe(AUTHORIZED_BASE_SHA);
      expect(manifest.algorithm).toBe('sha256');

      const tracked = execFileSync(
        'git',
        ['ls-tree', '-r', '--name-only', AUTHORIZED_BASE_SHA, '--', '.github', '.project'],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .filter((path) => path !== '')
        .sort();
      expect(Object.keys(manifest.paths).sort()).toEqual(tracked);

      for (const path of tracked) {
        const content = execFileSync(
          'git',
          ['show', `${AUTHORIZED_BASE_SHA}:${path}`],
          { cwd: REPO_ROOT },
        );
        const hash = createHash('sha256').update(content).digest('hex');
        expect(manifest.paths[path]).toBe(hash);
      }
    },
  );

  it('action execution does not require npm publication', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer');
    writeFiles(consumer, { 'README.md': '# Consumer\n' });

    const result = await runAction({
      cwd: consumer,
      artifactPath,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(readPackageJson().private).toBe(true);
    expect(readActionArtifactText()).not.toMatch(
      /require\(["'](?:esbuild|vitest|typescript)["']\)/,
    );
    expect(result.status).toBe(0);
  });
});
