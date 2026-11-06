/**
 * M20 — direct-CLI isolation from the GitHub Actions job summary.
 *
 * The summary writer is action-only: a direct `md-link-check` invocation must
 * neither read nor alter `GITHUB_STEP_SUMMARY`, even when the runner sets that
 * variable for the step. These tests invoke the built CLI (`dist/cli.js`), not
 * the action entrypoint, with a seeded summary file and assert the bytes, the
 * CLI output and the exit code are unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, runCli } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

describe('M20 direct CLI summary isolation', () => {
  it('direct CLI execution does not alter GITHUB_STEP_SUMMARY', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, {
      'README.md': '# Clean fixture\n\n[guide](docs/guide.md)\n',
      'docs/guide.md': '# Guide\n',
    });
    const summaryPath = join(root, 'step-summary.md');
    const seed = 'prior summary bytes\n\n- keep: this exactly\n';
    writeFileSync(summaryPath, seed);
    const environment = {
      GITHUB_STEP_SUMMARY: summaryPath,
      XDG_CACHE_HOME: join(root, 'cache-home'),
    };

    const clean = await runCli(['--', '.'], { cwd: fixture, env: environment });

    expect(clean.status).toBe(0);
    expect(clean.stdout).toBe(
      'Checked 2 files: 0 broken targets, 0 external links skipped.\n',
    );
    expect(clean.stderr).toBe('');
    expect(clean.stdout).not.toContain('## Results');
    expect(clean.stdout).not.toContain('::error ');
    expect(readFileSync(summaryPath, 'utf8')).toBe(seed);

    // A broken direct CLI run is equally isolated.
    writeFiles(fixture, {
      'README.md': '# Broken fixture\n\n[missing](missing.md)\n',
    });
    const broken = await runCli(['--', '.'], { cwd: fixture, env: environment });

    expect(broken.status).toBe(1);
    expect(broken.stdout).toBe(
      'README.md:3: missing.md — target does not exist\n' +
        'Checked 2 files: 1 broken target, 0 external links skipped.\n',
    );
    expect(broken.stderr).toBe('');
    expect(broken.stdout).not.toContain('## Results');
    expect(readFileSync(summaryPath, 'utf8')).toBe(seed);

    // JSON mode never writes it either, and its stdout bytes are identical to
    // the same run without the summary variable.
    const json = await runCli(['--json', '--', '.'], {
      cwd: fixture,
      env: environment,
    });
    const jsonWithoutSummary = await runCli(['--json', '--', '.'], {
      cwd: fixture,
      env: { XDG_CACHE_HOME: join(root, 'cache-home') },
    });
    const report = JSON.parse(json.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      summary: { filesChecked: number; broken: number; externalSkipped: number };
      diagnostics: unknown[];
    };

    expect(json.status).toBe(1);
    expect(json.stderr).toBe('');
    expect(json.stdout).toBe(jsonWithoutSummary.stdout);
    expect(json.stdout.endsWith('\n')).toBe(true);
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.summary).toEqual({
      filesChecked: 2,
      broken: 1,
      externalSkipped: 0,
    });
    expect(report.diagnostics).toHaveLength(1);
    expect(readFileSync(summaryPath, 'utf8')).toBe(seed);
  });

  it('direct CLI ignores absent empty and invalid summary destinations', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, {
      'README.md': '# Clean fixture\n\n[guide](docs/guide.md)\n',
      'docs/guide.md': '# Guide\n',
    });
    const baseEnvironment = { XDG_CACHE_HOME: join(root, 'cache-home') };
    const expectedStdout =
      'Checked 2 files: 0 broken targets, 0 external links skipped.\n';
    const invalidPath = join(root, 'missing-parent', 'step-summary.md');

    for (const environment of [
      baseEnvironment,
      { ...baseEnvironment, GITHUB_STEP_SUMMARY: '' },
      { ...baseEnvironment, GITHUB_STEP_SUMMARY: invalidPath },
    ]) {
      const result = await runCli(['--', '.'], { cwd: fixture, env: environment });

      // M21 warning handling is action-only: the direct CLI never reads the
      // variable, never writes the file, never fails on an invalid destination
      // and never prints a workflow command.
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(expectedStdout);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('::warning');
      expect(result.stdout.split('\n').some((line) => line.startsWith('::'))).toBe(
        false,
      );
    }

    expect(existsSync(invalidPath)).toBe(false);
  });

  it('direct CLI sources do not reference the action summary writer', () => {
    const cli = readFileSync(join(REPO_ROOT, 'dist', 'cli.js'), 'utf8');
    const run = readFileSync(join(REPO_ROOT, 'dist', 'run.js'), 'utf8');

    for (const text of [cli, run]) {
      expect(text).not.toContain('GITHUB_STEP_SUMMARY');
      expect(text).not.toContain('summary-markdown');
      expect(text).not.toContain('action-step-summary');
      expect(text).not.toContain('action-runner');
    }
  });
});
