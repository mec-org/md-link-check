#!/usr/bin/env node
/**
 * Capture the checked-in M17 v0.3 expected-byte fixtures from a built checkout.
 *
 * Usage:
 *   node test/m17-capture-fixtures.mjs --source <checkout> [--out <dir>]
 *
 * `<checkout>` must already be built (`npm ci --ignore-scripts && npm run
 * build`) and must contain `dist/cli.js` and `action-dist/index.cjs`. To
 * reproduce the committed v0.3 bytes from the original surface:
 *
 *   git worktree add /tmp/m17-v0.3.0 v0.3.0
 *   (cd /tmp/m17-v0.3.0 && npm ci --ignore-scripts && npm run build)
 *   node test/m17-capture-fixtures.mjs --source /tmp/m17-v0.3.0
 *
 * The script stages the fixture in a temporary directory, runs the CLI and the
 * committed action bundle, and writes the expected files. It is a provenance
 * tool, not a test: the test suite compares against the checked-in bytes.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(message) {
  if (message !== undefined) {
    console.error(`m17-capture-fixtures: ${message}`);
  }
  console.error(
    'Usage: node test/m17-capture-fixtures.mjs --source <checkout> [--out <dir>]',
  );
  process.exit(2);
}

function parseArguments(argv) {
  let source = repoRoot;
  let out = join(repoRoot, 'test', 'fixtures', 'm17-v03');
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source' || argument === '--out') {
      const value = argv[index + 1];
      if (value === undefined) {
        usage(`missing value for ${argument}`);
      }
      index += 1;
      if (argument === '--source') {
        source = resolve(value);
      } else {
        out = resolve(value);
      }
      continue;
    }
    usage(`unknown argument "${argument}"`);
  }
  return { source, out };
}

const { source, out } = parseArguments(process.argv.slice(2));
const fixture = join(source, 'test', 'fixtures', 'm16-multifile');
const cliPath = join(source, 'dist', 'cli.js');
const actionPath = join(source, 'action-dist', 'index.cjs');

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== options.expectedStatus) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}; ` +
        `expected ${options.expectedStatus}: ${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function baseEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('INPUT_') || key === 'GITHUB_OUTPUT' || key === 'GITHUB_STEP_SUMMARY') {
      delete environment[key];
    }
  }
  return environment;
}

function captureRun(cwd, args) {
  const result = run(process.execPath, args, {
    cwd,
    env: baseEnvironment(),
    expectedStatus: 1,
  });
  if (result.stderr !== '') {
    throw new Error(`unexpected stderr for ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout;
}

function captureAnnotations(fixtureRoot, expectedCliText, expectedCount) {
  const outputPath = join(stageRoot, 'github-output.txt');
  writeFileSync(outputPath, '');
  const action = run(process.execPath, [actionPath], {
    cwd: fixtureRoot,
    env: {
      ...baseEnvironment(),
      INPUT_PATHS: '.',
      GITHUB_OUTPUT: outputPath,
    },
    expectedStatus: 1,
  });
  if (action.stderr !== '') {
    throw new Error(`unexpected action stderr: ${action.stderr}`);
  }
  if (!action.stdout.startsWith(expectedCliText)) {
    throw new Error('action stdout does not begin with the unchanged CLI text');
  }
  const annotations = action.stdout.slice(expectedCliText.length);
  const lines = annotations.split('\n').filter((line) => line !== '');
  if (lines.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} annotations, got ${lines.length}`);
  }
  return { annotations, outputs: readFileSync(outputPath, 'utf8') };
}

if (!existsSync(cliPath) || !existsSync(actionPath)) {
  usage(`build ${source} first (npm ci --ignore-scripts && npm run build)`);
}

const stageRoot = mkdtempSync(join(tmpdir(), 'm17-capture-'));
try {
  const fixtureRoot = join(stageRoot, 'fixture');
  cpSync(fixture, fixtureRoot, { recursive: true });

  const cliText = captureRun(fixtureRoot, [cliPath, '--', '.']);
  const cliJson = captureRun(fixtureRoot, [cliPath, '--json', '--', '.']);
  const { annotations, outputs } = captureAnnotations(fixtureRoot, cliText, 16);

  const specialRoot = join(stageRoot, 'special');
  cpSync(join(source, 'test', 'fixtures', 'm11-special-values'), specialRoot, {
    recursive: true,
  });
  const specialCliText = captureRun(specialRoot, [cliPath, '--', '.']);
  const special = captureAnnotations(specialRoot, specialCliText, 10);

  const emptyRoot = join(stageRoot, 'empty');
  mkdirSync(emptyRoot, { recursive: true });
  const usage = run(process.execPath, [cliPath], {
    cwd: emptyRoot,
    env: baseEnvironment(),
    expectedStatus: 2,
  });
  const actionUsage = run(process.execPath, [actionPath], {
    cwd: emptyRoot,
    env: {
      ...baseEnvironment(),
      INPUT_PATHS: '.',
      INPUT_EXTERNAL: 'maybe',
    },
    expectedStatus: 2,
  });
  if (usage.stdout !== '' || actionUsage.stdout !== '') {
    throw new Error('usage errors must write nothing to stdout');
  }

  // The synthetic findings mirror `M17_EDGE_FINDINGS`; they reach the
  // formatter-only bounds that no real filesystem path can reach.
  const { formatAnnotations } = await import(
    pathToFileURL(join(source, 'dist', 'annotation.js')).href
  );
  const edgeFindings = [
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
  const edge = formatAnnotations(edgeFindings)
    .map((annotation) => `${annotation}\n`)
    .join('');

  const files = {
    'cli-text.stdout.txt': cliText,
    'cli-json.stdout.txt': cliJson,
    'action-annotations.txt': annotations,
    'action-outputs.txt': outputs,
    'cli-usage.stderr.txt': usage.stderr,
    'action-input-error.stderr.txt': actionUsage.stderr,
    'special-annotations.txt': special.annotations,
    'edge-annotations.txt': edge,
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(out, name), contents, 'utf8');
    console.log(`${name}: ${Buffer.byteLength(contents)} bytes`);
  }
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
