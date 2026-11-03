import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ARTIFACT_PATH,
  REPO_ROOT,
  actionRuntimeExists,
  copyActionRuntime,
  isGitTracked,
  readActionArtifactText,
  runAction,
  runActionBuild,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

describe('action reproducibility', () => {
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

  it('action entrypoint rebuild leaves a clean diff', async () => {
    const result = await runActionBuild(['--check']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('action entrypoint is reproducible');
    expect(result.stderr).toBe('');
  });

  it('action reproducibility check fails for a stale bundle', async () => {
    const root = makeTempRoot();
    const stale = join(root, 'index.cjs');
    copyFileSync(ACTION_ARTIFACT_PATH, stale);
    appendFileSync(stale, '\n// stale artifact\n');

    const result = await runActionBuild(['--check', '--artifact', stale]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('action artifact is stale');
    expect(result.stderr).toContain(stale);
    expect(result.stderr).toContain('npm run build:action');
  });

  it('checked-in entrypoint contains no absolute worktree path', () => {
    const artifact = readActionArtifactText();
    expect(artifact).not.toContain(REPO_ROOT);
    expect(artifact).not.toMatch(/\/home\//);
    expect(artifact).not.toMatch(/\/Users\//);
    expect(artifact).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('checked-in entrypoint contains no build timestamp', () => {
    const artifact = readActionArtifactText();
    expect(artifact).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(artifact).not.toMatch(/\bgenerated (?:at|on)\b/i);
    expect(artifact).not.toMatch(/\b\d{13}\b/);
  });

  it('checked-in entrypoint runs without node_modules', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[link](missing.md)\n',
    });

    const result = await runAction({
      cwd: consumer,
      artifactPath,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(existsSync(join(actionCheckout, 'node_modules'))).toBe(false);
    expect(existsSync(join(consumer, 'node_modules'))).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('README.md:3: missing.md — target does not exist');
  });

  it('action runtime artifact is committed', () => {
    expect(actionRuntimeExists()).toBe(true);
    expect(isGitTracked('action-dist/index.cjs')).toBe(true);
  });
});
