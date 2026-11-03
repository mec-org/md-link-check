import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ARTIFACT_PATH,
  ACTION_METADATA_PATH,
  copyActionRuntime,
  runAction,
  runCli,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { startFixtureServer } from './server.js';

function writeCleanConsumer(root: string): void {
  writeFiles(root, {
    'README.md': '# Consumer\n\n[guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n\n[top](#guide)\n',
  });
}

describe('action input parsing', () => {
  it('paths input accepts one path', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 1 file: 0 broken targets, 0 external links skipped.');
  });

  it('paths input accepts multiple newline-delimited paths', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md\ndocs\n' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 2 files: 0 broken targets, 0 external links skipped.');
  });

  it('paths input ignores blank lines', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: '\n   README.md   \n\n\t\n' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 1 file:');
  });

  it('paths input preserves spaces inside a path', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'docs/guide with spaces.md': '# Guide\n\nNo broken links here.\n',
    });

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: '  docs/guide with spaces.md  ' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 1 file:');
  });

  it('paths input does not perform shell expansion', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'docs/*.md' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot access input path "docs/*.md"');
  });

  it('empty paths input exits 2', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: '' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('md-link-check: no input paths');
  });

  it('whitespace-only paths input exits 2', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: '   \n\t\n   ' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('md-link-check: no input paths');
  });

  it('external input defaults to false', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[external](https://example.com/page)\n',
    });
    const fetchLog = join(root, 'fetch.log');

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md' },
      fetchLog,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 external link skipped.');
    expect(existsSync(fetchLog)).toBe(false);
  });

  it('external input accepts true case-insensitively', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: '  TrUe  ' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('External checks: 0 occurrences');
  });

  it('external input accepts false case-insensitively', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[external](https://example.com/page)\n',
    });

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: ' FaLsE ' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 external link skipped.');
    expect(result.stdout).not.toContain('External checks:');
  });

  it('invalid external input exits 2', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'maybe' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'md-link-check: invalid action input "external": expected "true" or "false"',
    );
    expect(result.stderr).toContain('Usage: md-link-check');
  });

  it('invalid action input does not perform fetch', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[external](https://example.com/page)\n',
    });
    const fetchLog = join(root, 'fetch.log');

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: '1' },
      fetchLog,
    });

    expect(result.status).toBe(2);
    expect(existsSync(fetchLog)).toBe(false);
    expect(result.stdout).toBe('');
  });
});

describe('action wrapper and working directory', () => {
  it('wrapper checks paths relative to the caller workspace', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[missing](missing.md)\n',
    });
    writeFiles(join(root, 'elsewhere'), {
      'README.md': '# Elsewhere\n',
    });

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('README.md:3: missing.md — target does not exist');
  });

  it('wrapper resolves its entrypoint from the action directory', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      artifactPath,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(existsSync(ACTION_METADATA_PATH)).toBe(true);
    expect(artifactPath.startsWith(actionCheckout)).toBe(true);
    expect(result.status).toBe(0);
  });

  it('wrapper works when cwd is outside the action repository', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      artifactPath: ACTION_ARTIFACT_PATH,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 2 files:');
  });

  it('wrapper works when action and caller paths contain spaces', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer workspace');
    writeFiles(consumer, {
      'docs/guide with spaces.md': '# Guide\n\n[broken](missing.md)\n',
    });

    const result = await runAction({
      cwd: consumer,
      artifactPath,
      inputs: { INPUT_PATHS: 'docs/guide with spaces.md' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'docs/guide with spaces.md:3: missing.md — target does not exist',
    );
  });

  it('wrapper does not change cwd to the action directory', async () => {
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

    // The copied action checkout has no README.md; resolving the caller-relative
    // path after a chdir would fail with exit 2.
    expect(existsSync(join(actionCheckout, 'README.md'))).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 1 file:');
  });

  it('wrapper preserves CLI stdout', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[missing](missing.md)\n',
      'docs/guide.md': '# Guide\n\n[more](also-missing.md)\n',
    });

    const actionResult = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md\ndocs' },
    });
    const cliResult = await runCli(['--', 'README.md', 'docs'], { cwd: consumer });

    expect(actionResult.status).toBe(1);
    expect(cliResult.status).toBe(1);
    expect(actionResult.stdout).toBe(cliResult.stdout);
  });

  it('wrapper preserves CLI stderr', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const actionResult = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: '' },
    });
    const cliResult = await runCli(['--'], { cwd: consumer });

    expect(actionResult.status).toBe(2);
    expect(cliResult.status).toBe(2);
    expect(actionResult.stderr).toBe(cliResult.stderr);
  });

  it('wrapper waits for asynchronous checks before exiting', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': `# Consumer\n\n[gated](${server.urlFor('/gate')})\n`,
    });

    const running = runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
    });

    try {
      await server.waitForGated(1);
      server.releaseGated();
      const result = await running;
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('1 succeeded');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('wrapper does not print a stack trace for usage errors', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeCleanConsumer(consumer);

    const result = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'yes' },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain('    at ');
    expect(result.stderr).not.toContain('ActionInputError');
    expect(result.stderr).toContain('md-link-check: invalid action input "external"');
  });
});
