import type { CheckResult, Diagnostic } from './checker.js';
import type {
  ExternalCacheSummary,
  ExternalFailureKind,
  ExternalResultSource,
} from './external.js';

/** The one-line usage hint printed after a text-mode usage error. */
export const USAGE_LINE = 'Usage: md-link-check [--json] [--external] <path...>';

/** Human-readable help, documented in README.md. */
export const HELP = `md-link-check — checks relative links, images and heading anchors in Markdown.

Usage:
  md-link-check [--json] [--external] [--] <path...>
  md-link-check --help

Arguments:
  <path...>    Markdown files or directories to check. Directories are scanned
               recursively for .md and .markdown files.

Options:
  --json       Write one JSON document to stdout instead of text output.
  --external   Also check http: and https: targets over the network. This is
               opt-in: without it, external targets are counted as skipped and
               no request is made. With it, the CLI sends GET requests for each
               distinct target and may use the network. Requests, retries,
               redirects and the persistent result cache have documented finite
               bounds. See README.md for the complete contract.
  --help, -h   Show this help and exit 0.
  --           Treat every remaining argument as a path.

Exit codes:
  0  checking completed and no broken targets were found
  1  checking completed and at least one broken target was found
  2  usage error, or an internal failure that prevented checking from completing

Output:
  Text diagnostics go to stdout as file:line: target — reason, followed by a
  summary line. Usage errors go to stderr. A --json check run writes only the
  JSON document to stdout; --help always prints this help to stdout. See
  README.md for the JSON schema and the external-checking contract.
`;

/** Formats one broken target as `file:line: target — reason`. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}: ${diagnostic.target} — ${diagnostic.reason}`;
}

/**
 * Formats the final text-mode lines. The first line keeps its pre-M5 form and
 * meaning. With external checking enabled, a second line reports the external
 * occurrence, distinct-target and outcome counts.
 */
export function formatSummary(result: CheckResult): string {
  const files = count(result.filesChecked, 'file');
  const broken = count(result.broken, 'broken target');
  const skipped = count(result.externalSkipped, 'external link');
  const summary = `Checked ${files}: ${broken}, ${skipped} skipped.\n`;

  if (!result.external.enabled) {
    return summary;
  }

  const externals = result.external;
  const occurrences = count(externals.occurrences, 'occurrence');
  const distinct = count(externals.distinctChecked, 'distinct target');
  const brokenOccurrences = count(externals.brokenOccurrences, 'broken occurrence');
  return (
    summary +
    `External checks: ${occurrences}, ${distinct} checked ` +
    `(${externals.succeeded} succeeded, ${externals.failed} failed), ` +
    `${brokenOccurrences}.\n`
  );
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

/** One structured distinct external target in the JSON document. */
export interface JsonExternalResult {
  target: string;
  status: 'succeeded' | 'failed';
  attempts: number;
  httpStatus?: number;
  finalUrl?: string;
  failureKind?: ExternalFailureKind;
  redirectCount?: number;
  source?: ExternalResultSource;
}

/** The additive external-check object in the version 1 JSON document. */
export interface JsonExternalSummary {
  enabled: boolean;
  occurrences: number;
  skipped: number;
  distinctChecked: number;
  succeeded: number;
  failed: number;
  brokenOccurrences: number;
  cache: ExternalCacheSummary;
  results: JsonExternalResult[];
}

/** A usage error or internal failure reported outside the diagnostics array. */
export interface JsonError {
  kind: 'usage' | 'internal';
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
  external: JsonExternalSummary;
  diagnostics: JsonDiagnostic[];
}

/**
 * Builds the version 1 report object from a checking run and its exit code. A
 * usage error or internal failure is reported in the top-level `error` field,
 * never as a diagnostic, so consumers cannot mistake it for a broken link.
 * `kind` distinguishes the two. The `external` object is additive: pre-M5
 * consumers can ignore it and keep reading the same top-level fields, summary
 * counts and diagnostics.
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
    external: {
      enabled: result.external.enabled,
      occurrences: result.external.occurrences,
      skipped: result.external.skipped,
      distinctChecked: result.external.distinctChecked,
      succeeded: result.external.succeeded,
      failed: result.external.failed,
      brokenOccurrences: result.external.brokenOccurrences,
      cache: {
        enabled: result.external.cache.enabled,
        hits: result.external.cache.hits,
        misses: result.external.cache.misses,
        stale: result.external.cache.stale,
      },
      results: result.external.results.map((target) => ({
        target: target.target,
        status: target.status,
        attempts: target.attempts,
        ...(target.httpStatus === undefined ? {} : { httpStatus: target.httpStatus }),
        ...(target.finalUrl === undefined ? {} : { finalUrl: target.finalUrl }),
        ...(target.failureKind === undefined ? {} : { failureKind: target.failureKind }),
        ...(target.redirectCount === undefined
          ? {}
          : { redirectCount: target.redirectCount }),
        ...(target.source === undefined ? {} : { source: target.source }),
      })),
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
