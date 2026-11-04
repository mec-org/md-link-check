import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCommandLine, runAction } from '../src/action-runner.js';
import { formatAnnotations } from '../src/annotation.js';
import type { CliIo, RunResult } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import {
  captureRun,
  fixtureRelativeFindings,
  M9_BROKEN_FINDINGS,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';
import { startFixtureServer } from './server.js';

interface CapturedAction {
  exitCode: number;
  diagnostics: RunResult['diagnostics'];
  stdout: string;
  stderr: string;
}

/** Runs the action wrapper in-process, never spawning or inspecting its output. */
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
  return { exitCode: result.exitCode, diagnostics: result.diagnostics, stdout, stderr };
}

describe('M9 action wrapper structured results', () => {
  it('action wrapper receives broken-link results in process', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(M9_BROKEN_FINDINGS.length);
    expect(Object.isFrozen(action.diagnostics)).toBe(true);
    expect(action.stdout).toContain('Checked 2 files: 9 broken targets');
  });

  it('action wrapper receives each file line target and reason', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(fixtureRelativeFindings(action.diagnostics, M9_BROKEN_FIXTURE)).toEqual(
      M9_BROKEN_FINDINGS,
    );
  });

  it('action wrapper receives results in CLI order', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(action.diagnostics).toEqual(cli.diagnostics);
    expect(fixtureRelativeFindings(action.diagnostics, M9_BROKEN_FIXTURE)).toEqual(
      M9_BROKEN_FINDINGS,
    );
  });

  it('action wrapper does not parse stdout', async () => {
    const misleading: string[] = [];
    const io: CliIo = {
      // Replace everything the wrapper writes with output that disagrees with
      // the checker. A wrapper that parsed its own stdout would see only this.
      writeOut: () => {
        misleading.push('FAKE.md:1: fake-target — fake reason');
      },
      writeError: () => {
        misleading.push('FAKE.md:1: fake-target — fake reason');
      },
    };

    const action = await runAction({ INPUT_PATHS: M9_BROKEN_FIXTURE }, io);

    expect(misleading.length).toBeGreaterThan(0);
    expect(fixtureRelativeFindings(action.diagnostics, M9_BROKEN_FIXTURE)).toEqual(
      M9_BROKEN_FINDINGS,
    );
  });

  it('action wrapper does not parse stderr', async () => {
    const misleading: string[] = [];
    const io: CliIo = {
      writeOut: () => {
        misleading.push('FAKE.md:1: fake-target — fake reason');
      },
      writeError: () => {
        misleading.push('FAKE.md:1: fake-target — fake reason');
      },
    };

    const action = await runAction(
      { INPUT_PATHS: join(M9_BROKEN_FIXTURE, 'unreadable-input.md') },
      io,
    );

    expect(misleading).toHaveLength(1);
    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
  });

  it('action wrapper does not invoke JSON mode to obtain results', async () => {
    expect(buildCommandLine({ paths: ['docs'], external: false })).toEqual(['--', 'docs']);
    expect(buildCommandLine({ paths: ['docs'], external: true })).toEqual([
      '--external',
      '--',
      'docs',
    ]);

    const action = await captureAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.diagnostics).toHaveLength(M9_BROKEN_FINDINGS.length);
    expect(action.stdout.trim().startsWith('{')).toBe(false);
    expect(action.stdout).toContain('—');
  });

  it('action wrapper receives an empty list for a clean fixture', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
  });

  it('action wrapper receives an empty list for usage error', async () => {
    const action = await captureAction({});

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.stderr).toContain('no input paths');
  });

  it('action wrapper preserves exit code 0', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });

    expect(action.exitCode).toBe(0);
  });

  it('action wrapper preserves exit code 1', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.exitCode).toBe(1);
  });

  it('action wrapper preserves exit code 2', async () => {
    const action = await captureAction({ INPUT_PATHS: join(M9_CLEAN_FIXTURE, 'missing.md') });

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
  });

  it('action wrapper emits one annotation per M9 structured finding', async () => {
    const action = await captureAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const expected = formatAnnotations(action.diagnostics)
      .map((annotation) => `${annotation}\n`)
      .join('');

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).not.toHaveLength(0);
    expect(action.stdout.endsWith(expected)).toBe(true);
    expect(action.stdout.slice(0, action.stdout.length - expected.length)).toContain(
      'Checked 2 files: 9 broken targets',
    );
    expect(action.stderr).toBe('');
  });

  it('action wrapper writes no step summary in M9', async () => {
    const root = makeTempRoot();

    // M13 owns the GITHUB_OUTPUT contract and its tests; M9 only proves that
    // the action still writes no separate step-summary document.
    const action = await captureAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_STEP_SUMMARY: join(root, 'step-summary.md'),
    });

    expect(action.exitCode).toBe(0);
    expect(existsSync(join(root, 'step-summary.md'))).toBe(false);
  });

  it('action wrapper waits for asynchronous external checking', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# External\n\n[gated](${server.urlFor('/gate')})\n`,
    });
    let stdout = '';
    const io: CliIo = {
      writeOut: (text) => {
        stdout += text;
      },
      writeError: () => undefined,
    };

    try {
      const running = runAction(
        { INPUT_PATHS: join(root, 'README.md'), INPUT_EXTERNAL: 'true' },
        io,
      );
      await server.waitForGated(1);
      server.releaseGated();
      const action = await running;

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(stdout).toContain('1 succeeded');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });
});
