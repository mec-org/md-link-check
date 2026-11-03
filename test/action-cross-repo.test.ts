import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ARTIFACT_PATH,
  ACTION_METADATA_PATH,
  REPO_ROOT,
  readActionMetadata,
  requireScalar,
  runAction,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

interface TaggedRefLayout {
  root: string;
  actionCheckout: string;
  actionArtifact: string;
  consumerWorkspace: string;
}

/**
 * Simulates a tagged-ref action checkout and a separate consumer repository.
 * Only the metadata and the declared runtime entrypoint are copied into the
 * action checkout; the consumer contains Markdown only.
 */
function createTaggedRefLayout(): TaggedRefLayout {
  const root = makeTempRoot();
  const actionCheckout = join(root, 'action-checkout');
  const consumerWorkspace = join(root, 'consumer-workspace');
  const main = requireScalar(readActionMetadata().runs, 'main');
  const actionArtifact = resolve(ACTION_ARTIFACT_PATH);

  mkdirSync(dirname(join(actionCheckout, main)), { recursive: true });
  copyFileSync(ACTION_METADATA_PATH, join(actionCheckout, 'action.yml'));
  copyFileSync(actionArtifact, join(actionCheckout, main));

  writeFiles(consumerWorkspace, {
    'README.md': '# Consumer\n\n[guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n\n[top](#guide)\n',
  });

  return { root, actionCheckout, actionArtifact, consumerWorkspace };
}

describe('tagged-ref layout simulation', () => {
  it('tagged-ref layout simulation checks a separate consumer repository', async () => {
    const layout = createTaggedRefLayout();
    const result = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath: join(layout.actionCheckout, 'action-dist', 'index.cjs'),
      inputs: { INPUT_PATHS: '.' },
    });

    expect(layout.root).not.toBe(REPO_ROOT);
    expect(layout.actionCheckout.startsWith(layout.root)).toBe(true);
    expect(layout.consumerWorkspace.startsWith(layout.root)).toBe(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 2 files:');
  });

  it('tagged-ref layout simulation needs no npm publication', async () => {
    const layout = createTaggedRefLayout();
    const result = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath: join(layout.actionCheckout, 'action-dist', 'index.cjs'),
      inputs: { INPUT_PATHS: '.' },
    });

    expect(existsSync(join(layout.actionCheckout, 'package.json'))).toBe(false);
    expect(existsSync(join(layout.actionCheckout, 'src'))).toBe(false);
    expect(result.status).toBe(0);
  });

  it('tagged-ref layout simulation needs no consumer npm install', async () => {
    const layout = createTaggedRefLayout();
    const result = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath: join(layout.actionCheckout, 'action-dist', 'index.cjs'),
      inputs: { INPUT_PATHS: '.' },
    });

    expect(existsSync(join(layout.consumerWorkspace, 'package.json'))).toBe(false);
    expect(existsSync(join(layout.consumerWorkspace, 'node_modules'))).toBe(false);
    expect(existsSync(join(layout.actionCheckout, 'node_modules'))).toBe(false);
    expect(result.status).toBe(0);
  });

  it('tagged-ref layout simulation needs no consumer build', async () => {
    const layout = createTaggedRefLayout();
    const result = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath: join(layout.actionCheckout, 'action-dist', 'index.cjs'),
      inputs: { INPUT_PATHS: '.' },
    });

    expect(existsSync(join(layout.consumerWorkspace, 'dist'))).toBe(false);
    expect(existsSync(join(layout.consumerWorkspace, 'tsconfig.json'))).toBe(false);
    expect(result.status).toBe(0);
  });

  it('tagged-ref layout simulation does not resolve runtime files from cwd', async () => {
    const layout = createTaggedRefLayout();
    const result = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath: join(layout.actionCheckout, 'action-dist', 'index.cjs'),
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(existsSync(join(layout.consumerWorkspace, 'action.yml'))).toBe(false);
    expect(existsSync(join(layout.consumerWorkspace, 'action-dist'))).toBe(false);
    expect(result.status).toBe(0);
  });

  it('tagged-ref layout simulation supports clean and broken consumer fixtures', async () => {
    const layout = createTaggedRefLayout();
    const artifactPath = join(layout.actionCheckout, 'action-dist', 'index.cjs');
    const clean = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath,
      inputs: { INPUT_PATHS: '.' },
    });
    expect(clean.status).toBe(0);

    writeFiles(layout.consumerWorkspace, {
      'docs/broken.md': '# Broken\n\n[missing](missing.md)\n',
    });
    const broken = await runAction({
      cwd: layout.consumerWorkspace,
      artifactPath,
      inputs: { INPUT_PATHS: 'docs' },
    });

    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain('docs/broken.md:3: missing.md — target does not exist');
  });
});
