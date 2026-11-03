import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Suite-wide no-real-network guard.
 *
 * Every test runs with a private, temporary XDG cache home so no test can read
 * or write a developer's real external-result cache. The built-in fetch is
 * wrapped so any HTTP(S) request to a non-loopback host fails immediately: a
 * test that accidentally targets a public endpoint fails instead of touching
 * the network or depending on DNS.
 */
const cacheHome = mkdtempSync(join(tmpdir(), 'md-link-check-test-cache-'));
process.env.XDG_CACHE_HOME = cacheHome;

const originalFetch = globalThis.fetch;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  // Any address in the IPv4 loopback range 127.0.0.0/8.
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function requestUrl(input: string | URL | Request): URL {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return new URL(input.href);
  }
  return new URL(input.url);
}

globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = requestUrl(input);
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!isLoopbackHostname(url.hostname)) {
      throw new Error(
        `test fetch guard: refused non-loopback request to ${url.origin}; ` +
          'network tests must use a loopback fixture server',
      );
    }
  }
  return originalFetch(input as string | URL, init);
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
  rmSync(cacheHome, { recursive: true, force: true });
});
