import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runAction } from '../src/action-runner.js';
import { withDefaultStepSummary } from './action-helpers.js';
import type { CliIo, RunResult } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';

// Simulate failures escaping the checking layer. The action wrapper must reuse
// the CLI's structured internal-error policy, which carries no broken-link
// finding and therefore no annotation.
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
  const result = await runAction(withDefaultStepSummary(environment), io);
  return { exitCode: result.exitCode, diagnostics: result.diagnostics, stdout, stderr };
}

function existingMarkdownFile(): string {
  const root = makeTempRoot();
  writeFiles(root, { 'README.md': '# Internal error fixture\n' });
  return join(root, 'README.md');
}

describe('M12 action internal errors', () => {
  it('internal errors emit no broken-link annotation', async () => {
    const action = await captureAction({ INPUT_PATHS: existingMarkdownFile() });
    const output = `${action.stdout}${action.stderr}`;

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.stdout).toBe('');
    expect(action.stderr).toContain(
      'md-link-check: internal error: simulated local read failure',
    );
    expect(output).not.toContain('::error');
    expect(output.split('\n').some((line) => line.startsWith('::'))).toBe(false);
    expect(action.stdout).not.toContain('::');
  });

  it('internal errors preserve the CLI internal-error text and exit 2', async () => {
    const action = await captureAction({
      INPUT_PATHS: existingMarkdownFile(),
      INPUT_EXTERNAL: 'true',
    });

    expect(action.exitCode).toBe(2);
    expect(action.stderr).toContain(
      'md-link-check: internal error: simulated external check failure',
    );
    expect(action.stderr).not.toMatch(/^\s+at /m);
    expect(action.diagnostics).toEqual([]);
    expect(action.stdout).toBe('');
  });
});
