/**
 * M15 — direct CLI compatibility (no action surface involved).
 *
 * Split from the single M15 suite for reviewable diffs; every test name is
 * unchanged. Shared setup lives in `test/m15-helpers.ts`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  describe,
  expect,
  it,
} from 'vitest';
import { makeTempRoot } from './helpers.js';
import { runCli } from './action-helpers.js';
import { startFixtureServer } from './server.js';
import type {
  SummaryOutputValues,
} from './m15-helpers.js';
import {
  SEPARATOR,
  actionCliText,
  captureSourceAction,
  cliSummary,
  createOutputPath,
  externalSummary,
  linksDocument,
  writeMarkdown,
} from './m15-helpers.js';

describe('M15 direct CLI compatibility', () => {
  it('direct default CLI remains offline', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/ok')]));
    const fetchLog = join(root, 'cli-fetch.log');
    const result = await runCli(['--', file], {
      cwd: root,
      env: {
        ...process.env,
        XDG_CACHE_HOME: join(root, 'cli-cache'),
        MD_LINK_CHECK_ACTION_FETCH_LOG: fetchLog,
      },
    });

    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(cliSummary(1, 0, 1));
      expect(existsSync(fetchLog)).toBe(false);
      expect(server.requests).toEqual([]);
      expect(result.stdout).not.toContain('::error ');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('direct external CLI behavior remains unchanged', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    const result = await runCli(['--external', '--', file], {
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cli-cache') },
    });
    const action = await captureSourceAction({
      INPUT_PATHS: file,
      INPUT_EXTERNAL: 'true',
    });

    try {
      expect(result.status).toBe(1);
      expect(actionCliText(action)).toBe(result.stdout);
      expect(action.stderr).toBe(result.stderr);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('direct CLI emits no workflow annotation', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    const result = await runCli(['--external', '--', file], {
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cli-cache') },
    });

    try {
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('::error ');
      expect(result.stdout).not.toContain('::warning ');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('direct CLI writes no action output', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const file = writeMarkdown(root, linksDocument([server.urlFor('/not-found')]));
    const outputPath = createOutputPath(root, 'keep=sentinel\n');
    const result = await runCli(['--external', '--', file], {
      cwd: root,
      env: {
        ...process.env,
        XDG_CACHE_HOME: join(root, 'cli-cache'),
        GITHUB_OUTPUT: outputPath,
      },
    });

    try {
      expect(result.status).toBe(1);
      expect(readFileSync(outputPath, 'utf8')).toBe('keep=sentinel\n');
      expect(result.stdout).not.toMatch(/^(?:files-checked|broken|external-skipped)=/m);
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('direct CLI text remains byte-for-byte unchanged', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    const result = await runCli(['--external', '--', file], {
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cli-cache') },
    });

    try {
      expect(result.stdout).toBe(
        `${file}:3: ${target}${SEPARATOR}external HTTP 404\n` +
          cliSummary(1, 1, 0) +
          externalSummary({
            occurrences: 1,
            distinctChecked: 1,
            succeeded: 0,
            failed: 1,
            brokenOccurrences: 1,
          }),
      );
      expect(result.stderr).toBe('');
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('direct CLI JSON fields remain unchanged', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const target = server.urlFor('/not-found');
    const file = writeMarkdown(root, linksDocument([target]));
    const result = await runCli(['--json', '--external', '--', file], {
      cwd: root,
      env: { ...process.env, XDG_CACHE_HOME: join(root, 'cli-cache') },
    });

    try {
      const document = JSON.parse(result.stdout) as {
        version: number;
        ok: boolean;
        exitCode: number;
        summary: SummaryOutputValues;
        external: {
          enabled: boolean;
          occurrences: number;
          skipped: number;
          distinctChecked: number;
          succeeded: number;
          failed: number;
          brokenOccurrences: number;
          results: Array<{ target: string; status: string; failureKind: string }>;
        };
        diagnostics: Array<{ target: string; reason: string }>;
      };

      expect(document.version).toBe(1);
      expect(document.ok).toBe(false);
      expect(document.exitCode).toBe(1);
      expect(document.summary).toEqual({
        filesChecked: 1,
        broken: 1,
        externalSkipped: 0,
      });
      expect(document.external.enabled).toBe(true);
      expect(document.external.occurrences).toBe(1);
      expect(document.external.skipped).toBe(0);
      expect(document.external.distinctChecked).toBe(1);
      expect(document.external.succeeded).toBe(0);
      expect(document.external.failed).toBe(1);
      expect(document.external.brokenOccurrences).toBe(1);
      expect(document.external.results).toHaveLength(1);
      expect(document.external.results[0]).toMatchObject({
        target,
        status: 'failed',
        failureKind: 'http',
        httpStatus: 404,
        attempts: 1,
      });
      expect(document.diagnostics).toHaveLength(1);
      expect(document.diagnostics[0]).toMatchObject({
        file,
        line: 3,
        kind: 'link',
        target,
        reason: 'external HTTP 404',
      });
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('direct CLI exits remain 0 1 and 2', async () => {
    const root = makeTempRoot();
    const clean = writeMarkdown(root, '# Clean\n');
    const broken = writeMarkdown(root, linksDocument(['missing.md']), 'broken.md');
    const cleanResult = await runCli(['--', clean], { cwd: root });
    const brokenResult = await runCli(['--', broken], { cwd: root });
    const usageResult = await runCli([], { cwd: root });

    expect(cleanResult.status).toBe(0);
    expect(brokenResult.status).toBe(1);
    expect(usageResult.status).toBe(2);
  });
});

