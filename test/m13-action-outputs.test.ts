import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCommandLine,
  runAction as runSourceAction,
} from '../src/action-runner.js';
import {
  publishSummaryOutputs,
  SUMMARY_OUTPUT_NAMES,
} from '../src/action-outputs.js';
import { formatAnnotations } from '../src/annotation.js';
import type { CliIo, RunResult } from '../src/run.js';
import {
  ACTION_ARTIFACT_PATH,
  REPO_ROOT,
  copyActionRuntime,
  readActionArtifactText,
  readScopeReport,
  runAction as runCommittedAction,
  runActionBuild,
  runCli,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import {
  captureRun,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';
import { startFixtureServer } from './server.js';

const CLEAN_COUNTS = { filesChecked: 2, broken: 0, externalSkipped: 1 };
const BROKEN_COUNTS = { filesChecked: 2, broken: 9, externalSkipped: 1 };

interface CapturedAction {
  exitCode: RunResult['exitCode'];
  diagnostics: RunResult['diagnostics'];
  summary: RunResult['summary'];
  stdout: string;
  stderr: string;
}

interface SummaryOutputValues {
  filesChecked: number;
  broken: number;
  externalSkipped: number;
}

/**
 * Creates the temporary output file a hosted runner would create, deliberately
 * outside every consumer fixture.
 */
function createOutputPath(root: string, initial = ''): string {
  const outputPath = join(root, 'github-output.txt');
  writeFileSync(outputPath, initial);
  return outputPath;
}

/**
 * Narrow test parser for environment-file records. It does not use the
 * production serializer as an oracle: it reads `name=value` lines, rejects
 * unknown or duplicated M13 names, and requires non-negative decimal safe
 * integers for the three summary outputs. Unrelated records are only allowed
 * when a test deliberately seeds them for append coverage.
 */
function parseSummaryOutputs(
  text: string,
  options: { allowPreexisting?: readonly string[] } = {},
): SummaryOutputValues {
  const required = new Set(Object.values(SUMMARY_OUTPUT_NAMES));
  const allowed = new Set([...required, ...(options.allowPreexisting ?? [])]);
  const records = new Map<string, string>();

  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`malformed action output record: ${JSON.stringify(line)}`);
    }
    const name = line.slice(0, separator);
    if (!allowed.has(name)) {
      throw new Error(`unexpected action output record: ${name}`);
    }
    if (records.has(name)) {
      throw new Error(`duplicate action output record: ${name}`);
    }
    records.set(name, line.slice(separator + 1));
  }

  const count = (name: string): number => {
    const value = records.get(name);
    if (value === undefined) {
      throw new Error(`missing action output record: ${name}`);
    }
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`non-decimal action output record: ${name}=${value}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`unsafe action output record: ${name}=${value}`);
    }
    return parsed;
  };

  return {
    filesChecked: count(SUMMARY_OUTPUT_NAMES.filesChecked),
    broken: count(SUMMARY_OUTPUT_NAMES.broken),
    externalSkipped: count(SUMMARY_OUTPUT_NAMES.externalSkipped),
  };
}

/** Number of physical records for one output name. */
function outputOccurrences(text: string, name: string): number {
  return text.split('\n').filter((line) => line.startsWith(`${name}=`)).length;
}

function requireSummary(action: CapturedAction): NonNullable<RunResult['summary']> {
  if (action.summary === null) {
    throw new Error('expected a completed checking run with a summary');
  }
  return action.summary;
}

/** Runs the action wrapper in-process, capturing its streams and result. */
async function captureSourceAction(environment: NodeJS.ProcessEnv): Promise<CapturedAction> {
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
  const result = await runSourceAction(environment, io);
  return {
    exitCode: result.exitCode,
    diagnostics: result.diagnostics,
    summary: result.summary,
    stdout,
    stderr,
  };
}

/** Runs the committed artifact as the GitHub runner would. */
function runArtifact(options: {
  cwd: string;
  inputs?: Record<string, string | undefined>;
  outputPath?: string;
  artifactPath?: string;
}) {
  return runCommittedAction({
    cwd: options.cwd,
    inputs: options.inputs ?? {},
    ...(options.outputPath === undefined
      ? {}
      : { env: { GITHUB_OUTPUT: options.outputPath } }),
    ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
  });
}

/**
 * Splits action stdout into the CLI-owned prefix and the trailing annotation
 * lines using the structured finding count, never by parsing CLI text to
 * recover findings.
 */
function splitActionOutput(
  stdout: string,
  findingCount: number,
): { cli: string; annotations: string[] } {
  const lines = stdout.split('\n');
  expect(lines.at(-1)).toBe('');
  const body = lines.slice(0, -1);
  const annotations = body.slice(body.length - findingCount);
  const cliLines = body.slice(0, body.length - findingCount);
  return { cli: cliLines.length === 0 ? '' : `${cliLines.join('\n')}\n`, annotations };
}

/** Captures the CLI-owned text of an in-process action run. */
function actionCliText(action: CapturedAction): string {
  return splitActionOutput(action.stdout, action.diagnostics.length).cli;
}

/** Captures the emitted annotations of an in-process action run. */
function actionAnnotations(action: CapturedAction): string[] {
  return splitActionOutput(action.stdout, action.diagnostics.length).annotations;
}

/** Counts physical annotation lines without parsing them. */
function annotationLineCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.startsWith('::error ')).length;
}

/** Runs the source action against one committed fixture with an output file. */
async function runSourceFixture(fixture: string): Promise<{
  action: CapturedAction;
  text: string;
  values: SummaryOutputValues;
}> {
  const root = makeTempRoot();
  const outputPath = createOutputPath(root);
  const action = await captureSourceAction({
    INPUT_PATHS: fixture,
    GITHUB_OUTPUT: outputPath,
  });
  const text = readFileSync(outputPath, 'utf8');
  return { action, text, values: parseSummaryOutputs(text) };
}

/** Runs one source-action fixture written into a temporary consumer root. */
async function runSourceConsumer(
  files: Record<string, string>,
  inputs: Record<string, string> = {},
): Promise<{
  root: string;
  action: CapturedAction;
  text: string;
  values: SummaryOutputValues;
}> {
  const root = makeTempRoot();
  writeFiles(root, files);
  const outputPath = createOutputPath(root);
  const action = await captureSourceAction({
    INPUT_PATHS: join(root, 'README.md'),
    GITHUB_OUTPUT: outputPath,
    ...inputs,
  });
  const text = readFileSync(outputPath, 'utf8');
  return { root, action, text, values: parseSummaryOutputs(text) };
}

/** Runs the committed artifact against one committed fixture. */
async function runArtifactFixture(
  fixture: string,
  initial = '',
  allowPreexisting: readonly string[] = [],
): Promise<{
  root: string;
  outputPath: string;
  result: Awaited<ReturnType<typeof runArtifact>>;
  text: string;
  values: SummaryOutputValues;
}> {
  const root = makeTempRoot();
  const outputPath = createOutputPath(root, initial);
  const result = await runArtifact({
    cwd: fixture,
    inputs: { INPUT_PATHS: '.' },
    outputPath,
  });
  const text = readFileSync(outputPath, 'utf8');
  return {
    root,
    outputPath,
    result,
    text,
    values: parseSummaryOutputs(text, { allowPreexisting }),
  };
}

describe('M13 structured summary flow', () => {
  it('action receives files checked from the structured run result', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(requireSummary(action).filesChecked).toBe(CLEAN_COUNTS.filesChecked);
    expect(requireSummary(action).filesChecked).toBe(cli.summary?.filesChecked);
    expect(Object.isFrozen(action.summary)).toBe(true);
  });

  it('action receives broken count from the structured run result', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(requireSummary(action).broken).toBe(BROKEN_COUNTS.broken);
    expect(requireSummary(action).broken).toBe(cli.summary?.broken);
  });

  it('action receives external skipped from the structured run result', async () => {
    for (const fixture of [M9_CLEAN_FIXTURE, M9_BROKEN_FIXTURE]) {
      const action = await captureSourceAction({ INPUT_PATHS: fixture });
      const cli = await captureRun([fixture]);

      expect(requireSummary(action).externalSkipped).toBe(
        CLEAN_COUNTS.externalSkipped,
      );
      expect(requireSummary(action).externalSkipped).toBe(
        cli.summary?.externalSkipped,
      );
    }
  });

  it('action does not parse text output for summary counts', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const misleading: string[] = [];
    const io: CliIo = {
      writeOut: () => {
        misleading.push('Checked 999 files: 999 broken targets, 999 external links skipped.');
      },
      writeError: () => {
        misleading.push('md-link-check: no input paths');
      },
    };

    const result = await runSourceAction(
      { INPUT_PATHS: M9_BROKEN_FIXTURE, GITHUB_OUTPUT: outputPath },
      io,
    );

    expect(misleading.length).toBeGreaterThan(0);
    expect(result.summary).toEqual(BROKEN_COUNTS);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(
      BROKEN_COUNTS,
    );
  });

  it('action does not parse JSON output for summary counts', async () => {
    expect(buildCommandLine({ paths: ['docs'], external: false })).not.toContain(
      '--json',
    );

    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.stdout.trimStart().startsWith('{')).toBe(false);
    expect(requireSummary(action)).toEqual(BROKEN_COUNTS);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(
      BROKEN_COUNTS,
    );
  });

  it('action does not derive broken count from annotations', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    let wroteOutput = false;
    const io: CliIo = {
      writeOut: () => {
        wroteOutput = true;
      },
      writeError: () => undefined,
    };

    const result = await runSourceAction(
      { INPUT_PATHS: M9_BROKEN_FIXTURE, GITHUB_OUTPUT: outputPath },
      io,
    );

    // The annotation bytes were discarded, yet the published count is the
    // structured finding count, not a count of rendered annotation strings.
    expect(wroteOutput).toBe(true);
    expect(result.diagnostics).toHaveLength(BROKEN_COUNTS.broken);
    expect(result.summary?.broken).toBe(BROKEN_COUNTS.broken);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(
      BROKEN_COUNTS.broken,
    );
  });

  it('action preserves the checker summary semantics', async () => {
    for (const [fixture, expected] of [
      [M9_CLEAN_FIXTURE, CLEAN_COUNTS],
      [M9_BROKEN_FIXTURE, BROKEN_COUNTS],
    ] as const) {
      const action = await captureSourceAction({ INPUT_PATHS: fixture });
      const cli = await captureRun([fixture]);

      expect(action.summary).toEqual(cli.summary);
      expect(action.summary).toEqual(expected);
      expect(requireSummary(action).broken).toBe(action.diagnostics.length);
    }
  });

  it('action summary fields are non-negative integer counts', async () => {
    for (const fixture of [M9_CLEAN_FIXTURE, M9_BROKEN_FIXTURE]) {
      const action = await captureSourceAction({ INPUT_PATHS: fixture });
      const summary = requireSummary(action);

      for (const value of Object.values(summary)) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }

    const usage = await captureSourceAction({});
    expect(usage.summary).toBeNull();
  });
});

describe('M13 output publication helper', () => {
  it('publishes files checked as a decimal action output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);

    await publishSummaryOutputs(
      { filesChecked: 12, broken: 3, externalSkipped: 4 },
      { GITHUB_OUTPUT: outputPath },
    );

    const text = readFileSync(outputPath, 'utf8');
    expect(text).toContain('files-checked=12\n');
    expect(parseSummaryOutputs(text).filesChecked).toBe(12);
  });

  it('publishes broken as a decimal action output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);

    await publishSummaryOutputs(
      { filesChecked: 5, broken: 7, externalSkipped: 0 },
      { GITHUB_OUTPUT: outputPath },
    );

    const text = readFileSync(outputPath, 'utf8');
    expect(text).toContain('broken=7\n');
    expect(parseSummaryOutputs(text).broken).toBe(7);
  });

  it('publishes external skipped as a decimal action output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);

    await publishSummaryOutputs(
      { filesChecked: 1, broken: 0, externalSkipped: 9 },
      { GITHUB_OUTPUT: outputPath },
    );

    const text = readFileSync(outputPath, 'utf8');
    expect(text).toContain('external-skipped=9\n');
    expect(parseSummaryOutputs(text).externalSkipped).toBe(9);
  });

  it('publishes each summary output exactly once', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);

    await publishSummaryOutputs(
      { filesChecked: 2, broken: 3, externalSkipped: 4 },
      { GITHUB_OUTPUT: outputPath },
    );

    const text = readFileSync(outputPath, 'utf8');
    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(outputOccurrences(text, name)).toBe(1);
    }
  });

  it('appends outputs without truncating existing content', async () => {
    const root = makeTempRoot();
    const initial = 'keep=existing\nprevious=value\n';
    const outputPath = createOutputPath(root, initial);

    await publishSummaryOutputs(
      { filesChecked: 6, broken: 0, externalSkipped: 2 },
      { GITHUB_OUTPUT: outputPath },
    );

    const text = readFileSync(outputPath, 'utf8');
    expect(text.startsWith(initial)).toBe(true);
    expect(
      parseSummaryOutputs(text, { allowPreexisting: ['keep', 'previous'] }),
    ).toEqual({ filesChecked: 6, broken: 0, externalSkipped: 2 });
  });

  it('publishes no output records to stdout', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await publishSummaryOutputs(
        { filesChecked: 1, broken: 2, externalSkipped: 3 },
        { GITHUB_OUTPUT: outputPath },
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('publishes no output records to stderr', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await publishSummaryOutputs(
        { filesChecked: 1, broken: 2, externalSkipped: 3 },
        { GITHUB_OUTPUT: outputPath },
      );
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it('uses the GitHub output environment file', async () => {
    const root = makeTempRoot();
    const first = join(root, 'first-output.txt');
    const second = join(root, 'second-output.txt');

    await publishSummaryOutputs(
      { filesChecked: 3, broken: 1, externalSkipped: 0 },
      { GITHUB_OUTPUT: first },
    );

    expect(parseSummaryOutputs(readFileSync(first, 'utf8'))).toEqual({
      filesChecked: 3,
      broken: 1,
      externalSkipped: 0,
    });
    expect(existsSync(second)).toBe(false);
  });

  it('does not use deprecated set-output commands', async () => {
    const { action } = await runSourceFixture(M9_CLEAN_FIXTURE);

    expect(action.stdout).not.toContain('::set-output');
    expect(action.stderr).not.toContain('::set-output');
    expect(readActionArtifactText()).not.toContain('::set-output');
  });

  it('waits for output publication before action completion', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);

    const action = await captureSourceAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });

    // The file is already complete when the action run resolves.
    expect(action.exitCode).toBe(0);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(
      CLEAN_COUNTS,
    );
  });

  it('missing GitHub output path follows the documented policy', async () => {
    const root = makeTempRoot();

    for (const environment of [{}, { GITHUB_OUTPUT: '' }]) {
      const action = await captureSourceAction({
        INPUT_PATHS: M9_CLEAN_FIXTURE,
        ...environment,
      });

      expect(action.exitCode).toBe(0);
      expect(action.stderr).toBe('');
      expect(actionCliText(action)).toBe(
        'Checked 2 files: 0 broken targets, 1 external link skipped.\n',
      );
    }

    expect(readdirSync(root)).toEqual([]);
  });

  it('output-file failure follows the internal-error contract', async () => {
    const root = makeTempRoot();
    const missingParent = join(root, 'missing', 'github-output.txt');

    await expect(
      runSourceAction(
        { INPUT_PATHS: M9_CLEAN_FIXTURE, GITHUB_OUTPUT: missingParent },
        { writeOut: () => undefined, writeError: () => undefined },
      ),
    ).rejects.toThrow();

    const consumer = join(root, 'consumer');
    writeFiles(consumer, { 'README.md': '# Clean\n' });
    const result = await runArtifact({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md' },
      outputPath: missingParent,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('md-link-check: internal error:');
    expect(result.stdout).not.toContain('::error');
    expect(existsSync(missingParent)).toBe(false);
  });
});

describe('M13 clean fixture outputs', () => {
  it('clean action publishes the exact files checked count', async () => {
    const { values } = await runSourceFixture(M9_CLEAN_FIXTURE);

    expect(values.filesChecked).toBe(CLEAN_COUNTS.filesChecked);
  });

  it('clean action publishes broken zero', async () => {
    const { values } = await runSourceFixture(M9_CLEAN_FIXTURE);

    expect(values.broken).toBe(0);
  });

  it('clean action publishes the exact external skipped count', async () => {
    const { values } = await runSourceFixture(M9_CLEAN_FIXTURE);

    expect(values.externalSkipped).toBe(CLEAN_COUNTS.externalSkipped);
  });

  it('clean action preserves unchanged printed output', async () => {
    const { action } = await runSourceFixture(M9_CLEAN_FIXTURE);
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(actionCliText(action)).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
  });

  it('clean action emits no annotation', async () => {
    const { action } = await runSourceFixture(M9_CLEAN_FIXTURE);

    expect(annotationLineCount(action.stdout)).toBe(0);
    expect(action.stdout).not.toContain('::error ');
  });

  it('clean action remains exit 0', async () => {
    const { action } = await runSourceFixture(M9_CLEAN_FIXTURE);

    expect(action.exitCode).toBe(0);
  });
});

describe('M13 broken fixture outputs', () => {
  it('broken action publishes the exact files checked count', async () => {
    const { values } = await runSourceFixture(M9_BROKEN_FIXTURE);

    expect(values.filesChecked).toBe(BROKEN_COUNTS.filesChecked);
  });

  it('broken action publishes the exact broken count', async () => {
    const { values } = await runSourceFixture(M9_BROKEN_FIXTURE);

    expect(values.broken).toBe(BROKEN_COUNTS.broken);
  });

  it('broken action publishes the exact external skipped count', async () => {
    const { values } = await runSourceFixture(M9_BROKEN_FIXTURE);

    expect(values.externalSkipped).toBe(BROKEN_COUNTS.externalSkipped);
  });

  it('broken action preserves unchanged CLI diagnostic and summary', async () => {
    const { action } = await runSourceFixture(M9_BROKEN_FIXTURE);
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(actionCliText(action)).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
  });

  it('broken action preserves one annotation per finding', async () => {
    const { action } = await runSourceFixture(M9_BROKEN_FIXTURE);
    const expected = formatAnnotations(action.diagnostics);

    expect(action.diagnostics).toHaveLength(BROKEN_COUNTS.broken);
    expect(actionAnnotations(action)).toEqual(expected);
    expect(annotationLineCount(action.stdout)).toBe(BROKEN_COUNTS.broken);
  });

  it('broken action remains exit 1', async () => {
    const { action } = await runSourceFixture(M9_BROKEN_FIXTURE);

    expect(action.exitCode).toBe(1);
  });

  it('multiple broken findings publish their summary count once', async () => {
    const { text, values } = await runSourceFixture(M9_BROKEN_FIXTURE);

    expect(values.broken).toBe(BROKEN_COUNTS.broken);
    expect(outputOccurrences(text, SUMMARY_OUTPUT_NAMES.broken)).toBe(1);
  });
});

describe('M13 external-count fixtures', () => {
  it('offline action publishes zero when no external target is skipped', async () => {
    const { values } = await runSourceConsumer({
      'README.md': '# Consumer\n\n[local](guide.md)\n',
      'guide.md': '# Guide\n',
    });

    expect(values.externalSkipped).toBe(0);
    expect(values.filesChecked).toBe(1);
  });

  it('offline action publishes the existing external skipped count', async () => {
    const { values } = await runSourceConsumer({
      'README.md':
        '# Consumer\n\n[one](https://example.com/one) and ![two](https://example.com/two)\n',
    });

    expect(values.externalSkipped).toBe(2);
  });

  it('offline action with repeated external uses publishes occurrence count', async () => {
    const { values } = await runSourceConsumer({
      'README.md': [
        '# Consumer',
        '',
        '[one](https://example.com/repeated)',
        '[two](https://example.com/repeated)',
        '![three](https://example.com/repeated)',
        '',
      ].join('\n'),
    });

    expect(values.externalSkipped).toBe(3);
  });

  it('code-excluded external text does not affect published count', async () => {
    const { values } = await runSourceConsumer({
      'README.md': [
        '# Consumer',
        '',
        '`[inline](https://example.com/inline)`',
        '',
        '```md',
        '[fenced](https://example.com/fenced)',
        '```',
        '',
      ].join('\n'),
    });

    expect(values.externalSkipped).toBe(0);
  });

  it('unused external reference definition does not affect published count', async () => {
    const { values } = await runSourceConsumer({
      'README.md': '# Consumer\n\nNo links.\n\n[unused]: https://example.com/unused\n',
    });

    expect(values.externalSkipped).toBe(0);
  });

  it('enabled external mode uses the existing external skipped semantics', async () => {
    const server = await startFixtureServer();
    try {
      const { values } = await runSourceConsumer(
        {
          'README.md': `# Consumer\n\n[ok](${server.urlFor('/ok')})\n`,
        },
        { INPUT_EXTERNAL: 'true' },
      );

      expect(server.requests.map((request) => request.path)).toEqual(['/ok']);
      expect(values).toEqual({ filesChecked: 1, broken: 0, externalSkipped: 0 });
    } finally {
      await server.close();
    }
  });
});

describe('M13 usage and internal outcomes', () => {
  it('usage error publishes no fabricated summary outputs', async () => {
    const root = makeTempRoot();
    const initial = 'keep=sentinel\n';
    const outputPath = createOutputPath(root, initial);
    const action = await captureSourceAction({ GITHUB_OUTPUT: outputPath });

    expect(action.exitCode).toBe(2);
    expect(action.summary).toBeNull();
    expect(readFileSync(outputPath, 'utf8')).toBe(initial);
  });

  it('usage error remains exit 2', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: '',
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(2);
    expect(action.stderr).toContain('md-link-check: no input paths');
  });

  it('usage error emits no annotation', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({ GITHUB_OUTPUT: outputPath });

    expect(annotationLineCount(action.stdout)).toBe(0);
    expect(action.stdout).not.toContain('::error ');
  });

  it('output publication failure is not reported as a broken link', async () => {
    const root = makeTempRoot();
    const consumer = join(root, 'consumer');
    writeFiles(consumer, { 'README.md': '# Clean\n' });
    const result = await runArtifact({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md' },
      outputPath: join(root, 'missing', 'github-output.txt'),
    });

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('::error');
    expect(result.stdout).not.toContain('Checked 0 files: 1 broken target');
    expect(result.stderr).toContain('md-link-check: internal error:');
  });
});

describe('M13 printed-output compatibility', () => {
  it('M13 clean stdout is byte-for-byte unchanged', async () => {
    const { action } = await runSourceFixture(M9_CLEAN_FIXTURE);
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(actionCliText(action)).toBe(cli.stdout);
  });

  it('M13 clean stderr is byte-for-byte unchanged', async () => {
    const { action } = await runSourceFixture(M9_CLEAN_FIXTURE);
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(action.stderr).toBe(cli.stderr);
  });

  it('M13 broken stdout is byte-for-byte unchanged', async () => {
    const { action } = await runSourceFixture(M9_BROKEN_FIXTURE);
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(actionCliText(action)).toBe(cli.stdout);
  });

  it('M13 broken stderr is byte-for-byte unchanged', async () => {
    const { action } = await runSourceFixture(M9_BROKEN_FIXTURE);
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(action.stderr).toBe(cli.stderr);
  });

  it('M13 usage stdout and stderr are unchanged', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({ GITHUB_OUTPUT: outputPath });
    const cli = await captureRun([]);

    expect(action.stdout).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
  });

  it('M12 annotation bytes and order are unchanged', async () => {
    const { action } = await runSourceFixture(M9_BROKEN_FIXTURE);
    const expected = formatAnnotations(action.diagnostics);

    expect(actionAnnotations(action)).toEqual(expected);
  });

  it('summary output records do not appear in logs', async () => {
    const { action, text } = await runSourceFixture(M9_BROKEN_FIXTURE);
    const logs = `${action.stdout}${action.stderr}`;

    expect(logs).not.toMatch(/^(?:files-checked|broken|external-skipped)=/m);
    expect(logs).not.toContain('GITHUB_OUTPUT');
    expect(action.stdout).not.toContain(text.trim());
  });

  it('direct CLI output remains unchanged', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli([M9_BROKEN_FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(result.status).toBe(cli.exitCode);
    expect(result.stdout).toBe(cli.stdout);
    expect(result.stderr).toBe(cli.stderr);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct CLI JSON remains unchanged', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const result = await runCli(['--json', M9_BROKEN_FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    const cli = await captureRun(['--json', M9_BROKEN_FIXTURE]);

    expect(result.status).toBe(cli.exitCode);
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(cli.stdout));
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toBe('');
  });

  it('direct CLI does not read or write GitHub output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const neverCreated = join(root, 'never-created.txt');

    const broken = await runCli([M9_BROKEN_FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    const clean = await runCli([M9_CLEAN_FIXTURE], {
      cwd: REPO_ROOT,
      env: { ...process.env, GITHUB_OUTPUT: neverCreated },
    });

    expect(broken.status).toBe(1);
    expect(clean.status).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
    expect(existsSync(neverCreated)).toBe(false);

    const cli = readFileSync(join(REPO_ROOT, 'dist', 'cli.js'), 'utf8');
    const run = readFileSync(join(REPO_ROOT, 'dist', 'run.js'), 'utf8');
    expect(`${cli}${run}`).not.toContain('GITHUB_OUTPUT');
  });
});

describe('M13 committed artifact outputs', () => {
  it('checked-in action entrypoint publishes clean summary outputs', async () => {
    const { result, values } = await runArtifactFixture(M9_CLEAN_FIXTURE);

    expect(result.status).toBe(0);
    expect(values).toEqual(CLEAN_COUNTS);
  });

  it('checked-in action entrypoint publishes broken summary outputs', async () => {
    const { result, values } = await runArtifactFixture(M9_BROKEN_FIXTURE);

    expect(result.status).toBe(1);
    expect(values).toEqual(BROKEN_COUNTS);
  });

  it('checked-in action entrypoint preserves annotations', async () => {
    const { result } = await runArtifactFixture(M9_BROKEN_FIXTURE);

    expect(annotationLineCount(result.stdout)).toBe(BROKEN_COUNTS.broken);
    expect(result.stdout).toContain('::error file=README.md,line=3::');
    expect(result.stderr).toBe('');
  });

  it('checked-in action entrypoint preserves printed CLI output', async () => {
    const { result } = await runArtifactFixture(M9_BROKEN_FIXTURE);
    const cli = await runCli(['.'], { cwd: M9_BROKEN_FIXTURE });
    const { cli: cliText } = splitActionOutput(result.stdout, BROKEN_COUNTS.broken);

    expect(cliText).toBe(cli.stdout);
    expect(result.stderr).toBe(cli.stderr);
  });

  it('checked-in action entrypoint preserves exits 0 1 and 2', async () => {
    const clean = await runArtifactFixture(M9_CLEAN_FIXTURE);
    const broken = await runArtifactFixture(M9_BROKEN_FIXTURE);
    const usageRoot = makeTempRoot();
    const usageOutput = createOutputPath(usageRoot, 'keep=sentinel\n');
    const usage = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '' },
      outputPath: usageOutput,
    });

    expect(clean.result.status).toBe(0);
    expect(broken.result.status).toBe(1);
    expect(usage.status).toBe(2);
    expect(readFileSync(usageOutput, 'utf8')).toBe('keep=sentinel\n');
  });

  it('checked-in action entrypoint appends to the GitHub output file', async () => {
    const initial = 'keep=existing\n';
    const { text, values } = await runArtifactFixture(
      M9_BROKEN_FIXTURE,
      initial,
      ['keep'],
    );

    expect(text.startsWith(initial)).toBe(true);
    expect(
      parseSummaryOutputs(text, { allowPreexisting: ['keep'] }),
    ).toEqual(BROKEN_COUNTS);
    expect(values).toEqual(BROKEN_COUNTS);
  });

  it('checked-in action entrypoint works from a separate consumer workspace', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[guide](docs/guide.md)\n',
      'docs/guide.md': '# Guide\n\n[top](#guide)\n',
    });
    const outputPath = join(root, 'consumer-output.txt');

    const clean = await runArtifact({
      cwd: consumer,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
      artifactPath,
    });
    expect(clean.status).toBe(0);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 2,
      broken: 0,
      externalSkipped: 0,
    });

    writeFileSync(
      join(consumer, 'docs', 'broken.md'),
      '# Broken\n\n[missing](missing.md)\n',
    );
    // A new step invocation gets its own runner-created output file.
    const brokenOutputPath = join(root, 'consumer-output-broken.txt');
    const broken = await runArtifact({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'docs' },
      outputPath: brokenOutputPath,
      artifactPath,
    });
    expect(broken.status).toBe(1);
    expect(parseSummaryOutputs(readFileSync(brokenOutputPath, 'utf8'))).toEqual({
      filesChecked: 2,
      broken: 1,
      externalSkipped: 0,
    });
    expect(existsSync(join(consumer, 'github-output.txt'))).toBe(false);
  });

  it('checked-in action entrypoint contains the summary output publisher', () => {
    const artifact = readActionArtifactText();

    expect(artifact).toContain('publishSummaryOutputs');
    expect(artifact).toContain('GITHUB_OUTPUT');
    expect(artifact).toContain(SUMMARY_OUTPUT_NAMES.filesChecked);
    expect(artifact).toContain(SUMMARY_OUTPUT_NAMES.externalSkipped);
  });
});

/**
 * In-packet artifact and dependency proofs.
 *
 * These duplicate the repository-wide checks on purpose: a merge-gate packet
 * only sees the files a PR changes, so the evidence that the committed
 * entrypoint is current, that a rebuild is byte reproducible and that the
 * package keeps zero runtime dependencies must live in an M13 test file too.
 */
describe('M13 in-packet artifact verification', () => {
  it('checked-in action artifact is current', async () => {
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('action entrypoint is reproducible');
    expect(result.stderr).toBe('');
  });

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

  it('package retains zero runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});

    const lockfile = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { dependencies?: Record<string, string> }> };
    expect(lockfile.packages?.['']?.dependencies ?? {}).toEqual({});

    const listed = JSON.parse(
      execFileSync('npm', ['ls', '--omit=dev', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as { dependencies?: Record<string, unknown> };
    expect(listed.dependencies ?? {}).toEqual({});
  });
});

describe('M13 scope and dependencies', () => {
  it('M13 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M13 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M13 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(
      report.changed.filter((path) => path.startsWith('.github/workflows/')),
    ).toEqual([]);
  });

  it('M13 creates no tag release or npm publication', () => {
    const tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { private?: boolean; publishConfig?: unknown };

    expect(tags.trim()).toBe('');
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
    expect(readActionArtifactText()).not.toContain('npm publish');
  });
});
