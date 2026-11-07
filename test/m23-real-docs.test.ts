/**
 * M23 — replayable real-docs acceptance over the exact owner snapshot.
 *
 * The milestone requires an offline CLI and action-wrapper run over the exact
 * root-owned, read-only `dsh-copilot` snapshot, independent confirmation of
 * every reported local finding, a no-network proof and proof that the snapshot
 * was not modified. The generated artifacts stay outside both repositories
 * (this test uses its own temporary directory), but the acceptance itself is
 * executable: when the exact snapshot is present this test reproduces it, and
 * on other machines the whole block is skipped.
 *
 * Identity is pinned by a content fingerprint of the snapshot (sorted relative
 * paths plus SHA-256 of every file), so the evidence in
 * `docs/m23-acceptance.md` is not inferred from the directory name alone.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACTION_ARTIFACT_PATH,
  REPO_ROOT,
  runNode,
} from './action-helpers.js';
import { makeTempRoot } from './helpers.js';
import { OFFLINE_GUARD_PATH } from './m15-helpers.js';
import { treeInventory } from './m16-helpers.js';

/** The exact required snapshot from the M23 packet. */
const SNAPSHOT =
  '/opt/dsh-factory/snapshots/dsh-copilot@fc98b7b953f59f4e747d14164119770f1777e96d';

/** Content fingerprint (paths + file SHA-256) captured from the exact snapshot. */
const SNAPSHOT_CONTENT_FINGERPRINT =
  '9cf05743b2451f66495f406735dfc030232632180da43a8e32c1e58d1c1477a9';

const SNAPSHOT_FILE_COUNT = 154;
const SNAPSHOT_MARKDOWN_COUNT = 18;

const CLI_TEXT = [
  'HANDOVER-ADCP.md:5: ../../AGENTS.md — target does not exist',
  'docs/plan/foreman-v0.1-plan.md:120: url — target does not exist',
  'Checked 18 files: 2 broken targets, 0 external links skipped.',
  '',
].join('\n');

const DIAGNOSTICS = [
  {
    file: 'HANDOVER-ADCP.md',
    line: 5,
    column: 17,
    kind: 'link',
    target: '../../AGENTS.md',
    reason: 'target does not exist',
  },
  {
    file: 'docs/plan/foreman-v0.1-plan.md',
    line: 120,
    column: 214,
    kind: 'link',
    target: 'url',
    reason: 'target does not exist',
  },
] as const;

const ANNOTATIONS = [
  '::error file=HANDOVER-ADCP.md,line=5::../../AGENTS.md — target does not exist',
  '::error file=docs/plan/foreman-v0.1-plan.md,line=120::url — target does not exist',
];

const ACTION_SUMMARY = [
  '## Results',
  '',
  '- Checked: 18',
  '- Broken: 2',
  '- External skipped: 0',
  '',
  '## Diagnostics',
  '',
  '- HANDOVER\\-ADCP.md:5: ../../AGENTS.md — target does not exist',
  '- docs/plan/foreman\\-v0.1\\-plan.md:120: url — target does not exist',
  '',
].join('\n');

const ACTION_OUTPUTS = 'files-checked=18\nbroken=2\nexternal-skipped=0\n';

interface InventoryEntry {
  readonly kind: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly hash?: string;
}

function contentFingerprint(inventory: Record<string, InventoryEntry>): string {
  const lines = Object.entries(inventory)
    .filter(([, entry]) => entry.kind === 'file')
    // A JSON pair keeps the path/hash boundary visible and unambiguous while
    // hashing only the snapshot's content identity.
    .map(([path, entry]) => JSON.stringify([path, entry.hash ?? '']))
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

describe.skipIf(!existsSync(SNAPSHOT))('M23 real-docs acceptance (snapshot present)', () => {
  it('runs the CLI and action wrapper offline over the read-only snapshot', async () => {
    const snapshotStat = statSync(SNAPSHOT);
    expect(snapshotStat.isDirectory()).toBe(true);
    expect(snapshotStat.uid).toBe(0);
    // Group and other have no write permission, and the test process is not the
    // root owner, so the snapshot is read-only for this run.
    expect(snapshotStat.mode & 0o022).toBe(0);
    expect(process.getuid?.()).not.toBe(snapshotStat.uid);
    expect(existsSync(join(SNAPSHOT, '.git'))).toBe(false);

    const before = treeInventory(SNAPSHOT);
    const files = Object.entries(before).filter(([, entry]) => entry.kind === 'file');
    expect(files).toHaveLength(SNAPSHOT_FILE_COUNT);
    expect(
      files.filter(([path]) => /\.(?:md|markdown)$/i.test(path)),
    ).toHaveLength(SNAPSHOT_MARKDOWN_COUNT);
    expect(contentFingerprint(before)).toBe(SNAPSHOT_CONTENT_FINGERPRINT);

    const root = makeTempRoot();
    const guardedEnv = (tag: string): NodeJS.ProcessEnv => ({
      MDLC_ACCEPTANCE_CACHE_ROOT: join(root, tag, 'cache'),
      MDLC_ACCEPTANCE_GUARD_LOG: join(root, tag, 'guard.log'),
      XDG_CACHE_HOME: join(root, tag, 'xdg'),
    });
    const cleanEnv = (tag: string): NodeJS.ProcessEnv => {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(environment)) {
        if (
          key.startsWith('INPUT_') ||
          key === 'GITHUB_OUTPUT' ||
          key === 'GITHUB_STEP_SUMMARY' ||
          key === 'MDLC_ACCEPTANCE_CACHE_ROOT' ||
          key === 'MDLC_ACCEPTANCE_GUARD_LOG'
        ) {
          delete environment[key];
        }
      }
      return { ...environment, ...guardedEnv(tag) };
    };
    const expectNoGuardAccess = (tag: string): void => {
      expect(existsSync(join(root, tag, 'guard.log'))).toBe(false);
      expect(existsSync(join(root, tag, 'cache'))).toBe(false);
    };

    // Direct CLI text and JSON modes: both stay offline and finish with the
    // documented broken-link exit 1.
    const cliText = await runNode(join(REPO_ROOT, 'dist', 'cli.js'), ['.'], {
      cwd: SNAPSHOT,
      env: cleanEnv('cli-text'),
      requires: [OFFLINE_GUARD_PATH],
    });
    expect(cliText.status).toBe(1);
    expect(cliText.stderr).toBe('');
    expect(cliText.stdout).toBe(CLI_TEXT);
    expectNoGuardAccess('cli-text');

    const cliJson = await runNode(join(REPO_ROOT, 'dist', 'cli.js'), ['--json', '.'], {
      cwd: SNAPSHOT,
      env: cleanEnv('cli-json'),
      requires: [OFFLINE_GUARD_PATH],
    });
    expect(cliJson.status).toBe(1);
    expect(cliJson.stderr).toBe('');
    const report = JSON.parse(cliJson.stdout) as {
      version: number;
      ok: boolean;
      exitCode: number;
      summary: { filesChecked: number; broken: number; externalSkipped: number };
      external: { enabled: boolean };
      diagnostics: Array<{
        file: string;
        line: number;
        kind: 'link' | 'image';
        target: string;
        reason: string;
      }>;
    };
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.summary).toEqual({
      filesChecked: 18,
      broken: 2,
      externalSkipped: 0,
    });
    expect(report.external.enabled).toBe(false);
    expect(report.diagnostics).toEqual(DIAGNOSTICS);
    expectNoGuardAccess('cli-json');

    // Action wrapper: unchanged CLI text, two annotations, one summary, the
    // established outputs, and no warning.
    const summaryPath = join(root, 'action-summary.md');
    const outputPath = join(root, 'action.GITHUB_OUTPUT');
    const action = await runNode(ACTION_ARTIFACT_PATH, [], {
      cwd: SNAPSHOT,
      env: {
        ...cleanEnv('action'),
        INPUT_PATHS: '.',
        INPUT_EXTERNAL: 'false',
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
      },
      requires: [OFFLINE_GUARD_PATH],
    });
    expect(action.status).toBe(1);
    expect(action.stderr).toBe('');
    expect(action.stdout).toBe(`${CLI_TEXT}${ANNOTATIONS.join('\n')}\n`);
    expect(action.stdout).not.toContain('::warning::');
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary.split('## Results')).toHaveLength(2);
    expect(summary).toBe(ACTION_SUMMARY);
    expect(readFileSync(outputPath, 'utf8')).toBe(ACTION_OUTPUTS);
    expectNoGuardAccess('action');

    // Independent confirmation of every reported local finding from structured
    // JSON: inspect the source line, resolve the target under the checker's
    // file-relative rule, and confirm the resolved target is absent. The owner
    // documents are read-only and are not changed.
    for (const diagnostic of report.diagnostics) {
      expect(diagnostic.reason).toBe('target does not exist');
      expect(diagnostic.kind).toBe('link');
      const sourcePath = join(SNAPSHOT, diagnostic.file);
      const sourceLine =
        readFileSync(sourcePath, 'utf8').split('\n')[diagnostic.line - 1] ?? '';
      expect(sourceLine).toContain(`(${diagnostic.target})`);
      const resolvedTarget = resolve(dirname(sourcePath), diagnostic.target);
      expect(
        existsSync(resolvedTarget),
        `reported target exists: ${resolvedTarget}`,
      ).toBe(false);
    }

    // The read-only snapshot is byte-identical after all three runs: no file
    // created, changed or deleted, and no cache, log, summary or other artifact
    // appeared in it.
    expect(treeInventory(SNAPSHOT)).toEqual(before);
  });
});
