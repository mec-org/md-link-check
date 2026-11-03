import { describe, expect, it } from 'vitest';
import { readActionArtifactText, readScopeReport } from './action-helpers.js';

describe('M9 action artifact and scope', () => {
  it('checked-in action artifact contains the structured result contract', () => {
    const artifact = readActionArtifactText();

    // The bundle is generated from the action runner and the run seam, so a
    // stale artifact cannot silently lack the structured-result code.
    expect(artifact).toContain('// src/action-runner.ts');
    expect(artifact).toContain('async function runAction(');
    expect(artifact).toContain('NO_DIAGNOSTICS');
    expect(artifact).toContain('function brokenLinkResults(diagnostics)');
    expect(artifact).toContain('({ file, line, target, reason })');
    expect(artifact).toContain('Object.freeze({ file, line, target, reason })');
  });

  it('M9 changes no path under github metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/'))).toEqual([]);
  });

  it('M9 changes no path under project metadata', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.project/'))).toEqual([]);
  });

  it('M9 adds no workflow', async () => {
    const report = await readScopeReport();

    expect(report.changed.filter((path) => path.startsWith('.github/workflows/'))).toEqual([]);
  });
});
