import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExternalOccurrence, FetchLike } from '../src/external.js';
import { writeFiles } from './helpers.js';

/** Writes a one-file Markdown fixture and returns its absolute path. */
export function markdownFile(root: string, contents: string): string {
  writeFiles(root, { 'README.md': contents });
  return join(root, 'README.md');
}

/** Builds one inline-link occurrence per target, in order. */
export function occurrences(targets: readonly string[]): ExternalOccurrence[] {
  return targets.map((target, index) => ({
    file: 'README.md',
    line: index + 1,
    column: 1,
    kind: 'link',
    target,
  }));
}

export interface RecordedFetch {
  fetch: FetchLike;
  calls: string[];
}

/** A fetch stub that returns the given statuses in order, repeating the last. */
export function statusFetch(statuses: readonly number[]): RecordedFetch {
  const calls: string[] = [];
  let index = 0;
  const fetch: FetchLike = (input) => {
    calls.push(String(input));
    const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
    index += 1;
    return Promise.resolve(new Response(null, { status }));
  };
  return { fetch, calls };
}

/** A fetch stub that always rejects with a plain network-shaped error. */
export function networkFetch(): RecordedFetch {
  const calls: string[] = [];
  const fetch: FetchLike = (input) => {
    calls.push(String(input));
    return Promise.reject(new TypeError('fetch failed'));
  };
  return { fetch, calls };
}

export interface TimeoutFetch {
  fetch: FetchLike;
  calls: string[];
  signals: AbortSignal[];
}

/** A fetch stub that never responds and rejects when its attempt is aborted. */
export function timeoutFetch(): TimeoutFetch {
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push(String(input));
    const signal = init?.signal;
    if (signal === undefined || signal === null) {
      return Promise.reject(new Error('missing abort signal'));
    }
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  return { fetch, calls, signals };
}

/** A fetch stub whose requests are resolved by the test, in any order. */
export function manualFetch(): {
  fetch: FetchLike;
  pending: Array<{ input: string; resolve(status: number): void }>;
} {
  const pending: Array<{ input: string; resolve(status: number): void }> = [];
  const fetch: FetchLike = (input) =>
    new Promise<Response>((resolve) => {
      pending.push({
        input: String(input),
        resolve: (status: number) => resolve(new Response(null, { status })),
      });
    });
  return { fetch, pending };
}

/** A fetch stub driven by an explicit URL-to-response plan. */
export function planFetch(
  plan: ReadonlyMap<string, { status: number; location?: string }>,
): RecordedFetch {
  const calls: string[] = [];
  const fetch: FetchLike = (input) => {
    const url = String(input);
    calls.push(url);
    const response = plan.get(url);
    if (response === undefined) {
      return Promise.reject(new TypeError(`unexpected fetch for ${url}`));
    }
    return Promise.resolve(
      new Response(null, {
        status: response.status,
        ...(response.location === undefined ? {} : { headers: { location: response.location } }),
      }),
    );
  };
  return { fetch, calls };
}

export interface ControlledRequest {
  readonly input: string;
  readonly host: string;
  readonly settled: boolean;
  resolve(status?: number, headers?: Record<string, string>): void;
  reject(error?: unknown): void;
}

export interface ControlledFetch {
  fetch: FetchLike;
  requests: ControlledRequest[];
  active: number;
  maxActive: number;
  settled: number;
  maxActiveByHost: Map<string, number>;
  /** Resolves once at least `count` requests have been issued. */
  waitForRequests(count: number): Promise<void>;
  /** Resolves once at least `count` requests have settled. */
  waitForSettled(count: number): Promise<void>;
}

/**
 * A fetch stub that holds every request open until the test resolves it, while
 * recording active and peak-active counts globally and per host origin. All
 * waits are event driven: no test needs an arbitrary sleep.
 */
export function controlledFetch(): ControlledFetch {
  const requests: ControlledRequest[] = [];
  const activeByHost = new Map<string, number>();
  const maxActiveByHost = new Map<string, number>();
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  const settledWaiters: Array<{ count: number; resolve: () => void }> = [];
  let active = 0;
  let maxActive = 0;
  let settled = 0;

  const notify = (): void => {
    for (let index = requestWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = requestWaiters[index];
      if (waiter !== undefined && requests.length >= waiter.count) {
        requestWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
    for (let index = settledWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = settledWaiters[index];
      if (waiter !== undefined && settled >= waiter.count) {
        settledWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const fetch: FetchLike = (input) => {
    const url = new URL(String(input));
    const host = url.origin;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const hostActive = (activeByHost.get(host) ?? 0) + 1;
    activeByHost.set(host, hostActive);
    maxActiveByHost.set(host, Math.max(maxActiveByHost.get(host) ?? 0, hostActive));

    return new Promise<Response>((resolve, reject) => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        active -= 1;
        activeByHost.set(host, (activeByHost.get(host) ?? 1) - 1);
        settled += 1;
        notify();
      };
      const request: ControlledRequest = {
        input: String(input),
        host,
        get settled() {
          return finished;
        },
        resolve(status = 200, headers) {
          finish();
          resolve(
            new Response(null, {
              status,
              ...(headers === undefined ? {} : { headers }),
            }),
          );
        },
        reject(error = new TypeError('fetch failed')) {
          finish();
          reject(error);
        },
      };
      requests.push(request);
      notify();
    });
  };

  return {
    fetch,
    requests,
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get settled() {
      return settled;
    },
    maxActiveByHost,
    waitForRequests(count: number): Promise<void> {
      if (requests.length >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        requestWaiters.push({ count, resolve });
      });
    },
    waitForSettled(count: number): Promise<void> {
      if (settled >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        settledWaiters.push({ count, resolve });
      });
    },
  };
}

/** Yields until `condition` holds, without a fixed wall-clock wait. */
export async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

export interface CacheEntryFixture {
  checkedAt: string;
  outcome: string;
  httpStatus?: number;
  finalUrl?: string;
  attempts?: number;
}

/** Writes a raw cache document beneath `root`, creating parents. */
export function writeCacheFile(
  path: string,
  entries: Record<string, CacheEntryFixture>,
  version: unknown = 1,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version, entries }, null, 2)}\n`, 'utf8');
}

/** Returns a cache path inside a temporary root. */
export function cachePathIn(root: string): string {
  return join(root, 'cache', 'external-v1.json');
}

/** A clock that only moves when the test advances it. */
export interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

export function fakeClock(start: number): FakeClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
