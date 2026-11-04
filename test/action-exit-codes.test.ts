import { describe, expect, it } from 'vitest';
import { runAction, runCli } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

function writeCleanFixture(root: string): void {
  writeFiles(root, {
    'README.md': '# Clean\n\n[guide](docs/guide.md)\n',
    'docs/guide.md': '# Guide\n\n[top](#guide)\n',
  });
}

function writeBrokenFixture(root: string): void {
  writeFiles(root, {
    'README.md': '# Broken\n\n[missing](missing.md)\n',
    'docs/guide.md': '# Guide\n\n[missing](missing.md)\n',
  });
}

describe('action exit codes', () => {
  it('clean fixture through the action exits 0', async () => {
    const root = makeTempRoot();
    writeCleanFixture(root);

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(result.status).toBe(0);
  });

  it('broken fixture through the action exits 1', async () => {
    const root = makeTempRoot();
    writeBrokenFixture(root);

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(result.status).toBe(1);
  });

  it('missing paths through the action exits 2', async () => {
    const root = makeTempRoot();
    writeCleanFixture(root);

    const result = await runAction({
      cwd: root,
      inputs: {},
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('md-link-check: no input paths');
  });

  it('invalid external input through the action exits 2', async () => {
    const root = makeTempRoot();
    writeCleanFixture(root);

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'enabled' },
    });

    expect(result.status).toBe(2);
  });

  it('wrapper propagates exit code 0 unchanged', async () => {
    const root = makeTempRoot();
    writeCleanFixture(root);

    const actionResult = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });
    const cliResult = await runCli(['--', '.'], { cwd: root });

    expect(cliResult.status).toBe(0);
    expect(actionResult.status).toBe(cliResult.status);
  });

  it('wrapper propagates exit code 1 unchanged', async () => {
    const root = makeTempRoot();
    writeBrokenFixture(root);

    const actionResult = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });
    const cliResult = await runCli(['--', '.'], { cwd: root });

    expect(cliResult.status).toBe(1);
    expect(actionResult.status).toBe(cliResult.status);
  });

  it('wrapper propagates exit code 2 unchanged', async () => {
    const root = makeTempRoot();
    writeCleanFixture(root);

    const actionResult = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: 'missing.md' },
    });
    const cliResult = await runCli(['--', 'missing.md'], { cwd: root });

    expect(cliResult.status).toBe(2);
    expect(actionResult.status).toBe(cliResult.status);
  });

  it('diagnostics are emitted before nonzero termination', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Broken\n\n[missing](missing.md)\n',
    });

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('README.md:3: missing.md — target does not exist');
    expect(result.stdout).toContain('Checked 1 file: 1 broken target');
  });

  it('action preserves file line target em dash reason', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'docs/guide.md': '# Guide\n\n[missing](missing.md)\n',
    });

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: 'docs/guide.md' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('docs/guide.md:3: missing.md — target does not exist');
    expect(result.stdout.split('\n')[0]).toBe(
      'docs/guide.md:3: missing.md — target does not exist',
    );
  });

  it('action preserves deterministic diagnostic order', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Broken\n\n[first](missing-a.md)\n',
      'docs/guide.md': '# Guide\n\n[second](missing-b.md)\n',
    });

    const first = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });
    const second = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(first.status).toBe(1);
    expect(first.stdout).toBe(second.stdout);
    const lines = first.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('README.md:3: missing-a.md — target does not exist');
    expect(lines[1]).toBe('docs/guide.md:3: missing-b.md — target does not exist');
  });

  it('action preserves skipped external summary in default mode', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md':
        '# Consumer\n\n[one](https://example.com/a)\n\n[two](https://example.com/b)\n',
    });

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: 'README.md' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Checked 1 file: 0 broken targets, 2 external links skipped.');
    expect(result.stdout).not.toContain('External checks:');
  });

  it('action does not add wrapper banners to CLI output', async () => {
    const root = makeTempRoot();
    writeBrokenFixture(root);

    const actionResult = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });
    const cliResult = await runCli(['--', '.'], { cwd: root });

    // M12 appends action-owned annotation lines; CLI-owned bytes are a prefix.
    expect(actionResult.stdout.startsWith(cliResult.stdout)).toBe(true);
    expect(actionResult.stdout.slice(cliResult.stdout.length)).toMatch(
      /^(?:::error [^\n]+\n)+$/,
    );
    expect(actionResult.stderr).toBe(cliResult.stderr);
  });

  it('action preserves source paths relative to the caller context', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'docs/guide.md': '# Guide\n\n[missing](missing.md)\n',
    });

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('docs/guide.md:3: missing.md — target does not exist');
    expect(result.stdout).not.toContain(root);
  });
});
