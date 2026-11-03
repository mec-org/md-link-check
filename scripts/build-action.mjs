#!/usr/bin/env node
/**
 * Reproducible build for the checked-in GitHub Action entrypoint.
 *
 * The action wrapper (src/action.ts) and the CLI it calls are bundled into one
 * self-contained CommonJS file so a tagged checkout can run the action with no
 * `npm install`, no `node_modules`, no TypeScript build and no npm release.
 *
 * Usage:
 *   node scripts/build-action.mjs [--outfile <path>]
 *   node scripts/build-action.mjs --check [--artifact <path>]
 *
 * `--check` regenerates the bundle in a temporary directory and compares it
 * byte for byte with the committed artifact. It never writes into the
 * repository, so a stale artifact fails instead of being silently refreshed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = 'src/action.ts';
const defaultOutfile = 'action-dist/index.cjs';

const USAGE = `Usage: node scripts/build-action.mjs [--outfile <path>]
       node scripts/build-action.mjs --check [--artifact <path>]

  --outfile <path>   Write the generated bundle to this path instead of
                     ${defaultOutfile}.
  --check            Regenerate the bundle in a temporary directory and fail
                     when it differs from the committed artifact.
  --artifact <path>  Artifact to compare with --check (defaults to
                     ${defaultOutfile}).`;

class UsageError extends Error {}

function parseArguments(argv) {
  let check = false;
  let outfile = null;
  let artifact = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--outfile' || argument === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`missing value for ${argument}`);
      }
      index += 1;
      if (argument === '--outfile') {
        outfile = value;
      } else {
        artifact = value;
      }
      continue;
    }
    throw new UsageError(`unknown argument "${argument}"`);
  }

  if (check && outfile !== null) {
    throw new UsageError('--check cannot be combined with --outfile');
  }
  if (!check && artifact !== null) {
    throw new UsageError('--artifact requires --check');
  }

  return { check, outfile, artifact };
}

/**
 * Bundles the action from committed source. The output depends only on the
 * pinned esbuild version, the committed sources and the configuration below:
 * no timestamps, no random identifiers, no absolute paths, no source map and
 * stable LF line endings. `absWorkingDir` keeps module comments repo-relative
 * regardless of the caller's current directory.
 */
async function buildActionBundle(outfile) {
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'warning',
    sourcemap: false,
    treeShaking: true,
  });
}

function displayPath(path) {
  const relativePath = relative(repoRoot, path);
  return relativePath === '' || relativePath.startsWith('..') ? path : relativePath;
}

async function checkArtifact(artifact) {
  const artifactPath = resolve(artifact ?? join(repoRoot, defaultOutfile));
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'md-link-check-action-build-'));
  const generatedPath = join(temporaryDirectory, 'index.cjs');

  try {
    await buildActionBundle(generatedPath);
    const generated = readFileSync(generatedPath);

    let committed;
    try {
      committed = readFileSync(artifactPath);
    } catch {
      console.error(
        `action artifact is missing: ${displayPath(artifactPath)} has not been generated. ` +
          'Run "npm run build:action" and commit the result.',
      );
      process.exitCode = 1;
      return;
    }

    if (!committed.equals(generated)) {
      console.error(
        `action artifact is stale: ${displayPath(artifactPath)} differs from a fresh build of ` +
          `${entryPoint}. Run "npm run build:action" and commit the result.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`action entrypoint is reproducible: ${displayPath(artifactPath)}`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`build-action: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (options.check) {
    await checkArtifact(options.artifact);
    return;
  }

  const outfile = resolve(process.cwd(), options.outfile ?? defaultOutfile);
  await buildActionBundle(outfile);
  console.log(`built action entrypoint: ${displayPath(outfile)}`);
}

await main(process.argv.slice(2));
