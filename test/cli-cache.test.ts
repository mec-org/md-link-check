import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTERNAL_CACHE_FRESHNESS_MS } from '../src/cache.js';
import type { ExternalCheckOptions } from '../src/external.js';
import type { JsonReport } from '../src/report.js';
import { run, type CliIo } from '../src/run.js';
import { cachePathIn, writeCacheFile } from './external-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { startFixtureServer } from './server.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI with a private XDG cache home for the invocation. */
function runCli(
  cwd: string,
  args: readonly string[],
  xdgCacheHome: string = makeTempRoot(),
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, XDG_CACHE_HOME: xdgCacheHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

interface CapturedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI engine in-process with an injected temporary cache path. */
async function captureRun(
  args: readonly string[],
  cachePath: string,
  extra: ExternalCheckOptions = {},
): Promise<CapturedRun> {
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
  const { exitCode } = await run(args, io, { external: { cachePath, ...extra } });
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

/** The production default cache path beneath an XDG cache home. */
function defaultCachePath(xdgCacheHome: string): string {
  return join(xdgCacheHome, 'md-link-check', 'external-v1.json');
}

interface LegacyExternalResult {
  target: string;
  status: string;
  attempts: number;
  httpStatus?: number;
  finalUrl?: string;
  failureKind?: string;
}

function legacyResult(document: JsonReport): LegacyExternalResult | undefined {
  const result = document.external.results[0];
  if (result === undefined) {
    return undefined;
  }
  return {
    target: result.target,
    status: result.status,
    attempts: result.attempts,
    ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
    ...(result.finalUrl === undefined ? {} : { finalUrl: result.finalUrl }),
    ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
  };
}

describe('CLI persistent cache', () => {
  it('external CLI uses a fresh cache hit without contacting the server', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cacheHome = makeTempRoot();
      const target = server.urlFor('/ok');
      writeFiles(root, { 'README.md': `[web](${target})` });
      const cachePath = defaultCachePath(cacheHome);
      writeCacheFile(cachePath, {
        [target]: {
          checkedAt: new Date(Date.now() - 1_000).toISOString(),
          outcome: 'succeeded',
          httpStatus: 200,
          attempts: 1,
        },
      });

      const result = await runCli(root, ['--json', '--external', 'README.md'], cacheHome);
      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      const document = parseJson(result.stdout);
      expect(document.external.cache).toEqual({
        enabled: true,
        hits: 1,
        misses: 0,
        stale: 0,
      });
      expect(document.external.results[0]).toMatchObject({
        target,
        status: 'succeeded',
        attempts: 0,
        httpStatus: 200,
        source: 'cache',
      });
      expect(legacyResult(document)).toMatchObject({
        target,
        status: 'succeeded',
        attempts: 0,
        httpStatus: 200,
      });
    } finally {
      await server.close();
    }
  });

  it('external CLI refreshes a stale cache entry', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cacheHome = makeTempRoot();
      const target = server.urlFor('/ok');
      writeFiles(root, { 'README.md': `[web](${target})` });
      const cachePath = defaultCachePath(cacheHome);
      writeCacheFile(cachePath, {
        [target]: {
          checkedAt: new Date(Date.now() - EXTERNAL_CACHE_FRESHNESS_MS - 1).toISOString(),
          outcome: 'succeeded',
          httpStatus: 200,
          attempts: 1,
        },
      });

      const result = await runCli(root, ['--json', '--external', 'README.md'], cacheHome);
      expect(result.status).toBe(0);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
      const document = parseJson(result.stdout);
      expect(document.external.cache.stale).toBe(1);
      expect(document.external.results[0]?.source).toBe('network');
      const refreshed = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        entries?: Record<string, { checkedAt?: string }>;
      };
      expect(refreshed.entries?.[target]?.checkedAt).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('cached permanent failure exits 1', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cacheHome = makeTempRoot();
      const target = server.urlFor('/not-found');
      writeFiles(root, { 'README.md': `[web](${target})` });
      writeCacheFile(defaultCachePath(cacheHome), {
        [target]: {
          checkedAt: new Date(Date.now() - 1_000).toISOString(),
          outcome: 'permanent-failure',
          httpStatus: 404,
          attempts: 1,
        },
      });

      const result = await runCli(root, ['--external', 'README.md'], cacheHome);
      expect(result.status).toBe(1);
      expect(server.requests).toEqual([]);
      expect(result.stdout.split('\n')[0]).toBe(
        `README.md:1: ${target} — external HTTP 404`,
      );
      expect(result.stderr).toBe('');
    } finally {
      await server.close();
    }
  });

  it('cache corruption does not turn into exit 2', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cacheHome = makeTempRoot();
      const target = server.urlFor('/ok');
      writeFiles(root, { 'README.md': `[web](${target})` });
      const cachePath = defaultCachePath(cacheHome);
      mkdirSync(join(cachePath, '..'), { recursive: true });
      writeFileSync(cachePath, '{corrupted', 'utf8');

      const result = await runCli(root, ['--external', 'README.md'], cacheHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
      const recovered = JSON.parse(readFileSync(cachePath, 'utf8')) as {
        version?: number;
      };
      expect(recovered.version).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('usage errors remain exit 2 and do not touch the cache', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cachePath = cachePathIn(root);
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/ok')})` });

      const result = await captureRun(
        ['--json', '--external', '--bogus', join(root, 'README.md')],
        cachePath,
      );
      expect(result.exitCode).toBe(2);
      const document = parseJson(result.stdout);
      expect(document.error?.kind).toBe('usage');
      expect(document.external.cache).toEqual({
        enabled: false,
        hits: 0,
        misses: 0,
        stale: 0,
      });
      expect(server.requests).toEqual([]);

      const unreadableInput = await captureRun(
        ['--external', join(root, 'missing.md')],
        cachePath,
      );
      expect(unreadableInput.exitCode).toBe(2);
      expect(() => readFileSync(cachePath, 'utf8')).toThrow();
    } finally {
      await server.close();
    }
  });

  it('default CLI remains zero-network and does not touch the cache', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cachePath = cachePathIn(root);
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/ok')})` });

      const result = await captureRun(['--json', join(root, 'README.md')], cachePath);
      expect(result.exitCode).toBe(0);
      expect(server.requests).toEqual([]);
      const document = parseJson(result.stdout);
      expect(document.external.enabled).toBe(false);
      expect(document.external.cache.enabled).toBe(false);
      expect(() => readFileSync(cachePath, 'utf8')).toThrow();
    } finally {
      await server.close();
    }
  });

  it('JSON distinguishes cache and network provenance additively', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cachePath = cachePathIn(root);
      const target = server.urlFor('/ok');
      const file = join(root, 'README.md');
      writeFiles(root, { 'README.md': `[web](${target})` });

      const network = await captureRun(['--json', '--external', file], cachePath);
      expect(network.exitCode).toBe(0);
      const networkDocument = parseJson(network.stdout);
      expect(networkDocument.external.results[0]?.source).toBe('network');
      expect(networkDocument.external.cache.misses).toBe(1);

      const cached = await captureRun(['--json', '--external', file], cachePath);
      expect(cached.exitCode).toBe(0);
      const cachedDocument = parseJson(cached.stdout);
      expect(cachedDocument.external.results[0]?.source).toBe('cache');
      expect(cachedDocument.external.cache.hits).toBe(1);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);

      expect(legacyResult(cachedDocument)).toMatchObject({
        target,
        status: 'succeeded',
        attempts: 0,
        httpStatus: 200,
      });
      expect(cachedDocument.version).toBe(1);
      expect(cachedDocument.summary).toEqual({
        filesChecked: 1,
        broken: 0,
        externalSkipped: 0,
      });
    } finally {
      await server.close();
    }
  });

  it('cached diagnostics keep the file line target em dash reason shape', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cachePath = cachePathIn(root);
      const target = server.urlFor('/not-found');
      const file = join(root, 'README.md');
      writeFiles(root, { 'README.md': `# Project\n\n[web](${target})` });
      writeCacheFile(cachePath, {
        [target]: {
          checkedAt: new Date().toISOString(),
          outcome: 'permanent-failure',
          httpStatus: 404,
          attempts: 1,
        },
      });

      const result = await captureRun(['--external', file], cachePath);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.split('\n')[0]).toBe(
        `${file}:3: ${target} — external HTTP 404`,
      );
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('a cached result is identified without changing old JSON field names', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const cachePath = cachePathIn(root);
      const target = server.urlFor('/ok');
      const file = join(root, 'README.md');
      writeFiles(root, { 'README.md': `[web](${target})` });
      writeCacheFile(cachePath, {
        [target]: {
          checkedAt: new Date().toISOString(),
          outcome: 'succeeded',
          httpStatus: 200,
          finalUrl: target,
          attempts: 1,
        },
      });

      const result = await captureRun(['--json', '--external', file], cachePath);
      const document = parseJson(result.stdout);
      expect(Object.keys(document).sort()).toEqual([
        'diagnostics',
        'exitCode',
        'external',
        'ok',
        'summary',
        'version',
      ]);
      expect(Object.keys(document.external).sort()).toEqual([
        'brokenOccurrences',
        'cache',
        'distinctChecked',
        'enabled',
        'failed',
        'occurrences',
        'results',
        'skipped',
        'succeeded',
      ]);
      expect(legacyResult(document)).toEqual({
        target,
        status: 'succeeded',
        attempts: 0,
        httpStatus: 200,
        finalUrl: target,
      });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
