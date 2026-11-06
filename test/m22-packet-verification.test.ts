/**
 * M22 — in-packet protection for the acceptance criteria that are not specific
 * to one transport mode.
 *
 * The merge gate requires the packet itself to cover direct CLI summary
 * isolation, the M21 unavailable-destination warnings, the owner-approved charter
 * pins and v0.3 tag, bundle freshness, and the repository's non-recursive
 * verification commands. Every expectation here is an independent hard-coded
 * oracle; the full repository test suite is the same packet (`npm test`) and its
 * green run in CI is the evidence for that criterion.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZED_BASE_SHA,
  REPO_ROOT,
  readScopeReport,
  runAction,
  runActionBuild,
  runCli,
} from './action-helpers.js';
import { CHARTER_FILE_PINS, gitBlobHash } from './charter-pins.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { runArtifactUnderOfflineGuard } from './m15-helpers.js';
import {
  OFFLINE_EXPECTATION,
  PROXY_ISOLATION,
  UNAVAILABLE_WARNING,
  WRITE_FAILED_WARNING,
  actionStdout,
  offlineFixture,
  warningLines,
} from './m22-helpers.js';
import { startFixtureServer } from './server.js';

/** The owner-approved v0.3 tag and its commit (owner decision, 2026-11-06). */
const OWNER_APPROVED_V03_TAG = 'v0.3.0';
const OWNER_APPROVED_V03_TAG_COMMIT =
  '4438906e6e6085c941faf3117c2aaca1824a073d';

/** The pinned charter blob hashes, restated as an independent oracle. */
const EXPECTED_CHARTER_PINS = {
  'PROJECT.md': 'ea3d2ee55f766b0d30956754e4908fa578c6c5c7',
  'ROADMAP.md': 'b7c34bd3902a0a26551d6fb1bb7266134a5fddeb',
} as const;

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('M22 packet protection for merge-gate acceptance criteria', () => {
  it('direct CLI ignores summary destinations and writes no summary', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, offlineFixture(server.url));
    const writableSummary = join(root, 'step-summary.md');
    const outputPath = join(root, 'github-output.txt');
    const summarySentinel = 'prior unrelated step summary\n';
    const outputSentinel = 'keep=sentinel\n';
    writeFileSync(writableSummary, summarySentinel);
    writeFileSync(outputPath, outputSentinel);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      GITHUB_STEP_SUMMARY: writableSummary,
      GITHUB_OUTPUT: outputPath,
      XDG_CACHE_HOME: join(root, 'cache-home'),
    };

    try {
      // A direct CLI run never imports the action modules: a writable summary
      // and output destination keep their pre-existing bytes, and no workflow
      // command is emitted.
      const writable = await runCli(['--', '.'], { cwd: fixture, env: environment });
      expect(writable.status).toBe(1);
      expect(writable.stdout).toBe(OFFLINE_EXPECTATION.cliText);
      expect(writable.stderr).toBe('');
      expect(warningLines(`${writable.stdout}${writable.stderr}`)).toEqual([]);
      expect(readFileSync(writableSummary, 'utf8')).toBe(summarySentinel);
      expect(readFileSync(outputPath, 'utf8')).toBe(outputSentinel);

      // An unusable destination is equally ignored: no creation, no warning and
      // no change to the CLI's own result.
      const unusableSummary = join(root, 'missing-parent', 'step-summary.md');
      const unusable = await runCli(['--', '.'], {
        cwd: fixture,
        env: { ...environment, GITHUB_STEP_SUMMARY: unusableSummary },
      });
      expect(unusable.status).toBe(1);
      expect(unusable.stdout).toBe(OFFLINE_EXPECTATION.cliText);
      expect(unusable.stderr).toBe('');
      expect(warningLines(`${unusable.stdout}${unusable.stderr}`)).toEqual([]);
      expect(existsSync(unusableSummary)).toBe(false);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('M21 unavailable summary destinations keep their warnings and results', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, offlineFixture(server.url));
    const expectedStdout = actionStdout(OFFLINE_EXPECTATION);

    try {
      // An unwritable destination: exactly one fixed warning after the unchanged
      // action stdout, no write, and the broken result's exit and outputs kept.
      const outputPath = join(root, 'github-output.txt');
      const unwritableSummary = join(root, 'missing-parent', 'step-summary.md');
      writeFileSync(outputPath, '');
      const unwritable = await runAction({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.' },
        env: {
          ...PROXY_ISOLATION,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: unwritableSummary,
        },
        fetchLog: join(root, 'unwritable-fetch.log'),
        cacheHome: join(root, 'unwritable-cache'),
      });
      expect(unwritable.status).toBe(1);
      expect(unwritable.stdout).toBe(`${expectedStdout}${WRITE_FAILED_WARNING}`);
      expect(unwritable.stderr).toBe('');
      expect(warningLines(unwritable.stdout)).toEqual([
        WRITE_FAILED_WARNING.slice(0, -1),
      ]);
      expect(readFileSync(outputPath, 'utf8')).toBe(OFFLINE_EXPECTATION.outputs);
      expect(existsSync(unwritableSummary)).toBe(false);
      expect(server.requests).toEqual([]);

      // The M21 unset case warns once with its own fixed message and preserves
      // the same established surfaces.
      const unsetOutputPath = join(root, 'unset-output.txt');
      writeFileSync(unsetOutputPath, '');
      const unset = await runAction({
        cwd: fixture,
        inputs: { INPUT_PATHS: '.' },
        env: {
          ...PROXY_ISOLATION,
          GITHUB_OUTPUT: unsetOutputPath,
          GITHUB_STEP_SUMMARY: undefined,
        },
        fetchLog: join(root, 'unset-fetch.log'),
        cacheHome: join(root, 'unset-cache'),
      });
      expect(unset.status).toBe(1);
      expect(unset.stdout).toBe(`${expectedStdout}${UNAVAILABLE_WARNING}`);
      expect(unset.stderr).toBe('');
      expect(warningLines(unset.stdout)).toEqual([
        UNAVAILABLE_WARNING.slice(0, -1),
      ]);
      expect(readFileSync(unsetOutputPath, 'utf8')).toBe(OFFLINE_EXPECTATION.outputs);
      expect(existsSync(join(root, 'unset-fetch.log'))).toBe(false);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('offline-guard helper never inherits a host summary destination', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const fixture = join(root, 'fixture');
    writeFiles(fixture, offlineFixture(server.url));
    const hostSummary = join(root, 'host-step-summary.md');
    const hostOutput = join(root, 'host-github-output.txt');
    const summarySentinel = 'host step summary sentinel\n';
    const outputSentinel = 'host output sentinel\n';
    writeFileSync(hostSummary, summarySentinel);
    writeFileSync(hostOutput, outputSentinel);
    const savedSummary = process.env.GITHUB_STEP_SUMMARY;
    const savedOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_STEP_SUMMARY = hostSummary;
    process.env.GITHUB_OUTPUT = hostOutput;

    try {
      const { result } = await runArtifactUnderOfflineGuard(fixture, {
        INPUT_PATHS: 'README.md\ndocs/guide.md',
      });

      // The inherited host destinations are removed before the helper chooses
      // its own writable summary default, so neither host file is touched and
      // the run does not fall through to the M21 unavailable warning.
      expect(result.status).toBe(1);
      expect(readFileSync(hostSummary, 'utf8')).toBe(summarySentinel);
      expect(readFileSync(hostOutput, 'utf8')).toBe(outputSentinel);
      expect(result.stdout).toBe(actionStdout(OFFLINE_EXPECTATION));
      expect(warningLines(`${result.stdout}${result.stderr}`)).toEqual([]);
    } finally {
      if (savedSummary === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY;
      } else {
        process.env.GITHUB_STEP_SUMMARY = savedSummary;
      }
      if (savedOutput === undefined) {
        delete process.env.GITHUB_OUTPUT;
      } else {
        process.env.GITHUB_OUTPUT = savedOutput;
      }
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('owner-approved charter pins and the v0.3 tag remain intact', () => {
    // The pins are content assertions, so a changed charter file fails even
    // though the pin table itself would also change in the same commit.
    expect(CHARTER_FILE_PINS).toEqual(EXPECTED_CHARTER_PINS);
    for (const [path, hash] of Object.entries(EXPECTED_CHARTER_PINS)) {
      expect(gitBlobHash(join(REPO_ROOT, path)), path).toBe(hash);
    }

    // A shallow CI checkout may carry no tags. When this checkout has a v0.3
    // tag, it must be exactly the owner-approved tag at the M16 commit; M22
    // neither moves nor recreates it.
    const tags = git(['tag', '--list', 'v0.3*']).trim();
    if (tags !== '') {
      expect(tags).toBe(OWNER_APPROVED_V03_TAG);
      expect(git(['rev-parse', `${OWNER_APPROVED_V03_TAG}^{commit}`]).trim()).toBe(
        OWNER_APPROVED_V03_TAG_COMMIT,
      );
    }
    expect(existsSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'))).toBe(
      false,
    );
  });

  it('action-dist/index.cjs is current', async () => {
    const result = await runActionBuild(['--check']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'action entrypoint is reproducible: action-dist/index.cjs',
    );
  });

  it(
    'repository typecheck and scope checks pass',
    { timeout: 60_000 },
    async () => {
      // The full repository test suite is this packet; CI runs `npm test` on
      // the PR. The remaining non-recursive checks are executed here so their
      // pass is packet evidence rather than a prose claim.
      expect(() =>
        execFileSync('npm', ['run', 'typecheck'], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        }),
      ).not.toThrow();

      const scope = await readScopeReport();
      expect(scope.base).toBe(AUTHORIZED_BASE_SHA);
      expect(scope.violations).toEqual([]);
      // A shallow CI checkout compares only the protected metadata directories
      // and may legitimately report no changed path; a full git diff always has
      // the M22 changes.
      if (scope.mode === 'git-diff') {
        expect(scope.changed.length).toBeGreaterThan(0);
      }
    },
  );
});
