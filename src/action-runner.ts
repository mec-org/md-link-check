/**
 * GitHub Action wrapper logic, kept free of process-level side effects so the
 * wrapper can be exercised in-process by tests and loaded by the action
 * entrypoint alike.
 *
 * The action is a thin adapter over the existing CLI: it reads the documented
 * `paths` and `external` inputs from the standard `INPUT_<NAME>` environment
 * variables, builds the CLI argument list, and calls the typed `run(...)`
 * in-process. It never spawns a shell, never parses CLI output, and never
 * changes the working directory, so caller-relative paths keep resolving from
 * the caller's workspace while the action itself is loaded from its own
 * checkout.
 *
 * This is the narrowest action-only boundary. After the CLI has completed its
 * checking and written its complete, unchanged diagnostics and summary, the
 * wrapper renders one GitHub workflow-command annotation per structured
 * broken-link finding and writes those lines to standard output. It then
 * publishes the checker's authoritative summary counts through the runner's
 * `GITHUB_OUTPUT` environment file without printing them, and finally handles
 * the M19/M21 job summary for the file named by `GITHUB_STEP_SUMMARY`.
 *
 * M21 keeps every established action result authoritative while the job
 * summary is active. A completed check (clean or broken) and a usage error each
 * get one summary when a destination exists; an unset, empty or unwritable
 * destination produces exactly one workflow-command warning instead. The
 * summary is the last action publication, so its success or failure can never
 * replace, suppress, upgrade, downgrade or reinterpret the CLI's `0`, `1` or
 * `2`. Direct CLI execution never imports this module, the annotation
 * formatter, the output publisher or the step-summary writer.
 */
import { formatAnnotations, formatWarningCommand } from './annotation.js';
import { publishSummaryOutputs } from './action-outputs.js';
import { appendStepSummary } from './action-step-summary.js';
import {
  formatRunSummaryMarkdown,
  formatUsageErrorSummaryMarkdown,
} from './summary-markdown.js';
import {
  formatUsageErrorText,
  run,
  type ActionSummary,
  type BrokenLinkResult,
  type CliIo,
  type RunResult,
} from './run.js';

export interface ActionInputs {
  paths: string[];
  external: boolean;
}

/** A usage error caused by an action input rather than by the CLI arguments. */
export class ActionInputError extends Error {}

/**
 * The one stable warning message for an action invocation whose summary
 * destination is unset or empty. The empty string is treated exactly like an
 * unset variable: neither names a usable file, so no filesystem access is
 * attempted. The workflow-command encoding is supplied by
 * {@link formatWarningCommand}; this message is fixed, so no path or
 * environment value can leak into a warning.
 */
export const STEP_SUMMARY_UNAVAILABLE_WARNING =
  'GITHUB_STEP_SUMMARY is not set; no job summary was written.';

/**
 * The one stable warning message for a destination that exists but rejects the
 * single append attempt. The raw filesystem error is never interpolated: only
 * this fixed classification is reported, so no arbitrary error object or
 * destination is exposed.
 */
export const STEP_SUMMARY_WRITE_FAILED_WARNING =
  'GITHUB_STEP_SUMMARY could not be written; no job summary was written.';

/**
 * The summary content that belongs to one action outcome.
 *
 * - `completed`: a clean or broken check with its authentic M17 counts and
 *   ordered findings, formatted by the guarded M19 formatter.
 * - `usage-error`: the fixed M21 usage-error fragment, which carries no run
 *   counts and no broken-link diagnostics.
 * - `none`: an internal failure or help, for which no summary content is
 *   defined. An unavailable destination is still reported once as a warning.
 */
export type StepSummaryOutcome =
  | {
      readonly kind: 'completed';
      readonly summary: ActionSummary;
      readonly findings: readonly BrokenLinkResult[];
    }
  | { readonly kind: 'usage-error' }
  | { readonly kind: 'none' };

/**
 * Reads the action inputs. `paths` is newline-delimited: each line is trimmed,
 * blank lines are ignored, internal spaces are preserved, and every remaining
 * line becomes exactly one path argument. Quotes, globs, environment variables
 * and other shell syntax are not interpreted.
 *
 * `external` is an optional strict boolean: `true` and `false` are accepted
 * case-insensitively after trimming, an absent or empty value means `false`,
 * and any other value is an action-input usage error.
 */
export function readActionInputs(environment: NodeJS.ProcessEnv): ActionInputs {
  return {
    paths: parsePaths(environment.INPUT_PATHS),
    external: parseExternal(environment.INPUT_EXTERNAL),
  };
}

/**
 * Builds the CLI argument list. `--` precedes the paths so a path that starts
 * with `-` is checked as a path and cannot enable a CLI option by accident.
 */
export function buildCommandLine(inputs: ActionInputs): string[] {
  return [...(inputs.external ? ['--external'] : []), '--', ...inputs.paths];
}

/** The production CLI I/O contract, backed by the process streams. */
export function createProcessIo(): CliIo {
  return {
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
  };
}

/**
 * Runs the CLI for one action invocation, emits one workflow-command annotation
 * per structured broken-link finding, publishes the completed check's summary
 * counts to the GitHub output file, and handles the job summary, then returns
 * the CLI's exit code together with the ordered, immutable findings, the
 * authoritative summary and the outcome classification.
 *
 * The findings and counts come directly from the CLI's in-process result; the
 * wrapper never reads, parses or re-renders its own output. The CLI writes its
 * complete diagnostics and summary before this function returns from `run(...)`,
 * so every annotation line lands after the unchanged CLI output. An empty
 * finding list writes nothing, and the exit code is returned exactly as the CLI
 * produced it.
 *
 * The job summary is the final action publication and runs once per invocation:
 * after the annotations and after the output publication. A completed check and
 * a usage error each append one M21 fragment when the destination is usable; an
 * unset or empty destination emits one warning and performs no write; a failed
 * append emits one warning and preserves the original result. An internal
 * failure has no defined summary content but still reports an unavailable
 * destination exactly once. No summary or warning is printed in place of the
 * CLI's text, and direct CLI execution never reaches this function.
 */
export async function runAction(
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<RunResult> {
  let inputs: ActionInputs;
  try {
    inputs = readActionInputs(environment);
  } catch (error) {
    if (error instanceof ActionInputError) {
      io.writeError(formatUsageErrorText(error.message));
      await writeStepSummary({ kind: 'usage-error' }, environment, io);
      return {
        exitCode: 2,
        diagnostics: [],
        summary: null,
        outcome: 'usage-error',
      };
    }
    throw error;
  }

  const result = await run(buildCommandLine(inputs), io);
  emitAnnotations(result.diagnostics, io);
  if (result.summary !== null) {
    await publishSummaryOutputs(result.summary, environment);
  }
  await writeStepSummary(stepSummaryOutcome(result), environment, io);
  return result;
}

/**
 * Maps the CLI's authoritative result onto the summary content that belongs to
 * it. This reads only the structured `outcome` and `summary` fields; it never
 * inspects printed text and never recomputes a count.
 */
function stepSummaryOutcome(result: RunResult): StepSummaryOutcome {
  if (result.outcome === 'usage-error') {
    return { kind: 'usage-error' };
  }
  if (result.outcome === 'checked' && result.summary !== null) {
    return {
      kind: 'completed',
      summary: result.summary,
      findings: result.diagnostics,
    };
  }
  return { kind: 'none' };
}

/**
 * Handles the one job-summary publication for an action invocation and reports
 * exactly one warning when it cannot happen.
 *
 * The destination is resolved once from the action environment:
 *
 * - absent or empty: no formatting and no filesystem access; one fixed
 *   {@link STEP_SUMMARY_UNAVAILABLE_WARNING} workflow command is written;
 * - present: the outcome's already-complete Markdown fragment is formatted and
 *   appended once. `completed` uses the guarded M19 formatter unchanged (its
 *   count guard still throws before an append); `usage-error` uses the fixed
 *   zero-diagnostic M21 fragment; `none` writes nothing;
 * - append rejected: one fixed {@link STEP_SUMMARY_WRITE_FAILED_WARNING}
 *   workflow command is written and the raw error is discarded.
 *
 * The warning is emitted exactly once at this single call boundary, after the
 * CLI output, the annotations and the output publication. It never replaces
 * the underlying result and is never emitted for a successful append. This is
 * the only summary write in the action path, so no module-global state or
 * second call site is needed to guarantee "exactly once".
 *
 * Exported so focused tests can prove the M19 count guard still escapes before
 * any write and that both warning classifications are produced here.
 */
export async function writeStepSummary(
  outcome: StepSummaryOutcome,
  environment: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<void> {
  const destination = environment.GITHUB_STEP_SUMMARY;
  if (destination === undefined || destination === '') {
    io.writeOut(`${formatWarningCommand(STEP_SUMMARY_UNAVAILABLE_WARNING)}\n`);
    return;
  }

  if (outcome.kind === 'none') {
    return;
  }

  const markdown =
    outcome.kind === 'completed'
      ? formatRunSummaryMarkdown(outcome.summary, outcome.findings)
      : formatUsageErrorSummaryMarkdown();

  const status = await appendStepSummary(destination, markdown);
  if (status === 'failed') {
    io.writeOut(`${formatWarningCommand(STEP_SUMMARY_WRITE_FAILED_WARNING)}\n`);
  }
}

/**
 * Emits one annotation line per structured finding, in the finding order. The
 * existing formatter owns escaping, truncation and one-command-per-finding
 * rendering; this helper only controls the physical line boundary, writing a
 * single trailing newline after each command. Emissions are never sorted,
 * deduplicated or counted, and an empty list writes no bytes.
 */
export function emitAnnotations(
  findings: readonly BrokenLinkResult[],
  io: CliIo,
): void {
  for (const annotation of formatAnnotations(findings)) {
    io.writeOut(`${annotation}\n`);
  }
}

function parsePaths(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function parseExternal(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'false') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  throw new ActionInputError(
    'invalid action input "external": expected "true" or "false"',
  );
}
