import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction, runCli, REPO_ROOT } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';

const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');
const OFFLINE_GUARD_PATH = join(REPO_ROOT, 'test', 'offline-guard.cjs');

interface GuardedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface AcceptanceRepo {
  root: string;
  cacheHome: string;
  home: string;
  guardLog: string;
  cacheFile: string;
}

interface GuardEntry {
  api: string;
  detail: string;
}

/**
 * A docs-shaped, non-confidential fixture. It mirrors the acceptance shape:
 * Markdown and supported raw HTML targets, heading and explicit anchors,
 * same-file and cross-file links, code-excluded fakes, and three external
 * occurrences. It is not copied from the owner's documentation.
 */
const ACCEPTANCE_FILES: Record<string, string> = {
  'README.md': [
    '# Acceptance fixture',
    '',
    '[guide](docs/guide.md), [missing](docs/missing.md), ![logo](assets/logo.png),',
    '[same](#acceptance-fixture), [cross](docs/guide.md#installation),',
    '[ref][api], [external](https://example.com/one),',
    '![external image](https://example.com/image.png),',
    '<a href="docs/guide.md#explicit">HTML link</a>,',
    '<a href="https://example.com/two">external HTML link</a>,',
    '<img src="assets/logo.png" alt="logo">,',
    '<a id="local-anchor"></a>',
    '',
    '[api]: docs/api.md',
    '',
    '```text',
    '[fenced](missing.md)',
    '```',
    '',
    '    [indented](missing.md)',
    '',
    'Use `[inline](missing.md)` in prose.',
    '',
    '[unused]: https://example.com/unused',
    '',
  ].join('\n'),
  'docs/guide.md': [
    '# Guide',
    '',
    '## Installation',
    '',
    '<a id="explicit"></a>',
    '',
    '[home](../README.md#acceptance-fixture)',
    '',
  ].join('\n'),
  'docs/api.md': '# API\n',
  'docs/plan/notes.md':
    '# Plan notes\n\nSee [the guide](../guide.md#installation) and [the API](../api.md).\n',
  'assets/logo.png': '',
};

const EXPECTED_TEXT =
  'README.md:3: docs/missing.md — target does not exist\n' +
  'Checked 4 files: 1 broken target, 3 external links skipped.\n';

function git(root: string, args: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=M8 Acceptance',
      '-c',
      'user.email=m8-acceptance@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

function makeAcceptanceRepo(options: { seedCache?: boolean } = {}): AcceptanceRepo {
  const root = makeTempRoot();
  writeFiles(root, ACCEPTANCE_FILES);
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'acceptance fixture']);

  const runRoot = makeTempRoot();
  const cacheHome = join(runRoot, 'cache');
  const home = join(runRoot, 'home');
  const guardLog = join(runRoot, 'guard.log');
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(home, { recursive: true });

  const cacheFile = join(cacheHome, 'md-link-check', 'external-v1.json');
  if (options.seedCache ?? true) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(
      cacheFile,
      `${JSON.stringify(
        {
          version: 1,
          entries: {
            'https://example.com/one': {
              checkedAt: 1_800_000_000_000,
              outcome: 'permanent-failure',
              httpStatus: 404,
              attempts: 1,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }

  return { root, cacheHome, home, guardLog, cacheFile };
}

function acceptanceEnvironment(repo: AcceptanceRepo): NodeJS.ProcessEnv {
  return {
    HOME: repo.home,
    XDG_CACHE_HOME: repo.cacheHome,
    MDLC_ACCEPTANCE_GUARD_LOG: repo.guardLog,
    MDLC_ACCEPTANCE_CACHE_ROOT: repo.cacheHome,
  };
}

function runGuarded(
  repo: AcceptanceRepo,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): GuardedRun {
  const result = spawnSync(
    process.execPath,
    ['--require', OFFLINE_GUARD_PATH, CLI_PATH, ...args],
    {
      cwd: repo.root,
      env: { ...process.env, ...acceptanceEnvironment(repo), ...environment },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readGuardLog(path: string): GuardEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GuardEntry);
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface TreeEntry {
  kind: 'dir' | 'file' | 'link';
  hash?: string;
  target?: string;
}

/** A deterministic recursive inventory of every path under `root`. */
function treeSnapshot(root: string): Record<string, TreeEntry> {
  const snapshot: Record<string, TreeEntry> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        snapshot[relativePath] = { kind: 'link', target: readlinkSync(absolutePath) };
      } else if (entry.isDirectory()) {
        snapshot[relativePath] = { kind: 'dir' };
        walk(absolutePath, relativePath);
      } else {
        snapshot[relativePath] = { kind: 'file', hash: hashFile(absolutePath) };
      }
    }
  };
  walk(root, '');
  return snapshot;
}

function parseTextOutput(stdout: string): {
  findings: Array<{ file: string; line: number; target: string; reason: string }>;
  filesChecked: number;
  broken: number;
  externalSkipped: number;
} {
  const lines = stdout.replace(/\n$/, '').split('\n');
  const summary = lines.pop() ?? '';
  const summaryMatch =
    /^Checked (\d+) files?: (\d+) broken targets?, (\d+) external links? skipped\.$/.exec(summary);
  expect(summaryMatch, `unexpected summary line: ${summary}`).not.toBeNull();
  const findings = lines.map((line) => {
    const match = /^(.*):(\d+): (.*?) — (.*)$/.exec(line);
    expect(match, `unexpected diagnostic line: ${line}`).not.toBeNull();
    return {
      file: match?.[1] ?? '',
      line: Number(match?.[2] ?? 0),
      target: match?.[3] ?? '',
      reason: match?.[4] ?? '',
    };
  });
  return {
    findings,
    filesChecked: Number(summaryMatch?.[1] ?? 0),
    broken: Number(summaryMatch?.[2] ?? 0),
    externalSkipped: Number(summaryMatch?.[3] ?? 0),
  };
}

describe('M8 offline acceptance harness', () => {
  it('the offline guard records fetch DNS and socket attempts', () => {
    const guardLog = join(makeTempRoot(), 'guard.log');
    const script = [
      "const attempts = [];",
      "for (const attempt of [",
      "  () => globalThis.fetch('https://example.com/guard'),",
      "  () => require('node:dns').lookup('example.com', () => {}),",
      "  () => require('node:net').connect(9, '127.0.0.1'),",
      ']) {',
      '  try { attempt(); } catch (error) { attempts.push(error.message); }',
      '}',
      'console.log(attempts.length);',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--require', OFFLINE_GUARD_PATH, '-e', script],
      {
        env: { ...process.env, MDLC_ACCEPTANCE_GUARD_LOG: guardLog },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('3');
    expect(readGuardLog(guardLog).map((entry) => entry.api)).toEqual([
      'fetch',
      'dns.lookup',
      'net.connect',
    ]);
  });
});

describe('M8 offline real-docs-shaped acceptance', () => {
  it('v0.2 offline acceptance performs no fetch', () => {
    const repo = makeAcceptanceRepo();
    const result = runGuarded(repo, ['.']);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(EXPECTED_TEXT);
    expect(readGuardLog(repo.guardLog).filter((entry) => entry.api === 'fetch')).toEqual([]);
  });

  it('v0.2 offline acceptance performs no DNS or socket access', () => {
    const repo = makeAcceptanceRepo();
    const result = runGuarded(repo, ['.']);

    expect(result.status).toBe(1);
    const networkEntries = readGuardLog(repo.guardLog).filter(
      (entry) =>
        entry.api.startsWith('dns.') ||
        entry.api.startsWith('net.') ||
        entry.api.startsWith('tls.') ||
        entry.api.startsWith('node:http') ||
        entry.api.startsWith('node:https') ||
        entry.api.startsWith('dgram.'),
    );
    expect(networkEntries).toEqual([]);
  });

  it('v0.2 offline acceptance does not read or write the external cache', () => {
    const repo = makeAcceptanceRepo();
    const cacheHashBefore = hashFile(repo.cacheFile);
    const result = runGuarded(repo, ['--json', '.']);

    expect(result.status).toBe(1);
    const document = JSON.parse(result.stdout) as {
      external: { cache: Record<string, number | boolean> };
    };
    expect(document.external.cache).toEqual({
      enabled: false,
      hits: 0,
      misses: 0,
      stale: 0,
    });
    expect(readGuardLog(repo.guardLog)).toEqual([]);
    expect(hashFile(repo.cacheFile)).toBe(cacheHashBefore);
    expect(readdirSync(repo.cacheHome)).toEqual(['md-link-check']);
  });

  it('v0.2 offline acceptance preserves skipped external counts', () => {
    const repo = makeAcceptanceRepo();
    const text = runGuarded(repo, ['.']);
    const json = runGuarded(repo, ['--json', '.']);

    expect(text.stdout).toContain('3 external links skipped.');
    const document = JSON.parse(json.stdout) as {
      summary: { externalSkipped: number };
      external: {
        enabled: boolean;
        occurrences: number;
        skipped: number;
        distinctChecked: number;
        results: unknown[];
      };
    };
    expect(document.summary.externalSkipped).toBe(3);
    expect(document.external.enabled).toBe(false);
    expect(document.external.occurrences).toBe(3);
    expect(document.external.skipped).toBe(3);
    expect(document.external.distinctChecked).toBe(0);
    expect(document.external.results).toEqual([]);
    expect(readGuardLog(repo.guardLog)).toEqual([]);
  });

  it('v0.2 offline acceptance creates no tracked change', () => {
    const repo = makeAcceptanceRepo();
    expect(git(repo.root, ['status', '--porcelain'])).toBe('');
    const result = runGuarded(repo, ['.']);
    expect(result.status).toBe(1);
    expect(git(repo.root, ['status', '--porcelain'])).toBe('');
  });

  it('v0.2 offline acceptance creates no untracked file', () => {
    const repo = makeAcceptanceRepo();
    const filesBefore = treeSnapshot(repo.root);
    const result = runGuarded(repo, ['.']);
    expect(result.status).toBe(1);
    expect(git(repo.root, ['ls-files', '--others', '--exclude-standard'])).toBe('');
    expect(treeSnapshot(repo.root)).toEqual(filesBefore);
  });

  it('v0.2 offline acceptance produces deterministic text output', () => {
    const repo = makeAcceptanceRepo();
    const first = runGuarded(repo, ['.']);
    const second = runGuarded(repo, ['.']);

    expect(first).toEqual(second);
    expect(first.stdout).toBe(EXPECTED_TEXT);
    expect(first.stderr).toBe('');
    expect(readGuardLog(repo.guardLog)).toEqual([]);
  });

  it('v0.2 offline acceptance produces deterministic JSON output', () => {
    const repo = makeAcceptanceRepo();
    const first = runGuarded(repo, ['--json', '.']);
    const second = runGuarded(repo, ['--json', '.']);

    expect(first).toEqual(second);
    expect(first.stderr).toBe('');
    expect(readGuardLog(repo.guardLog)).toEqual([]);
  });

  it('v0.2 offline acceptance text and JSON findings are equivalent', () => {
    const repo = makeAcceptanceRepo();
    const text = runGuarded(repo, ['.']);
    const json = runGuarded(repo, ['--json', '.']);
    const parsedText = parseTextOutput(text.stdout);
    const document = JSON.parse(json.stdout) as {
      summary: { filesChecked: number; broken: number; externalSkipped: number };
      diagnostics: Array<{
        file: string;
        line: number;
        column: number;
        kind: string;
        target: string;
        reason: string;
      }>;
    };

    expect(document.summary).toEqual({
      filesChecked: parsedText.filesChecked,
      broken: parsedText.broken,
      externalSkipped: parsedText.externalSkipped,
    });
    expect(
      document.diagnostics.map(({ file, line, target, reason }) => ({
        file,
        line,
        target,
        reason,
      })),
    ).toEqual(parsedText.findings);
    expect(document.diagnostics).toEqual([
      {
        file: 'README.md',
        line: 3,
        column: 25,
        kind: 'link',
        target: 'docs/missing.md',
        reason: 'target does not exist',
      },
    ]);
  });
});

describe('M8 repository mutation guards', () => {
  it('checking a repository does not create files inside it', () => {
    const repo = makeAcceptanceRepo();
    const before = treeSnapshot(repo.root);
    const result = runGuarded(repo, ['.']);

    expect(result.status).toBe(1);
    expect(treeSnapshot(repo.root)).toEqual(before);
  });

  it('checking a repository does not modify existing files', () => {
    const repo = makeAcceptanceRepo();
    const before = treeSnapshot(repo.root);
    runGuarded(repo, ['--json', '.']);
    const after = treeSnapshot(repo.root);

    for (const [path, entry] of Object.entries(before)) {
      expect(after[path], `missing or changed path: ${path}`).toEqual(entry);
    }
  });

  it('default checking does not create the external cache', () => {
    const repo = makeAcceptanceRepo({ seedCache: false });
    expect(existsSync(repo.cacheFile)).toBe(false);
    const result = runGuarded(repo, ['.']);

    expect(result.status).toBe(1);
    expect(existsSync(repo.cacheFile)).toBe(false);
    expect(readdirSync(repo.cacheHome)).toEqual([]);
    expect(readGuardLog(repo.guardLog)).toEqual([]);
  });

  it('JSON output is written only to stdout unless the caller redirects it', () => {
    const repo = makeAcceptanceRepo();
    const before = treeSnapshot(repo.root);
    const result = runGuarded(repo, ['--json', '.']);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(treeSnapshot(repo.root)).toEqual(before);
  });

  it('action and CLI checks leave consumer fixtures unchanged', async () => {
    const consumer = makeTempRoot();
    writeFiles(consumer, { 'README.md': '# Consumer\n\n[guide](docs/guide.md)\n', 'docs/guide.md': '# Guide\n' });
    const before = treeSnapshot(consumer);
    const cacheHome = join(makeTempRoot(), 'cache');

    const action = await runAction({
      cwd: consumer,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'false' },
      cacheHome,
    });
    expect(action.status).toBe(0);
    expect(treeSnapshot(consumer)).toEqual(before);

    const cli = await runCli(['.'], { cwd: consumer, env: { ...process.env, XDG_CACHE_HOME: cacheHome } });
    expect(cli.status).toBe(0);
    expect(treeSnapshot(consumer)).toEqual(before);
    expect(existsSync(join(cacheHome, 'md-link-check'))).toBe(false);
  });
});
