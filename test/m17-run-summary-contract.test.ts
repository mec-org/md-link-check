/**
 * M17 — the action wrapper's structured run-summary contract.
 *
 * These tests invoke the in-process wrapper seam directly and assert the
 * returned structured result against the frozen v0.3 fixture. The I/O sink
 * counts writes but deliberately keeps none of their text, so the counts and
 * findings under assertion cannot have been recovered by parsing printed
 * output.
 */
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction } from '../src/action-runner.js';
import type { BrokenLinkResult, CliIo, RunResult } from '../src/run.js';
import { withDefaultStepSummary } from './action-helpers.js';
import { makeTempRoot } from './helpers.js';
import { stageFixture } from './m16-helpers.js';
import { M17_EXIT_CODE, M17_FINDINGS, M17_SUMMARY } from './m17-helpers.js';

interface StructuredInvocation {
  readonly fixture: string;
  readonly result: RunResult;
  readonly stdoutWrites: number;
  readonly stderrWrites: number;
}

/** Invokes the wrapper from source with a write-only sink that retains no text. */
async function invokeStructured(): Promise<StructuredInvocation> {
  const fixture = stageFixture(makeTempRoot());
  let stdoutWrites = 0;
  let stderrWrites = 0;
  const io: CliIo = {
    writeOut: () => {
      stdoutWrites += 1;
    },
    writeError: () => {
      stderrWrites += 1;
    },
  };
  const result = await runAction(
    withDefaultStepSummary({ INPUT_PATHS: fixture, INPUT_EXTERNAL: 'false' }),
    io,
  );
  return { fixture, result, stdoutWrites, stderrWrites };
}

/** Projects absolute fixture findings onto the fixture-relative contract. */
function projectedFindings(
  fixture: string,
  findings: readonly BrokenLinkResult[],
): BrokenLinkResult[] {
  return findings.map(({ file, line, target, reason }) => ({
    file: relative(fixture, file),
    line,
    target,
    reason,
  }));
}

describe('M17 structured run-summary contract', () => {
  it('action wrapper receives all three summary counts', async () => {
    const { result } = await invokeStructured();

    expect(result.exitCode).toBe(M17_EXIT_CODE);
    expect(result.summary).toEqual(M17_SUMMARY);
    expect(result.summary?.filesChecked).toBe(4);
    expect(result.summary?.broken).toBe(16);
    expect(result.summary?.externalSkipped).toBe(4);
  });

  it('action wrapper receives every broken finding in CLI result order', async () => {
    const { fixture, result } = await invokeStructured();

    expect(result.diagnostics).toHaveLength(M17_FINDINGS.length);
    expect(projectedFindings(fixture, result.diagnostics)).toEqual(M17_FINDINGS);
  });

  it('each received finding retains file, line, target and reason', async () => {
    const { fixture, result } = await invokeStructured();
    const projected = projectedFindings(fixture, result.diagnostics);

    for (const finding of result.diagnostics) {
      expect(Object.keys(finding).sort()).toEqual(['file', 'line', 'reason', 'target']);
      expect(finding.file).not.toBe('');
      expect(Number.isInteger(finding.line)).toBe(true);
      expect(finding.line).toBeGreaterThanOrEqual(1);
      expect(finding.target).not.toBe('');
      expect(finding.reason).not.toBe('');
    }

    // The fixture deliberately preserves distinct values in every field: four
    // files, several source lines, distinct targets and both reason kinds.
    expect(new Set(projected.map((finding) => finding.file)).size).toBe(4);
    expect(new Set(projected.map((finding) => finding.line)).size).toBeGreaterThan(1);
    expect(new Set(projected.map((finding) => finding.target)).size).toBe(
      M17_FINDINGS.length,
    );
    expect(new Set(projected.map((finding) => finding.reason))).toEqual(
      new Set(['target does not exist', 'anchor does not exist']),
    );
  });

  it('needs no printed output to build the structured result', async () => {
    const { fixture, result, stdoutWrites, stderrWrites } = await invokeStructured();

    // The CLI did print, but the sink discarded every byte. The returned
    // object still carries the frozen counts and the complete ordered finding
    // list, so no consumer had to parse captured text to obtain them.
    expect(stdoutWrites).toBeGreaterThan(0);
    expect(stderrWrites).toBe(0);
    expect(result.summary).toEqual(M17_SUMMARY);
    expect(projectedFindings(fixture, result.diagnostics)).toEqual(M17_FINDINGS);
  });

  it('carries the counts and the findings in one result object', async () => {
    const { result } = await invokeStructured();

    // M21 adds the outcome classification alongside the counts and findings;
    // it is one result object, not a second parallel summary model.
    expect(Object.keys(result).sort()).toEqual([
      'diagnostics',
      'exitCode',
      'outcome',
      'summary',
    ]);
    expect(result.outcome).toBe('checked');
    expect(result.summary?.broken).toBe(result.diagnostics.length);
    expect(result.summary).toEqual(M17_SUMMARY);
  });
});
