import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runAction } from '../src/action-runner.js';
import type { CliIo, RunResult } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { M9_CLEAN_FIXTURE } from './m9-helpers.js';

// Simulate failures escaping the checking layer. The action wrapper must reuse
// the CLI's structured internal-error policy, which carries no authoritative
// summary and therefore no published output records.
vi.mock('../src/checker.js', () => ({
  checkMarkdown: () => {
    throw new Error('simulated local read failure');
  },
  checkMarkdownWithExternal: () =>
    Promise.reject(new Error('simulated external check failure')),
}));

interface CapturedAction {
  exitCode: RunResult['exitCode'];
  diagnostics: RunResult['diagnostics'];
  summary: RunResult['summary'];
  stdout: string;
  stderr: string;
}

/** Runs the in-process action wrapper and captures both streams. */
async function captureAction(environment: NodeJS.ProcessEnv): Promise<CapturedAction> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
  };
  const result = await runAction(environment, io);
  return {
    exitCode: result.exitCode,
    diagnostics: result.diagnostics,
    summary: result.summary,
    stdout,
    stderr,
  };
}

function createOutputPath(root: string, initial: string): string {
  const outputPath = join(root, 'github-output.txt');
  writeFiles(root, { 'github-output.txt': initial });
  return outputPath;
}

describe('M13 internal error outputs', () => {
  it('internal error publishes no fabricated summary outputs', async () => {
    const root = makeTempRoot();
    const initial = 'keep=sentinel\n';
    const outputPath = createOutputPath(root, initial);

    const action = await captureAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.summary).toBeNull();
    expect(readFileSync(outputPath, 'utf8')).toBe(initial);
  });

  it('internal error remains governed by the existing internal-error contract', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });

    expect(action.exitCode).toBe(2);
    expect(action.stdout).toBe('');
    expect(action.stderr).toContain(
      'md-link-check: internal error: simulated local read failure',
    );
    expect(action.stderr).not.toMatch(/^\s+at /m);
    expect(action.stdout).not.toContain('::error');
  });

  it('internal error publishes no summary in external mode', async () => {
    const root = makeTempRoot();
    const initial = 'keep=sentinel\n';
    const outputPath = createOutputPath(root, initial);

    const action = await captureAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      INPUT_EXTERNAL: 'true',
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(2);
    expect(action.summary).toBeNull();
    expect(action.stderr).toContain(
      'md-link-check: internal error: simulated external check failure',
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(initial);
  });
});
