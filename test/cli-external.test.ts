import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExternalCheckOptions, FetchLike } from '../src/external.js';
import type { JsonReport } from '../src/report.js';
import { run, type CliIo } from '../src/run.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { startFixtureServer } from './server.js';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built CLI asynchronously so the in-process fixture can reply. Each
 * invocation gets its own temporary XDG cache home so no test touches a real
 * user cache; cache tests pass a shared home to exercise persistence.
 */
function runCli(
  cwd: string,
  args: readonly string[],
  cacheHome: string = makeTempRoot(),
): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
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

/** Runs the CLI engine in-process with injectable external options. */
async function captureRun(
  args: readonly string[],
  external: ExternalCheckOptions = {},
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
  const { exitCode } = await run(args, io, {
    external: { cachePath: join(makeTempRoot(), 'external-v1.json'), ...external },
  });
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): JsonReport {
  return JSON.parse(stdout) as JsonReport;
}

describe('CLI argument surface', () => {
  it('accepts --external with one input path', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = await runCli(root, ['--external', 'README.md']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('accepts --external with --json', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = await runCli(root, ['--json', '--external', 'README.md']);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout).external.enabled).toBe(true);
  });

  it('preserves existing invocations without --external', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[guide](docs/guide.md)',
      'docs/guide.md': '# Guide',
    });

    const result = await runCli(root, ['README.md']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Checked 1 file: 0 broken targets, 0 external links skipped.\n');
  });

  it('repeated --external is accepted idempotently', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = await runCli(root, ['--external', '--external', 'README.md']);
    expect(result.status).toBe(0);
  });

  it('unknown option with --external exits 2', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = await runCli(root, ['--external', '--bogus', 'README.md']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown option "--bogus"');
  });

  it('no input paths with --external exits 2', async () => {
    const root = makeTempRoot();

    const result = await runCli(root, ['--external']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no input paths');
    expect(result.stderr).toContain('Usage: md-link-check [--json] [--external] <path...>');
  });

  it('help documents opt-in external checking', async () => {
    const root = makeTempRoot();

    const result = await runCli(root, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--external');
    expect(result.stdout).toContain('opt-in');
    expect(result.stdout).toContain('network');
    expect(result.stdout).toContain('md-link-check [--json] [--external] [--] <path...>');
  });

  it('usage errors do not perform fetch', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': `[web](${server.urlFor('/ok')})`,
      });

      const result = await runCli(root, ['--external', '--bogus', 'README.md']);
      expect(result.status).toBe(2);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('JSON usage error does not claim external checks ran', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/ok')})` });

      const result = await runCli(root, ['--json', '--external', '--bogus', 'README.md']);
      expect(result.status).toBe(2);
      const document = parseJson(result.stdout);
      expect(document.exitCode).toBe(2);
      expect(document.error?.kind).toBe('usage');
      expect(document.external.distinctChecked).toBe(0);
      expect(document.external.results).toEqual([]);
      expect(document.external.brokenOccurrences).toBe(0);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('default offline behavior with a reachable server', () => {
  it('default mode performs no fetch', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': `[ok](${server.urlFor('/ok')}) and [missing](${server.urlFor('/not-found')})`,
      });

      const result = await runCli(root, ['README.md']);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('Checked 1 file: 0 broken targets, 2 external links skipped.\n');
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('default mode counts each supported external form as skipped', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': [
          `[inline](${server.urlFor('/ok')})`,
          `![image](${server.urlFor('/ok')})`,
          `[ref][site]`,
          `<a href="${server.urlFor('/ok')}">html</a>`,
          `<img src="${server.urlFor('/ok')}">`,
          '',
          `[site]: ${server.urlFor('/ok')}`,
        ].join('\n'),
      });

      const result = await runCli(root, ['--json', 'README.md']);
      expect(result.status).toBe(0);
      const document = parseJson(result.stdout);
      expect(document.summary.externalSkipped).toBe(5);
      expect(document.external.enabled).toBe(false);
      expect(document.external.occurrences).toBe(5);
      expect(document.external.skipped).toBe(5);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('default mode exit status is unaffected by unreachable external targets', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': `[broken](${server.urlFor('/not-found')}) and [down](${server.urlFor('/drop')})`,
      });

      const result = await runCli(root, ['README.md']);
      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('external success against a loopback server', () => {
  it('external mode accepts a final successful response', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/ok')})` });

      const result = await runCli(root, ['--external', 'README.md']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Checked 1 file: 0 broken targets, 0 external links skipped.');
      expect(result.stdout).toContain(
        'External checks: 1 occurrence, 1 distinct target checked (1 succeeded, 0 failed), 0 broken occurrences.',
      );
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
    } finally {
      await server.close();
    }
  });

  it('external mode follows a redirect to a successful response', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/redirect')})` });

      const result = await runCli(root, ['--json', '--external', 'README.md']);
      expect(result.status).toBe(0);
      const document = parseJson(result.stdout);
      expect(document.external.succeeded).toBe(1);
      expect(document.external.results[0]?.finalUrl).toBe(server.urlFor('/ok'));
      expect(server.requests.map((request) => request.path)).toEqual(['/redirect', '/ok']);
    } finally {
      await server.close();
    }
  });

  it('external mode retries a retryable response and then succeeds', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/flaky')})` });

      const result = await runCli(root, ['--json', '--external', 'README.md']);
      expect(result.status).toBe(0);
      const document = parseJson(result.stdout);
      expect(document.external.results[0]).toMatchObject({
        target: server.urlFor('/flaky'),
        status: 'succeeded',
        attempts: 2,
        httpStatus: 200,
      });
      expect(server.requests.filter((request) => request.path === '/flaky')).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('does not send URL fragments in the HTTP request', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/ok')}#section)` });

      const result = await runCli(root, ['--external', 'README.md']);
      expect(result.status).toBe(0);
      expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
    } finally {
      await server.close();
    }
  });

  it('local broken links still exit 1 when an external check succeeds', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': `[local](missing.md) and [web](${server.urlFor('/ok')})`,
      });

      const result = await runCli(root, ['--external', 'README.md']);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('missing.md — target does not exist');
      expect(result.stdout).toContain('0 external links skipped');
    } finally {
      await server.close();
    }
  });

  it('successful external checks do not produce diagnostics', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/ok')})` });

      const result = await runCli(root, ['--external', 'README.md']);
      expect(result.stdout).not.toContain('—');
      expect(result.status).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('external HTTP failures against a loopback server', () => {
  it('external mode reports a terminal 404', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/not-found')})` });

      const result = await runCli(root, ['--external', 'README.md']);
      expect(result.status).toBe(1);
      expect(result.stdout.split('\n')[0]).toBe(
        `README.md:1: ${server.urlFor('/not-found')} — external HTTP 404`,
      );
      expect(server.requests).toEqual([{ method: 'GET', path: '/not-found' }]);
    } finally {
      await server.close();
    }
  });

  it('external mode retries for a server error', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/always-flaky')})` });

      const result = await runCli(root, ['--json', '--external', 'README.md']);
      expect(result.status).toBe(1);
      const document = parseJson(result.stdout);
      expect(document.external.results[0]).toMatchObject({
        status: 'failed',
        attempts: 2,
        httpStatus: 500,
        failureKind: 'http',
      });
      expect(document.diagnostics[0]?.reason).toBe('external HTTP 500 after 2 attempts');
      expect(server.requests.filter((request) => request.path === '/always-flaky')).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('external mode reports a network failure after retry exhaustion', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[web](${server.urlFor('/drop')})` });

      const result = await runCli(root, ['--json', '--external', 'README.md']);
      expect(result.status).toBe(1);
      const document = parseJson(result.stdout);
      expect(document.external.results[0]).toMatchObject({
        status: 'failed',
        attempts: 2,
        failureKind: 'network',
      });
      expect(document.diagnostics[0]?.reason).toBe(
        'external network failure after 2 attempts',
      );
    } finally {
      await server.close();
    }
  });

  it('timeout and network failures exit 1 rather than 2', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': `[slow](${server.urlFor('/slow')}) and [down](${server.urlFor('/drop')})`,
      });

      const result = await captureRun(['--external', join(root, 'README.md')], { timeoutMs: 25 });
      expect(result.exitCode).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe('deduplication and occurrence reporting', () => {
  it('checks each distinct external target once', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const target = server.urlFor('/ok');
      // URL normalization lowercases the scheme, so these two spellings share
      // one distinct request target.
      const variant = target.replace(/^http:/, 'HTTP:');
      writeFiles(root, {
        'README.md': [`[one](${target})`, `[two](${variant})`, `<img src="${target}">`].join(
          '\n',
        ),
      });

      const result = await runCli(root, ['--json', '--external', 'README.md']);
      expect(result.status).toBe(0);
      const document = parseJson(result.stdout);
      expect(document.external.occurrences).toBe(3);
      expect(document.external.distinctChecked).toBe(1);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('a failed distinct target reports every source occurrence', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      const target = server.urlFor('/not-found');
      writeFiles(root, {
        'README.md': [`[one](${target})`, `[two](${target})`].join('\n'),
      });

      const result = await runCli(root, ['--external', 'README.md']);
      expect(result.status).toBe(1);
      const lines = result.stdout.trimEnd().split('\n');
      expect(lines[0]).toBe(`README.md:1: ${target} — external HTTP 404`);
      expect(lines[1]).toBe(`README.md:2: ${target} — external HTTP 404`);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('external failure does not suppress local diagnostics', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, {
        'README.md': `[local](missing.md) and [web](${server.urlFor('/not-found')})`,
      });

      const result = await runCli(root, ['--json', '--external', 'README.md']);
      expect(result.status).toBe(1);
      const document = parseJson(result.stdout);
      expect(document.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
        'missing.md',
        server.urlFor('/not-found'),
      ]);
    } finally {
      await server.close();
    }
  });
});

describe('timeouts against a loopback server', () => {
  it('external mode reports a timeout after retry exhaustion', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[slow](${server.urlFor('/slow')})` });

      const result = await captureRun(['--external', join(root, 'README.md')], { timeoutMs: 25 });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        `README.md:1: ${server.urlFor('/slow')} — external request timed out after 2 attempts`,
      );
      expect(server.requests.filter((request) => request.path === '/slow')).toHaveLength(2);
    } finally {
      await server.close();
    }
    expect(server.closed).toBe(true);
  });

  it('timeout tests close the local server cleanly', async () => {
    const server = await startFixtureServer();
    try {
      const root = makeTempRoot();
      writeFiles(root, { 'README.md': `[slow](${server.urlFor('/slow')})` });

      await captureRun(['--json', '--external', join(root, 'README.md')], { timeoutMs: 25 });
    } finally {
      await server.close();
    }
    expect(server.closed).toBe(true);
  });
});

describe('exit-code matrix', () => {
  const okFetch: FetchLike = () => Promise.resolve(new Response(null, { status: 200 }));
  const missingFetch: FetchLike = () => Promise.resolve(new Response(null, { status: 404 }));

  it('clean local input without external checking exits 0', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '# Clean' });

    const result = await captureRun([join(root, 'README.md')]);
    expect(result.exitCode).toBe(0);
  });

  it('broken local input without external checking exits 1', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[missing](missing.md)' });

    const result = await captureRun([join(root, 'README.md')]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('missing.md — target does not exist');
  });

  it('clean external check exits 0', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/ok)' });

    const result = await captureRun(['--external', join(root, 'README.md')], {
      fetch: okFetch,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('—');
  });

  it('broken external check exits 1', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/missing)' });

    const result = await captureRun(['--external', join(root, 'README.md')], {
      fetch: missingFetch,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('external HTTP 404');
  });

  it('local and external failures together exit 1', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '[local](missing.md) and [web](https://example.com/missing)',
    });

    const result = await captureRun(['--external', join(root, 'README.md')], {
      fetch: missingFetch,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('missing.md — target does not exist');
    expect(result.stdout).toContain('external HTTP 404');
  });

  it('usage error with external flag exits 2', async () => {
    const result = await captureRun(['--json', '--external']);
    expect(result.exitCode).toBe(2);
    expect(parseJson(result.stdout).error?.kind).toBe('usage');
  });

  it('external mode changes exit status only through reported broken links', async () => {
    const root = makeTempRoot();
    writeFiles(root, { 'README.md': '[web](https://example.com/link)' });
    const file = join(root, 'README.md');

    const success = await captureRun(['--json', '--external', file], { fetch: okFetch });
    const failure = await captureRun(['--json', '--external', file], { fetch: missingFetch });
    const successDocument = parseJson(success.stdout);
    const failureDocument = parseJson(failure.stdout);

    expect(success.exitCode).toBe(0);
    expect(successDocument.diagnostics).toEqual([]);
    expect(failure.exitCode).toBe(1);
    expect(failureDocument.diagnostics).toHaveLength(1);
    expect(success.exitCode).toBe(successDocument.diagnostics.length === 0 ? 0 : 1);
    expect(failure.exitCode).toBe(failureDocument.diagnostics.length === 0 ? 0 : 1);
  });
});
