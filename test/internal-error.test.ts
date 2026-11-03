import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { JsonReport } from '../src/report.js';
import { run, type CliIo, type RunResult } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';

// Simulate failures escaping the checking layer. The run() boundary must turn
// both the synchronous throw and the rejected promise into structured results.
vi.mock('../src/checker.js', () => ({
  checkMarkdown: () => {
    throw new Error('simulated local read failure');
  },
  checkMarkdownWithExternal: () =>
    Promise.reject(new Error('simulated external check failure')),
}));

interface CapturedRun {
  exitCode: number;
  diagnostics: RunResult['diagnostics'];
  stdout: string;
  stderr: string;
}

async function captureRun(args: readonly string[]): Promise<CapturedRun> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
  };
  const { exitCode, diagnostics } = await run(args, io);
  return { exitCode, diagnostics, stdout, stderr };
}

function parseJson(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

function fixture(): string {
  const root = makeTempRoot();
  writeFiles(root, { 'README.md': '# Clean' });
  return join(root, 'README.md');
}

describe('internal failures stay inside the structured CLI result', () => {
  it('text mode reports an internal failure without a stack trace', async () => {
    const result = await captureRun([fixture()]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('internal error: simulated local read failure');
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain('node:');
    expect(result.stderr).not.toContain('Usage:');
  });

  it('JSON mode reports an internal failure as one structured document', async () => {
    const result = await captureRun(['--json', fixture()]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().startsWith('{')).toBe(true);
    expect(result.stdout.trim().endsWith('}')).toBe(true);
    const document = parseJson(result.stdout);
    expect(document.ok).toBe(false);
    expect(document.exitCode).toBe(2);
    expect(document.error).toEqual({
      kind: 'internal',
      message: 'simulated local read failure',
    });
    expect(document.summary).toEqual({ filesChecked: 0, broken: 0, externalSkipped: 0 });
    expect(document.diagnostics).toEqual([]);
    expect(document.external.enabled).toBe(false);
    expect(document.external.distinctChecked).toBe(0);
    expect(document.external.results).toEqual([]);
  });

  it('a rejected async external check is reported as an internal failure', async () => {
    const result = await captureRun(['--json', '--external', fixture()]);

    expect(result.exitCode).toBe(2);
    const document = parseJson(result.stdout);
    expect(document.error).toEqual({
      kind: 'internal',
      message: 'simulated external check failure',
    });
    expect(document.external.enabled).toBe(true);
    expect(document.external.distinctChecked).toBe(0);
    expect(document.external.brokenOccurrences).toBe(0);
    expect(document.external.results).toEqual([]);
  });

  it('usage errors remain distinguishable from internal failures', async () => {
    const result = await captureRun(['--json', '--bogus', fixture()]);

    expect(result.exitCode).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(parseJson(result.stdout).error?.kind).toBe('usage');
  });

  it('internal error is not represented as a broken-link result', async () => {
    const text = await captureRun([fixture()]);
    const json = await captureRun(['--json', fixture()]);

    expect(text.exitCode).toBe(2);
    expect(text.diagnostics).toEqual([]);
    expect(json.exitCode).toBe(2);
    expect(json.diagnostics).toEqual([]);
    expect(parseJson(json.stdout).diagnostics).toEqual([]);
    expect(parseJson(json.stdout).error?.kind).toBe('internal');
  });
});
