/**
 * Job-summary append for the GitHub Action.
 *
 * M20 completes the run-summary work: the action orchestration layer formats
 * one completed check's M17 counts and ordered findings with the M19 guarded
 * formatter and hands the already-formatted Markdown to this helper, which
 * appends it once to the step-summary destination the action resolved from the
 * runner's environment.
 *
 * The helper owns only the filesystem write. It never formats a summary, reads
 * the environment, inspects the findings or parses output, so the action path
 * has exactly one formatter (the M19 one) and one append. It performs no stdout
 * or stderr output, so every existing CLI surface stays byte-for-byte
 * unchanged.
 *
 * The append preserves every pre-existing byte and writes no separator of its
 * own: the caller's complete M19 fragment is appended exactly as given. That
 * fragment starts with the `## Results` heading and ends with exactly one
 * newline, so an existing summary that ends with a newline keeps its bytes and
 * the new fragment starts on a fresh line.
 *
 * An unwritable destination is not a checking failure. As with the existing
 * `GITHUB_OUTPUT` publisher, the error propagates to the action entrypoint's
 * internal-error path, which reports it and exits `2` without inventing a
 * broken-link finding or changing the completed check's result. The error is
 * never silently swallowed.
 *
 * This module is action-only: the direct CLI path does not import it. It adds
 * no runtime dependency and uses only Node's built-in filesystem API.
 */
import { appendFile } from 'node:fs/promises';

/**
 * Appends one already-formatted job-summary fragment to `destination`,
 * preserving all existing bytes. The promise resolves only after the append
 * completed.
 *
 * The caller has already decided that a destination exists and has already
 * formatted the fragment. A missing parent directory, a directory used as the
 * destination or any other filesystem error is propagated unchanged so the
 * action entrypoint can report it through the established internal-error
 * policy; nothing is written to stdout or stderr.
 */
export async function appendStepSummary(
  destination: string,
  markdown: string,
): Promise<void> {
  await appendFile(destination, markdown, 'utf8');
}
