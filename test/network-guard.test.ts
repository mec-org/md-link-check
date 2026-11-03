import { describe, expect, it } from 'vitest';
import { startFixtureServer } from './server.js';

describe('suite-level no-real-network guard', () => {
  it('test fetch guard rejects non-loopback requests', () => {
    expect(() => {
      void globalThis.fetch('https://example.com/');
    }).toThrow(/test fetch guard: refused non-loopback request/);
  });

  it('unexpected external hostname fails the test', () => {
    expect(() => {
      void globalThis.fetch('http://not-a-loopback-host.invalid/page');
    }).toThrow(/non-loopback/);
  });

  it('test fetch guard allows loopback fixture requests', async () => {
    const server = await startFixtureServer();
    try {
      expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
      const response = await globalThis.fetch(server.urlFor('/ok'));
      expect(response.status).toBe(200);
      await response.body?.cancel();
    } finally {
      await server.close();
      expect(server.closed).toBe(true);
    }
  });

  it('network tests bind only to loopback', async () => {
    const server = await startFixtureServer();
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await server.close();
    }
  });

  it('network tests use ephemeral ports', async () => {
    const first = await startFixtureServer();
    const second = await startFixtureServer();
    try {
      const firstPort = Number(new URL(first.url).port);
      const secondPort = Number(new URL(second.url).port);
      expect(firstPort).toBeGreaterThan(0);
      expect(secondPort).toBeGreaterThan(0);
      expect(firstPort).not.toBe(secondPort);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('test suite does not depend on DNS or public endpoints', () => {
    // The guard rejects every non-loopback HTTP(S) request before the built-in
    // fetch runs, so a test cannot resolve DNS for a public endpoint.
    for (const target of [
      'https://example.com/a',
      'http://example.org/b',
      'https://public.example.net/c',
    ]) {
      expect(() => {
        void globalThis.fetch(target);
      }).toThrow(/non-loopback/);
    }
  });
});
