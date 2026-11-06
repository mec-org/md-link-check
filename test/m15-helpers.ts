/**
 * Shared setup and assertions for the M15 offline/external interaction suites.
 *
 * The M15 acceptance matrix is split by topic across several test files so each
 * remains reviewable. This module owns the shared harness:
 *
 * - the structured `RunResult` capture for the in-process action wrapper;
 * - the transport-injection state used by tests that need bounded timeouts or
 *   an explicit temporary cache path (`injectExternal`/`resetRunInjection`);
 * - the `GITHUB_OUTPUT` environment-file parser and action-output assertions;
 * - the frozen CLI text-summary builders and small Markdown/fixture helpers;
 * - the committed-artifact runner options and the offline-guard audit runner.
 *
 * Each test file still declares its own `vi.mock('../src/run.js', ...)` because
 * Vitest mock factories are file-scoped and must reference a `vi.hoisted` state
 * object. The factory in every file forwards to the real `run(...)` and only
 * merges this module's injected `RunOptions.external`; when nothing is
 * injected, production defaults are exercised unchanged.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

import { runAction as runSourceAction } from '../src/action-runner.js';
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import type { ExternalCheckOptions, FetchLike } from '../src/external.js';
import type { CliIo, RunResult } from '../src/run.js';
import {
  ACTION_ARTIFACT_PATH,
  REPO_ROOT,
  runAction as runCommittedAction,
  runNode,
} from './action-helpers.js';
import { writeFiles } from './helpers.js';

/** The frozen diagnostic separator: `file:line: target — reason`. */
export const SEPARATOR = ' — ';

/** The M15 authorized base commit from the milestone packet. */
export const M15_BASE_SHA = '84c9e981f8d85c08119469d344939177fcb2d4f6';

/** The offline-guard preload that audits network and cache I/O of a child. */
export const OFFLINE_GUARD_PATH = join(REPO_ROOT, 'test', 'offline-guard.cjs');

/** Mutable per-file transport injection handed to the `vi.mock` factory. */
export interface RunInjectionState {
  external: Partial<ExternalCheckOptions> | undefined;
}

/** Creates the empty injection state used with `vi.hoisted` in each file. */
export function createRunInjectionState(): RunInjectionState {
  return { external: undefined };
}

/** Restores production defaults between tests. */
export function resetRunInjection(state: RunInjectionState): void {
  state.external = undefined;
}

/**
 * Injects one run's transport options. Caching is disabled by default so a
 * non-cache test cannot be answered from an earlier test's cache entry; cache
 * tests pass an explicit temporary path.
 */
export function injectExternal(
  state: RunInjectionState,
  options: Partial<ExternalCheckOptions> = {},
): void {
  state.external = { cachePath: false, ...options };
}

/** One captured in-process action invocation. */
export interface CapturedAction {
  exitCode: RunResult['exitCode'];
  diagnostics: RunResult['diagnostics'];
  summary: RunResult['summary'];
  stdout: string;
  stderr: string;
}

/** The three established M13 summary counts. */
export interface SummaryOutputValues {
  filesChecked: number;
  broken: number;
  externalSkipped: number;
}

/** Runs the action wrapper from TypeScript source and captures its streams. */
export async function captureSourceAction(
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
  const result = await runSourceAction(environment, io);
  return {
    exitCode: result.exitCode,
    diagnostics: result.diagnostics,
    summary: result.summary,
    stdout,
    stderr,
  };
}

/** Options for one committed-artifact run. */
export interface ArtifactRunOptions {
  cwd: string;
  inputs: Record<string, string | undefined>;
  artifactPath?: string;
  outputPath?: string;
  fetchLog?: string;
  cacheHome?: string;
}

/** Runs the committed artifact exactly as the GitHub runner would. */
export function runArtifact(options: ArtifactRunOptions) {
  return runCommittedAction({
    cwd: options.cwd,
    inputs: options.inputs,
    ...(options.artifactPath === undefined ? {} : { artifactPath: options.artifactPath }),
    ...(options.outputPath === undefined
      ? {}
      : { env: { GITHUB_OUTPUT: options.outputPath } }),
    ...(options.fetchLog === undefined ? {} : { fetchLog: options.fetchLog }),
    ...(options.cacheHome === undefined ? {} : { cacheHome: options.cacheHome }),
  });
}

/** Creates the temporary output file a hosted runner would create. */
export function createOutputPath(root: string, initial = ''): string {
  const outputPath = join(root, 'github-output.txt');
  writeFileSync(outputPath, initial);
  return outputPath;
}

/**
 * Protocol-aware parser for the runner's `GITHUB_OUTPUT` environment file. It
 * understands the `name=value` records the implementation writes and the
 * documented `name<<DELIMITER` multiline form, and rejects unknown, duplicate
 * or malformed records so an invented count cannot pass as valid.
 */
export function parseSummaryOutputs(
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

/** Returns the exact output names present in one output file. */
export function outputNamesIn(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const separator = line.indexOf('=');
      if (separator <= 0) {
        throw new Error(`malformed action output record: ${JSON.stringify(line)}`);
      }
      return line.slice(0, separator);
    });
}

/**
 * Splits action stdout into the CLI-owned prefix and the trailing annotation
 * lines using the structured finding count, never by parsing CLI text to
 * recover findings.
 */
export function splitActionOutput(
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
export function annotationLineCount(stdout: string): number {
  return stdout.split('\n').filter((line) => line.startsWith('::error ')).length;
}

/** Captures the CLI-owned text of an in-process or artifact action run. */
export function actionCliText(action: CapturedAction): string {
  return splitActionOutput(action.stdout, action.diagnostics.length).cli;
}

/** Captures the emitted annotations of an in-process action run. */
export function actionAnnotations(action: CapturedAction): string[] {
  return splitActionOutput(action.stdout, action.diagnostics.length).annotations;
}

/** Requires a completed checking run so its summary counts can be compared. */
export function requireSummary(action: CapturedAction): SummaryOutputValues {
  if (action.summary === null) {
    throw new Error('expected a completed checking run with a summary');
  }
  return action.summary;
}

/** Asserts that the output file publishes exactly the structured summary. */
export function expectOutputsMatchSummary(
  outputPath: string,
  action: CapturedAction,
): void {
  const summary = requireSummary(action);
  expect(parseSummaryOutputs(readFileSync(outputPath, 'utf8'))).toEqual(summary);
  expect(outputNamesIn(readFileSync(outputPath, 'utf8')).sort()).toEqual(
    Object.values(SUMMARY_OUTPUT_NAMES).sort(),
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The frozen one-line text summary of a completed run. */
export function cliSummary(files: number, broken: number, skipped: number): string {
  return `Checked ${plural(files, 'file')}: ${plural(broken, 'broken target')}, ${plural(skipped, 'external link')} skipped.\n`;
}

/** The frozen second text-summary line of an enabled external run. */
export function externalSummary(counts: {
  occurrences: number;
  distinctChecked: number;
  succeeded: number;
  failed: number;
  brokenOccurrences: number;
}): string {
  return (
    `External checks: ${plural(counts.occurrences, 'occurrence')}, ` +
    `${plural(counts.distinctChecked, 'distinct target')} checked ` +
    `(${counts.succeeded} succeeded, ${counts.failed} failed), ` +
    `${plural(counts.brokenOccurrences, 'broken occurrence')}.\n`
  );
}

/** Writes one Markdown file beneath `root` and returns its absolute path. */
export function writeMarkdown(root: string, contents: string, name = 'README.md'): string {
  writeFiles(root, { [name]: contents });
  return join(root, name);
}

/** Builds a document whose targets start on the one-based line 3. */
export function linksDocument(targets: readonly string[]): string {
  return `# Consumer\n\n${targets
    .map((target, index) => `[link ${index + 1}](${target})`)
    .join('\n')}\n`;
}

/** A fetch wrapper that records every call and delegates to the real fetch. */
export function recordingFetch(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push(String(input));
    return globalThis.fetch(String(input), init);
  };
  return { fetch, calls };
}

/** The loopback port of a fixture server URL. */
export function portOf(serverUrl: string): string {
  return new URL(serverUrl).port;
}

/** True when the commit is present, so history-dependent checks can run. */
export function commitAvailable(sha: string): boolean {
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

/**
 * Runs the committed artifact with the offline guard preloaded. The guard
 * records and refuses every practical network entry point and every filesystem
 * access beneath the audit cache root.
 */
export async function runArtifactUnderOfflineGuard(
  root: string,
  inputs: Record<string, string | undefined>,
) {
  const cacheRoot = join(root, 'audit-cache');
  const guardLog = join(root, 'audit-guard.log');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('INPUT_') ||
      key === 'GITHUB_OUTPUT' ||
      key === 'GITHUB_STEP_SUMMARY'
    ) {
      delete env[key];
    }
  }
  Object.assign(env, inputs, {
    XDG_CACHE_HOME: cacheRoot,
    MDLC_ACCEPTANCE_CACHE_ROOT: cacheRoot,
    MDLC_ACCEPTANCE_GUARD_LOG: guardLog,
  });
  const result = await runNode(ACTION_ARTIFACT_PATH, [], {
    cwd: root,
    env,
    requires: [OFFLINE_GUARD_PATH],
  });
  return {
    result,
    guardLog,
    cacheFile: join(cacheRoot, 'md-link-check', 'external-v1.json'),
  };
}
