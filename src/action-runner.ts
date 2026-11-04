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
 * `GITHUB_OUTPUT` environment file without printing them. Direct CLI execution
 * never imports this module, the annotation formatter or the output publisher.
 */
import { formatAnnotations } from './annotation.js';
import { publishSummaryOutputs } from './action-outputs.js';
import {
  formatUsageErrorText,
  run,
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
 * counts to the GitHub output file, and returns the CLI's exit code together
 * with the ordered, immutable findings and the authoritative summary. The
 * findings and counts come directly from the CLI's in-process result; the
 * wrapper never reads, parses or re-renders its own output.
 *
 * The CLI writes its complete diagnostics and summary before this function
 * returns from `run(...)`, so every annotation line lands after the unchanged
 * CLI output. An empty finding list writes nothing, and the exit code is
 * returned exactly as the CLI produced it. Output publication appends its
 * records after the annotations and resolves before the wrapper returns, so
 * the values are complete when the action process finishes.
 *
 * An invalid input is reported through the same text-mode usage diagnostic and
 * exit code `2` as a CLI usage error, before any checking or network access
 * starts, and carries no findings. A usage or internal failure has no
 * authoritative summary, so no output records are published.
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
      return { exitCode: 2, diagnostics: [], summary: null };
    }
    throw error;
  }

  const result = await run(buildCommandLine(inputs), io);
  emitAnnotations(result.diagnostics, io);
  if (result.summary !== null) {
    await publishSummaryOutputs(result.summary, environment);
  }
  return result;
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
