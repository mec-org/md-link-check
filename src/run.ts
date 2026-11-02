import {
  checkMarkdown,
  checkMarkdownWithExternal,
  type CheckResult,
} from './checker.js';
import { discoverMarkdownFiles, InputError } from './discovery.js';
import type { ExternalCheckOptions } from './external.js';
import { formatDiagnostic, formatJson, formatSummary, HELP, USAGE_LINE } from './report.js';

export interface CliIo {
  writeOut(text: string): void;
  writeError(text: string): void;
}

/**
 * Internal options for tests. Production uses the documented defaults; M5 adds
 * no timeout, retry or concurrency CLI flags.
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
      results: [],
    },
  };
}

/**
 * Runs the CLI and returns its exit code:
 *
 * - 0 when checking completed and no broken target was found;
 * - 1 when checking completed and at least one broken target was found;
 * - 2 for a usage error (no input paths, unknown option, unreadable input).
 *
 * Text diagnostics and the summary go to standard output. Usage errors go to
 * standard error. With `--json`, a check run writes exactly one JSON document
 * to standard output, including for usage errors; `--help` always prints help
 * and exits 0.
 *
 * External checking is strictly opt-in through `--external`. Without it no
 * fetch is called and HTTP(S) targets stay counted as skipped. Argument and
 * discovery errors return before any external check can start.
 */
export async function run(
  args: readonly string[],
  io: CliIo,
  options: RunOptions = {},
): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    io.writeOut(HELP);
    return 0;
  }

  if (parsed.error !== null) {
    return reportUsageError(parsed.error, parsed.json, parsed.external, io);
  }

  let files: string[];
  try {
    files = discoverMarkdownFiles(parsed.paths);
  } catch (error) {
    if (error instanceof InputError) {
      return reportUsageError(error.message, parsed.json, parsed.external, io);
    }
    throw error;
  }

  const result = parsed.external
    ? await checkMarkdownWithExternal(files, options.external)
    : checkMarkdown(files);
  const exitCode = result.diagnostics.length === 0 ? 0 : 1;

  if (parsed.json) {
    io.writeOut(formatJson(result, exitCode));
    return exitCode;
  }

  for (const diagnostic of result.diagnostics) {
    io.writeOut(`${formatDiagnostic(diagnostic)}\n`);
  }
  io.writeOut(formatSummary(result));
  return exitCode;
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

function reportUsageError(
  message: string,
  json: boolean,
  external: boolean,
  io: CliIo,
): number {
  if (json) {
    io.writeOut(formatJson(emptyResult(external), 2, { kind: 'usage', message }));
    return 2;
  }

  io.writeError(
    `md-link-check: ${message}\n\n${USAGE_LINE}\nRun "md-link-check --help" for usage and exit codes.\n`,
  );
  return 2;
}
