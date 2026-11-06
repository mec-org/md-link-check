/**
 * M16 — README contract for the v0.3 surface.
 *
 * These assertions keep the README truthful about the annotations, the three
 * action outputs, the unchanged direct CLI, the exits and modes, and the tags
 * that actually exist. The repository has one release tag, `v0.2.0`; it marks
 * the v0.2 action and predates the v0.3 annotations and outputs, so the v0.3
 * action example must keep a `<tag>` placeholder until the owner creates a tag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import { REPO_ROOT } from './action-helpers.js';
import { M16_BASE_SHA } from './m16-helpers.js';

const README_PATH = join(REPO_ROOT, 'README.md');
const ACTION_METADATA_PATH = join(REPO_ROOT, 'action.yml');

function readmeText(): string {
  return readFileSync(README_PATH, 'utf8');
}

function metadataText(): string {
  return readFileSync(ACTION_METADATA_PATH, 'utf8');
}

/** Returns the body of one level-2 README section, without its heading. */
function section(title: string): string {
  const lines = readmeText().split('\n');
  const start = lines.findIndex((line) => line === `## ${title}`);
  if (start === -1) {
    throw new Error(`README has no "## ${title}" section`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** Every YAML code block in the README. */
function yamlBlocks(): string[] {
  return [...readmeText().matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? '',
  );
}

/** The action metadata's input names, in declaration order. */
function metadataInputNames(): string[] {
  const block = metadataText().split(/^inputs:\n/m)[1]?.split(/^outputs:\n/m)[0];
  if (block === undefined) {
    throw new Error('action.yml has no inputs block');
  }
  return [...block.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((match) => match[1] ?? '');
}

/** The action metadata's output names, in declaration order. */
function metadataOutputNames(): string[] {
  const block = metadataText().split(/^outputs:\n/m)[1]?.split(/^runs:\n/m)[0];
  if (block === undefined) {
    throw new Error('action.yml has no outputs block');
  }
  return [...block.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((match) => match[1] ?? '');
}

/** The `uses:` lines of the documented action example. */
function documentedUsesLines(): string[] {
  const actionBlock = yamlBlocks().find((block) =>
    block.includes('uses: mec-org/md-link-check@'),
  );
  if (actionBlock === undefined) {
    throw new Error('README has no action usage example');
  }
  return actionBlock
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:- )?uses: mec-org\/md-link-check@/.test(line));
}

describe('M16 README v0.3 contract', () => {
  it('README documents v0.3 annotations', () => {
    const readme = readmeText();
    const action = section('GitHub Action');

    expect(readme).toContain('one workflow annotation per broken-link finding');
    expect(action).toContain('one GitHub error annotation per broken-link finding');
    expect(action).toContain("in the CLI's result order");
    expect(action).toContain('escaped and bounded as GitHub workflow commands require');
    expect(action).toContain('supplement the CLI output');
    expect(action).toContain('skipped in the default offline mode are counted and produce no annotation');
    expect(action).toContain('A clean run emits no annotation');
    expect(action).toContain('never turned into broken-link annotations');
  });

  it('README documents v0.3 annotation bounds', () => {
    const action = section('GitHub Action');
    expect(action).toContain('at most 4,096 code points');
    expect(action).toContain('at most 8,192');
    expect(action).toContain('at most 16,384');
    expect(action).toContain('shortened value ending in `…`');
  });

  it('README documents every action output', () => {
    const readme = readmeText();
    const action = section('GitHub Action');

    expect(Object.values(SUMMARY_OUTPUT_NAMES).sort()).toEqual(
      ['broken', 'external-skipped', 'files-checked'].sort(),
    );
    for (const name of Object.values(SUMMARY_OUTPUT_NAMES)) {
      expect(readme).toContain(`\`${name}\``);
    }
    expect(action).toContain('decimal base-10 strings');
    expect(action).toContain('A clean or broken completed check publishes all three');
    expect(action).toContain('In the default offline mode `external-skipped` counts every skipped HTTP(S) occurrence');
    expect(action).toContain('`external-skipped` is `0` for a run whose external occurrences were all checked');
    expect(action).toContain('adds to `broken` as well as the annotations and the exit status');
  });

  it('README states direct CLI output is unchanged', () => {
    const readme = readmeText();
    const action = section('GitHub Action');
    expect(readme).toContain('the direct CLI keeps its text output, JSON schema, options, offline default and exit codes unchanged');
    expect(action).toContain('The action prints the CLI\'s diagnostics and summaries unchanged');
    expect(action).toContain('Direct CLI runs emit no workflow command and need no GitHub Actions environment');
  });

  it('README documents exits 0 1 and 2', () => {
    const exits = section('Exit codes');
    expect(exits).toContain('`0`: checking completed and no broken targets were found');
    expect(exits).toContain('`1`: checking completed and at least one broken target was found');
    expect(exits).toContain('`2`: usage error');

    const action = section('GitHub Action');
    expect(action).toContain('`0` when checking completed with no broken targets');
    expect(action).toContain('`1` when at least one broken target was reported');
    expect(action).toContain('`2` for a usage error');
    expect(action).toContain('Annotations and outputs do not determine the exit status');
  });

  it('README documents offline default and external opt-in', () => {
    const readme = readmeText();
    expect(readme).toContain('Omitting the flag keeps a run fully offline');
    expect(readme).toContain('`external` (optional)');
    expect(readme).toContain('The default is `false`');
    expect(readme).toContain('The default run is fully offline');
    expect(section('GitHub Action')).toContain('external: false');
  });

  it('README action inputs match action metadata', () => {
    expect(metadataInputNames()).toEqual(['paths', 'external']);
    const metadata = metadataText();
    expect(metadata).toMatch(/^ {2}paths:\n(?: {4}.*\n)*? {4}required: true$/m);
    expect(metadata).toMatch(/^ {2}external:\n(?: {4}.*\n)*? {4}default: "false"$/m);

    const action = section('GitHub Action');
    expect(action).toContain('`paths` (required)');
    expect(action).toContain('`external` (optional)');
    expect(action).toContain('The action has exactly two inputs');
  });

  it('README output names match action metadata', () => {
    expect(metadataOutputNames().sort()).toEqual(
      Object.values(SUMMARY_OUTPUT_NAMES).sort(),
    );
    expect(metadataOutputNames()).toHaveLength(3);
  });

  it('README release-tag statements match tags that exist', () => {
    const readme = readmeText();
    // M23 brought these statements in line with the tags that actually exist:
    // the owner-approved v0.3.0 tag now exists, while no v0.4 tag does.
    expect(readme).toContain('The `v0.2.0` tag exists');
    expect(readme).toContain('The `v0.3.0` tag exists');
    expect(readme).not.toContain('no v0.3 release tag exists yet');
    expect(readme).toContain('no v0.4 release tag exists yet');
    expect(readme).not.toContain('no release tag exists yet');
    // The v0.2.0 tag predates annotations and outputs, so it must not be
    // presented as the v0.3 action surface.
    expect(readme).toContain('The v0.2.0 tag does not contain the v0.3 annotations or outputs');
    expect(readme).not.toMatch(/v0\.4\.0/);
    for (const line of documentedUsesLines()) {
      expect(line).not.toMatch(/@v0\.2\.0$/);
    }
    expect(M16_BASE_SHA).toMatch(/^[0-9a-f]{40}$/);
  });

  it('README uses a placeholder when no applicable release tag exists', () => {
    const readme = readmeText();
    const usesLines = documentedUsesLines();
    expect(usesLines).toHaveLength(1);
    expect(usesLines[0]).toMatch(/^uses: mec-org\/md-link-check@<tag>$/);
    // No v0.4 release tag exists, so the v0.4 surface stays a placeholder.
    expect(readme).toContain('`<tag>` is a placeholder for the v0.4 surface');
  });

  it('README does not claim npm publication', () => {
    const readme = readmeText();
    expect(readme).toContain('not published to npm');
    expect(readme).toContain('no npm release');
    expect(readme).not.toMatch(/\bnpm (?:install|i|add) md-link-check\b/);
    expect(readme).not.toMatch(/\bavailable on npm\b/i);
    expect(readme).not.toMatch(/\bis published to npm\b/i);
  });

  it('README retains release and tag decisions for the owner', () => {
    const readme = readmeText();
    expect(readme).toContain('The v0.3 release and tag decisions remain the owner\'s');
    expect(readme).toContain('the release and tag decision remains the owner\'s');
    expect(readme).toContain('Create a v0.4 tag only after the owner\'s release decision');
    expect(readme).toContain('M16 creates no tag or release');
  });

  it('README retains zero runtime dependencies as the v0.3 behavior', () => {
    const readme = readmeText();
    expect(readme).toContain('still with no runtime dependencies');
    expect(readme).toContain('The package has no runtime dependencies');
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { private?: boolean; dependencies?: Record<string, string> };
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
