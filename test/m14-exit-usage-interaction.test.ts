/**
 * M14 — exit and usage interaction.
 *
 * M14 is an interaction-hardening milestone. The structured `RunResult` stays
 * authoritative while the GitHub Action's annotations and summary outputs are
 * active: a clean run exits 0, one or more broken links exit 1, and a usage
 * error exits 2. Annotations and outputs supplement the CLI result; they are
 * never parsed back to recalculate it.
 *
 * The tests build the expected outcome from the structured result and compare
 * CLI-owned bytes with a direct CLI run. They never recover findings, counts or
 * the exit status by parsing formatted output.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAction as runSourceAction } from '../src/action-runner.js';
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import { formatAnnotations } from '../src/annotation.js';
import { formatUsageErrorText } from '../src/run.js';
import type { BrokenLinkResult, CliIo, RunResult } from '../src/run.js';
import {
  ACTION_ARTIFACT_PATH,
  ACTION_SCOPE_SCRIPT,
  REPO_ROOT,
  copyActionRuntime,
  optionalScalar,
  readActionMetadata,
  readScopeReport,
  requireMapping,
  requireScalar,
  runAction as runCommittedAction,
  runActionBuild,
  runCli,
  runNode,
  withDefaultStepSummary,
} from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { parseAnnotation } from './m11-helpers.js';
import {
  captureRun,
  M9_BROKEN_FINDINGS,
  M9_BROKEN_FIXTURE,
  M9_CLEAN_FIXTURE,
} from './m9-helpers.js';
import { startFixtureServer } from './server.js';

/**
 * Controlled seams for the two "does not determine exit status" tests. The
 * default (`null`) delegates to the real annotation formatter and output
 * publisher, so every other test exercises production behavior. A test sets
 * one override to make the rendered annotation count or the published summary
 * counts disagree with the structured result, proving the action exit code
 * still comes from `RunResult.exitCode`.
 */
const overrides = vi.hoisted(() => ({
  annotations: null as
    | null
    | ((findings: readonly BrokenLinkResult[]) => readonly string[]),
  summary: null as
    | null
    | ((summary: {
        filesChecked: number;
        broken: number;
        externalSkipped: number;
      }) => { filesChecked: number; broken: number; externalSkipped: number }),
}));

vi.mock('../src/annotation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/annotation.js')>();
  return {
    ...actual,
    formatAnnotations: (findings: readonly BrokenLinkResult[]): readonly string[] =>
      overrides.annotations === null
        ? actual.formatAnnotations(findings)
        : overrides.annotations(findings),
  };
});

vi.mock('../src/action-outputs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/action-outputs.js')>();
  return {
    ...actual,
    publishSummaryOutputs: async (
      summary: Parameters<typeof actual.publishSummaryOutputs>[0],
      environment: NodeJS.ProcessEnv,
    ): Promise<void> => {
      const effective = overrides.summary === null ? summary : overrides.summary(summary);
      await actual.publishSummaryOutputs(effective, environment);
    },
  };
});

const SEPARATOR = ' — ';

/** Structured summary counts for the committed clean fixture, offline mode. */
const CLEAN_COUNTS = { filesChecked: 2, broken: 0, externalSkipped: 1 };

/** Structured summary counts for the committed broken fixture, offline mode. */
const BROKEN_COUNTS = { filesChecked: 2, broken: 9, externalSkipped: 1 };

/** Frozen CLI-owned text for the committed clean fixture, offline mode. */
const CLEAN_CLI_TEXT =
  'Checked 2 files: 0 broken targets, 1 external link skipped.\n';

/** Frozen CLI-owned text for the committed broken fixture, offline mode. */
const BROKEN_CLI_TEXT = `${[
  ...M9_BROKEN_FINDINGS.map(
    ({ file, line, target, reason }) => `${file}:${line}: ${target}${SEPARATOR}${reason}`,
  ),
  'Checked 2 files: 9 broken targets, 1 external link skipped.',
].join('\n')}\n`;

/** Frozen CLI-owned usage text, written to stderr, for no input paths. */
const USAGE_TEXT = [
  'md-link-check: no input paths',
  '',
  'Usage: md-link-check [--json] [--external] <path...>',
  'Run "md-link-check --help" for usage and exit codes.',
  '',
].join('\n');

/** The authorized M14 base commit from the milestone packet. */
const M14_BASE_SHA = 'be1c58084966d8003a48d687b028451c0a7c7b03';

/** The committed M14 plan record that restates the plan criteria. */
const M14_PLAN_PATH = join(REPO_ROOT, 'docs', 'm14-plan.md');

/** `npm` is `npm.cmd` on Windows; `execFileSync` does not use a shell. */
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

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

/** Runs the action wrapper in-process from TypeScript source. */
async function captureSourceAction(
  environment: NodeJS.ProcessEnv,
): Promise<CapturedAction> {
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
  const result = await runSourceAction(withDefaultStepSummary(environment), io);
  return {
    exitCode: result.exitCode,
    diagnostics: result.diagnostics,
    summary: result.summary,
    stdout,
    stderr,
  };
}

/** Runs the committed artifact exactly as the GitHub runner would. */
function runArtifact(options: {
  cwd: string;
  inputs?: Record<string, string | undefined>;
  artifactPath?: string;
  outputPath?: string;
  fetchLog?: string;
}) {
  return runCommittedAction({
    cwd: options.cwd,
    inputs: options.inputs ?? {},
    ...(options.artifactPath === undefined
      ? {}
      : { artifactPath: options.artifactPath }),
    ...(options.outputPath === undefined
      ? {}
      : { env: { GITHUB_OUTPUT: options.outputPath } }),
    ...(options.fetchLog === undefined ? {} : { fetchLog: options.fetchLog }),
  });
}

/** Creates the temporary output file a hosted runner would create. */
function createOutputPath(root: string, initial = ''): string {
  const outputPath = join(root, 'github-output.txt');
  writeFileSync(outputPath, initial);
  return outputPath;
}

/**
 * Protocol-aware parser for the runner's `GITHUB_OUTPUT` environment file. It
 * understands the `name=value` records the implementation writes and, for
 * forward coverage of the documented environment-file protocol, the
 * `name<<DELIMITER` multiline form. Unknown or duplicate names are rejected so
 * a second publication of the same summary key cannot pass as a valid file.
 */
function parseSummaryOutputs(
  text: string,
  options: { allowPreexisting?: readonly string[] } = {},
): SummaryOutputValues {
  const required = new Set(Object.values(SUMMARY_OUTPUT_NAMES));
  const allowed = new Set([...required, ...(options.allowPreexisting ?? [])]);
  const records = new Map<string, string>();
  const lines = text.split('\n');
  if (lines.at(-1) !== '') {
    throw new Error('action output file must end with a newline');
  }

  const register = (name: string, value: string): void => {
    if (!allowed.has(name)) {
      throw new Error(`unexpected action output record: ${name}`);
    }
    if (records.has(name)) {
      throw new Error(`duplicate action output record: ${name}`);
    }
    records.set(name, value);
  };

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? '';
    if (line === '') {
      throw new Error('blank action output record');
    }
    if (line.includes('\r')) {
      throw new Error('carriage return in action output record');
    }

    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc !== null) {
      const name = heredoc[1] ?? '';
      const delimiter = heredoc[2] ?? '';
      const valueLines: string[] = [];
      index += 1;
      while (index < lines.length - 1 && lines[index] !== delimiter) {
        valueLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index >= lines.length - 1 || lines[index] !== delimiter) {
        throw new Error(`unterminated action output value for: ${name}`);
      }
      register(name, valueLines.join('\n'));
      continue;
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`malformed action output record: ${JSON.stringify(line)}`);
    }
    register(line.slice(0, separator), line.slice(separator + 1));
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

/**
 * Splits action stdout into the CLI-owned prefix and the trailing annotation
 * lines using the structured finding count, never by parsing CLI text.
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

/** Counts physical annotation lines without parsing them. */
function annotationLineCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.startsWith('::error ')).length;
}

/** Captures the CLI-owned text of an in-process action run. */
function actionCliText(action: CapturedAction): string {
  return splitActionOutput(action.stdout, action.diagnostics.length).cli;
}

/** Captures the emitted annotations of an in-process action run. */
function actionAnnotations(action: CapturedAction): string[] {
  return splitActionOutput(action.stdout, action.diagnostics.length).annotations;
}

/** Requires a completed checking run so its summary counts can be compared. */
function requireSummary(action: CapturedAction): NonNullable<RunResult['summary']> {
  if (action.summary === null) {
    throw new Error('expected a completed checking run with a summary');
  }
  return action.summary;
}

/** True when the commit is present, so history-dependent checks can run. */
function commitAvailable(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Returns one `## ` section of the plan record, excluding the heading. */
function planSection(plan: string, heading: string): string {
  const start = plan.indexOf(heading);
  if (start === -1) {
    return '';
  }
  const rest = plan.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

afterEach(() => {
  overrides.annotations = null;
  overrides.summary = null;
});

describe('M14 exit matrix while annotations and outputs are active', () => {
  it('clean action exits 0 while annotations and outputs are active', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(action.summary).toEqual(CLEAN_COUNTS);
    expect(action.stdout).toBe(cli.stdout);
    expect(action.stdout).toBe(CLEAN_CLI_TEXT);
    expect(action.stderr).toBe(cli.stderr);
    expect(action.stdout).not.toContain('::error');
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(CLEAN_COUNTS);
  });

  it('broken action exits 1 while annotations and outputs are active', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(BROKEN_COUNTS.broken);
    expect(action.summary).toEqual(BROKEN_COUNTS);
    expect(annotationLineCount(action.stdout)).toBe(BROKEN_COUNTS.broken);
    expect(actionCliText(action)).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(BROKEN_COUNTS);
  });

  it('usage-error action exits 2 while annotations and outputs are active', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const action = await captureSourceAction({ GITHUB_OUTPUT: outputPath });

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.summary).toBeNull();
    expect(action.stdout).toBe('');
    expect(action.stderr).toBe(USAGE_TEXT);
    expect(`${action.stdout}${action.stderr}`).not.toContain('::error');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('one broken link exits 1', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Consumer\n\n[missing](missing.md)\n' });
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: join(root, 'README.md'),
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(1);
    expect(actionAnnotations(action)).toHaveLength(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 1,
      externalSkipped: 0,
    });
  });

  it('multiple broken links still exit 1', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Consumer\n\n[first](missing-a.md)\n[second](missing-b.md)\n',
      'docs/guide.md': '# Guide\n\n[third](missing-c.md)\n',
    });
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: root,
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(1);
    expect(action.diagnostics).toHaveLength(3);
    expect(actionAnnotations(action)).toHaveLength(3);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 2,
      broken: 3,
      externalSkipped: 0,
    });
  });

  it('annotation count does not determine exit status', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    overrides.annotations = () => [];
    try {
      const action = await captureSourceAction({
        INPUT_PATHS: M9_BROKEN_FIXTURE,
        GITHUB_OUTPUT: outputPath,
      });

      // The structured result still has nine findings and stays exit 1 even
      // though this run renders no annotation at all.
      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toHaveLength(BROKEN_COUNTS.broken);
      expect(action.stdout).not.toContain('::error');
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(BROKEN_COUNTS);
    } finally {
      overrides.annotations = null;
    }
  });

  it('summary output values do not determine exit status', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    overrides.summary = () => ({ filesChecked: 0, broken: 0, externalSkipped: 0 });
    try {
      const action = await captureSourceAction({
        INPUT_PATHS: M9_BROKEN_FIXTURE,
        GITHUB_OUTPUT: outputPath,
      });

      // The written counts disagree with the structured result on purpose;
      // the action still exits 1 because the result defines the outcome.
      expect(action.exitCode).toBe(1);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 0,
        broken: 0,
        externalSkipped: 0,
      });
      expect(actionAnnotations(action)).toEqual(formatAnnotations(action.diagnostics));
    } finally {
      overrides.summary = null;
    }
  });

  it('skipped external targets do not change clean exit 0', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md':
        '# Consumer\n\n[one](https://example.com/one)\n[two](https://example.com/two)\n',
    });
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: join(root, 'README.md'),
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(actionAnnotations(action)).toEqual([]);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 0,
      externalSkipped: 2,
    });
  });

  it('enabled broken external target exits 1 through a finding', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, { 'README.md': `# Consumer\n\n[external](${target})\n` });
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toEqual([
        {
          file: join(root, 'README.md'),
          line: 3,
          target,
          reason: 'external HTTP 404',
        },
      ]);
      expect(actionAnnotations(action)).toHaveLength(1);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
    } finally {
      await server.close();
    }
  });

  it('local and external findings together exit 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const externalTarget = server.urlFor('/not-found');
    writeFiles(root, {
      'README.md': [
        '# Consumer',
        '',
        '[local](missing.md)',
        '',
        `[external](${externalTarget})`,
        '',
      ].join('\n'),
    });
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });
      const annotations = actionAnnotations(action).map((annotation) =>
        parseAnnotation(annotation),
      );

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics.map((finding) => finding.target)).toEqual([
        'missing.md',
        externalTarget,
      ]);
      expect(action.diagnostics.map((finding) => finding.reason)).toEqual([
        'target does not exist',
        'external HTTP 404',
      ]);
      expect(annotations.map((annotation) => annotation.rawMessage)).toEqual([
        `missing.md${SEPARATOR}target does not exist`,
        `${externalTarget}${SEPARATOR}external HTTP 404`,
      ]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 2,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
    }
  });
});

describe('M14 plan evidence', () => {
  it('M14 plan restates the exact clean HEAD and the one-day scope', () => {
    const plan = readFileSync(M14_PLAN_PATH, 'utf8');

    expect(plan).toContain(`\`${M14_BASE_SHA}\``);
    expect(plan).toContain('Exact starting `HEAD`');
    expect(plan).toMatch(/Starting worktree: clean/i);
    expect(plan).toMatch(
      /one focused pull request of approximately one day of work/i,
    );
  });

  it('M14 plan states assumptions confidence and the facts that could change it', () => {
    const plan = readFileSync(M14_PLAN_PATH, 'utf8');
    const headings = [
      '## Assumptions',
      '## Confidence',
      '## Facts that could change the plan',
    ];

    for (const heading of headings) {
      expect(plan).toContain(heading);
      expect(planSection(plan, heading).length).toBeGreaterThan(120);
    }
  });
});

describe('M14 broken-run retention', () => {
  it('broken action retains every annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const expected = formatAnnotations(action.diagnostics);

    expect(action.exitCode).toBe(1);
    expect(expected).toHaveLength(BROKEN_COUNTS.broken);
    expect(actionAnnotations(action)).toEqual(expected);
  });

  it('broken action retains every established summary output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const text = readFileSync(outputPath, 'utf8');

    expect(action.exitCode).toBe(1);
    expect(parseSummaryOutputs(text)).toEqual(requireSummary(action));
    expect(parseSummaryOutputs(text)).toEqual(BROKEN_COUNTS);
    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(outputOccurrences(text, name)).toBe(1);
    }
  });

  it('broken result publishes every documented output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const text = readFileSync(outputPath, 'utf8');

    expect(action.exitCode).toBe(1);
    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(outputOccurrences(text, name)).toBe(1);
    }
    expect(parseSummaryOutputs(text)).toEqual(BROKEN_COUNTS);
  });

  it('broken action annotation order equals result order', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const annotations = actionAnnotations(action).map((annotation) =>
      parseAnnotation(annotation),
    );

    expect(annotations).toHaveLength(action.diagnostics.length);
    for (const [index, finding] of action.diagnostics.entries()) {
      expect(annotations[index]?.file).toBe(finding.file);
      expect(annotations[index]?.line).toBe(finding.line);
      expect(annotations[index]?.message).toBe(
        `${finding.target}${SEPARATOR}${finding.reason}`,
      );
    }
  });

  it('broken action outputs match the structured summary', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const summary = requireSummary(action);

    expect(action.exitCode).toBe(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: summary.filesChecked,
      broken: summary.broken,
      externalSkipped: summary.externalSkipped,
    });
  });

  it('broken action diagnostic text remains unchanged', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);

    expect(action.exitCode).toBe(1);
    expect(actionCliText(action)).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
  });

  it('broken action summary text remains unchanged', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cliText = actionCliText(action);
    const summaryLine = 'Checked 2 files: 9 broken targets, 1 external link skipped.';

    expect(cliText.split('\n').filter((line) => line === summaryLine)).toHaveLength(1);
    expect(cliText.trimEnd().split('\n').at(-1)).toBe(summaryLine);
  });

  it('broken action completes annotation emission before exit', async () => {
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(result.status).toBe(1);
    expect(annotationLineCount(result.stdout)).toBe(BROKEN_COUNTS.broken);
    expect(result.stdout.endsWith('\n')).toBe(true);
    expect(result.stdout).toContain('::error file=README.md,line=3::');
  });

  it('broken action completes output publication before exit', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    // The child process has exited; the output file is already complete.
    expect(result.status).toBe(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(BROKEN_COUNTS);
  });

  it('exit 1 does not suppress annotations', async () => {
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });

    expect(result.status).toBe(1);
    expect(annotationLineCount(result.stdout)).toBe(BROKEN_COUNTS.broken);
  });

  it('exit 1 does not suppress outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(result.status).toBe(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(BROKEN_COUNTS);
  });

  it('broken count output matches diagnostic count', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const values = parseSummaryOutputs(readFileSync(outputPath, 'utf8'));

    expect(action.exitCode).toBe(1);
    expect(values.broken).toBe(action.diagnostics.length);
  });
});

describe('M14 M13 output contract', () => {
  /** The complete M13 output set, sorted. */
  const ESTABLISHED_OUTPUT_NAMES = ['broken', 'external-skipped', 'files-checked'];

  function metadataOutputNames(): string[] {
    return [...requireMapping(readActionMetadata().fields, 'outputs').keys()].sort();
  }

  it('output names match action metadata', () => {
    expect(metadataOutputNames()).toEqual(
      Object.values(SUMMARY_OUTPUT_NAMES).sort(),
    );
    expect(metadataOutputNames()).toEqual(ESTABLISHED_OUTPUT_NAMES);
  });

  it('output values retain established string types', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const records = readFileSync(outputPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '');

    expect(records).toHaveLength(3);
    for (const record of records) {
      const separator = record.indexOf('=');
      expect(separator).toBeGreaterThan(0);
      expect(record.slice(separator + 1)).toMatch(/^(?:0|[1-9][0-9]*)$/);
    }
  });

  it('output values retain established meanings', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const summary = requireSummary(action);

    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: summary.filesChecked,
      broken: summary.broken,
      externalSkipped: summary.externalSkipped,
    });
  });

  it('output file contains no duplicate summary key', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const text = readFileSync(outputPath, 'utf8');

    for (const name of ESTABLISHED_OUTPUT_NAMES) {
      expect(outputOccurrences(text, name)).toBe(1);
    }
  });

  it('output environment-file encoding remains valid', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const text = readFileSync(outputPath, 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    for (const line of text.split('\n').filter((entry) => entry !== '')) {
      expect(line).toMatch(/^[a-z-]+=(?:0|[1-9][0-9]*)$/);
    }
  });

  it('M14 removes no output', () => {
    expect(metadataOutputNames()).toEqual(
      expect.arrayContaining(ESTABLISHED_OUTPUT_NAMES),
    );
    expect(metadataOutputNames()).toHaveLength(ESTABLISHED_OUTPUT_NAMES.length);
  });

  it('M14 renames no output', () => {
    expect(metadataOutputNames()).toEqual(ESTABLISHED_OUTPUT_NAMES);
  });

  it('M14 adds no output', () => {
    expect(metadataOutputNames()).toEqual(ESTABLISHED_OUTPUT_NAMES);
  });
});

describe('M14 clean-run behavior', () => {
  it('clean action emits no annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(actionAnnotations(action)).toEqual([]);
    expect(action.stdout).not.toContain('::error');
  });

  it('clean action publishes established clean summary outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(0);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: CLEAN_COUNTS.filesChecked,
      broken: 0,
      externalSkipped: CLEAN_COUNTS.externalSkipped,
    });
  });

  it('clean result publishes every documented output', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const text = readFileSync(outputPath, 'utf8');

    expect(action.exitCode).toBe(0);
    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(outputOccurrences(text, name)).toBe(1);
    }
    expect(parseSummaryOutputs(text)).toEqual(CLEAN_COUNTS);
  });

  it('clean action CLI output remains unchanged', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const cli = await captureRun([M9_CLEAN_FIXTURE]);

    expect(action.exitCode).toBe(0);
    expect(action.stdout).toBe(cli.stdout);
    expect(action.stdout).toBe(CLEAN_CLI_TEXT);
    expect(action.stderr).toBe(cli.stderr);
  });

  it('clean action emits no broken diagnostic', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const diagnosticLines = action.stdout
      .split('\n')
      .filter((line) => /^[^:]+:\d+: /.test(line));

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(diagnosticLines).toEqual([]);
  });

  it('clean outputs contain no fabricated broken count', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const values = parseSummaryOutputs(readFileSync(outputPath, 'utf8'));

    expect(action.exitCode).toBe(0);
    expect(action.diagnostics).toEqual([]);
    expect(actionAnnotations(action)).toEqual([]);
    expect(values.broken).toBe(0);
    expect(values.filesChecked).toBe(CLEAN_COUNTS.filesChecked);
  });

  it('clean action waits for output publication before exit 0', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const result = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(CLEAN_CLI_TEXT);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(CLEAN_COUNTS);
  });
});

describe('M14 usage-error behavior', () => {
  it('usage error exits 2', async () => {
    const action = await captureSourceAction({});

    expect(action.exitCode).toBe(2);
  });

  it('usage error emits no broken-link annotation', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({ GITHUB_OUTPUT: outputPath });

    expect(action.exitCode).toBe(2);
    expect(annotationLineCount(action.stdout)).toBe(0);
    expect(action.stdout).not.toContain('::error');
  });

  it('usage error fabricates no broken-link finding', async () => {
    const action = await captureSourceAction({});

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.summary).toBeNull();
  });

  it('usage text is byte-for-byte unchanged', async () => {
    const action = await captureSourceAction({});
    const cli = await captureRun([]);

    expect(action.stdout).toBe(cli.stdout);
    expect(action.stderr).toBe(cli.stderr);
    expect(action.stderr).toBe(USAGE_TEXT);
  });

  it('usage stdout and stderr routing remain unchanged', async () => {
    const action = await captureSourceAction({});

    expect(action.stdout).toBe('');
    expect(action.stderr).not.toBe('');
    expect(action.stderr).toContain('no input paths');
  });

  it('usage error is not reinterpreted as exit 1', async () => {
    const action = await captureSourceAction({});

    expect(action.exitCode).toBe(2);
    expect(action.exitCode).not.toBe(1);
  });

  it('usage-error output behavior matches the established M13 contract', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\nprevious=value\n');
    const action = await captureSourceAction({ GITHUB_OUTPUT: outputPath });

    expect(action.exitCode).toBe(2);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\nprevious=value\n');
  });

  it('usage text does not become an annotation', async () => {
    const action = await captureSourceAction({});
    const output = `${action.stdout}${action.stderr}`;

    expect(output).not.toContain('::error');
    expect(output.split('\n').some((line) => line.startsWith('::'))).toBe(false);
  });

  it('missing paths remains a usage error', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: '' });

    expect(action.exitCode).toBe(2);
    expect(action.stderr).toContain('md-link-check: no input paths');
  });

  it('invalid external input remains a usage error', async () => {
    const action = await captureSourceAction({
      INPUT_PATHS: M9_CLEAN_FIXTURE,
      INPUT_EXTERNAL: 'enabled',
    });

    expect(action.exitCode).toBe(2);
    expect(action.diagnostics).toEqual([]);
    expect(action.summary).toBeNull();
    expect(action.stdout).toBe('');
    expect(action.stderr).toBe(
      formatUsageErrorText(
        'invalid action input "external": expected "true" or "false"',
      ),
    );
  });
});

describe('M14 annotation and output independence', () => {
  it('annotations do not replace the CLI result', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);
    const { cli: cliText, annotations } = splitActionOutput(
      action.stdout,
      action.diagnostics.length,
    );

    expect(action.exitCode).toBe(1);
    expect(cliText).toBe(cli.stdout);
    expect(annotations).toHaveLength(BROKEN_COUNTS.broken);
    expect(action.stdout.indexOf('::error ')).toBeGreaterThan(
      action.stdout.indexOf('Checked 2 files: 9 broken targets'),
    );
  });

  it('summary outputs do not replace the CLI result', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const cli = await captureRun([M9_BROKEN_FIXTURE]);
    const logs = `${action.stdout}${action.stderr}`;

    expect(action.exitCode).toBe(1);
    expect(actionCliText(action)).toBe(cli.stdout);
    expect(logs).not.toMatch(/^(?:files-checked|broken|external-skipped)=/m);
  });

  it('annotations and outputs derive from structured results', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: outputPath,
    });
    const summary = requireSummary(action);

    expect(actionAnnotations(action)).toEqual(formatAnnotations(action.diagnostics));
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: summary.filesChecked,
      broken: summary.broken,
      externalSkipped: summary.externalSkipped,
    });
  });

  it('annotations are not derived from summary outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    overrides.summary = () => ({ filesChecked: 7, broken: 0, externalSkipped: 0 });
    try {
      const action = await captureSourceAction({
        INPUT_PATHS: M9_BROKEN_FIXTURE,
        GITHUB_OUTPUT: outputPath,
      });

      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8')).broken).toBe(0);
      expect(actionAnnotations(action)).toEqual(formatAnnotations(action.diagnostics));
      expect(actionAnnotations(action)).toHaveLength(BROKEN_COUNTS.broken);
    } finally {
      overrides.summary = null;
    }
  });

  it('outputs are not derived from annotation text', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Consumer\n\n[missing](missing-files-checked=99.md)\n',
    });
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: join(root, 'README.md'),
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(1);
    expect(actionAnnotations(action).join('\n')).toContain('missing-files-checked=99.md');
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 1,
      externalSkipped: 0,
    });
  });

  it('neither annotations nor outputs parse CLI text', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': [
        '# Consumer',
        '',
        'Checked 9 files: 99 broken targets, 7 external links skipped.',
        'files-checked=99',
        'broken=99',
        '::error file=fake.md,line=1::fake — target does not exist',
        '',
        '[missing](missing.md)',
        '',
      ].join('\n'),
    });
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: join(root, 'README.md'),
      GITHUB_OUTPUT: outputPath,
    });
    const annotations = actionAnnotations(action).map((annotation) =>
      parseAnnotation(annotation),
    );

    expect(action.exitCode).toBe(1);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.file).toBe(join(root, 'README.md'));
    expect(annotations[0]?.line).toBe(8);
    expect(annotations[0]?.message).toBe(
      `missing.md${SEPARATOR}target does not exist`,
    );
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 1,
      externalSkipped: 0,
    });
  });

  it('annotation and output ordering is deterministic', async () => {
    const firstRoot = makeTempRoot();
    const firstOutput = createOutputPath(firstRoot);
    const secondRoot = makeTempRoot();
    const secondOutput = createOutputPath(secondRoot);

    const first = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: firstOutput,
    });
    const second = await captureSourceAction({
      INPUT_PATHS: M9_BROKEN_FIXTURE,
      GITHUB_OUTPUT: secondOutput,
    });
    const firstText = readFileSync(firstOutput, 'utf8');
    const secondText = readFileSync(secondOutput, 'utf8');

    expect(first.stdout).toBe(second.stdout);
    expect(firstText).toBe(secondText);
    expect(firstText.split('\n').filter((line) => line !== '')[0]).toMatch(
      /^files-checked=/,
    );
    expect(firstText.split('\n').filter((line) => line !== '')[1]).toMatch(/^broken=/);
    expect(firstText.split('\n').filter((line) => line !== '')[2]).toMatch(
      /^external-skipped=/,
    );
  });

  it('rendering does not mutate the structured result', async () => {
    const first = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const second = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(Object.isFrozen(first.diagnostics)).toBe(true);
    expect(first.diagnostics.every((finding) => Object.isFrozen(finding))).toBe(true);
    expect(Object.isFrozen(first.summary)).toBe(true);
    expect(first.diagnostics).toEqual(second.diagnostics);
    expect(first.summary).toEqual(second.summary);
  });
});

/** The committed broken fixture's CLI output, reused by child-process tests. */
async function directBrokenCli() {
  return runCli(['.'], { cwd: M9_BROKEN_FIXTURE });
}

describe('M14 failure interaction', () => {
  it('annotation write failure follows the established internal-error policy', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, INPUT_PATHS: '.' };
    delete env.GITHUB_OUTPUT;
    delete env.GITHUB_STEP_SUMMARY;

    const result = await runNode(ACTION_ARTIFACT_PATH, [], {
      cwd: M9_BROKEN_FIXTURE,
      env,
      requires: [join(REPO_ROOT, 'test', 'action-write-failure.cjs')],
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe(BROKEN_CLI_TEXT);
    expect(result.stderr).toContain(
      'md-link-check: internal error: simulated annotation write failure',
    );
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  it('annotation write failure does not fabricate a broken-link result', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, INPUT_PATHS: '.' };
    delete env.GITHUB_OUTPUT;
    delete env.GITHUB_STEP_SUMMARY;

    const result = await runNode(ACTION_ARTIFACT_PATH, [], {
      cwd: M9_BROKEN_FIXTURE,
      env,
      requires: [join(REPO_ROOT, 'test', 'action-write-failure.cjs')],
    });

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain('::error');
    expect(result.stdout).not.toContain('Checked 0 files');
    expect(result.stderr).not.toContain('::error');
  });

  it('output write failure follows the established internal-error policy', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath: missingOutput,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('md-link-check: internal error:');
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(existsSync(missingOutput)).toBe(false);
  });

  it('output write failure does not fabricate a broken-link result', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath: missingOutput,
    });
    const { cli, annotations } = splitActionOutput(
      result.stdout,
      BROKEN_COUNTS.broken,
    );

    expect(result.status).toBe(2);
    expect(annotationLineCount(result.stdout)).toBe(BROKEN_COUNTS.broken);
    expect(annotations).toEqual(formatAnnotations(M9_BROKEN_FINDINGS));
    expect(cli).toContain('Checked 2 files: 9 broken targets');
  });

  it('rendering failure does not convert usage error to exit 1', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');
    const result = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '' },
      outputPath: missingOutput,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_TEXT);
  });

  it('rendering failure does not silently produce exit 0', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');

    const broken = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath: missingOutput,
    });
    const clean = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath: missingOutput,
    });

    expect(broken.status).toBe(2);
    expect(clean.status).toBe(2);
  });

  it('already written diagnostic text remains unchanged on rendering failure', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath: missingOutput,
    });
    const cli = await directBrokenCli();
    const { cli: cliText } = splitActionOutput(result.stdout, BROKEN_COUNTS.broken);

    expect(result.status).toBe(2);
    expect(cliText).toBe(cli.stdout);
    expect(cliText).toBe(BROKEN_CLI_TEXT);
  });

  it('already written usage text remains unchanged on rendering failure', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');
    const result = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '' },
      outputPath: missingOutput,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe(USAGE_TEXT);
  });

  it('failure handling exposes no unexpected stack trace', async () => {
    const root = makeTempRoot();
    const missingOutput = join(root, 'missing', 'github-output.txt');
    const outputFailure = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath: missingOutput,
    });
    const usageFailure = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '' },
      outputPath: missingOutput,
    });

    expect(outputFailure.stderr).not.toMatch(/^\s+at /m);
    expect(usageFailure.stderr).not.toMatch(/^\s+at /m);
  });
});

describe('M14 direct CLI isolation', () => {
  it('direct clean CLI exits 0 without annotations or action outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli(['.'], {
      cwd: M9_CLEAN_FIXTURE,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(CLEAN_CLI_TEXT);
    expect(result.stdout).not.toContain('::error');
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct broken CLI exits 1 without annotations or action outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli(['.'], {
      cwd: M9_BROKEN_FIXTURE,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(BROKEN_CLI_TEXT);
    expect(result.stdout).not.toContain('::error');
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct usage-error CLI exits 2 without annotations or action outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli([], {
      cwd: M9_CLEAN_FIXTURE,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_TEXT);
    expect(result.stderr).not.toContain('::error');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct broken JSON CLI emits no workflow command', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli(['--json', '.'], {
      cwd: M9_BROKEN_FIXTURE,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    const report = JSON.parse(result.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      summary: SummaryOutputValues;
      diagnostics: unknown[];
    };

    expect(result.status).toBe(1);
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.summary).toEqual(BROKEN_COUNTS);
    expect(report.diagnostics).toHaveLength(BROKEN_COUNTS.broken);
    expect(result.stdout).not.toContain('::error');
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct clean JSON CLI exits 0 without annotations or action outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli(['--json', '.'], {
      cwd: M9_CLEAN_FIXTURE,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    const report = JSON.parse(result.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      summary: SummaryOutputValues;
      diagnostics: unknown[];
    };

    expect(result.status).toBe(0);
    expect(report.version).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.summary).toEqual(CLEAN_COUNTS);
    expect(report.diagnostics).toEqual([]);
    expect(result.stdout).not.toContain('::error');
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct usage-error JSON CLI exits 2 without annotations or action outputs', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli(['--json'], {
      cwd: M9_CLEAN_FIXTURE,
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    });
    const report = JSON.parse(result.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      error?: { kind: string; message: string };
      summary: SummaryOutputValues;
      diagnostics: unknown[];
    };

    expect(result.status).toBe(2);
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    expect(report.error).toEqual({ kind: 'usage', message: 'no input paths' });
    expect(report.summary).toEqual({ filesChecked: 0, broken: 0, externalSkipped: 0 });
    expect(report.diagnostics).toEqual([]);
    expect(result.stdout).not.toContain('::error');
    expect(result.stderr).toBe('');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct CLI never writes GITHUB_OUTPUT', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const results = await Promise.all([
      runCli(['.'], {
        cwd: M9_CLEAN_FIXTURE,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      }),
      runCli(['.'], {
        cwd: M9_BROKEN_FIXTURE,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      }),
      runCli([], {
        cwd: M9_CLEAN_FIXTURE,
        env: { ...process.env, GITHUB_OUTPUT: outputPath },
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([0, 1, 2]);
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('direct CLI text remains byte-for-byte unchanged', async () => {
    const broken = await runCli(['.'], { cwd: M9_BROKEN_FIXTURE });
    const clean = await runCli(['.'], { cwd: M9_CLEAN_FIXTURE });
    const usage = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(broken.stdout).toBe(BROKEN_CLI_TEXT);
    expect(broken.stderr).toBe('');
    expect(clean.stdout).toBe(CLEAN_CLI_TEXT);
    expect(clean.stderr).toBe('');
    expect(usage.stdout).toBe('');
    expect(usage.stderr).toBe(USAGE_TEXT);
  });

  it('direct CLI JSON fields remain unchanged', async () => {
    const result = await runCli(['--json', '.'], { cwd: M9_BROKEN_FIXTURE });
    const report = JSON.parse(result.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      summary: { filesChecked: number; broken: number; externalSkipped: number };
      diagnostics: unknown[];
    };

    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.summary).toEqual(BROKEN_COUNTS);
    expect(report.diagnostics).toHaveLength(BROKEN_COUNTS.broken);
  });

  it('CLI human-readable surface remains unchanged', async () => {
    const cleanAction = await captureSourceAction({ INPUT_PATHS: M9_CLEAN_FIXTURE });
    const brokenAction = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });
    const usageAction = await captureSourceAction({});
    const [cleanCli, brokenCli, usageCli] = await Promise.all([
      captureRun([M9_CLEAN_FIXTURE]),
      captureRun([M9_BROKEN_FIXTURE]),
      captureRun([]),
    ]);

    expect(cleanAction.exitCode).toBe(0);
    expect(cleanAction.stdout).toBe(cleanCli.stdout);
    expect(cleanAction.stderr).toBe(cleanCli.stderr);
    expect(brokenAction.exitCode).toBe(1);
    expect(actionCliText(brokenAction)).toBe(brokenCli.stdout);
    expect(brokenAction.stderr).toBe(brokenCli.stderr);
    expect(usageAction.exitCode).toBe(2);
    expect(usageAction.stdout).toBe(usageCli.stdout);
    expect(usageAction.stderr).toBe(usageCli.stderr);
    expect(actionCliText(brokenAction)).not.toContain('::error');
  });

  it('CLI JSON surface remains unchanged', async () => {
    const clean = await runCli(['--json', '.'], { cwd: M9_CLEAN_FIXTURE });
    const broken = await runCli(['--json', '.'], { cwd: M9_BROKEN_FIXTURE });
    const usage = await runCli(['--json'], { cwd: M9_CLEAN_FIXTURE });
    const cleanReport = JSON.parse(clean.stdout) as Record<string, unknown>;
    const brokenReport = JSON.parse(broken.stdout) as Record<string, unknown>;
    const usageReport = JSON.parse(usage.stdout) as Record<string, unknown>;
    const baseFields = [
      'diagnostics',
      'exitCode',
      'external',
      'ok',
      'summary',
      'version',
    ];

    expect(clean.status).toBe(0);
    expect(broken.status).toBe(1);
    expect(usage.status).toBe(2);
    expect(Object.keys(cleanReport).sort()).toEqual(baseFields);
    expect(Object.keys(brokenReport).sort()).toEqual(baseFields);
    expect(Object.keys(usageReport).sort()).toEqual([...baseFields, 'error'].sort());
    expect(cleanReport.summary).toEqual(CLEAN_COUNTS);
    expect(brokenReport.summary).toEqual(BROKEN_COUNTS);
    expect(clean.stdout).not.toContain('::error');
    expect(broken.stdout).not.toContain('::error');
    expect(usage.stdout).not.toContain('::error');
  });
});

describe('M14 external interaction', () => {
  it('default action mode performs no fetch', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Consumer\n\n[external](https://example.com/skipped)\n',
    });
    const outputPath = createOutputPath(root);
    const fetchLog = join(root, 'fetch.log');
    const result = await runArtifact({
      cwd: root,
      inputs: { INPUT_PATHS: 'README.md' },
      outputPath,
      fetchLog,
    });

    expect(result.status).toBe(0);
    expect(existsSync(fetchLog)).toBe(false);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 0,
      externalSkipped: 1,
    });
  });

  it('default skipped external target emits no broken annotation', async () => {
    const action = await captureSourceAction({ INPUT_PATHS: M9_BROKEN_FIXTURE });

    expect(action.exitCode).toBe(1);
    for (const annotation of actionAnnotations(action)) {
      expect(annotation).not.toMatch(/https?:/);
    }
    expect(action.diagnostics.every((finding) => !finding.target.startsWith('http'))).toBe(
      true,
    );
  });

  it('default skipped external counts remain unchanged', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md':
        '# Consumer\n\n[one](https://example.com/repeated)\n[two](https://example.com/repeated)\n',
    });
    const outputPath = createOutputPath(root);
    const action = await captureSourceAction({
      INPUT_PATHS: join(root, 'README.md'),
      GITHUB_OUTPUT: outputPath,
    });

    expect(action.exitCode).toBe(0);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 0,
      externalSkipped: 2,
    });
  });

  it('external success preserves clean exit 0', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Consumer\n\n[ok](${server.urlFor('/ok')})\n`,
    });
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(0);
      expect(action.diagnostics).toEqual([]);
      expect(actionAnnotations(action)).toEqual([]);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('external failure emits an annotation and exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, { 'README.md': `# Consumer\n\n[external](${target})\n` });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
      });

      expect(action.exitCode).toBe(1);
      expect(action.diagnostics).toHaveLength(1);
      expect(actionAnnotations(action)).toHaveLength(1);
      expect(actionAnnotations(action)[0]).toContain(
        `${target}${SEPARATOR}external HTTP 404`,
      );
    } finally {
      await server.close();
    }
  });

  it('external failure retains summary outputs', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': `# Consumer\n\n[external](${server.urlFor('/not-found')})\n`,
    });
    const outputPath = createOutputPath(root);

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
        GITHUB_OUTPUT: outputPath,
      });

      expect(action.exitCode).toBe(1);
      expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('external and local findings retain deterministic order', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const externalTarget = server.urlFor('/not-found');
    writeFiles(root, {
      'README.md': [
        '# Consumer',
        '',
        '[local](missing.md)',
        '',
        `[external](${externalTarget})`,
        '',
      ].join('\n'),
    });

    try {
      const action = await captureSourceAction({
        INPUT_PATHS: join(root, 'README.md'),
        INPUT_EXTERNAL: 'true',
      });
      const targets = action.diagnostics.map((finding) => finding.target);

      expect(targets).toEqual(['missing.md', externalTarget]);
      expect(targets.indexOf('missing.md')).toBeLessThan(
        targets.indexOf(externalTarget),
      );
      expect(actionAnnotations(action)[0]).toContain('missing.md');
    } finally {
      await server.close();
    }
  });

  it('external tests contact only loopback', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    writeFiles(root, { 'README.md': `# Consumer\n\n[external](${target})\n` });
    const outputPath = createOutputPath(root);
    const fetchLog = join(root, 'fetch.log');

    try {
      const result = await runArtifact({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        outputPath,
        fetchLog,
      });
      const logLines = readFileSync(fetchLog, 'utf8')
        .split('\n')
        .filter((line) => line !== '');

      expect(result.status).toBe(1);
      expect(logLines.length).toBeGreaterThan(0);
      expect(
        logLines.every((line) => line.startsWith('allowed http://127.0.0.1:')),
      ).toBe(true);
      expect(logLines.some((line) => line.startsWith('refused'))).toBe(false);
      expect(server.requests.map((request) => request.path)).toEqual(['/not-found']);
    } finally {
      await server.close();
    }
  });
});

describe('M14 committed artifact', () => {
  it('checked-in artifact clean run exits 0', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const result = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(CLEAN_CLI_TEXT);
    expect(result.stdout).not.toContain('::error');
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(CLEAN_COUNTS);
  });

  it('checked-in artifact broken run annotates publishes outputs and exits 1', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root);
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
      outputPath,
    });
    const { cli, annotations } = splitActionOutput(
      result.stdout,
      BROKEN_COUNTS.broken,
    );

    expect(result.status).toBe(1);
    expect(cli).toBe(BROKEN_CLI_TEXT);
    expect(annotations).toEqual(formatAnnotations(M9_BROKEN_FINDINGS));
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(BROKEN_COUNTS);
  });

  it('checked-in artifact usage error exits 2 without annotation', async () => {
    const root = makeTempRoot();
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '' },
      outputPath,
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_TEXT);
    expect(result.stdout).not.toContain('::error');
    expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
  });

  it('checked-in artifact preserves diagnostic text', async () => {
    const result = await runArtifact({
      cwd: M9_BROKEN_FIXTURE,
      inputs: { INPUT_PATHS: '.' },
    });
    const cli = await directBrokenCli();
    const { cli: cliText } = splitActionOutput(result.stdout, BROKEN_COUNTS.broken);

    expect(result.status).toBe(1);
    expect(cliText).toBe(cli.stdout);
    expect(result.stderr).toBe(cli.stderr);
  });

  it('checked-in artifact preserves usage text', async () => {
    const result = await runArtifact({
      cwd: M9_CLEAN_FIXTURE,
      inputs: { INPUT_PATHS: '' },
    });
    const cli = await runCli([], { cwd: M9_CLEAN_FIXTURE });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe(cli.stdout);
    expect(result.stderr).toBe(cli.stderr);
    expect(result.stderr).toBe(USAGE_TEXT);
  });

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

  it('action reproducibility check leaves no diff', async () => {
    const statusBefore = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'action-dist'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    const artifactBefore = readFileSync(ACTION_ARTIFACT_PATH);

    const result = await runActionBuild(['--check']);

    const statusAfter = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'action-dist'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('action entrypoint is reproducible');
    expect(statusAfter).toBe(statusBefore);
    expect(statusAfter).toBe('');
    expect(readFileSync(ACTION_ARTIFACT_PATH).equals(artifactBefore)).toBe(true);
  });

  it('stale action artifact is rejected', async () => {
    const root = makeTempRoot();
    const stale = join(root, 'index.cjs');
    copyFileSync(ACTION_ARTIFACT_PATH, stale);
    appendFileSync(stale, '\n// stale artifact\n');

    const result = await runActionBuild(['--check', '--artifact', stale]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('action artifact is stale');
    expect(result.stderr).toContain('npm run build:action');
  });

  it('checked-in action artifact works from a separate consumer workspace', async () => {
    const root = makeTempRoot();
    const actionCheckout = join(root, 'action-checkout');
    const artifactPath = copyActionRuntime(actionCheckout);
    const consumer = join(root, 'consumer');
    writeFiles(consumer, {
      'README.md': '# Consumer\n\n[missing](missing.md)\n',
    });
    const outputPath = join(root, 'consumer-output.txt');
    const result = await runArtifact({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md' },
      artifactPath,
      outputPath,
    });

    expect(existsSync(join(actionCheckout, 'node_modules'))).toBe(false);
    expect(existsSync(join(consumer, 'node_modules'))).toBe(false);
    expect(result.status).toBe(1);
    expect(annotationLineCount(result.stdout)).toBe(1);
    expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual({
      filesChecked: 1,
      broken: 1,
      externalSkipped: 0,
    });
  });
});

describe('M14 scope and compatibility', () => {
  it('paths input remains unchanged', () => {
    const paths = requireMapping(readActionMetadata().inputs, 'paths');

    expect(requireScalar(paths, 'required')).toBe('true');
    expect(requireScalar(paths, 'description')).toContain(
      'Newline-delimited files or directories to check',
    );
    expect(optionalScalar(paths, 'default')).toBeUndefined();
  });

  it('external input remains unchanged', () => {
    const external = requireMapping(readActionMetadata().inputs, 'external');

    expect(optionalScalar(external, 'default')).toBe('false');
    expect(optionalScalar(external, 'required') ?? 'false').toBe('false');
    expect(requireScalar(external, 'description')).toContain('HTTP(S) targets');
  });

  it('M13 output metadata remains unchanged', () => {
    const outputs = requireMapping(readActionMetadata().fields, 'outputs');
    const names = [...outputs.keys()].sort();

    expect(names).toEqual(['broken', 'external-skipped', 'files-checked']);
    expect(names).toEqual(Object.values(SUMMARY_OUTPUT_NAMES).sort());
    for (const name of names) {
      expect(requireScalar(requireMapping(outputs, name), 'description')).not.toBe('');
    }
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
      execFileSync(NPM_COMMAND, ['ls', '--omit=dev', '--json'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }),
    ) as { dependencies?: Record<string, unknown> };
    expect(listed.dependencies ?? {}).toEqual({});
  });

  it('M14 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M14 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M14 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(
      report.changed.filter((path) => path.startsWith('.github/workflows/')),
    ).toEqual([]);
  });

  it.skipIf(!commitAvailable(M14_BASE_SHA))(
    'M14 changes only permitted paths relative to the authorized base',
    async () => {
      const result = await runNode(
        ACTION_SCOPE_SCRIPT,
        ['--json', '--base', M14_BASE_SHA],
        { cwd: REPO_ROOT },
      );
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        base: string;
        mode: string;
        changed: string[];
        violations: string[];
      };
      // M14's packet check runs on later branches too. Later milestones add
      // their own test files and fixture changes on top of the authorized
      // base; list them explicitly so M14's own files stay the only M14-era
      // changes this check accepts. Later packets prove their own files.
      const laterMilestonePaths = new Set([
        'test/m15-committed-artifact.test.ts',
        'test/m15-default-offline.test.ts',
        'test/m15-direct-cli.test.ts',
        'test/m15-external-enabled.test.ts',
        'test/m15-external-failures.test.ts',
        'test/m15-helpers.ts',
        'test/m15-metadata-scope.test.ts',
        'test/m15-mixed-usage.test.ts',
        'test/m15-occurrence-cache.test.ts',
        'test/server.ts',
        'test/readme-contract.test.ts',
        'test/m16-artifact-scope.test.ts',
        'test/m16-base-manifest.json',
        'test/m16-cli-action-contract.test.ts',
        'test/m16-helpers.ts',
        'test/m16-readme-contract.test.ts',
        'test/m16-v03-fixture.test.ts',
        'test/fixtures/m16-multifile/README.md',
        'test/fixtures/m16-multifile/docs/api.md',
        'test/fixtures/m16-multifile/docs/guide.md',
        'test/fixtures/m16-multifile/docs/plan/notes.md',
        'test/fixtures/m16-multifile/images/logo.png',
        'docs/m16-acceptance.md',
        'test/m17-helpers.ts',
        'test/m17-run-summary-contract.test.ts',
        'test/m17-v03-surface-regression.test.ts',
        'test/m17-capture-fixtures.mjs',
        'test/fixtures/m17-v03/action-annotations.txt',
        'test/fixtures/m17-v03/action-input-error.stderr.txt',
        'test/fixtures/m17-v03/action-outputs.txt',
        'test/fixtures/m17-v03/cli-json.stdout.txt',
        'test/fixtures/m17-v03/cli-text.stdout.txt',
        'test/fixtures/m17-v03/cli-usage.stderr.txt',
        'test/fixtures/m17-v03/edge-annotations.txt',
        'test/fixtures/m17-v03/manifest.json',
        'test/fixtures/m17-v03/special-annotations.txt',
        'docs/m17-run-summary-contract.md',
        'src/summary-markdown.ts',
        'test/summary-markdown.test.ts',
        'docs/m18-summary-markdown.md',
        'test/summary-diagnostic-list.test.ts',
        'docs/m19-diagnostic-list-formatter.md',
        'test/m19-scope.test.ts',
        'docs/m20-action-summary-integration.md',
        'src/action-runner.ts',
        'src/action-step-summary.ts',
        'test/action-helpers.ts',
        'test/action-summary-integration.test.ts',
        'test/cli-summary-isolation.test.ts',
        'test/m12-action-annotations.test.ts',
        'test/m9-action-result.test.ts',
        'src/run.ts',
        'src/annotation.ts',
        'test/m12-action-internal-error.test.ts',
        'test/m13-action-internal-error.test.ts',
        'test/m13-action-outputs.test.ts',
        'test/m21-exit-summary-interaction.test.ts',
        'docs/m21-exit-usage-write-failure.md',
      ]);
      const permitted = new Set([
        'test/m14-exit-usage-interaction.test.ts',
        'docs/m14-plan.md',
        'action-dist/index.cjs',
        'README.md',
        ...laterMilestonePaths,
      ]);

      expect(report.base).toBe(M14_BASE_SHA);
      expect(report.mode).toBe('git-diff');
      expect(report.violations).toEqual([]);
      expect(report.changed.length).toBeGreaterThan(0);
      for (const path of report.changed) {
        expect(permitted.has(path), `unexpected changed path: ${path}`).toBe(true);
      }
    },
  );
});
