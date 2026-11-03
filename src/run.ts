import {
  checkMarkdown,
  checkMarkdownWithExternal,
  type CheckResult,
  type Diagnostic,
} from './checker.js';
import { resolveExternalCachePath } from './cache.js';
import { discoverMarkdownFiles, InputError } from './discovery.js';
import type { ExternalCheckOptions } from './external.js';
import {
  formatDiagnostic,
  formatJson,
  formatSummary,
  HELP,
  USAGE_LINE,
  type JsonError,
} from './report.js';

export interface CliIo {
  writeOut(text: string): void;
  writeError(text: string): void;
}

/**
 * One broken link, as seen by an in-process caller of {@link run}. This is the
 * narrow CI-facing projection of the checker's diagnostic: the source file, the
 * one-based source line, the target exactly as written, and the stable reason,
 * in the checker's existing result order.
 *
 * It is an internal seam for the bundled GitHub Action, not a supported
 * library API. Callers must treat the value as read-only.
 */
export interface BrokenLinkResult {
  readonly file: string;
  readonly line: number;
  readonly target: string;
  readonly reason: string;
}

/**
 * The structured outcome of one CLI invocation. The exit code keeps its
 * documented meaning, and `diagnostics` holds every broken-link finding in the
 * checker's existing order. A clean, help, usage-error or internal-error run
 * carries no diagnostics: usage and internal errors are never fabricated as
 * broken-link findings.
 */
export interface RunResult {
  readonly exitCode: 0 | 1 | 2;
  readonly diagnostics: readonly BrokenLinkResult[];
}

/** Shared empty finding list for runs that did not check any links. */
const NO_DIAGNOSTICS: readonly BrokenLinkResult[] = Object.freeze([]);

/**
 * Internal options for tests. Production uses the documented defaults; M6 adds
 * no timeout, retry, redirect, concurrency or cache CLI flags.
 */
export interface RunOptions {
  external?: ExternalCheckOptions;
}

interface ParsedArgs {
  json: boolean;
  external: boolean;
  help: boolean;
  paths: string[];
  error: string | null;
}

function emptyResult(externalEnabled: boolean): CheckResult {
  return {
    diagnostics: [],
    filesChecked: 0,
    broken: 0,
    externalSkipped: 0,
    external: {
      enabled: externalEnabled,
      occurrences: 0,
      skipped: 0,
      distinctChecked: 0,
      succeeded: 0,
      failed: 0,
      brokenOccurrences: 0,
      cache: { enabled: false, hits: 0, misses: 0, stale: 0 },
      results: [],
    },
  };
}

/**
 * Runs the CLI and returns its structured result: the exit code plus the
 * ordered, immutable broken-link findings.
 *
 * The exit code is:
 *
 * - 0 when checking completed and no broken target was found;
 * - 1 when checking completed and at least one broken target was found;
 * - 2 for a usage error (no input paths, unknown option, unreadable input) or
 *   an internal failure that prevented checking from completing.
 *
 * Text diagnostics and the summary go to standard output. Usage errors and
 * internal failures go to standard error. With `--json`, a check run writes
 * exactly one JSON document to standard output, including for usage and
 * internal errors; `--help` always prints help and exits 0. Internal failures
 * are reported through the same structured result instead of escaping as an
 * unhandled rejection or stack trace.
 *
 * External checking is strictly opt-in through `--external`. Without it no
 * fetch is called and HTTP(S) targets stay counted as skipped. Argument and
 * discovery errors return before any external check can start.
 *
 * The findings are a fresh, frozen projection of the checker's diagnostics, so
 * an in-process caller cannot reorder or mutate the CLI's own result list.
 */
export async function run(
  args: readonly string[],
  io: CliIo,
  options: RunOptions = {},
): Promise<RunResult> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    io.writeOut(HELP);
    return { exitCode: 0, diagnostics: NO_DIAGNOSTICS };
  }

  if (parsed.error !== null) {
    return {
      exitCode: reportUsageError(parsed.error, parsed.json, parsed.external, io),
      diagnostics: NO_DIAGNOSTICS,
    };
  }

  let result: CheckResult;
  try {
    const files = discoverMarkdownFiles(parsed.paths);
    result = parsed.external
      ? await checkMarkdownWithExternal(files, externalOptions(options.external))
      : checkMarkdown(files);
  } catch (error) {
    if (error instanceof InputError) {
      return {
        exitCode: reportUsageError(error.message, parsed.json, parsed.external, io),
        diagnostics: NO_DIAGNOSTICS,
      };
    }
    return {
      exitCode: reportInternalError(error, parsed.json, parsed.external, io),
      diagnostics: NO_DIAGNOSTICS,
    };
  }

  const exitCode = result.diagnostics.length === 0 ? 0 : 1;
  const diagnostics = brokenLinkResults(result.diagnostics);

  if (parsed.json) {
    io.writeOut(formatJson(result, exitCode));
    return { exitCode, diagnostics };
  }

  for (const diagnostic of result.diagnostics) {
    io.writeOut(`${formatDiagnostic(diagnostic)}\n`);
  }
  io.writeOut(formatSummary(result));
  return { exitCode, diagnostics };
}

/**
 * Projects the checker's diagnostics onto the narrow finding contract and
 * freezes both the list and each record. A fresh array of fresh objects is
 * returned, so later in-process consumers (the action's annotation renderer)
 * cannot reorder or mutate the CLI's own result list.
 */
function brokenLinkResults(diagnostics: readonly Diagnostic[]): readonly BrokenLinkResult[] {
  return Object.freeze(
    diagnostics.map(({ file, line, target, reason }) =>
      Object.freeze({ file, line, target, reason }),
    ),
  );
}

/**
 * Resolves the persistent external cache for a real `--external` invocation.
 * The platform user-cache path is the production default; a test can inject a
 * temporary path, or `false` to disable persistence for one run. When no safe
 * user-cache directory exists, caching is disabled rather than writing into the
 * working tree.
 */
function externalOptions(options: ExternalCheckOptions | undefined): ExternalCheckOptions {
  const cachePath = options?.cachePath ?? resolveExternalCachePath();
  return { ...options, cachePath: cachePath ?? false };
}

/**
 * Parses flags and paths. Arguments are read fully before the first error is
 * reported so that `--json` is honoured for a usage error wherever it appears
 * before `--`. `--help` wins over other argument errors. Repeated `--json` and
 * `--external` are accepted idempotently, matching the existing flag convention.
 */
function parseArgs(args: readonly string[]): ParsedArgs {
  const paths: string[] = [];
  let json = false;
  let external = false;
  let help = false;
  let endOfOptions = false;
  let error: string | null = null;

  for (const argument of args) {
    if (!endOfOptions && argument === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && argument === '--json') {
      json = true;
      continue;
    }
    if (!endOfOptions && argument === '--external') {
      external = true;
      continue;
    }
    if (!endOfOptions && (argument === '--help' || argument === '-h')) {
      help = true;
      continue;
    }
    if (!endOfOptions && argument.startsWith('-') && argument.length > 1) {
      error ??= `unknown option "${argument}"`;
      continue;
    }
    paths.push(argument);
  }

  if (!help && error === null && paths.length === 0) {
    error = 'no input paths';
  }

  return { json, external, help, paths, error };
}

/**
 * Formats the text-mode usage diagnostic, including the one-line usage hint.
 * The GitHub Action wrapper reuses this so that an invalid action input is
 * reported exactly like a CLI usage error.
 */
export function formatUsageErrorText(message: string): string {
  return `md-link-check: ${message}\n\n${USAGE_LINE}\nRun "md-link-check --help" for usage and exit codes.\n`;
}

/**
 * Formats the text-mode unexpected-failure diagnostic. The raw error object
 * and stack are never serialized. The GitHub Action wrapper reuses this for
 * unexpected wrapper failures so they follow the CLI's internal-error policy.
 */
export function formatInternalErrorText(error: unknown): string {
  return `md-link-check: internal error: ${internalErrorDetail(error)}\n`;
}

function reportUsageError(
  message: string,
  json: boolean,
  external: boolean,
  io: CliIo,
): 2 {
  if (json) {
    io.writeOut(formatJson(emptyResult(external), 2, { kind: 'usage', message }));
    return 2;
  }

  io.writeError(formatUsageErrorText(message));
  return 2;
}

/**
 * Reports an unexpected failure without letting it escape as a stack trace or
 * an unhandled rejection. The message is kept short and deterministic; the raw
 * error object and stack are never serialized.
 */
function reportInternalError(
  error: unknown,
  json: boolean,
  external: boolean,
  io: CliIo,
): 2 {
  const detail = internalErrorDetail(error);
  const failure: JsonError = { kind: 'internal', message: detail };

  if (json) {
    io.writeOut(formatJson(emptyResult(external), 2, failure));
    return 2;
  }

  io.writeError(formatInternalErrorText(error));
  return 2;
}

function internalErrorDetail(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'unexpected failure';
}
