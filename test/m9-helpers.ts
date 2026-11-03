import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, type CliIo, type RunOptions, type RunResult } from '../src/run.js';

/** Repository root, resolved from this test file rather than the cwd. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Committed M9 fixtures. Paths are absolute so tests never depend on the cwd. */
export const M9_CLEAN_FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'm9-clean');
export const M9_BROKEN_FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'm9-broken');

/**
 * The frozen ordered findings of the committed broken fixture, with fixture
 * paths made relative to the fixture root. This list is the expected result for
 * text, JSON and the in-process structured contract alike.
 */
export const M9_BROKEN_FINDINGS = [
  { file: 'README.md', line: 3, target: 'docs/missing.md', reason: 'target does not exist' },
  {
    file: 'README.md',
    line: 4,
    target: 'images/missing.png',
    reason: 'target does not exist',
  },
  { file: 'README.md', line: 4, target: '#missing-anchor', reason: 'anchor does not exist' },
  {
    file: 'README.md',
    line: 5,
    target: 'docs/guide.md#deployment',
    reason: 'anchor does not exist',
  },
  { file: 'README.md', line: 7, target: 'docs/missing.md', reason: 'target does not exist' },
  { file: 'README.md', line: 7, target: 'docs/missing.md', reason: 'target does not exist' },
  { file: 'README.md', line: 9, target: 'docs/missing.md', reason: 'target does not exist' },
  {
    file: 'README.md',
    line: 9,
    target: 'images/missing.png',
    reason: 'target does not exist',
  },
  {
    file: join('docs', 'guide.md'),
    line: 5,
    target: '../README.md#nope',
    reason: 'anchor does not exist',
  },
] as const;

/** Projects structured findings onto fixture-relative paths for assertion. */
export function fixtureRelativeFindings(
  diagnostics: RunResult['diagnostics'],
  fixtureRoot: string,
) {
  return diagnostics.map(({ file, line, target, reason }) => ({
    file: relative(fixtureRoot, file),
    line,
    target,
    reason,
  }));
}

export interface CapturedRun {
  exitCode: number;
  diagnostics: RunResult['diagnostics'];
  stdout: string;
  stderr: string;
}

/** Runs the CLI engine in-process and captures its streams and structured result. */
export async function captureRun(
  args: readonly string[],
  options: RunOptions = {},
): Promise<CapturedRun> {
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
  const result = await run(args, io, options);
  return { exitCode: result.exitCode, diagnostics: result.diagnostics, stdout, stderr };
}

/** One finding parsed from the frozen human-readable diagnostic line. */
export interface TextFinding {
  file: string;
  line: number;
  target: string;
  reason: string;
}

/**
 * Splits the human-readable stream into findings and its final summary line.
 * Test-only: production and the action never parse formatted output.
 */
export function parseTextFindings(stdout: string): {
  findings: TextFinding[];
  summary: string;
} {
  const lines = stdout.replace(/\n$/, '').split('\n');
  const summary = lines.pop() ?? '';
  const findings = lines.map((line) => {
    const match = /^(.*):(\d+): (.*?) — (.*)$/.exec(line);
    if (match === null) {
      throw new Error(`unexpected diagnostic line: ${line}`);
    }
    return {
      file: match[1] ?? '',
      line: Number(match[2] ?? 0),
      target: match[3] ?? '',
      reason: match[4] ?? '',
    };
  });
  return { findings, summary };
}
