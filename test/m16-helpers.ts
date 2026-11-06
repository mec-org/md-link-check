/**
 * Shared setup and assertions for the M16 v0.3 multi-file acceptance suite.
 *
 * The committed fixture beneath `test/fixtures/m16-multifile` combines several
 * Markdown files and findings: valid and broken file links, images, same-file
 * and cross-file heading anchors, duplicate headings, explicit HTML anchors,
 * raw HTML links and images, reference-style targets, skipped external
 * occurrences, and loopback external success and terminal failure. The fixture
 * is repository-contained and non-confidential; a loopback variant rewrites
 * only the example origin so external-mode tests never contact a real host.
 *
 * Expected findings are frozen here, independently of the production code, so
 * text, JSON, annotations, outputs and exits are compared with one oracle.
 */
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrokenLinkResult } from '../src/run.js';
import { REPO_ROOT } from './action-helpers.js';

/** The M16 authorized base commit from the milestone packet. */
export const M16_BASE_SHA = '4c821d201072b3fe00ebd053605e95cf7d5e8a93';

/** The committed multi-file v0.3 fixture root. */
export const M16_FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'm16-multifile');

/** The example origin rewritten to loopback for external-enabled tests. */
export const M16_EXAMPLE_ORIGIN = 'https://example.com';

/** One frozen diagnostic, including the fields the JSON report carries. */
export interface M16Diagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: 'link' | 'image';
  readonly target: string;
  readonly reason: string;
}

/**
 * The fixture's 16 local findings, in the CLI's deterministic document order:
 * README.md, docs/api.md, docs/guide.md and docs/plan/notes.md.
 */
export const M16_LOCAL_DIAGNOSTICS: readonly M16Diagnostic[] = [
  { file: 'README.md', line: 3, column: 30, kind: 'link', target: 'docs/missing.md', reason: 'target does not exist' },
  { file: 'README.md', line: 4, column: 33, kind: 'image', target: 'images/missing.png', reason: 'target does not exist' },
  { file: 'README.md', line: 5, column: 41, kind: 'link', target: '#missing-anchor', reason: 'anchor does not exist' },
  { file: 'README.md', line: 6, column: 45, kind: 'link', target: 'docs/guide.md#deployment', reason: 'anchor does not exist' },
  { file: 'README.md', line: 8, column: 46, kind: 'link', target: 'docs/missing-raw.md', reason: 'target does not exist' },
  { file: 'README.md', line: 9, column: 55, kind: 'image', target: 'images/missing-raw.png', reason: 'target does not exist' },
  { file: 'README.md', line: 10, column: 32, kind: 'link', target: 'docs/missing-ref.md', reason: 'target does not exist' },
  { file: 'README.md', line: 18, column: 66, kind: 'link', target: '#duplicate-2', reason: 'anchor does not exist' },
  { file: 'docs/api.md', line: 7, column: 36, kind: 'link', target: 'guide.md#installation-1', reason: 'anchor does not exist' },
  { file: 'docs/api.md', line: 8, column: 27, kind: 'link', target: '#installation-1', reason: 'anchor does not exist' },
  { file: 'docs/api.md', line: 10, column: 1, kind: 'link', target: 'guide.md#not-a-heading', reason: 'anchor does not exist' },
  { file: 'docs/guide.md', line: 7, column: 49, kind: 'link', target: '../README.md#missing', reason: 'anchor does not exist' },
  { file: 'docs/guide.md', line: 8, column: 19, kind: 'link', target: 'missing-api.md', reason: 'target does not exist' },
  { file: 'docs/guide.md', line: 9, column: 33, kind: 'image', target: '../images/missing-logo.png', reason: 'target does not exist' },
  { file: 'docs/plan/notes.md', line: 5, column: 1, kind: 'link', target: '../guide.md#plan-notes', reason: 'anchor does not exist' },
  { file: 'docs/plan/notes.md', line: 6, column: 1, kind: 'link', target: '../missing-plan.md', reason: 'target does not exist' },
];

/** The frozen `BrokenLinkResult` projection of the local findings. */
export const M16_LOCAL_FINDINGS: readonly BrokenLinkResult[] = M16_LOCAL_DIAGNOSTICS.map(
  ({ file, line, target, reason }) => ({ file, line, target, reason }),
);

/** The fixture's frozen text-mode output in the default offline mode. */
export const M16_LOCAL_TEXT =
  M16_LOCAL_FINDINGS.map(
    (finding) => `${finding.file}:${finding.line}: ${finding.target} — ${finding.reason}\n`,
  ).join('') + 'Checked 4 files: 16 broken targets, 4 external links skipped.\n';

/**
 * The frozen JSON report of a default offline run over the fixture. The
 * document includes the additive v0.2 external block with checking disabled,
 * exactly as the current schema emits it.
 */
export const M16_LOCAL_JSON = {
  version: 1,
  ok: false,
  exitCode: 1,
  summary: { filesChecked: 4, broken: 16, externalSkipped: 4 },
  external: {
    enabled: false,
    occurrences: 4,
    skipped: 4,
    distinctChecked: 0,
    succeeded: 0,
    failed: 0,
    brokenOccurrences: 0,
    cache: { enabled: false, hits: 0, misses: 0, stale: 0 },
    results: [],
  },
  diagnostics: M16_LOCAL_DIAGNOSTICS,
} as const;

/**
 * The two external failure diagnostics the fixture adds in external-enabled
 * mode: the duplicate `/fail` occurrence is checked once and reported twice,
 * in document order, after the local finding on line 10.
 */
export function m16ExternalFailureDiagnostics(
  origin: string,
): readonly BrokenLinkResult[] {
  const target = `${origin}/fail`;
  return [
    { file: 'README.md', line: 11, target, reason: 'external HTTP 404' },
    { file: 'README.md', line: 11, target, reason: 'external HTTP 404' },
  ];
}

/** The fixture's findings in external-enabled mode, in document order. */
export function m16ExternalFindings(origin: string): readonly BrokenLinkResult[] {
  const failures = m16ExternalFailureDiagnostics(origin);
  return [
    ...M16_LOCAL_FINDINGS.slice(0, 7),
    ...failures,
    ...M16_LOCAL_FINDINGS.slice(7),
  ];
}

/**
 * Copies the committed fixture to `root` and, when `externalBaseUrl` is given,
 * rewrites the example origin in README.md to that loopback base URL. The
 * committed fixture itself is never modified.
 */
export function stageFixture(
  root: string,
  options: { readonly externalBaseUrl?: string } = {},
): string {
  const destination = join(root, 'fixture');
  cpSync(M16_FIXTURE, destination, { recursive: true });
  if (options.externalBaseUrl !== undefined) {
    const readmePath = join(destination, 'README.md');
    const rewritten = readFileSync(readmePath, 'utf8').replaceAll(
      M16_EXAMPLE_ORIGIN,
      options.externalBaseUrl,
    );
    writeFileSync(readmePath, rewritten);
  }
  return destination;
}

/**
 * Makes every directory and file beneath `root` non-writable for its owner,
 * which is enough to prove a check creates and modifies nothing there.
 */
export function makeTreeReadOnly(root: string): void {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      makeTreeReadOnly(absolutePath);
    } else {
      chmodSync(absolutePath, 0o444);
    }
  }
  chmodSync(root, 0o555);
}

/** Restores owner write access after a read-only test so cleanup can succeed. */
export function makeTreeWritable(root: string): void {
  chmodSync(root, 0o755);
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      makeTreeWritable(absolutePath);
    } else {
      chmodSync(absolutePath, 0o644);
    }
  }
}

/**
 * Extracts every `file:line: target — reason` diagnostic line from a CLI
 * stdout prefix. Summary lines, external summary lines and workflow-command
 * annotations are ignored, so the parser works for direct CLI and action
 * output alike without trusting the production formatter to produce findings.
 */
export function parseTextDiagnostics(stdout: string): BrokenLinkResult[] {
  const findings: BrokenLinkResult[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(.*):(\d+): (.*?) — (.*)$/.exec(line);
    if (match !== null) {
      findings.push({
        file: match[1] ?? '',
        line: Number(match[2]),
        target: match[3] ?? '',
        reason: match[4] ?? '',
      });
    }
  }
  return findings;
}

/** One deterministic inventory entry for a mutation-guard comparison. */
export interface TreeEntry {
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly hash?: string;
}

/**
 * Builds a content inventory of every path beneath `root`. File contents are
 * hashed, so the comparison detects an in-place modification as well as a
 * created, deleted or renamed entry.
 */
export function treeInventory(root: string): Record<string, TreeEntry> {
  const inventory: Record<string, TreeEntry> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const displayPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        inventory[displayPath] = { kind: 'symlink', size: 0 };
      } else if (entry.isDirectory()) {
        inventory[displayPath] = { kind: 'directory', size: 0 };
        walk(absolutePath, displayPath);
      } else {
        const contents = readFileSync(absolutePath);
        inventory[displayPath] = {
          kind: 'file',
          size: statSync(absolutePath).size,
          hash: createHash('sha256').update(contents).digest('hex'),
        };
      }
    }
  };
  walk(root, '');
  return inventory;
}
