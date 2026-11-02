import { checkMarkdown, type CheckResult } from './checker.js';
import { discoverMarkdownFiles, InputError } from './discovery.js';
import { formatDiagnostic, formatJson, formatSummary, HELP, USAGE_LINE } from './report.js';

export interface CliIo {
  writeOut(text: string): void;
  writeError(text: string): void;
}

interface ParsedArgs {
  json: boolean;
  help: boolean;
  paths: string[];
  error: string | null;
}

const EMPTY_RESULT: CheckResult = {
  diagnostics: [],
  filesChecked: 0,
  broken: 0,
  externalSkipped: 0,
};

/**
 * Runs the CLI and returns its exit code:
 *
 * - 0 when checking completed and no broken target was found;
 * - 1 when checking completed and at least one broken target was found;
 * - 2 for a usage error (no input paths, unknown option, unreadable input).
 *
 * Text diagnostics and the summary go to standard output. Usage errors go to
 * standard error. With `--json`, standard output carries exactly one JSON
 * document, including for usage errors.
 */
export function run(args: readonly string[], io: CliIo): number {
  const parsed = parseArgs(args);

  if (parsed.help) {
    if (parsed.json) {
      io.writeOut(formatJson(EMPTY_RESULT, 0));
      io.writeError(HELP);
    } else {
      io.writeOut(HELP);
    }
    return 0;
  }

  if (parsed.error !== null) {
    return reportUsageError(parsed.error, parsed.json, io);
  }

  let files: string[];
  try {
    files = discoverMarkdownFiles(parsed.paths);
  } catch (error) {
    if (error instanceof InputError) {
      return reportUsageError(error.message, parsed.json, io);
    }
    throw error;
  }

  const result = checkMarkdown(files);
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
 * before `--`. `--help` wins over other argument errors.
 */
function parseArgs(args: readonly string[]): ParsedArgs {
  const paths: string[] = [];
  let json = false;
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

  return { json, help, paths, error };
}

function reportUsageError(message: string, json: boolean, io: CliIo): number {
  if (json) {
    const result: CheckResult = {
      diagnostics: [
        { file: '', line: 0, column: 0, kind: 'link', target: '', reason: message },
      ],
      filesChecked: 0,
      broken: 0,
      externalSkipped: 0,
    };
    io.writeOut(formatJson(result, 2));
    return 2;
  }

  io.writeError(
    `md-link-check: ${message}\n\n${USAGE_LINE}\nRun "md-link-check --help" for usage and exit codes.\n`,
  );
  return 2;
}
