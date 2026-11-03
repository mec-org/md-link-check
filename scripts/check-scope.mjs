#!/usr/bin/env node
/**
 * Scope guard for M7 instrumentation.
 *
 * The authorized base for the tagged-ref action milestone is pinned below. The
 * check reports every path changed relative to that base, then fails when a
 * change touches `.github/` or `.project/`, which the milestone may not modify.
 *
 * A full checkout contains the base commit and uses Git directly. GitHub's
 * default shallow CI checkout does not fetch history, so when the base commit
 * is unavailable the check falls back to a committed manifest of SHA-256
 * content hashes for the two protected directories at that same base commit.
 * Both modes prove that no protected file was added, removed or modified.
 *
 * Usage:
 *   node scripts/check-scope.mjs [--json] [--base <sha>]
 *
 * `--json` prints `{ base, mode, changed, violations }` for repository-local
 * tests.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Base commit authorized for the tagged-ref action milestone. */
export const AUTHORIZED_BASE_SHA = '572d43da06a68c8af0cf61cde5a597c7fa56e8d5';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_MANIFEST_PATH = join(repoRoot, 'test', 'm7-base-metadata.json');
const PROTECTED_DIRECTORIES = ['.github', '.project'];

const USAGE = `Usage: node scripts/check-scope.mjs [--json] [--base <sha>]`;

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function outputLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function baseCommitAvailable(base) {
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists paths changed between the base commit and the current working tree,
 * including staged, unstaged and untracked files. Renames are reported as a
 * deletion plus an addition so a path moved out of a protected directory is
 * still visible.
 */
function gitChangedPaths(base) {
  const paths = new Set();
  for (const path of outputLines(git(['diff', '--name-only', '--no-renames', base]))) {
    paths.add(path);
  }
  for (const path of outputLines(git(['ls-files', '--others', '--exclude-standard']))) {
    paths.add(path);
  }
  return [...paths].sort();
}

function walk(directory, displayDirectory, files) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const displayPath = `${displayDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(absolutePath, displayPath, files);
    } else if (entry.isFile()) {
      files.push({ absolutePath, displayPath });
    }
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Compares the protected directories with the committed base manifest. Any
 * added, deleted or modified protected file is reported as a changed path.
 */
function baselineChangedPaths(base) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(BASELINE_MANIFEST_PATH, 'utf8'));
  } catch {
    throw new Error(
      `base commit ${base} is unavailable in this checkout and ${BASELINE_MANIFEST_PATH} ` +
        'cannot be read',
    );
  }

  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.base !== base ||
    manifest.algorithm !== 'sha256' ||
    manifest.paths === null ||
    typeof manifest.paths !== 'object'
  ) {
    throw new Error(
      `base commit ${base} is unavailable in this checkout and the baseline manifest ` +
        `does not describe that base with SHA-256 hashes`,
    );
  }

  const expected = manifest.paths;
  const actual = new Map();
  for (const directory of PROTECTED_DIRECTORIES) {
    const files = [];
    walk(join(repoRoot, directory), directory, files);
    for (const file of files) {
      actual.set(file.displayPath, hashFile(file.absolutePath));
    }
  }

  const changed = new Set();
  for (const [path, hash] of Object.entries(expected)) {
    if (actual.get(path) !== hash) {
      changed.add(path);
    }
  }
  for (const path of actual.keys()) {
    if (!(path in expected)) {
      changed.add(path);
    }
  }
  return [...changed].sort();
}

/** Paths forbidden by the M7 scope: repository metadata and workflows. */
export function findScopeViolations(paths) {
  return paths.filter(
    (path) =>
      path === '.github' ||
      path.startsWith('.github/') ||
      path === '.project' ||
      path.startsWith('.project/'),
  );
}

/** Computes the scope report for a base revision. */
export function inspectScope(base) {
  const mode = baseCommitAvailable(base) ? 'git-diff' : 'baseline-manifest';
  let changed;
  if (mode === 'git-diff') {
    changed = gitChangedPaths(base);
  } else {
    if (base !== AUTHORIZED_BASE_SHA) {
      throw new Error(
        `base commit ${base} is unavailable in this checkout and no baseline manifest ` +
          'describes it',
      );
    }
    changed = baselineChangedPaths(base);
  }
  return { base, mode, changed, violations: findScopeViolations(changed) };
}

function parseArguments(argv) {
  let json = false;
  let base = AUTHORIZED_BASE_SHA;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--base') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('missing value for --base');
      }
      index += 1;
      base = value;
      continue;
    }
    throw new Error(`unknown argument "${argument}"`);
  }

  return { json, base };
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`check-scope: ${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  let report;
  try {
    report = inspectScope(options.base);
  } catch (error) {
    const detail = error instanceof Error && error.message !== '' ? error.message : 'git failed';
    console.error(`check-scope: ${detail}`);
    process.exitCode = 2;
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.violations.length === 0) {
    console.log(
      `scope check passed (${report.mode}): no change under .github/ or .project/ ` +
        `relative to ${report.base}`,
    );
  } else {
    console.error(
      `scope check failed (${report.mode}): changes under protected metadata ` +
        `relative to ${report.base}:`,
    );
    for (const violation of report.violations) {
      console.error(`  ${violation}`);
    }
  }

  process.exitCode = report.violations.length === 0 ? 0 : 1;
}

// Perform the repository check only when this file is executed directly.
// Importing the module to reach the pure matchers must have no side effects, so
// a test or tool can use `findScopeViolations`/`inspectScope` safely even when
// history is shallow or the default base commit is unavailable.
const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main(process.argv.slice(2));
}
