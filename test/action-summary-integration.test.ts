/**
 * M20 — action-level job-summary integration.
 *
 * These tests exercise the real action path: the committed `action-dist/index.cjs`
 * bundle in a child process for the customer-visible bytes, and the in-process
 * `runAction` orchestration seam where the test also needs the structured M17
 * result. The action appends one M19-formatted summary to the file named by
 * `GITHUB_STEP_SUMMARY`, preserves any existing bytes, writes nothing when the
 * destination is absent or empty, and follows the established internal-error
 * policy when the destination cannot be appended to.
 *
 * The clean and broken expected summaries below are independent hard-coded
 * oracles. They are not produced by calling the formatter under test; the one
 * test that does compare against the formatter proves the action passes the
 * authentic M17 result through the guarded M19 formatter unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction as runSourceAction, writeStepSummary } from '../src/action-runner.js';
import { formatRunSummaryMarkdown } from '../src/summary-markdown.js';
import type { CliIo } from '../src/run.js';
import { runAction, runActionBuild, type ProcessResult } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

/** A clean fixture: two files, every target resolvable, no external uses. */
const CLEAN_FIXTURE_FILES = {
  'README.md':
    '# Clean fixture\n\n[guide](docs/guide.md)\n[top](#clean-fixture)\n',
  'docs/guide.md': '# Guide\n\n[back](../README.md)\n',
} as const;

/** A broken fixture: five findings in scan order plus two skipped external uses. */
const BROKEN_FIXTURE_FILES = {
  'README.md':
    '# Broken fixture\n\n' +
    '[missing](missing_one.md)\n' +
    '[also missing](docs/not-there.md)\n' +
    '[external](https://example.com/one)\n' +
    '[anchor](#nowhere)\n' +
    '![image](images/none.png)\n',
  'docs/guide.md':
    '# Guide\n\n' +
    '[up](../missing-two.md)\n' +
    '[external two](http://example.com/two)\n',
} as const;

const CLEAN_CLI_TEXT =
  'Checked 2 files: 0 broken targets, 0 external links skipped.\n';

/** Independent hard-coded clean summary, including the final newline. */
const CLEAN_SUMMARY = [
  '## Results',
  '',
  '- Checked: 2',
  '- Broken: 0',
  '- External skipped: 0',
  '',
].join('\n');

const CLEAN_OUTPUTS =
  'files-checked=2\nbroken=0\nexternal-skipped=0\n';

/** The untouched CLI text of the broken fixture. */
const BROKEN_CLI_TEXT = [
  'README.md:3: missing_one.md — target does not exist',
  'README.md:4: docs/not-there.md — target does not exist',
  'README.md:6: #nowhere — anchor does not exist',
  'README.md:7: images/none.png — target does not exist',
  'docs/guide.md:3: ../missing-two.md — target does not exist',
  'Checked 2 files: 5 broken targets, 2 external links skipped.',
  '',
].join('\n');

/** The unchanged workflow-command annotations of the broken fixture. */
const BROKEN_ANNOTATIONS = [
  '::error file=README.md,line=3::missing_one.md — target does not exist',
  '::error file=README.md,line=4::docs/not-there.md — target does not exist',
  '::error file=README.md,line=6::#nowhere — anchor does not exist',
  '::error file=README.md,line=7::images/none.png — target does not exist',
  '::error file=docs/guide.md,line=3::../missing-two.md — target does not exist',
  '',
].join('\n');

/** The broken action's complete stdout: unchanged CLI text, then annotations. */
const BROKEN_STDOUT = `${BROKEN_CLI_TEXT}${BROKEN_ANNOTATIONS}`;

/**
 * Independent hard-coded broken summary. The count section comes first, the
 * diagnostics keep the CLI result order, and every value passes through the M18
 * escaper (`_`, `-` and the leading `#` are the encodings it produces here).
 */
const BROKEN_SUMMARY = [
  '## Results',
  '',
  '- Checked: 2',
  '- Broken: 5',
  '- External skipped: 2',
  '',
  '## Diagnostics',
  '',
  '- README.md:3: missing\\_one.md — target does not exist',
  '- README.md:4: docs/not\\-there.md — target does not exist',
  '- README.md:6: \\#nowhere — anchor does not exist',
  '- README.md:7: images/none.png — target does not exist',
  '- docs/guide.md:3: ../missing\\-two.md — target does not exist',
  '',
].join('\n');

const BROKEN_OUTPUTS =
  'files-checked=2\nbroken=5\nexternal-skipped=2\n';

interface ArtifactInvocation {
  readonly result: ProcessResult;
  readonly outputPath: string;
}

/**
 * Runs the committed action bundle exactly as the hosted runner does. `null`
 * omits `GITHUB_STEP_SUMMARY`, `''` sets it to the empty string, and any other
 * value is the destination path.
 */
async function invokeArtifact(
  root: string,
  fixture: string,
  summaryPath: string | null,
): Promise<ArtifactInvocation> {
  const outputPath = join(root, 'github-output.txt');
  writeFileSync(outputPath, '');
  const environment: Record<string, string | undefined> = {
    GITHUB_OUTPUT: outputPath,
  };
  if (summaryPath !== null) {
    environment.GITHUB_STEP_SUMMARY = summaryPath;
  }

  const result = await runAction({
    cwd: fixture,
    inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'false' },
    env: environment,
  });
  return { result, outputPath };
}

/** The exact Node error message an append would produce at this destination. */
async function appendErrorMessage(destination: string): Promise<string> {
  try {
    await appendFile(destination, 'probe', 'utf8');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the destination was expected to be unusable');
}

/** Occurs exactly once when a summary was appended exactly once. */
function summaryOccurrences(summary: string): number {
  return summary.split('## Results').length - 1;
}

describe('M20 action summary integration', () => {
  it('appends exactly one summary for a clean action run', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, CLEAN_FIXTURE_FILES);
    const summaryPath = join(root, 'step-summary.md');
    writeFileSync(summaryPath, '');

    const { result, outputPath } = await invokeArtifact(root, fixture, summaryPath);
    const summary = readFileSync(summaryPath, 'utf8');

    // The existing action surfaces are byte-for-byte unchanged.
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(CLEAN_CLI_TEXT);
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe(CLEAN_OUTPUTS);

    // Exactly one complete M19 summary was appended.
    expect(summary).toBe(CLEAN_SUMMARY);
    expect(summaryOccurrences(summary)).toBe(1);
    expect(summary.endsWith('\n')).toBe(true);
    expect(summary).not.toContain('## Diagnostics');
    expect(`${result.stdout}${result.stderr}`).not.toContain('## Results');
  });

  it('appends exactly one summary for a broken action run', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, BROKEN_FIXTURE_FILES);
    const summaryPath = join(root, 'step-summary.md');
    writeFileSync(summaryPath, '');

    const { result, outputPath } = await invokeArtifact(root, fixture, summaryPath);
    const summary = readFileSync(summaryPath, 'utf8');

    // The CLI text, annotations, outputs and exit code stay unchanged.
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(BROKEN_STDOUT);
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe(BROKEN_OUTPUTS);

    // The exact summary proves the authentic counts and every diagnostic value
    // reached the formatter, in the CLI's result order, with M18 escaping.
    expect(summary).toBe(BROKEN_SUMMARY);
    expect(summaryOccurrences(summary)).toBe(1);
    const diagnostics = summary.slice(summary.indexOf('## Diagnostics'));
    expect(diagnostics.match(/^- /gm)?.length).toBe(5);
    expect(`${result.stdout}${result.stderr}`).not.toContain('## Results');
    expect(`${result.stdout}${result.stderr}`).not.toContain('## Diagnostics');
  });

  it('formats the authentic M17 result through the guarded M19 formatter', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, BROKEN_FIXTURE_FILES);
    const summaryPath = join(root, 'step-summary.md');

    let stdout = '';
    const io: CliIo = {
      writeOut: (text) => {
        stdout += text;
      },
      writeError: () => undefined,
    };
    const result = await runSourceAction(
      { INPUT_PATHS: fixture, GITHUB_STEP_SUMMARY: summaryPath },
      io,
    );

    expect(result.exitCode).toBe(1);
    expect(result.summary).not.toBeNull();
    expect(result.summary?.broken).toBe(result.diagnostics.length);
    // The action appends exactly the guarded formatter's output for the result
    // it just produced; the counts were not rewritten or reconstructed.
    expect(readFileSync(summaryPath, 'utf8')).toBe(
      formatRunSummaryMarkdown(result.summary!, result.diagnostics),
    );
    expect(stdout).toContain('Checked 2 files: 5 broken targets');
  });

  it('keeps the M19 count guard authoritative and writes nothing on mismatch', async () => {
    const root = makeTempRoot();
    const destination = join(root, 'step-summary.md');
    writeFileSync(destination, 'sentinel\n');

    await expect(
      writeStepSummary(
        { filesChecked: 1, broken: 2, externalSkipped: 0 },
        [
          {
            file: 'README.md',
            line: 1,
            target: 'missing.md',
            reason: 'target does not exist',
          },
        ],
        { GITHUB_STEP_SUMMARY: destination },
      ),
    ).rejects.toThrow(
      'run summary counts and findings disagree: broken=2, findings=1',
    );

    // The guard throws before the append, so no partial summary is written.
    expect(readFileSync(destination, 'utf8')).toBe('sentinel\n');
  });

  it('preserves existing summary bytes when appending', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, CLEAN_FIXTURE_FILES);
    const summaryPath = join(root, 'existing-step-summary.md');
    const seed = 'prior step summary\n\n- keep: every byte\n';
    writeFileSync(summaryPath, seed);

    const { result } = await invokeArtifact(root, fixture, summaryPath);
    const summary = readFileSync(summaryPath, 'utf8');

    expect(result.status).toBe(0);
    // The prefix is byte-for-byte unchanged and exactly one complete summary
    // follows it; the writer inserts no separator of its own.
    expect(summary.slice(0, seed.length)).toBe(seed);
    expect(summary).toBe(`${seed}${CLEAN_SUMMARY}`);
    expect(summary.slice(seed.length)).toBe(CLEAN_SUMMARY);
    expect(summaryOccurrences(summary)).toBe(1);

    // The documented no-separator rule also holds when the existing bytes do
    // not end with a newline: pre-existing bytes are never rewritten.
    const noNewlinePath = join(root, 'no-trailing-newline.md');
    writeFileSync(noNewlinePath, 'sentinel');
    const again = await invokeArtifact(root, fixture, noNewlinePath);
    expect(again.result.status).toBe(0);
    expect(readFileSync(noNewlinePath, 'utf8')).toBe(`sentinel${CLEAN_SUMMARY}`);
  });

  it('does not write when GITHUB_STEP_SUMMARY is absent', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, BROKEN_FIXTURE_FILES);

    const absent = await invokeArtifact(root, fixture, null);
    const withDestinationPath = join(root, 'step-summary.md');
    writeFileSync(withDestinationPath, '');
    const withDestination = await invokeArtifact(root, fixture, withDestinationPath);

    // Otherwise identical action behavior: no output, exit or value changes.
    expect(absent.result.timedOut).toBe(false);
    expect(absent.result.status).toBe(1);
    expect(absent.result.stdout).toBe(BROKEN_STDOUT);
    expect(absent.result.stderr).toBe('');
    expect(readFileSync(absent.outputPath, 'utf8')).toBe(BROKEN_OUTPUTS);
    expect(withDestination.result.stdout).toBe(absent.result.stdout);
    expect(withDestination.result.stderr).toBe(absent.result.stderr);
    expect(withDestination.result.status).toBe(absent.result.status);
    expect(readFileSync(withDestination.outputPath, 'utf8')).toBe(
      readFileSync(absent.outputPath, 'utf8'),
    );
  });

  it('does not write when GITHUB_STEP_SUMMARY is empty', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, BROKEN_FIXTURE_FILES);

    const empty = await invokeArtifact(root, fixture, '');
    const absent = await invokeArtifact(root, fixture, null);

    expect(empty.result.timedOut).toBe(false);
    expect(empty.result.status).toBe(1);
    expect(empty.result.stdout).toBe(BROKEN_STDOUT);
    expect(empty.result.stderr).toBe('');
    expect(readFileSync(empty.outputPath, 'utf8')).toBe(BROKEN_OUTPUTS);
    expect(empty.result.stdout).toBe(absent.result.stdout);
    expect(empty.result.stderr).toBe(absent.result.stderr);
    expect(empty.result.status).toBe(absent.result.status);
  });

  it('handles an unusable summary destination under the established action I/O policy', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, BROKEN_FIXTURE_FILES);
    const unusable = join(root, 'missing-parent', 'step-summary.md');
    const expectedError = await appendErrorMessage(unusable);

    const { result, outputPath } = await invokeArtifact(root, fixture, unusable);

    // The completed check's own surfaces are already complete: the unchanged
    // CLI output and annotations, the three published outputs, and no warning.
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe(BROKEN_STDOUT);
    expect(readFileSync(outputPath, 'utf8')).toBe(BROKEN_OUTPUTS);
    expect(result.stderr).not.toContain('::warning');
    expect(result.stderr).not.toContain('::error');

    // The append failure reaches the action entrypoint's existing internal-error
    // path, exactly like an output-file failure: reported once, no stack trace,
    // and never turned into a broken-link finding.
    expect(result.stderr).toBe(
      `md-link-check: internal error: ${expectedError}\n`,
    );
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(existsSync(unusable)).toBe(false);
  });

  it('writes no summary when no completed check produced a result', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, CLEAN_FIXTURE_FILES);
    const summaryPath = join(root, 'step-summary.md');
    writeFileSync(summaryPath, '');
    const outputPath = join(root, 'github-output.txt');
    writeFileSync(outputPath, '');

    const inputFailure = await runAction({
      cwd: fixture,
      inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'maybe' },
      env: {
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    expect(inputFailure.status).toBe(2);
    expect(inputFailure.stdout).toBe('');
    expect(inputFailure.stderr).toContain(
      'invalid action input "external": expected "true" or "false"',
    );
    expect(readFileSync(summaryPath, 'utf8')).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('');

    const discoveryFailure = await runAction({
      cwd: fixture,
      inputs: { INPUT_PATHS: 'does-not-exist.md' },
      env: {
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    expect(discoveryFailure.status).toBe(2);
    expect(discoveryFailure.stderr).toContain('cannot access input path');
    expect(readFileSync(summaryPath, 'utf8')).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('');
  });

  it('limits the action summary to fifty diagnostics with the overflow disclosure', async () => {
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    const links = Array.from(
      { length: 52 },
      (_, index) => `[missing ${index + 1}](missing-${index + 1}.md)`,
    );
    writeFiles(fixture, {
      'README.md': `# Overflow fixture\n\n${links.join('\n')}\n`,
    });
    const summaryPath = join(root, 'step-summary.md');
    writeFileSync(summaryPath, '');

    const { result } = await invokeArtifact(root, fixture, summaryPath);
    const summary = readFileSync(summaryPath, 'utf8');
    const diagnostics = summary.slice(summary.indexOf('## Diagnostics'));
    const listed = diagnostics.split('\n').filter((line) => line.startsWith('- '));

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'Checked 1 file: 52 broken targets, 0 external links skipped.\n',
    );
    expect(result.stdout.match(/^::error /gm)?.length).toBe(52);

    // The M19 limit is 50 in result order; the last two findings are disclosed
    // by count only. The counts remain the authentic M17 totals.
    expect(summary).toContain(
      '- Checked: 1\n- Broken: 52\n- External skipped: 0\n',
    );
    expect(listed).toHaveLength(50);
    expect(diagnostics).toContain(
      '- README.md:3: missing\\-1.md — target does not exist\n',
    );
    expect(diagnostics).toContain(
      '- README.md:52: missing\\-50.md — target does not exist\n',
    );
    expect(diagnostics).not.toContain('missing\\-51.md');
    expect(diagnostics).not.toContain('missing\\-52.md');
    expect(diagnostics.endsWith('\n\n52 total diagnostics; 2 not listed.\n')).toBe(
      true,
    );
    expect(summaryOccurrences(summary)).toBe(1);
  });

  it('action-dist/index.cjs is current', async () => {
    // Reuse the repository's established build script: --check regenerates the
    // bundle in a temporary directory and compares it byte for byte with the
    // committed artifact. This is the in-packet proof of bundle freshness.
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'action entrypoint is reproducible: action-dist/index.cjs',
    );
  });
});
