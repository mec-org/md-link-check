import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTION_ARTIFACT_PATH,
  ACTION_METADATA_PATH,
  DOCUMENTED_ACTION_RUNTIME,
  REPO_ROOT,
  isGitTracked,
  optionalScalar,
  readActionMetadata,
  readReadmeActionExampleInputs,
  requireMapping,
  requireScalar,
  type ParsedActionMetadata,
} from './action-helpers.js';

function metadata(): ParsedActionMetadata {
  return readActionMetadata();
}

function readmeText(): string {
  return readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
}

describe('root action metadata', () => {
  it('root action metadata exists', () => {
    expect(existsSync(ACTION_METADATA_PATH)).toBe(true);
    const parsed = metadata();
    expect(requireScalar(parsed.fields, 'name')).toBe('md-link-check');
    expect(requireScalar(parsed.fields, 'description').length).toBeGreaterThan(0);
  });

  it('action metadata declares paths input', () => {
    expect(metadata().inputs.has('paths')).toBe(true);
  });

  it('paths input is required', () => {
    const paths = requireMapping(metadata().inputs, 'paths');
    expect(requireScalar(paths, 'required')).toBe('true');
    expect(requireScalar(paths, 'description').length).toBeGreaterThan(0);
  });

  it('action metadata declares external input', () => {
    expect(metadata().inputs.has('external')).toBe(true);
  });

  it('external input defaults to false', () => {
    const external = requireMapping(metadata().inputs, 'external');
    expect(optionalScalar(external, 'default')).toBe('false');
    expect(optionalScalar(external, 'required') ?? 'false').toBe('false');
  });

  it('action metadata uses the documented JavaScript runtime', () => {
    const { runs } = metadata();
    expect(requireScalar(runs, 'using')).toBe(DOCUMENTED_ACTION_RUNTIME);
    expect(requireScalar(runs, 'using')).toMatch(/^node\d+$/);
    expect(readmeText()).toContain(`\`${DOCUMENTED_ACTION_RUNTIME}\``);
  });

  it('action metadata main points to the checked-in entrypoint', () => {
    const { runs } = metadata();
    expect(requireScalar(runs, 'main')).toBe('action-dist/index.cjs');
    expect(existsSync(ACTION_ARTIFACT_PATH)).toBe(true);
    expect(isGitTracked('action-dist/index.cjs')).toBe(true);
  });

  it('action metadata main is repository-relative', () => {
    const main = requireScalar(metadata().runs, 'main');
    expect(main).not.toBe('');
    expect(isAbsolute(main)).toBe(false);
    expect(main.startsWith('.')).toBe(false);
    expect(main.includes('\\')).toBe(false);
    expect(metadata().text).not.toContain(REPO_ROOT);
    expect(resolve(REPO_ROOT, main)).toBe(ACTION_ARTIFACT_PATH);
  });

  it('action metadata main cannot escape the action repository', () => {
    const main = requireScalar(metadata().runs, 'main');
    expect(main.split('/')).not.toContain('..');
    const resolved = resolve(REPO_ROOT, main);
    expect(resolved === REPO_ROOT || resolved.startsWith(`${REPO_ROOT}${sep}`)).toBe(true);
  });

  it('action metadata declares no pre or post action', () => {
    const { runs, fields } = metadata();
    expect(runs.has('pre')).toBe(false);
    expect(runs.has('pre-if')).toBe(false);
    expect(runs.has('post')).toBe(false);
    expect(runs.has('post-if')).toBe(false);
    expect(requireScalar(runs, 'using')).not.toBe('composite');
    expect(requireScalar(runs, 'using')).not.toBe('docker');

    // Workflow-only keys must not appear in action metadata.
    for (const key of ['on', 'jobs', 'steps', 'permissions', 'defaults', 'env', 'concurrency']) {
      expect(fields.has(key)).toBe(false);
    }
    expect([...metadata().inputs.keys()].sort()).toEqual(['external', 'paths']);
  });

  it('README action example matches metadata inputs', () => {
    const declared = [...metadata().inputs.keys()].sort();
    expect(readReadmeActionExampleInputs()).toEqual(declared);
  });
});
