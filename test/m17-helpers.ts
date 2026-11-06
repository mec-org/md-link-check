/**
 * Shared frozen expectations for the M17 run-summary contract and v0.3 surface
 * regression.
 *
 * The fixture is the committed M16 multi-file v0.3 fixture: four Markdown files
 * and 16 broken findings across several source lines, with file, image and
 * anchor targets and two distinct reasons, so file, line, target, reason and
 * result order are all observable. Reusing it keeps one v0.3 fixture and one
 * finding oracle rather than a second copy of the M16 harness.
 *
 * The expected wire bytes beneath `test/fixtures/m17-v03` were captured from
 * the v0.3 action surface (tag `v0.3.0`, before any job summary existed) and
 * are checked in. `manifest.json` records the tag object, the tagged commit,
 * the tagged action bundle's SHA-256, the capture command and every expected
 * file's size and SHA-256; `test/m17-capture-fixtures.mjs` reproduces the
 * end-to-end files from a built v0.3.0 checkout. Tests compare the current
 * output with those files; they never build an expectation by asking the
 * formatter under test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrokenLinkResult } from '../src/run.js';
import { REPO_ROOT, runAction, type ProcessResult } from './action-helpers.js';
import { M16_LOCAL_FINDINGS } from './m16-helpers.js';

/** Directory holding the checked-in v0.3 expected-byte fixtures. */
export const M17_FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'm17-v03');

/** The frozen exit code of the broken v0.3 fixture. */
export const M17_EXIT_CODE = 1;

/** The three summary counts of the broken v0.3 fixture. */
export const M17_SUMMARY = Object.freeze({
  filesChecked: 4,
  broken: 16,
  externalSkipped: 4,
});

/**
 * The fixture's broken findings in the CLI's canonical result order. This is
 * the same independent oracle the M16 v0.3 suite compares text and JSON with,
 * projected onto the in-process finding contract.
 */
export const M17_FINDINGS = M16_LOCAL_FINDINGS;

/** Frozen human-readable CLI stdout for the v0.3 fixture. */
export const M17_CLI_TEXT = readFixture('cli-text.stdout.txt');

/** Frozen `--json` CLI stdout for the v0.3 fixture. */
export const M17_CLI_JSON = readFixture('cli-json.stdout.txt');

/** Frozen workflow-command annotations, one per finding and in result order. */
export const M17_ANNOTATIONS = readFixture('action-annotations.txt');

/** Frozen `GITHUB_OUTPUT` bytes: the three summary-count records, in order. */
export const M17_ACTION_OUTPUTS = readFixture('action-outputs.txt');

/** Frozen CLI usage-error stderr for a run with no input paths. */
export const M17_CLI_USAGE_STDERR = readFixture('cli-usage.stderr.txt');

/** Frozen action-input usage-error stderr for an invalid `external` value. */
export const M17_ACTION_INPUT_ERROR_STDERR = readFixture(
  'action-input-error.stderr.txt',
);

/**
 * Frozen annotations for the M11 special-values fixture, captured from a
 * committed-artifact action run. The file and target values exercise the
 * workflow-command property and message escapes (`%`, `,`, `:` and literal
 * percent sequences) through the real action path.
 */
export const M17_SPECIAL_ANNOTATIONS = readFixture('special-annotations.txt');

/**
 * Synthetic findings that exercise the remaining annotation escape channels
 * (CR, LF and `:` in the file property; CR and LF in the message) and the
 * `file`, `target`, `reason` and whole-message truncation bounds. Real
 * filesystem paths cannot reach the 4096/8192/16384-code-point bounds, so this
 * formatter-boundary fixture freezes those v0.3 bytes instead.
 */
export const M17_EDGE_FINDINGS: readonly BrokenLinkResult[] = [
  { file: '100%.md', line: 3, target: 'docs/a,b.md', reason: 'target does not exist' },
  { file: 'comma,file.md', line: 4, target: 'docs/a:b.md', reason: 'anchor does not exist' },
  { file: 'synthetic:cr\r\nlf.md', line: 5, target: 'a%b', reason: 'target does not exist' },
  {
    file: 'README.md',
    line: 6,
    target: 'literal%0A\rmissing\nname',
    reason: 'external 100% fail',
  },
  {
    file: `${'f'.repeat(4100)}.md`,
    line: 7,
    target: 'missing.md',
    reason: 'target does not exist',
  },
  {
    file: 'README.md',
    line: 8,
    target: 't'.repeat(8200),
    reason: 'reason '.repeat(1300).trim(),
  },
];

/** Frozen v0.3 annotations for {@link M17_EDGE_FINDINGS}, escaping and bounds. */
export const M17_EDGE_ANNOTATIONS = readFixture('edge-annotations.txt');

/** Checked-in provenance manifest for the expected-byte fixture directory. */
export const M17_MANIFEST_PATH = join(M17_FIXTURE_DIR, 'manifest.json');

/** The complete action stdout: unchanged CLI text followed by annotations. */
export const M17_ACTION_STDOUT = `${M17_CLI_TEXT}${M17_ANNOTATIONS}`;

/** Options for one committed-artifact run over the frozen v0.3 fixture. */
export interface M17ActionOptions {
  readonly cwd: string;
  readonly outputPath?: string;
  readonly stepSummaryPath?: string;
}

/**
 * Runs the committed action bundle over the staged fixture exactly as a GitHub
 * runner would, with `paths: .` and external checking left at its documented
 * default. The runner's summary file can be pointed at a temporary path so a
 * test can prove that no job summary is written.
 */
export function runM17Action(options: M17ActionOptions): Promise<ProcessResult> {
  const env: Record<string, string | undefined> = {};
  if (options.outputPath !== undefined) {
    env.GITHUB_OUTPUT = options.outputPath;
  }
  if (options.stepSummaryPath !== undefined) {
    env.GITHUB_STEP_SUMMARY = options.stepSummaryPath;
  }
  return runAction({
    cwd: options.cwd,
    inputs: { INPUT_PATHS: '.', INPUT_EXTERNAL: 'false' },
    env,
  });
}

function readFixture(name: string): string {
  return readFileSync(join(M17_FIXTURE_DIR, name), 'utf8');
}
