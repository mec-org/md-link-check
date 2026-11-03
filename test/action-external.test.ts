import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAction } from './action-helpers.js';
import { makeTempRoot, writeFiles } from './helpers.js';
import { startFixtureServer } from './server.js';

function writeExternalFixture(root: string, url: string): void {
  writeFiles(root, {
    'README.md': `# Consumer\n\n[external](${url})\n`,
  });
}

describe('action external checking', () => {
  it('external false performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/ok'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'false' },
        fetchLog: join(root, 'fetch.log'),
      });

      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(existsSync(join(root, 'fetch.log'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('omitted external input performs no fetch', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/ok'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md' },
        fetchLog: join(root, 'fetch.log'),
      });

      expect(result.status).toBe(0);
      expect(server.requests).toEqual([]);
      expect(existsSync(join(root, 'fetch.log'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('external true checks a loopback target', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/ok'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        fetchLog: join(root, 'fetch.log'),
      });

      expect(result.status).toBe(0);
      expect(server.requests.map((request) => request.path)).toEqual(['/ok']);
      expect(readFileSync(join(root, 'fetch.log'), 'utf8')).toContain('/ok');
    } finally {
      await server.close();
    }
  });

  it('external success through the action exits 0', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/ok'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('External checks: 1 occurrence, 1 distinct target checked');
      expect(result.stdout).toContain('1 succeeded, 0 failed');
    } finally {
      await server.close();
    }
  });

  it('external failure through the action exits 1', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/not-found'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('external HTTP 404');
    } finally {
      await server.close();
    }
  });

  it('external usage error remains exit 2', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/ok'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: '', INPUT_EXTERNAL: 'true' },
        fetchLog: join(root, 'fetch.log'),
      });

      expect(result.status).toBe(2);
      expect(server.requests).toEqual([]);
      expect(existsSync(join(root, 'fetch.log'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('external action invocation preserves bounded transport behavior', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/always-flaky'));

    try {
      const result = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain('external HTTP 500 after 2 attempts');
      expect(
        server.requests.filter((request) => request.path === '/always-flaky').length,
      ).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('external action invocation uses the existing cache contract', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    const cacheHome = join(root, 'cache-home');
    writeExternalFixture(root, server.urlFor('/ok'));

    try {
      const first = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        cacheHome,
      });
      const requestsAfterFirst = server.requests.length;

      const second = await runAction({
        cwd: root,
        inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
        cacheHome,
      });

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(requestsAfterFirst).toBe(1);
      expect(server.requests.length).toBe(requestsAfterFirst);
      expect(
        existsSync(join(cacheHome, 'md-link-check', 'external-v1.json')),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('external action tests contact only loopback', async () => {
    const root = makeTempRoot();
    writeFiles(root, {
      'README.md': '# Consumer\n\n[public](https://example.com/public-page)\n',
    });
    const fetchLog = join(root, 'fetch.log');

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
      fetchLog,
    });

    // The child-process guard refuses the public request before it can reach
    // the network; the CLI reports the resulting network failure as a finding.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('external network failure after 2 attempts');
    const log = readFileSync(fetchLog, 'utf8');
    expect(log).toContain('refused https://example.com/public-page');
    expect(log).not.toMatch(/^allowed /m);
  });

  it('external action test server and sockets close cleanly', async () => {
    const server = await startFixtureServer();
    const root = makeTempRoot();
    writeExternalFixture(root, server.urlFor('/ok'));

    const result = await runAction({
      cwd: root,
      inputs: { INPUT_PATHS: 'README.md', INPUT_EXTERNAL: 'true' },
    });

    expect(result.status).toBe(0);
    await server.close();
    expect(server.closed).toBe(true);
  });
});
