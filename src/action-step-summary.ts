/**
 * Job-summary append for the GitHub Action.
 *
 * M20 completes the run-summary work: the action orchestration layer formats
 * one completed check's M17 counts and ordered findings with the M19 guarded
 * formatter and hands the already-formatted Markdown to this helper, which
 * appends it once to the step-summary destination the action resolved from the
 * runner's environment.
 *
 * M21 makes the append result explicit. A summary is secondary to the action's
 * established result, so an unwritable destination is classified as `failed`
 * instead of throwing through the action's main result path. The orchestration
 * layer turns that one classification into exactly one warning and returns the
 * underlying exit code unchanged.
 *
 * The helper owns only the filesystem write and its classification. It never
 * formats a summary, reads the environment, inspects the findings or parses
 * output, so the action path has exactly one formatter per outcome. It performs
 * no stdout or stderr output, so every existing CLI surface stays byte-for-byte
 * unchanged.
 *
 * The append preserves every pre-existing byte and writes no separator of its
 * own: the caller's complete Markdown fragment is appended exactly as given.
 * Both formatters return a fragment that starts with the `## Results` heading
 * and ends with exactly one newline, so an existing summary that ends with a
 * newline keeps its bytes and the new fragment starts on a fresh line.
 *
 * This module is action-only: the direct CLI path does not import it. It adds
 * no runtime dependency and uses only Node's built-in filesystem API.
 */
import { appendFile } from 'node:fs/promises';

/**
 * Classification of one summary append attempt.
 *
 * - `appended`: the single append operation completed; nothing else is written.
 * - `failed`: the append was attempted but the filesystem rejected it. The
 *   caller reports exactly one warning and keeps the action's established
 *   result.
 */
export type StepSummaryAppendStatus = 'appended' | 'failed';

/**
 * Appends one already-formatted job-summary fragment to `destination`,
 * preserving all existing bytes, and classifies the single append attempt.
 *
 * The caller has already decided that a destination exists and has already
 * formatted the fragment. A missing parent directory, a directory used as the
 * destination or any other filesystem error is caught at this summary boundary
 * and reported as `failed`; the raw error object is never surfaced, logged or
 * turned into a second action failure. The promise resolves only after the
 * append completed or failed, and nothing is written to stdout or stderr.
 *
 * Only this one append operation is performed: there is no retry, and no
 * pre-existing summary byte is rewritten.
 */
export async function appendStepSummary(
  destination: string,
  markdown: string,
): Promise<StepSummaryAppendStatus> {
  try {
    await appendFile(destination, markdown, 'utf8');
    return 'appended';
  } catch {
    return 'failed';
  }
}
