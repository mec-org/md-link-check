import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkMarkdown, checkMarkdownWithExternal } from '../src/checker.js';
import {
  EXTERNAL_CACHE_CLOCK_SKEW_MS,
  EXTERNAL_CACHE_FRESHNESS_MS,
  EXTERNAL_CACHE_MAX_ENTRIES,
  EXTERNAL_CACHE_MAX_FILE_BYTES,
  EXTERNAL_CACHE_MAX_URL_LENGTH,
  EXTERNAL_CACHE_SCHEMA_VERSION,
  externalCacheKey,
  isFreshExternalCacheEntry,
  loadExternalCache,
  resolveExternalCachePath,
  saveExternalCache,
  type ExternalCacheEntry,
} from '../src/cache.js';
import {
  checkExternalOccurrences,
} from '../src/external.js';
import {
  cachePathIn,
  markdownFile,
  networkFetch,
  occurrences,
  statusFetch,
  timeoutFetch,
  waitFor,
} from './external-helpers.js';
import { makeTempRoot } from './helpers.js';
import { startFixtureServer, type FixtureServer } from './server.js';

const NOW = 1_700_000_000_000;

interface CacheDocument {
  version?: unknown;
  entries?: Record<string, Record<string, unknown>>;
}

function readCache(path: string): CacheDocument {
  return JSON.parse(readFileSync(path, 'utf8')) as CacheDocument;
}

function entryFixture(overrides: Partial<ExternalCacheEntry> = {}): ExternalCacheEntry {
  return {
    checkedAt: NOW - 1_000,
    outcome: 'succeeded',
    httpStatus: 200,
    attempts: 1,
    ...overrides,
  };
}

function writeEntries(path: string, entries: Record<string, unknown>, version: unknown = 1): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version, entries }, null, 2)}\n`, 'utf8');
}

function temporaryFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.tmp'));
  } catch {
    return [];
  }
}

const servers: FixtureServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await server.close();
      expect(server.closed).toBe(true);
    }
  }
});

async function fixtureServer(): Promise<FixtureServer> {
  const server = await startFixtureServer();
  servers.push(server);
  return server;
}

function totalGated(all: readonly FixtureServer[]): number {
  return all.reduce((sum, server) => sum + server.gated, 0);
}

describe('cache location', () => {
  it('uses XDG_CACHE_HOME when it is an absolute path', () => {
    expect(resolveExternalCachePath({ XDG_CACHE_HOME: '/var/cache/user' }, 'linux')).toBe(
      '/var/cache/user/md-link-check/external-v1.json',
    );
  });

  it('falls back to the home dot-cache directory', () => {
    expect(resolveExternalCachePath({}, 'linux', '/home/owner')).toBe(
      '/home/owner/.cache/md-link-check/external-v1.json',
    );
    expect(resolveExternalCachePath({}, 'darwin', '/Users/owner')).toBe(
      '/Users/owner/.cache/md-link-check/external-v1.json',
    );
  });

  it('ignores a relative XDG_CACHE_HOME and uses the home fallback', () => {
    expect(
      resolveExternalCachePath({ XDG_CACHE_HOME: 'relative/cache' }, 'linux', '/home/owner'),
    ).toBe('/home/owner/.cache/md-link-check/external-v1.json');
  });

  it('uses LOCALAPPDATA on Windows', () => {
    expect(
      resolveExternalCachePath(
        { LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local' },
        'win32',
      ),
    ).toBe('C:\\Users\\owner\\AppData\\Local\\md-link-check\\external-v1.json');
  });

  it('disables the cache when no safe user cache home exists', () => {
    expect(resolveExternalCachePath({}, 'linux', '')).toBeNull();
    expect(resolveExternalCachePath({}, 'linux', 'relative/home')).toBeNull();
    expect(resolveExternalCachePath({}, 'win32')).toBeNull();
    expect(
      resolveExternalCachePath({ LOCALAPPDATA: 'relative\\AppData' }, 'win32'),
    ).toBeNull();
  });

  it('documents a fixed cache file name and schema version', () => {
    const path = resolveExternalCachePath({ XDG_CACHE_HOME: '/tmp/cache' }, 'linux');
    expect(path?.endsWith('md-link-check/external-v1.json')).toBe(true);
    expect(EXTERNAL_CACHE_SCHEMA_VERSION).toBe(1);
  });
});

describe('cache key', () => {
  it('excludes the URL fragment', () => {
    expect(externalCacheKey('https://example.test/page#one')).toBe(
      'https://example.test/page',
    );
  });

  it('keeps scheme, host, effective port, path and query distinct', () => {
    expect(externalCacheKey('http://example.test/a')).not.toBe(
      externalCacheKey('https://example.test/a'),
    );
    expect(externalCacheKey('https://example.test/a?x=1')).not.toBe(
      externalCacheKey('https://example.test/a?x=2'),
    );
    expect(externalCacheKey('https://example.test:444/a')).not.toBe(
      externalCacheKey('https://example.test/a'),
    );
  });

  it('does not produce a cache key for credential-bearing or non-HTTP URLs', () => {
    expect(externalCacheKey('https://owner:secret@example.test/a')).toBeNull();
    expect(externalCacheKey('mailto:owner@example.test')).toBeNull();
    expect(externalCacheKey('not a url')).toBeNull();
  });

  it('rejects keys longer than the documented ceiling', () => {
    const long = `https://example.test/${'a'.repeat(EXTERNAL_CACHE_MAX_URL_LENGTH)}`;
    expect(externalCacheKey(long)).toBeNull();
  });
});

describe('cache freshness', () => {
  it('fresh entry is used within the documented freshness period', () => {
    expect(
      isFreshExternalCacheEntry(entryFixture({ checkedAt: NOW - 1_000 }), NOW, EXTERNAL_CACHE_FRESHNESS_MS),
    ).toBe(true);
  });

  it('entry exactly at the freshness boundary follows the documented rule', () => {
    expect(
      isFreshExternalCacheEntry(
        entryFixture({ checkedAt: NOW - EXTERNAL_CACHE_FRESHNESS_MS }),
        NOW,
        EXTERNAL_CACHE_FRESHNESS_MS,
      ),
    ).toBe(true);
    expect(
      isFreshExternalCacheEntry(
        entryFixture({ checkedAt: NOW - EXTERNAL_CACHE_FRESHNESS_MS - 1 }),
        NOW,
        EXTERNAL_CACHE_FRESHNESS_MS,
      ),
    ).toBe(false);
  });

  it('future-dated entry cannot remain fresh indefinitely', () => {
    expect(
      isFreshExternalCacheEntry(
        entryFixture({ checkedAt: NOW + EXTERNAL_CACHE_CLOCK_SKEW_MS + 1 }),
        NOW,
        EXTERNAL_CACHE_FRESHNESS_MS,
      ),
    ).toBe(false);
    expect(
      isFreshExternalCacheEntry(
        entryFixture({ checkedAt: NOW + EXTERNAL_CACHE_CLOCK_SKEW_MS }),
        NOW,
        EXTERNAL_CACHE_FRESHNESS_MS,
      ),
    ).toBe(true);
  });
});

describe('cache document recovery', () => {
  it('missing cache is treated as empty', () => {
    const root = makeTempRoot();
    const loaded = loadExternalCache(cachePathIn(root));
    expect(loaded.state).toBe('missing');
    expect(loaded.entries.size).toBe(0);
  });

  it('malformed cache is treated as empty and recovered', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {}, 1);
    writeFileSync(cachePath, 'not json at all', 'utf8');
    expect(loadExternalCache(cachePath).state).toBe('malformed');

    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/recovered']),
      { fetch, cachePath },
    );
    expect(outcome.results[0]?.status).toBe('succeeded');
    expect(calls).toHaveLength(1);
    const document = readCache(cachePath);
    expect(document.version).toBe(EXTERNAL_CACHE_SCHEMA_VERSION);
    expect(Object.keys(document.entries ?? {})).toEqual(['https://example.test/recovered']);
  });

  it('truncated cache is treated as empty and recovered', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {});
    writeFileSync(cachePath, '{"version":1,"entries":{', 'utf8');
    expect(loadExternalCache(cachePath).state).toBe('malformed');

    const { fetch } = statusFetch([200]);
    await checkExternalOccurrences(occurrences(['https://example.test/truncated']), {
      fetch,
      cachePath,
    });
    expect(readCache(cachePath).version).toBe(1);
  });

  it('wrong cache schema version is invalidated', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {}, 2);
    expect(loadExternalCache(cachePath).state).toBe('wrong-version');

    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/version']),
      { fetch, cachePath },
    );
    expect(calls).toHaveLength(1);
    expect(outcome.results[0]?.status).toBe('succeeded');
    expect(readCache(cachePath).version).toBe(1);
  });

  it('wrong-type cache document is treated as empty', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {});
    writeFileSync(cachePath, '[]', 'utf8');
    expect(loadExternalCache(cachePath).state).toBe('malformed');
  });

  it('oversized cache is rejected without loading unbounded data', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    mkdirSync(join(cachePath, '..'), { recursive: true });
    writeFileSync(cachePath, Buffer.alloc(EXTERNAL_CACHE_MAX_FILE_BYTES + 1, 0x78));
    expect(EXTERNAL_CACHE_MAX_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(loadExternalCache(cachePath).state).toBe('oversized');

    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/oversized']),
      { fetch, cachePath },
    );
    expect(calls).toHaveLength(1);
    expect(outcome.results[0]?.status).toBe('succeeded');
    expect(statSync(cachePath).size).toBeLessThan(EXTERNAL_CACHE_MAX_FILE_BYTES);
  });

  it('invalid cache entry is ignored without discarding valid bounded entries', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {
      'https://example.test/valid': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
      'https://example.test/invalid': {
        checkedAt: 'not a date',
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const loaded = loadExternalCache(cachePath);
    expect(loaded.state).toBe('ok');
    expect([...loaded.entries.keys()]).toEqual(['https://example.test/valid']);

    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/valid', 'https://example.test/invalid']),
      { fetch, cachePath, now: () => NOW },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://example.test/invalid');
    expect(outcome.cache.hits).toBe(1);
    expect(outcome.cache.misses).toBe(1);
    expect(Object.keys(readCache(cachePath).entries ?? {}).sort()).toEqual([
      'https://example.test/invalid',
      'https://example.test/valid',
    ]);
  });

  it('unreadable cache does not crash external checking', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    mkdirSync(cachePath, { recursive: true });
    expect(loadExternalCache(cachePath).state).toBe('unreadable');

    const { fetch } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/unreadable']),
      { fetch, cachePath },
    );
    expect(outcome.results[0]?.status).toBe('succeeded');
    expect(outcome.cache.enabled).toBe(true);
  });

  it('invalid entries with unsupported shapes are ignored', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {
      'https://example.test/ok': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
      'https://example.test/status': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 500,
        attempts: 1,
      },
      'https://example.test/outcome': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'timeout',
        attempts: 1,
      },
      'https://example.test/attempts': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 0,
      },
      'https://example.test/credentials': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        finalUrl: 'https://owner:secret@example.test/x',
        attempts: 1,
      },
      'https://example.test/fragment#frag': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
      [`https://example.test/${'a'.repeat(EXTERNAL_CACHE_MAX_URL_LENGTH)}`]: {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const loaded = loadExternalCache(cachePath);
    expect([...loaded.entries.keys()]).toEqual([
      'https://example.test/ok',
      'https://example.test/credentials',
    ]);
    expect(loaded.entries.get('https://example.test/credentials')?.finalUrl).toBe(
      'https://example.test/x',
    );
  });
});

describe('cache writes', () => {
  it('cache write uses atomic replacement', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    mkdirSync(join(cachePath, '..'), { recursive: true });
    writeFileSync(cachePath, '{"version":1,"entries":{}}\n', 'utf8');

    const entries = new Map<string, ExternalCacheEntry>([
      ['https://example.test/atomic', entryFixture()],
    ]);
    expect(saveExternalCache(cachePath, entries, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(true);
    expect(readCache(cachePath).entries).toHaveProperty('https://example.test/atomic');
    expect(temporaryFiles(join(cachePath, '..'))).toEqual([]);
  });

  it('temporary cache file is cleaned after a failed write', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    mkdirSync(cachePath, { recursive: true });

    const entries = new Map<string, ExternalCacheEntry>([
      ['https://example.test/fail', entryFixture({ checkedAt: NOW })],
    ]);
    expect(saveExternalCache(cachePath, entries, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(false);
    expect(temporaryFiles(join(cachePath, '..'))).toEqual([]);
  });

  it('cache write failure does not create a broken-link diagnostic', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    mkdirSync(cachePath, { recursive: true });

    const file = markdownFile(root, '[ok](https://example.test/ok)');
    const { fetch, calls } = statusFetch([200]);
    const result = await checkMarkdownWithExternal([file], { fetch, cachePath });
    expect(calls).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.external.succeeded).toBe(1);
  });

  it('excess entries are pruned to the documented ceiling', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const entries = new Map<string, ExternalCacheEntry>();
    for (let index = 0; index < EXTERNAL_CACHE_MAX_ENTRIES + 5; index += 1) {
      entries.set(`https://example.test/e${index}`, entryFixture({ checkedAt: NOW }));
    }
    expect(EXTERNAL_CACHE_MAX_ENTRIES).toBe(10_000);
    expect(saveExternalCache(cachePath, entries, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(true);
    const document = readCache(cachePath);
    expect(Object.keys(document.entries ?? {})).toHaveLength(EXTERNAL_CACHE_MAX_ENTRIES);
  });

  it('cache loading caps the number of inspected entries', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const entries: Record<string, unknown> = {};
    for (let index = 0; index < EXTERNAL_CACHE_MAX_ENTRIES + 5; index += 1) {
      entries[`https://example.test/e${index}`] = {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      };
    }
    writeEntries(cachePath, entries);
    expect(loadExternalCache(cachePath).entries.size).toBe(EXTERNAL_CACHE_MAX_ENTRIES);
  });

  it('cache serialization is deterministic', () => {
    const root = makeTempRoot();
    const firstPath = join(root, 'first', 'external-v1.json');
    const secondPath = join(root, 'second', 'external-v1.json');
    const entries = new Map<string, ExternalCacheEntry>([
      ['https://example.test/b', entryFixture()],
      ['https://example.test/a', entryFixture()],
    ]);
    expect(saveExternalCache(firstPath, entries, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(true);
    const reversed = new Map([...entries.entries()].reverse());
    expect(saveExternalCache(secondPath, reversed, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(true);
    expect(readFileSync(firstPath, 'utf8')).toBe(readFileSync(secondPath, 'utf8'));
  });

  it('stale entries are pruned on write', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const entries = new Map<string, ExternalCacheEntry>([
      ['https://example.test/fresh', entryFixture({ checkedAt: NOW })],
      [
        'https://example.test/stale',
        entryFixture({ checkedAt: NOW - EXTERNAL_CACHE_FRESHNESS_MS - 1 }),
      ],
    ]);
    expect(saveExternalCache(cachePath, entries, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(true);
    expect(Object.keys(readCache(cachePath).entries ?? {})).toEqual([
      'https://example.test/fresh',
    ]);
  });

  it('the cache file byte ceiling is enforced', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const entries = new Map<string, ExternalCacheEntry>();
    const longFinalUrl = `https://example.test/${'a'.repeat(EXTERNAL_CACHE_MAX_URL_LENGTH - 100)}`;
    for (let index = 0; index < 1_000; index += 1) {
      entries.set(`https://example.test/e${index}`, entryFixture({ finalUrl: longFinalUrl }));
    }
    expect(saveExternalCache(cachePath, entries, NOW, EXTERNAL_CACHE_FRESHNESS_MS)).toBe(true);
    expect(statSync(cachePath).size).toBeLessThanOrEqual(EXTERNAL_CACHE_MAX_FILE_BYTES);
  });
});

describe('cacheable outcomes and cache reads', () => {
  it('fresh successful cache hit performs no fetch', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {
      'https://example.test/ok': {
        checkedAt: new Date(NOW - 1_000).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        finalUrl: 'https://example.test/ok',
        attempts: 1,
      },
    });
    let fetchCalls = 0;
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/ok']),
      {
        fetch: () => {
          fetchCalls += 1;
          throw new Error('fetch must not run for a fresh cache hit');
        },
        cachePath,
        now: () => NOW,
      },
    );
    expect(fetchCalls).toBe(0);
    expect(outcome.results[0]).toMatchObject({
      target: 'https://example.test/ok',
      status: 'succeeded',
      attempts: 0,
      httpStatus: 200,
      finalUrl: 'https://example.test/ok',
      source: 'cache',
    });
    expect(outcome.cache).toEqual({ enabled: true, hits: 1, misses: 0, stale: 0 });
  });

  it('fresh permanent-failure cache hit performs no fetch', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {
      'https://example.test/missing': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'permanent-failure',
        httpStatus: 404,
        attempts: 1,
      },
    });
    const outcome = await checkExternalOccurrences(
      occurrences(['https://example.test/missing']),
      {
        fetch: () => {
          throw new Error('fetch must not run');
        },
        cachePath,
        now: () => NOW,
      },
    );
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 0,
      httpStatus: 404,
      failureKind: 'http',
      source: 'cache',
    });
  });

  it('cache miss performs one live distinct-target check', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/miss';
    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(occurrences([target, target, target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(calls).toEqual([target]);
    expect(outcome.cache).toEqual({ enabled: true, hits: 0, misses: 1, stale: 0 });
    expect(outcome.results[0]?.source).toBe('network');
  });

  it('cache hit preserves diagnostics for every source occurrence', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {
      'https://example.test/missing': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'permanent-failure',
        httpStatus: 404,
        attempts: 1,
      },
    });
    const file = markdownFile(
      root,
      [
        '[one](https://example.test/missing)',
        '[two](https://example.test/missing)',
        '[three](https://example.test/missing)',
      ].join('\n'),
    );
    let fetchCalls = 0;
    const result = await checkMarkdownWithExternal([file], {
      fetch: () => {
        fetchCalls += 1;
        throw new Error('fetch must not run');
      },
      cachePath,
      now: () => NOW,
    });
    expect(fetchCalls).toBe(0);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.external.brokenOccurrences).toBe(3);
    expect(result.external.results[0]?.source).toBe('cache');
  });

  it('successful response is cached', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/saved';
    const { fetch } = statusFetch([200]);
    await checkExternalOccurrences(occurrences([target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    const document = readCache(cachePath);
    expect(document.version).toBe(1);
    expect(document.entries?.[target]).toMatchObject({
      checkedAt: new Date(NOW).toISOString(),
      outcome: 'succeeded',
      httpStatus: 200,
      attempts: 1,
    });
  });

  it('permanent HTTP failure is cached', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/missing';
    const { fetch } = statusFetch([404]);
    await checkExternalOccurrences(occurrences([target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(readCache(cachePath).entries?.[target]).toMatchObject({
      outcome: 'permanent-failure',
      httpStatus: 404,
      attempts: 1,
    });
  });

  it('timeout is not cached', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const { fetch } = timeoutFetch();
    await checkExternalOccurrences(occurrences(['https://example.test/slow']), {
      fetch,
      cachePath,
      timeoutMs: 10,
      now: () => NOW,
    });
    expect(loadExternalCache(cachePath).state).toBe('missing');
  });

  it('network failure is not cached', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const { fetch } = networkFetch();
    await checkExternalOccurrences(occurrences(['https://example.test/down']), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(loadExternalCache(cachePath).state).toBe('missing');
  });

  it('exhausted retryable HTTP failure is not cached', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const { fetch } = statusFetch([500]);
    await checkExternalOccurrences(occurrences(['https://example.test/down']), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(loadExternalCache(cachePath).state).toBe('missing');
  });

  it('redirect failures are not cached', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const loop = 'https://example.test/loop';
    const fetch = (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith(loop)) {
        return Promise.reject(new TypeError('unexpected fetch'));
      }
      return Promise.resolve(new Response(null, { status: 302, headers: { location: loop } }));
    };
    await checkExternalOccurrences(occurrences([loop]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(loadExternalCache(cachePath).state).toBe('missing');
  });

  it('credential-bearing URL is not persisted', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const { fetch } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://owner:secret@example.test/private']),
      { fetch, cachePath, now: () => NOW },
    );
    expect(outcome.results[0]?.status).toBe('succeeded');
    expect(loadExternalCache(cachePath).state).toBe('missing');
    expect(outcome.cache.misses).toBe(1);
  });

  it('cache never persists response bodies headers or raw errors', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response('top secret body', {
          status: 200,
          headers: { 'x-secret-header': 'secret header value' },
        }),
      );
    await checkExternalOccurrences(occurrences(['https://example.test/private']), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    const raw = readFileSync(cachePath, 'utf8');
    expect(raw).not.toContain('top secret body');
    expect(raw).not.toContain('x-secret-header');
    expect(raw).not.toContain('secret header value');
    const document = readCache(cachePath);
    const entries = document.entries ?? {};
    const entry = entries['https://example.test/private'];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'attempts',
      'checkedAt',
      'httpStatus',
      'outcome',
    ]);
  });

  it('stale entry triggers one live refresh', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/stale';
    const checkedAt = NOW - EXTERNAL_CACHE_FRESHNESS_MS - 1;
    writeEntries(cachePath, {
      [target]: {
        checkedAt: new Date(checkedAt).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(occurrences([target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(calls).toEqual([target]);
    expect(outcome.cache).toEqual({ enabled: true, hits: 0, misses: 0, stale: 1 });
    expect(outcome.results[0]?.source).toBe('network');
    expect(readCache(cachePath).entries?.[target]?.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('stale duplicate target triggers only one refresh', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/stale-duplicate';
    writeEntries(cachePath, {
      [target]: {
        checkedAt: new Date(NOW - EXTERNAL_CACHE_FRESHNESS_MS - 1).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(occurrences([target, target, target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.cache.stale).toBe(1);
  });

  it('future-dated entry beyond clock skew triggers a live refresh', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/future';
    writeEntries(cachePath, {
      [target]: {
        checkedAt: new Date(NOW + EXTERNAL_CACHE_CLOCK_SKEW_MS + 60_000).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(occurrences([target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.cache.stale).toBe(1);
    expect(readCache(cachePath).entries?.[target]?.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('refreshed cache entry records the injected current time', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = 'https://example.test/refresh';
    const { fetch } = statusFetch([200]);
    await checkExternalOccurrences(occurrences([target]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(readCache(cachePath).entries?.[target]?.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it('distinct queries remain distinct cache and request keys', async () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const first = 'https://example.test/page?view=a';
    const second = 'https://example.test/page?view=b';
    const { fetch, calls } = statusFetch([200, 200]);
    const outcome = await checkExternalOccurrences(occurrences([first, second]), {
      fetch,
      cachePath,
      now: () => NOW,
    });
    expect(calls).toEqual([first, second]);
    expect(outcome.cache.misses).toBe(2);
    expect(Object.keys(readCache(cachePath).entries ?? {}).sort()).toEqual([first, second]);
  });

  it('default non-external mode neither reads nor writes the cache', () => {
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    writeEntries(cachePath, {
      'https://example.test/ok': {
        checkedAt: new Date(NOW).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const before = readFileSync(cachePath, 'utf8');
    const file = markdownFile(root, '[web](https://example.test/ok)');
    const result = checkMarkdown([file]);
    expect(result.external.enabled).toBe(false);
    expect(result.externalSkipped).toBe(1);
    expect(readFileSync(cachePath, 'utf8')).toBe(before);
  });
});

describe('local-server cache and transport matrix', () => {
  it('local server success is checked and cached', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const file = markdownFile(root, `[web](${server.urlFor('/ok')})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toEqual([]);
    expect(result.external.succeeded).toBe(1);
    expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
    expect(readCache(cachePath).entries?.[server.urlFor('/ok')]?.outcome).toBe('succeeded');
  });

  it('local server redirect is bounded', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const file = markdownFile(root, `[web](${server.urlFor('/redirect')})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toEqual([]);
    expect(result.external.results[0]?.finalUrl).toBe(server.urlFor('/ok'));
    expect(server.requests.map((request) => request.path)).toEqual(['/redirect', '/ok']);
  });

  it('local server permanent failure is not retried', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const file = markdownFile(root, `[web](${server.urlFor('/not-found')})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toHaveLength(1);
    expect(server.requests).toEqual([{ method: 'GET', path: '/not-found' }]);
    expect(readCache(cachePath).entries?.[server.urlFor('/not-found')]?.outcome).toBe(
      'permanent-failure',
    );
  });

  it('local server retry followed by success is bounded', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const file = markdownFile(root, `[web](${server.urlFor('/flaky')})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toEqual([]);
    expect(result.external.results[0]?.attempts).toBe(2);
    expect(server.requests.filter((request) => request.path === '/flaky')).toHaveLength(2);
  });

  it('local server retry exhaustion is bounded', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const file = markdownFile(root, `[web](${server.urlFor('/always-flaky')})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.external.results[0]?.attempts).toBe(2);
    expect(server.requests.filter((request) => request.path === '/always-flaky')).toHaveLength(2);
    expect(loadExternalCache(cachePath).state).toBe('missing');
  });

  it('local server timeout is bounded', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const file = markdownFile(root, `[web](${server.urlFor('/slow')})`);
    const result = await checkMarkdownWithExternal([file], {
      cachePath,
      timeoutMs: 25,
    });
    expect(result.external.results[0]?.failureKind).toBe('timeout');
    expect(result.external.results[0]?.attempts).toBe(2);
    expect(server.requests.filter((request) => request.path === '/slow')).toHaveLength(2);
  });

  it('local servers prove global concurrency enforcement', async () => {
    const allServers = await Promise.all([
      fixtureServer(),
      fixtureServer(),
      fixtureServer(),
      fixtureServer(),
    ]);
    let active = 0;
    let maxActive = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return globalThis.fetch(input, init).finally(() => {
        active -= 1;
      });
    };
    const targets = allServers.map((server) => server.urlFor('/gate'));
    const checking = checkExternalOccurrences(occurrences(targets), {
      fetch,
      concurrency: 2,
    });

    await waitFor(() => totalGated(allServers) === 2);
    expect(maxActive).toBe(2);
    for (const server of allServers) {
      server.releaseGated();
    }
    await waitFor(() => totalGated(allServers) === 2);
    expect(maxActive).toBe(2);
    for (const server of allServers) {
      server.releaseGated();
    }
    const outcome = await checking;
    expect(outcome.results).toHaveLength(4);
    expect(maxActive).toBe(2);
  });

  it('local servers prove per-host politeness', async () => {
    const server = await fixtureServer();
    const targets = [
      server.urlFor('/gate?slot=1'),
      server.urlFor('/gate?slot=2'),
      server.urlFor('/gate?slot=3'),
    ];
    const checking = checkExternalOccurrences(occurrences(targets), {
      fetch: globalThis.fetch,
    });

    for (let expected = 1; expected <= 3; expected += 1) {
      await server.waitForGated(1);
      expect(server.gated).toBe(1);
      expect(server.requests).toHaveLength(expected);
      server.releaseGated();
    }

    const outcome = await checking;
    expect(outcome.results).toHaveLength(3);
    expect(server.requests.map((request) => request.path)).toEqual(['/gate', '/gate', '/gate']);
  });

  it('local server receives one request sequence for duplicate targets', async () => {
    const server = await fixtureServer();
    const target = server.urlFor('/flaky');
    const outcome = await checkExternalOccurrences(occurrences([target, target, target]), {
      fetch: globalThis.fetch,
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.attempts).toBe(2);
    expect(server.requests).toHaveLength(2);
  });

  it('fresh cache prevents a local server request', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = server.urlFor('/ok');
    writeEntries(cachePath, {
      [target]: {
        checkedAt: new Date().toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const file = markdownFile(root, `[web](${target})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toEqual([]);
    expect(result.external.cache.hits).toBe(1);
    expect(server.requests).toEqual([]);
  });

  it('stale cache causes a local server refresh', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    const target = server.urlFor('/ok');
    writeEntries(cachePath, {
      [target]: {
        checkedAt: new Date(Date.now() - EXTERNAL_CACHE_FRESHNESS_MS - 1).toISOString(),
        outcome: 'succeeded',
        httpStatus: 200,
        attempts: 1,
      },
    });
    const file = markdownFile(root, `[web](${target})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.external.cache.stale).toBe(1);
    expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
  });

  it('malformed cache recovers through a local server check', async () => {
    const server = await fixtureServer();
    const root = makeTempRoot();
    const cachePath = cachePathIn(root);
    mkdirSync(join(cachePath, '..'), { recursive: true });
    writeFileSync(cachePath, '{bad json', 'utf8');
    const file = markdownFile(root, `[web](${server.urlFor('/ok')})`);
    const result = await checkMarkdownWithExternal([file], { cachePath });
    expect(result.diagnostics).toEqual([]);
    expect(server.requests).toEqual([{ method: 'GET', path: '/ok' }]);
    expect(readCache(cachePath).version).toBe(1);
  });
});
