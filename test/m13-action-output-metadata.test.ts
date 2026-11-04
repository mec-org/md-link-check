import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUMMARY_OUTPUT_NAMES } from '../src/action-outputs.js';
import {
  ACTION_ARTIFACT_PATH,
  DOCUMENTED_ACTION_RUNTIME,
  REPO_ROOT,
  optionalScalar,
  readActionMetadata,
  requireMapping,
  requireScalar,
} from './action-helpers.js';

/** The complete M13 output set, sorted. */
const REQUIRED_OUTPUTS = ['broken', 'external-skipped', 'files-checked'];

function metadata() {
  return readActionMetadata();
}

function outputs() {
  return requireMapping(metadata().fields, 'outputs');
}

function output(name: string) {
  return requireMapping(outputs(), name);
}

function readmeText(): string {
  return readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
}

describe('M13 action output metadata', () => {
  it('action metadata declares files checked output', () => {
    expect(outputs().has(SUMMARY_OUTPUT_NAMES.filesChecked)).toBe(true);
    expect(requireScalar(output(SUMMARY_OUTPUT_NAMES.filesChecked), 'description')).not.toBe('');
  });

  it('action metadata declares broken output', () => {
    expect(outputs().has(SUMMARY_OUTPUT_NAMES.broken)).toBe(true);
    expect(requireScalar(output(SUMMARY_OUTPUT_NAMES.broken), 'description')).not.toBe('');
  });

  it('action metadata declares external skipped output', () => {
    expect(outputs().has(SUMMARY_OUTPUT_NAMES.externalSkipped)).toBe(true);
    expect(
      requireScalar(output(SUMMARY_OUTPUT_NAMES.externalSkipped), 'description'),
    ).not.toBe('');
  });

  it('action metadata describes each summary output', () => {
    expect(
      requireScalar(output(SUMMARY_OUTPUT_NAMES.filesChecked), 'description'),
    ).toMatch(/markdown files checked/i);
    expect(requireScalar(output(SUMMARY_OUTPUT_NAMES.broken), 'description')).toMatch(
      /broken-link findings/i,
    );
    expect(
      requireScalar(output(SUMMARY_OUTPUT_NAMES.externalSkipped), 'description'),
    ).toMatch(/http\(s\).*skipped/i);
  });

  it('action metadata retains paths input unchanged', () => {
    const paths = requireMapping(metadata().inputs, 'paths');

    expect(requireScalar(paths, 'required')).toBe('true');
    expect(requireScalar(paths, 'description')).toContain(
      'Newline-delimited files or directories to check',
    );
    expect(optionalScalar(paths, 'default')).toBeUndefined();
  });

  it('action metadata retains external input unchanged', () => {
    const external = requireMapping(metadata().inputs, 'external');

    expect(optionalScalar(external, 'default')).toBe('false');
    expect(optionalScalar(external, 'required') ?? 'false').toBe('false');
    expect(requireScalar(external, 'description')).toContain('HTTP(S) targets');
  });

  it('action metadata declares exactly the required M13 outputs', () => {
    expect([...outputs().keys()].sort()).toEqual(REQUIRED_OUTPUTS);
    for (const name of REQUIRED_OUTPUTS) {
      expect(requireScalar(output(name), 'description').length).toBeGreaterThan(0);
    }
  });

  it('action metadata output names match the publisher', () => {
    expect(Object.values(SUMMARY_OUTPUT_NAMES).sort()).toEqual(REQUIRED_OUTPUTS);
    expect([...outputs().keys()].sort()).toEqual(
      Object.values(SUMMARY_OUTPUT_NAMES).sort(),
    );
  });

  it('action metadata main still points to the committed entrypoint', () => {
    const { runs } = metadata();

    expect(requireScalar(runs, 'using')).toBe(DOCUMENTED_ACTION_RUNTIME);
    expect(requireScalar(runs, 'main')).toBe('action-dist/index.cjs');
    expect(existsSync(ACTION_ARTIFACT_PATH)).toBe(true);
  });

  it('README output names match action metadata', () => {
    const readme = readmeText();

    for (const name of [...outputs().keys()].sort()) {
      expect(readme).toContain(`\`${name}\``);
      expect(readme).toContain(`steps.links.outputs.${name}`);
    }

    // No output name is advertised by the README that the metadata omits.
    const advertised = new Set(
      [...readme.matchAll(/steps\.links\.outputs\.([A-Za-z0-9_.-]+)/g)].map(
        (match) => match[1] ?? '',
      ),
    );
    expect([...advertised].sort()).toEqual(REQUIRED_OUTPUTS);
  });
});
