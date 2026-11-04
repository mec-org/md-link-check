/**
 * Summary-count outputs for the GitHub Action.
 *
 * A completed checking run already produces an authoritative summary of the
 * files checked, the broken-link findings and the skipped external uses. This
 * module publishes those three counts as action outputs through the runner's
 * `GITHUB_OUTPUT` environment file, using GitHub's environment-file protocol.
 * It appends decimal `name=value` records and performs no stdout or stderr
 * output, so the CLI's diagnostics, summaries and workflow-command annotations
 * stay byte-for-byte unchanged. It never reads output to compute values and
 * never uses the deprecated `::set-output` command.
 *
 * The values come directly from the structured run result (`ActionSummary`);
 * this module never parses text, JSON, annotations or formatted diagnostics.
 * It is action-only: the direct CLI path does not import it, and a run outside
 * a GitHub Actions runner stays usable because an absent or empty
 * `GITHUB_OUTPUT` simply skips publication.
 *
 * A missing or unwritable output file is not a checking failure. The error
 * propagates to the action entrypoint's existing internal-error path, which
 * reports it without inventing a broken link or a summary value.
 */
import { appendFile } from 'node:fs/promises';
import type { ActionSummary } from './run.js';

/**
 * Stable output identifiers declared in `action.yml`, in publication order.
 * `action.yml`, the README and the M13 tests all assert these exact names.
 */
export const SUMMARY_OUTPUT_NAMES = Object.freeze({
  filesChecked: 'files-checked',
  broken: 'broken',
  externalSkipped: 'external-skipped',
} as const);

/**
 * The structured summary fields published as action outputs. It is
 * structurally identical to the run result's {@link ActionSummary}; the type
 * alias keeps this module independent of how the counts are produced.
 */
export type ActionSummaryOutputs = ActionSummary;

/**
 * Appends one decimal output record per summary count to the file named by
 * `GITHUB_OUTPUT`, preserving any existing content. All three records are
 * built before the single bounded append, so an invalid count or a failed
 * write cannot leave a partial set of values. The promise resolves only after
 * the append completed, and nothing is written to stdout or stderr.
 *
 * When `GITHUB_OUTPUT` is absent or empty, publication is skipped: local action
 * invocation and manual execution outside a hosted runner need no output file.
 * For a usage error or an internal failure there is no authoritative summary,
 * so the caller never invokes this function and no invented zeros are written.
 */
export async function publishSummaryOutputs(
  summary: ActionSummaryOutputs,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const outputPath = environment.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath === '') {
    return;
  }

  const records =
    [
      `${SUMMARY_OUTPUT_NAMES.filesChecked}=${formatCount(summary.filesChecked, 'filesChecked')}`,
      `${SUMMARY_OUTPUT_NAMES.broken}=${formatCount(summary.broken, 'broken')}`,
      `${SUMMARY_OUTPUT_NAMES.externalSkipped}=${formatCount(
        summary.externalSkipped,
        'externalSkipped',
      )}`,
    ].join('\n') + '\n';

  await appendFile(outputPath, records, 'utf8');
}

/**
 * Serializes one summary count as a base-10 string, rejecting values that are
 * not finite non-negative safe integers. The checker only produces counts in
 * that range, so this is a defensive boundary rather than a recovery path.
 */
function formatCount(value: number, field: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid action summary count "${field}": ${String(value)}`);
  }
  return String(value);
}
