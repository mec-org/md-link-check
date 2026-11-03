import { describe, expect, it, vi } from 'vitest';
import { checkMarkdownWithExternal } from '../src/checker.js';
import {
  checkExternalOccurrences,
  DEFAULT_EXTERNAL_MAX_ATTEMPTS,
  DEFAULT_EXTERNAL_MAX_REDIRECTS,
  DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY,
  DEFAULT_EXTERNAL_PER_HOST_DELAY_MS,
  DEFAULT_EXTERNAL_TIMEOUT_MS,
  MAX_EXTERNAL_PER_HOST_DELAY_MS,
  type ExternalCheckOptions,
  type FetchLike,
} from '../src/external.js';
import { MAX_PER_HOST_DELAY_MS } from '../src/scheduler.js';
import {
  controlledFetch,
  fakeClock,
  markdownFile,
  networkFetch,
  occurrences,
  planFetch,
  statusFetch,
  timeoutFetch,
} from './external-helpers.js';
import { makeTempRoot } from './helpers.js';

describe('documented finite transport defaults', () => {
  it('request timeout uses the documented finite default', () => {
    expect(DEFAULT_EXTERNAL_TIMEOUT_MS).toBe(5_000);
    expect(Number.isFinite(DEFAULT_EXTERNAL_TIMEOUT_MS)).toBe(true);
    expect(Number.isInteger(DEFAULT_EXTERNAL_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_EXTERNAL_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('maximum attempts uses the documented finite default', async () => {
    expect(DEFAULT_EXTERNAL_MAX_ATTEMPTS).toBe(2);
    expect(Number.isFinite(DEFAULT_EXTERNAL_MAX_ATTEMPTS)).toBe(true);
    const { fetch, calls } = statusFetch([500]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/fail']), {
      fetch,
    });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
    expect(outcome.results[0]?.attempts).toBe(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
  });

  it('documents finite per-host and redirect defaults', () => {
    expect(DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY).toBe(1);
    expect(DEFAULT_EXTERNAL_PER_HOST_DELAY_MS).toBe(0);
    expect(DEFAULT_EXTERNAL_MAX_REDIRECTS).toBe(5);
    expect(MAX_EXTERNAL_PER_HOST_DELAY_MS).toBe(MAX_PER_HOST_DELAY_MS);
    expect(Number.isFinite(MAX_EXTERNAL_PER_HOST_DELAY_MS)).toBe(true);
  });
});

describe('bounded retry policy', () => {
  it('successful first attempt is not retried', async () => {
    const { fetch, calls } = statusFetch([200]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/ok']), {
      fetch,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      httpStatus: 200,
    });
  });

  it('permanent HTTP failure is never retried', async () => {
    const { fetch, calls } = statusFetch([404]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/gone']), {
      fetch,
    });
    expect(calls).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      httpStatus: 404,
      failureKind: 'http',
    });
  });

  it('does not retry other terminal 4xx responses', async () => {
    for (const status of [400, 401, 403, 410, 418, 451]) {
      const { fetch, calls } = statusFetch([status]);
      const outcome = await checkExternalOccurrences(
        occurrences([`https://example.test/${status}`]),
        { fetch },
      );
      expect(calls).toHaveLength(1);
      expect(outcome.results[0]?.failureKind).toBe('http');
    }
  });

  it('retryable status succeeds on a later bounded attempt', async () => {
    const { fetch, calls } = statusFetch([503, 200]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/flaky']), {
      fetch,
    });
    expect(calls).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      httpStatus: 200,
    });
  });

  it('retryable status stops at the maximum attempts', async () => {
    const { fetch, calls } = statusFetch([500]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/down']), {
      fetch,
    });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      httpStatus: 500,
      failureKind: 'http',
    });
  });

  it('network failure stops at the maximum attempts', async () => {
    const { fetch, calls } = networkFetch();
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/drop']), {
      fetch,
    });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      failureKind: 'network',
    });
  });

  it('timeout stops at the maximum attempts', async () => {
    const { fetch, calls } = timeoutFetch();
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/slow']), {
      fetch,
      timeoutMs: 10,
    });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      failureKind: 'timeout',
    });
  });

  it('each retry receives a fresh bounded timeout', async () => {
    const { fetch, signals } = timeoutFetch();
    await checkExternalOccurrences(occurrences(['https://example.test/slow']), {
      fetch,
      timeoutMs: 10,
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('no retry wait exceeds the documented ceiling', async () => {
    const clock = fakeClock(1_000_000);
    const sleeps: number[] = [];
    const { fetch, calls } = statusFetch([500, 200]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/retry']), {
      fetch,
      perHostDelayMs: Number.MAX_SAFE_INTEGER,
      now: clock.now,
      sleep: (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
        return Promise.resolve();
      },
    });
    expect(calls).toHaveLength(2);
    expect(outcome.results[0]?.attempts).toBe(2);
    expect(sleeps.length).toBeGreaterThan(0);
    for (const wait of sleeps) {
      expect(Number.isFinite(wait)).toBe(true);
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThanOrEqual(MAX_EXTERNAL_PER_HOST_DELAY_MS);
    }
  });

  it('retries have no mandatory wall-clock wait by default', async () => {
    const sleeps: number[] = [];
    const { fetch } = statusFetch([500, 200]);
    await checkExternalOccurrences(occurrences(['https://example.test/retry']), {
      fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(DEFAULT_EXTERNAL_PER_HOST_DELAY_MS).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it('invalid transport limits cannot create unbounded work', async () => {
    const { fetch, calls } = statusFetch([500]);
    const outcome = await checkExternalOccurrences(occurrences(['https://example.test/bad']), {
      fetch,
      timeoutMs: Number.POSITIVE_INFINITY,
      maxAttempts: Number.NaN,
      maxRedirects: Number.POSITIVE_INFINITY,
      concurrency: 0,
      perHostConcurrency: -1,
      perHostDelayMs: Number.POSITIVE_INFINITY,
      cacheFreshnessMs: -1,
    });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
    expect(outcome.results[0]?.attempts).toBe(DEFAULT_EXTERNAL_MAX_ATTEMPTS);
    expect(Number.isFinite(outcome.results[0]?.attempts ?? Number.NaN)).toBe(true);
  });

  it('zero concurrency options fall back to the documented finite defaults', async () => {
    const { fetch } = statusFetch([200, 200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://one.example/a', 'https://two.example/b']),
      { fetch, concurrency: 0, perHostConcurrency: Number.NaN },
    );
    expect(outcome.results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
  });
});

describe('bounded redirect handling', () => {
  it('redirect reaches a successful final response', async () => {
    const start = 'https://example.test/start';
    const plan = new Map([
      [start, { status: 302, location: '/next' }],
      ['https://example.test/next', { status: 200 }],
    ]);
    const { fetch, calls } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([start]), { fetch });
    expect(calls).toEqual([start, 'https://example.test/next']);
    expect(outcome.results[0]).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      httpStatus: 200,
    });
  });

  it('redirect to a permanent failure reports the final failure', async () => {
    const start = 'https://example.test/start';
    const plan = new Map([
      [start, { status: 302, location: '/missing' }],
      ['https://example.test/missing', { status: 404 }],
    ]);
    const { fetch, calls } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([start]), { fetch });
    expect(calls).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      httpStatus: 404,
      failureKind: 'http',
    });
  });

  it('redirect chain stops at the documented limit', async () => {
    const plan = new Map<string, { status: number; location?: string }>();
    const origin = 'https://example.test';
    for (let index = 0; index <= DEFAULT_EXTERNAL_MAX_REDIRECTS; index += 1) {
      plan.set(`${origin}/r${index}`, { status: 302, location: `/r${index + 1}` });
    }
    const { fetch, calls } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([`${origin}/r0`]), { fetch });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_REDIRECTS + 1);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureKind: 'redirect',
      redirectCount: DEFAULT_EXTERNAL_MAX_REDIRECTS,
    });
    expect(calls).not.toContain(`${origin}/r${DEFAULT_EXTERNAL_MAX_REDIRECTS + 1}`);
  });

  it('redirect loop becomes a bounded failure', async () => {
    const loop = 'https://example.test/loop';
    const plan = new Map([[loop, { status: 302, location: '/loop' }]]);
    const { fetch, calls } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([loop]), { fetch });
    expect(calls).toHaveLength(DEFAULT_EXTERNAL_MAX_REDIRECTS + 1);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureKind: 'redirect',
      redirectCount: DEFAULT_EXTERNAL_MAX_REDIRECTS,
    });
  });

  it('custom redirect limit is honoured exactly', async () => {
    const loop = 'https://example.test/loop';
    const plan = new Map([[loop, { status: 302, location: '/loop' }]]);
    const { fetch, calls } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([loop]), {
      fetch,
      maxRedirects: 2,
    });
    expect(calls).toHaveLength(3);
    expect(outcome.results[0]).toMatchObject({ failureKind: 'redirect', redirectCount: 2 });
  });

  it('redirect handling does not bypass attempt or timeout bounds', async () => {
    const calls: string[] = [];
    const base = 'https://example.test';
    const fetch: FetchLike = (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === `${base}/redirect`) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: '/slow' } }));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = (): void => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (signal?.aborted === true) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      });
    };
    const outcome = await checkExternalOccurrences(occurrences([`${base}/redirect`]), {
      fetch,
      timeoutMs: 10,
    });
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: DEFAULT_EXTERNAL_MAX_ATTEMPTS,
      failureKind: 'timeout',
    });
    expect(calls).toEqual([
      `${base}/redirect`,
      `${base}/slow`,
      `${base}/redirect`,
      `${base}/slow`,
    ]);
  });

  it('redirect hop timeout is not charged for scheduler queue wait', async () => {
    vi.useFakeTimers();
    try {
      const controlled = controlledFetch();
      const hostCount = 20;
      const targets = Array.from(
        { length: hostCount },
        (_value, index) => `https://host${index}.example/${index}`,
      );
      const finalTarget = 'https://final.example/landing';
      const checking = checkExternalOccurrences(occurrences(targets), {
        fetch: controlled.fetch,
        concurrency: 1,
        timeoutMs: 100,
      });

      await controlled.waitForRequests(1);
      controlled.requests[0]?.resolve(302, { location: finalTarget });

      // Drain the rest of the queue while the redirect target's second hop
      // waits. The accumulated fake time exceeds one hop timeout, so an
      // attempt-wide timer would abort the healthy redirect.
      for (let index = 1; index < hostCount; index += 1) {
        await controlled.waitForRequests(index + 1);
        await vi.advanceTimersByTimeAsync(20);
        controlled.requests[index]?.resolve(200);
      }

      await controlled.waitForRequests(hostCount + 1);
      expect(controlled.requests[hostCount]?.input).toBe(finalTarget);
      controlled.requests[hostCount]?.resolve(200);

      const outcome = await checking;
      expect(outcome.results[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(outcome.results.every((result) => result.status === 'succeeded')).toBe(true);
      expect(controlled.requests).toHaveLength(hostCount + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalid redirect target becomes a bounded failure', async () => {
    const start = 'https://example.test/start';
    const plan = new Map([[start, { status: 302, location: 'mailto:owner@example.test' }]]);
    const { fetch, calls } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([start]), { fetch });
    expect(calls).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureKind: 'invalid-redirect',
    });
  });

  it('redirect statuses without a location stay terminal successes', async () => {
    const start = 'https://example.test/not-modified';
    const plan = new Map([[start, { status: 304 }]]);
    const { fetch } = planFetch(plan);
    const outcome = await checkExternalOccurrences(occurrences([start]), { fetch });
    expect(outcome.results[0]).toMatchObject({ status: 'succeeded', httpStatus: 304 });
  });
});

describe('global concurrency', () => {
  it('global active requests never exceed the configured limit', async () => {
    const targets = Array.from(
      { length: 10 },
      (_value, index) => `https://host${index}.example/${index}`,
    );
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences(targets), {
      fetch: controlled.fetch,
      concurrency: 3,
    });

    await controlled.waitForRequests(3);
    expect(controlled.requests).toHaveLength(3);
    expect(controlled.maxActive).toBe(3);

    for (let index = 0; index < targets.length; index += 1) {
      const request = controlled.requests[index];
      expect(request).toBeDefined();
      request?.resolve(200);
      if (index + 1 < targets.length) {
        await controlled.waitForRequests(index + 2);
      }
    }

    const outcome = await checking;
    expect(outcome.results).toHaveLength(targets.length);
    expect(controlled.maxActive).toBe(3);
    expect(controlled.active).toBe(0);
  });

  it('global concurrency test is event driven', async () => {
    const targets = ['https://one.example/a', 'https://two.example/b'];
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences(targets), {
      fetch: controlled.fetch,
      concurrency: 1,
    });

    await controlled.waitForRequests(1);
    expect(controlled.requests).toHaveLength(1);
    controlled.requests[0]?.resolve(200);
    await controlled.waitForRequests(2);
    expect(controlled.maxActive).toBe(1);
    controlled.requests[1]?.resolve(200);
    await checking;
  });

  it('retries share the global concurrency limit', async () => {
    const first = 'https://one.example/retry';
    const second = 'https://two.example/other';
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences([first, second]), {
      fetch: controlled.fetch,
      concurrency: 1,
    });

    await controlled.waitForRequests(1);
    expect(controlled.requests[0]?.input).toBe(first);
    controlled.requests[0]?.resolve(500);

    await controlled.waitForRequests(2);
    expect(controlled.requests[1]?.input).toBe(second);
    controlled.requests[1]?.resolve(200);

    await controlled.waitForRequests(3);
    expect(controlled.requests[2]?.input).toBe(first);
    controlled.requests[2]?.resolve(200);

    const outcome = await checking;
    expect(controlled.maxActive).toBe(1);
    expect(controlled.requests).toHaveLength(3);
    expect(outcome.results[0]?.attempts).toBe(2);
    expect(outcome.results[0]?.status).toBe('succeeded');
    expect(outcome.results[1]?.status).toBe('succeeded');
  });

  it('completion order does not change result order', async () => {
    const targets = [
      'https://one.example/first',
      'https://two.example/second',
      'https://three.example/third',
    ];
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences(targets), {
      fetch: controlled.fetch,
    });
    await controlled.waitForRequests(3);
    controlled.requests[2]?.resolve(200);
    controlled.requests[1]?.resolve(200);
    controlled.requests[0]?.resolve(200);
    const outcome = await checking;
    expect(outcome.results.map((result) => result.target)).toEqual(targets);
    expect(outcome.byOccurrence.map((result) => result.target)).toEqual(targets);
  });
});

describe('per-host politeness', () => {
  it('per-host active requests never exceed the configured limit', async () => {
    const targets = [
      'https://same.example/one',
      'https://same.example/two',
      'https://same.example/three',
    ];
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences(targets), {
      fetch: controlled.fetch,
    });

    for (let index = 0; index < targets.length; index += 1) {
      await controlled.waitForRequests(index + 1);
      expect(controlled.requests).toHaveLength(index + 1);
      controlled.requests[index]?.resolve(200);
    }

    await checking;
    expect(controlled.maxActiveByHost.get('https://same.example')).toBe(1);
  });

  it('different hosts may use separate host capacity', async () => {
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(
      occurrences(['https://one.example/a', 'https://two.example/b']),
      { fetch: controlled.fetch, concurrency: 2 },
    );
    await controlled.waitForRequests(2);
    expect(controlled.active).toBe(2);
    expect(controlled.requests.map((request) => request.host).sort()).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
    controlled.requests[0]?.resolve(200);
    controlled.requests[1]?.resolve(200);
    await checking;
  });

  it('retries obey the same per-host policy', async () => {
    const first = 'https://same.example/retry';
    const second = 'https://same.example/other';
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences([first, second]), {
      fetch: controlled.fetch,
    });

    await controlled.waitForRequests(1);
    expect(controlled.requests[0]?.input).toBe(first);
    controlled.requests[0]?.resolve(500);

    await controlled.waitForRequests(2);
    expect(controlled.requests[1]?.input).toBe(second);
    controlled.requests[1]?.resolve(200);

    await controlled.waitForRequests(3);
    expect(controlled.requests[2]?.input).toBe(first);
    controlled.requests[2]?.resolve(200);

    await checking;
    expect(controlled.maxActiveByHost.get('https://same.example')).toBe(1);
  });

  it('redirected requests obey the destination host policy', async () => {
    const start = 'https://source.example/start';
    const direct = 'https://destination.example/direct';
    const second = 'https://destination.example/second';
    const redirected = 'https://destination.example/redirected';
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences([start, direct, second]), {
      fetch: controlled.fetch,
    });

    await controlled.waitForRequests(2);
    expect(controlled.requests.map((request) => request.input)).toEqual([start, direct]);

    const startRequest = controlled.requests.find((request) => request.input === start);
    startRequest?.resolve(302, { location: redirected });
    await controlled.waitForSettled(1);
    expect(controlled.requests.map((request) => request.input)).toEqual([start, direct]);

    const directRequest = controlled.requests.find((request) => request.input === direct);
    directRequest?.resolve(200);
    await controlled.waitForRequests(3);
    expect(controlled.requests[2]?.input).toBe(second);

    controlled.requests[2]?.resolve(200);
    await controlled.waitForRequests(4);
    expect(controlled.requests[3]?.input).toBe(redirected);

    controlled.requests[3]?.resolve(200);
    await checking;
    expect(controlled.maxActiveByHost.get('https://destination.example')).toBe(1);
  });

  it('per-host waits remain bounded', async () => {
    const clock = fakeClock(1_000_000);
    const sleeps: number[] = [];
    const { fetch } = statusFetch([200, 200]);
    const outcome = await checkExternalOccurrences(
      occurrences(['https://same.example/one', 'https://same.example/two']),
      {
        fetch,
        perHostDelayMs: Number.MAX_SAFE_INTEGER,
        now: clock.now,
        sleep: (ms) => {
          sleeps.push(ms);
          clock.advance(ms);
          return Promise.resolve();
        },
      },
    );
    expect(outcome.results.every((result) => result.status === 'succeeded')).toBe(true);
    expect(sleeps.length).toBeGreaterThan(0);
    for (const wait of sleeps) {
      expect(wait).toBeLessThanOrEqual(MAX_EXTERNAL_PER_HOST_DELAY_MS);
      expect(wait).toBeGreaterThan(0);
    }
  });

  it('one slow host does not indefinitely block another host', async () => {
    const slow = 'https://slow.example/slow';
    const fast = 'https://fast.example/fast';
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences([slow, fast]), {
      fetch: controlled.fetch,
    });

    await controlled.waitForRequests(2);
    const fastRequest = controlled.requests.find((request) => request.input === fast);
    fastRequest?.resolve(200);
    await controlled.waitForSettled(1);

    const slowRequest = controlled.requests.find((request) => request.input === slow);
    expect(slowRequest?.settled).toBe(false);
    expect(controlled.active).toBe(1);

    slowRequest?.resolve(200);
    const outcome = await checking;
    expect(outcome.results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
  });
});

describe('deduplication before scheduling', () => {
  it('repeated targets are deduplicated before scheduling', async () => {
    const target = 'https://example.test/same';
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(
      occurrences([target, target, target]),
      { fetch: controlled.fetch },
    );
    await controlled.waitForRequests(1);
    expect(controlled.requests).toHaveLength(1);
    controlled.requests[0]?.resolve(200);
    const outcome = await checking;
    expect(outcome.results).toHaveLength(1);
    expect(outcome.byOccurrence).toHaveLength(3);
    expect(controlled.requests).toHaveLength(1);
  });

  it('duplicate targets consume one global slot', async () => {
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(
      occurrences([
        'https://same.example/a',
        'https://same.example/a',
        'https://same.example/b',
      ]),
      { fetch: controlled.fetch, concurrency: 1 },
    );
    await controlled.waitForRequests(1);
    controlled.requests[0]?.resolve(200);
    await controlled.waitForRequests(2);
    controlled.requests[1]?.resolve(200);
    await checking;
    expect(controlled.requests).toHaveLength(2);
    expect(controlled.maxActive).toBe(1);
  });

  it('duplicate targets consume one per-host slot', async () => {
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(
      occurrences([
        'https://same.example/a',
        'https://same.example/a',
        'https://same.example/b',
      ]),
      { fetch: controlled.fetch },
    );
    await controlled.waitForRequests(1);
    expect(controlled.requests).toHaveLength(1);
    controlled.requests[0]?.resolve(200);
    await controlled.waitForRequests(2);
    controlled.requests[1]?.resolve(200);
    await checking;
    expect(controlled.maxActiveByHost.get('https://same.example')).toBe(1);
    expect(controlled.requests).toHaveLength(2);
  });

  it('duplicate targets perform one retry sequence', async () => {
    const target = 'https://example.test/flaky';
    const { fetch, calls } = statusFetch([500, 200]);
    const outcome = await checkExternalOccurrences(occurrences([target, target, target]), {
      fetch,
    });
    expect(calls).toHaveLength(2);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(outcome.byOccurrence).toHaveLength(3);
  });

  it('duplicate failed target still reports every source occurrence', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '[one](https://example.test/missing)',
        '[two](https://example.test/missing)',
        '[three](https://example.test/missing)',
      ].join('\n'),
    );
    const { fetch, calls } = statusFetch([404]);
    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.external.brokenOccurrences).toBe(3);
    expect(result.external.results).toHaveLength(1);
  });

  it('deduplication key excludes the URL fragment', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[one](https://example.test/page#one) and [two](https://example.test/page#two)',
    );
    const controlled = controlledFetch();
    const checking = checkExternalMarkdown(file, {
      fetch: controlled.fetch,
    });
    await controlled.waitForRequests(1);
    expect(controlled.requests).toHaveLength(1);
    controlled.requests[0]?.resolve(200);
    const result = await checking;
    expect(result.external.distinctChecked).toBe(1);
    expect(result.external.occurrences).toBe(2);
    expect(result.external.results[0]?.target).toBe('https://example.test/page#one');
    expect(controlled.requests[0]?.input).toBe('https://example.test/page');
  });

  it('distinct queries remain distinct request keys', async () => {
    const first = 'https://example.test/page?view=a';
    const second = 'https://example.test/page?view=b';
    const controlled = controlledFetch();
    const checking = checkExternalOccurrences(occurrences([first, second]), {
      fetch: controlled.fetch,
    });
    await controlled.waitForRequests(1);
    controlled.requests[0]?.resolve(200);
    await controlled.waitForRequests(2);
    controlled.requests[1]?.resolve(200);
    const outcome = await checking;
    expect(outcome.results).toHaveLength(2);
    expect(controlled.requests.map((request) => request.input)).toEqual([first, second]);
  });
});

/** Runs the Markdown checker with external options and a controlled fetch. */
async function checkExternalMarkdown(
  file: string,
  options: ExternalCheckOptions,
): Promise<Awaited<ReturnType<typeof checkMarkdownWithExternal>>> {
  return checkMarkdownWithExternal([file], options);
}
