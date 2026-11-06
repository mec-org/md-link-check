/**
 * M23 — changed-path allowlist and committed action-bundle verification.
 *
 * The scope check compares the current tree with a committed manifest of the
 * exact authorized base `d8b312a79866291e0550d2fbdb9d68f192e39ead`, including
 * unstaged, staged and untracked files. It therefore works in a shallow CI
 * checkout without fetching history, but still reports every path added,
 * removed or modified against that base. Only the M23 allowlist may change.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, runActionBuild } from './action-helpers.js';
import { M23_BASE_SHA } from './m23-helpers.js';

interface BaseManifest {
  base: string;
  algorithm: string;
  paths: Record<string, string>;
}

/** The exact M23 authorized paths. */
const ALLOWED_PATH =
  /^(?:src\/.+|test\/.+|docs\/.+|README\.md|action\.yml|action-dist\/index\.cjs)$/;

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readBaseManifest(): BaseManifest {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, 'test', 'm23-base-manifest.json'), 'utf8'),
  ) as BaseManifest;
}

/** Every path changed from the authorized base, including the working tree. */
function changedPathsSinceBase(): string[] {
  const manifest = readBaseManifest();
  expect(manifest.base).toBe(M23_BASE_SHA);
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

describe('M23 v0.4 changed-path scope', () => {
  it('limits M23 changes to authorized paths', () => {
    const changed = changedPathsSinceBase();
    expect(changed.length).toBeGreaterThan(0);

    const violations = changed.filter((path) => !ALLOWED_PATH.test(path));
    expect(violations).toEqual([]);

    // The milestone's non-goals are explicit: the charter, project metadata,
    // package scripts, workflows and lockfiles are untouched.
    for (const protectedPath of [
      'PROJECT.md',
      'ROADMAP.md',
      'PRD.md',
      'CONTRIBUTING.md',
      'package.json',
      'package-lock.json',
      'scripts/build-action.mjs',
      'scripts/check-scope.mjs',
      '.github/workflows/ci.yml',
    ]) {
      expect(changed).not.toContain(protectedPath);
    }
  });

  it('keeps action-dist current', async () => {
    // The repository's established build script rebuilds the bundle in a
    // temporary directory and compares it byte for byte with the committed
    // artifact; this is the in-packet freshness proof, not a second verifier.
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'action entrypoint is reproducible: action-dist/index.cjs',
    );
  });
});
