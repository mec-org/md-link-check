import type { CheckResult, Diagnostic } from './checker.js';

/** The one-line usage hint printed after a text-mode usage error. */
export const USAGE_LINE = 'Usage: md-link-check [--json] <path...>';

/** Human-readable help, documented in README.md. */
export const HELP = `md-link-check — checks relative links, images and heading anchors in Markdown.

Usage:
  md-link-check [--json] [--] <path...>
  md-link-check --help

Arguments:
  <path...>    Markdown files or directories to check. Directories are scanned
               recursively for .md and .markdown files.

Options:
  --json       Write one JSON document to stdout instead of text output.
  --help, -h   Show this help and exit 0.
  --           Treat every remaining argument as a path.

Exit codes:
  0  checking completed and no broken targets were found
  1  checking completed and at least one broken target was found
  2  usage error: no input paths, unknown option, or unreadable input path

Output:
  Text diagnostics go to stdout as file:line: target — reason, followed by a
  summary line. Usage errors go to stderr. A --json check run writes only the
  JSON document to stdout; --help always prints this help to stdout. See
  README.md for the JSON schema.
`;

/** Formats one broken target as `file:line: target — reason`. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: ${diagnostic.target} — ${diagnostic.reason}`;
}

/** Formats the final text-mode line, including zero counts. */
export function formatSummary(result: CheckResult): string {
  const files = count(result.filesChecked, 'file');
  const broken = count(result.broken, 'broken target');
  const skipped = count(result.externalSkipped, 'external link');
  return `Checked ${files}: ${broken}, ${skipped} skipped.\n`;
}

/** One structured diagnostic in the JSON document. */
export interface JsonDiagnostic {
  file: string;
  line: number;
  column: number;
  kind: Diagnostic['kind'];
  target: string;
  reason: string;
}

/** A usage error reported outside the diagnostics array. */
export interface JsonError {
  kind: 'usage';
  message: string;
}

/** The version 1 JSON document written by `--json`. */
export interface JsonReport {
  version: 1;
  ok: boolean;
  exitCode: number;
  error?: JsonError;
  summary: {
    filesChecked: number;
    broken: number;
    externalSkipped: number;
  };
  diagnostics: JsonDiagnostic[];
}

/**
 * Builds the version 1 report object from a checking run and its exit code. A
 * usage error is reported in the top-level `error` field, never as a
 * diagnostic, so consumers cannot mistake it for a broken link.
 */
export function createJsonReport(
  result: CheckResult,
  exitCode: number,
  error?: JsonError,
): JsonReport {
  return {
    version: 1,
    ok: exitCode === 0,
    exitCode,
    ...(error === undefined ? {} : { error }),
    summary: {
      filesChecked: result.filesChecked,
      broken: result.broken,
      externalSkipped: result.externalSkipped,
    },
    diagnostics: result.diagnostics.map((diagnostic) => ({
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      kind: diagnostic.kind,
      target: diagnostic.target,
      reason: diagnostic.reason,
    })),
  };
}

/** Serializes the JSON report as exactly one document plus a trailing newline. */
export function formatJson(result: CheckResult, exitCode: number, error?: JsonError): string {
  return `${JSON.stringify(createJsonReport(result, exitCode, error), null, 2)}\n`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
