import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkMarkdown, checkMarkdownWithExternal } from '../src/checker.js';
import type { FetchLike } from '../src/external.js';
import { makeTempRoot, writeFiles } from './helpers.js';

/** Writes a one-file fixture and returns its absolute path. */
function markdownFile(root: string, contents: string): string {
  writeFiles(root, { 'README.md': contents });
  return join(root, 'README.md');
}

interface RecordedFetch {
  fetch: FetchLike;
  calls: string[];
}

/** A fetch stub that returns the given statuses in order, repeating the last. */
function statusFetch(statuses: readonly number[]): RecordedFetch {
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
function networkFetch(): RecordedFetch {
  const calls: string[] = [];
  const fetch: FetchLike = (input) => {
    calls.push(String(input));
    return Promise.reject(new TypeError('fetch failed'));
  };
  return { fetch, calls };
}

interface TimeoutFetch {
  fetch: FetchLike;
  calls: string[];
  signals: AbortSignal[];
}

/** A fetch stub that never responds and rejects when its attempt is aborted. */
function timeoutFetch(): TimeoutFetch {
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
function manualFetch(): {
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

/** Yields until `condition` holds, without a fixed wall-clock wait in tests. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

describe('default mode is offline', () => {
  it('default mode performs no fetch', () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[one](https://example.com/one) and ![two](http://example.com/two.png)',
    );

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error('network access attempted');
    }) as typeof fetch;
    try {
      const result = checkMarkdown([file]);
      expect(fetchCalls).toBe(0);
      expect(result.external.enabled).toBe(false);
      expect(result.external.occurrences).toBe(2);
      expect(result.externalSkipped).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('default mode counts inline external links as skipped', () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/a)');

    const result = checkMarkdown([file]);
    expect(result.externalSkipped).toBe(1);
    expect(result.external.skipped).toBe(1);
    expect(result.diagnostics).toEqual([]);
  });

  it('default mode counts reference external links as skipped', () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web][site]\n\n[site]: https://example.com/a');

    expect(checkMarkdown([file]).externalSkipped).toBe(1);
  });

  it('default mode counts raw HTML external links as skipped', () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '<a href="https://example.com/a">web</a>');

    expect(checkMarkdown([file]).externalSkipped).toBe(1);
  });

  it('default mode counts external images as skipped', () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '![one](https://example.com/one.png) <img src="http://example.com/two.png">',
    );

    expect(checkMarkdown([file]).externalSkipped).toBe(2);
  });

  it('default mode ignores external-looking content inside code', () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '```md',
        '[fenced](https://example.com/fenced)',
        '```',
        '',
        '    [indented](https://example.com/indented)',
        '',
        'Use `[inline](https://example.com/inline)` in prose.',
        '',
        '`<a href="https://example.com/html">html</a>`',
      ].join('\n'),
    );

    const result = checkMarkdown([file]);
    expect(result.externalSkipped).toBe(0);
    expect(result.external.occurrences).toBe(0);
  });

});

describe('external target collection and coverage', () => {
  it('external mode checks an inline Markdown link', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/link)');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/link']);
    expect(result.external.distinctChecked).toBe(1);
  });

  it('external mode checks an inline Markdown image', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '![pic](https://example.com/image.png)');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/image.png']);
    expect(result.external.distinctChecked).toBe(1);
  });

  it('external mode checks a reference-style link', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web][site]\n\n[site]: https://example.com/ref');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/ref']);
    expect(result.external.distinctChecked).toBe(1);
  });

  it('external mode checks a reference-style image', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '![pic][logo]\n\n[logo]: https://example.com/logo.png');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/logo.png']);
    expect(result.external.distinctChecked).toBe(1);
  });

  it('external mode checks a raw HTML link', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '<a href="https://example.com/html">web</a>');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/html']);
    expect(result.external.distinctChecked).toBe(1);
  });

  it('external mode checks a raw HTML image', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '<img src="https://example.com/html.png">');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/html.png']);
    expect(result.external.distinctChecked).toBe(1);
  });

  it('external HTML inside code is not checked', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '```html',
        '<a href="https://example.com/fenced">fenced</a>',
        '```',
        '',
        '`<img src="https://example.com/inline.png">`',
      ].join('\n'),
    );
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual([]);
    expect(result.external.occurrences).toBe(0);
  });

  it('unused external reference definitions are not checked', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[site]: https://example.com/unused\n');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual([]);
    expect(result.external.occurrences).toBe(0);
    expect(result.externalSkipped).toBe(0);
  });

  it('separate external occurrences are all reported', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '[inline](https://example.com/a)',
        '![image](https://example.com/b.png)',
        '[ref][site]',
        '<a href="https://example.com/c">raw</a>',
        '<img src="https://example.com/d.png">',
        '',
        '[site]: https://example.com/e',
      ].join('\n'),
    );
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(5);
    expect(result.external.occurrences).toBe(5);
    expect(result.external.distinctChecked).toBe(5);
  });
});

describe('deduplication and deterministic ordering', () => {
  it('checks each distinct external target once', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '[one](https://example.com/a)',
        '[two](https://example.com/a)',
        '<img src="https://example.com/a">',
      ].join('\n'),
    );
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/a']);
    expect(result.external.occurrences).toBe(3);
    expect(result.external.distinctChecked).toBe(1);
    expect(result.external.results).toHaveLength(1);
    expect(result.external.succeeded).toBe(1);
  });

  it('deduplicates by the exact normalized URL serialization', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[one](https://EXAMPLE.com/a) and [two](https://example.com/a)',
    );
    const { fetch, calls } = statusFetch([200]);

    await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/a']);
  });

  it('a failed distinct target reports every source occurrence', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[one](https://example.com/x) and [two](https://EXAMPLE.com/x) and [three](https://example.com/x)',
    );
    const { fetch, calls } = statusFetch([404]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.external.brokenOccurrences).toBe(3);
    expect(result.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'https://example.com/x',
      'https://EXAMPLE.com/x',
      'https://example.com/x',
    ]);
    expect(result.diagnostics[0]?.reason).toBe('external HTTP 404');
  });

  it('http and https targets are not merged', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[secure](https://example.com/a) and [plain](http://example.com/a)',
    );
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual(['https://example.com/a', 'http://example.com/a']);
    expect(result.external.distinctChecked).toBe(2);
  });

  it('external result order follows first occurrence', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '[first](https://first.example/first)',
        '[second](https://second.example/second)',
        '[third](https://third.example/third)',
      ].join('\n'),
    );
    const { fetch, pending } = manualFetch();

    const checking = checkMarkdownWithExternal([file], { fetch });
    await waitFor(() => pending.length === 3);
    for (const request of [...pending].reverse()) {
      request.resolve(200);
    }
    const result = await checking;

    expect(result.external.results.map((target) => target.target)).toEqual([
      'https://first.example/first',
      'https://second.example/second',
      'https://third.example/third',
    ]);
  });

  it('diagnostic order does not depend on response completion order', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      [
        '[local one](missing-one.md)',
        '[external one](https://slow.example/slow)',
        '[local two](missing-two.md)',
        '[external two](https://fast.example/fast)',
      ].join('\n'),
    );
    const { fetch, pending } = manualFetch();

    const checking = checkMarkdownWithExternal([file], { fetch });
    await waitFor(() => pending.length === 2);
    // Complete the later target first, then the earlier one.
    pending[1]?.resolve(404);
    pending[0]?.resolve(404);
    const result = await checking;

    expect(result.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'missing-one.md',
      'https://slow.example/slow',
      'missing-two.md',
      'https://fast.example/fast',
    ]);
  });

  it('external checks respect the concurrency limit', async () => {
    const root = makeTempRoot();
    const links = Array.from({ length: 10 }, (_value, index) =>
      `[link ${index}](https://host${index}.example/${index})`,
    );
    const file = markdownFile(root, links.join('\n'));

    let active = 0;
    let maxActive = 0;
    const fetch: FetchLike = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return new Response(null, { status: 200 });
    };

    const result = await checkMarkdownWithExternal([file], { fetch, concurrency: 4 });
    expect(result.external.distinctChecked).toBe(10);
    expect(maxActive).toBe(4);
  });

  it('applies the production default concurrency of four when no option is given', async () => {
    const root = makeTempRoot();
    const links = Array.from({ length: 10 }, (_value, index) =>
      `[link ${index}](https://host${index}.example/${index})`,
    );
    const file = markdownFile(root, links.join('\n'));

    let active = 0;
    let maxActive = 0;
    const fetch: FetchLike = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return new Response(null, { status: 200 });
    };

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(result.external.distinctChecked).toBe(10);
    expect(maxActive).toBe(4);
  });
});

describe('retry and timeout policy', () => {
  it('successful first attempt is not retried', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/ok)');
    const { fetch, calls } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(1);
    expect(result.external.results[0]).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      httpStatus: 200,
    });
  });

  it('terminal client error is not retried', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/missing)');
    const { fetch, calls } = statusFetch([404]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(1);
    expect(result.external.results[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      httpStatus: 404,
      failureKind: 'http',
    });
  });

  it('retryable status is retried within the configured limit', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/flaky)');
    const { fetch, calls } = statusFetch([500, 200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(2);
    expect(result.external.results[0]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      httpStatus: 200,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('flaky target succeeds within the retry policy', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/flaky)');
    const { fetch, calls } = statusFetch([429, 408, 500, 200]);

    const result = await checkMarkdownWithExternal([file], { fetch, maxAttempts: 4 });
    expect(calls).toHaveLength(4);
    expect(result.external.succeeded).toBe(1);
  });

  it('retryable status stops after the configured limit', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/broken)');
    const { fetch, calls } = statusFetch([500, 500, 500]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(2);
    expect(result.external.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      httpStatus: 500,
      failureKind: 'http',
    });
    expect(result.diagnostics[0]?.reason).toBe('external HTTP 500 after 2 attempts');
  });

  it('each attempt receives a fresh timeout', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/slow)');
    const { fetch, calls, signals } = timeoutFetch();

    const result = await checkMarkdownWithExternal([file], { fetch, timeoutMs: 10 });
    expect(calls).toHaveLength(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.external.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      failureKind: 'timeout',
    });
    expect(result.diagnostics[0]?.reason).toBe(
      'external request timed out after 2 attempts',
    );
  });

  it('timeout attempts do not exceed the configured maximum', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/slow)');
    const { fetch, calls } = timeoutFetch();

    const result = await checkMarkdownWithExternal([file], {
      fetch,
      timeoutMs: 10,
      maxAttempts: 2,
    });
    expect(calls).toHaveLength(2);
    expect(result.external.results[0]?.attempts).toBe(2);
  });

  it('network failure attempts do not exceed the configured maximum', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/down)');
    const { fetch, calls } = networkFetch();

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toHaveLength(2);
    expect(result.external.results[0]).toMatchObject({
      status: 'failed',
      attempts: 2,
      failureKind: 'network',
    });
    expect(result.diagnostics[0]?.reason).toBe('external network failure after 2 attempts');
  });

  it('attempt count is included in structured external results', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/flaky)');
    const { fetch } = statusFetch([503, 200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(result.external.results[0]?.attempts).toBe(2);
    expect(result.external.results[0]?.httpStatus).toBe(200);
  });

  it('an unparseable HTTP target is reported as an external failure', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[bad](http://)');
    const { fetch, calls } = statusFetch([200]);

    const online = await checkMarkdownWithExternal([file], { fetch });
    expect(calls).toEqual([]);
    expect(online.external.results[0]).toMatchObject({
      status: 'failed',
      attempts: 0,
      failureKind: 'invalid-url',
    });
    expect(online.diagnostics[0]?.reason).toBe('external invalid URL');

    const offline = checkMarkdown([file]);
    expect(offline.diagnostics).toEqual([]);
    expect(offline.externalSkipped).toBe(1);
  });
});

describe('external results combine with local findings', () => {
  it('successful external checks do not produce diagnostics', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[web](https://example.com/ok) and [local](missing.md)',
    );
    const { fetch } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(result.diagnostics.map((diagnostic) => diagnostic.target)).toEqual(['missing.md']);
    expect(result.external.brokenOccurrences).toBe(0);
  });

  it('external failure does not suppress local diagnostics', async () => {
    const root = makeTempRoot();
    const file = markdownFile(
      root,
      '[local](missing.md) and [web](https://example.com/missing)',
    );
    const { fetch } = statusFetch([404]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(result.diagnostics.map((diagnostic) => diagnostic.target)).toEqual([
      'missing.md',
      'https://example.com/missing',
    ]);
    expect(result.broken).toBe(2);
  });

  it('successful external checks leave a clean result', async () => {
    const root = makeTempRoot();
    const file = markdownFile(root, '[web](https://example.com/ok)');
    const { fetch } = statusFetch([200]);

    const result = await checkMarkdownWithExternal([file], { fetch });
    expect(result.broken).toBe(0);
    expect(result.external.failed).toBe(0);
    expect(result.external.skipped).toBe(0);
    expect(result.externalSkipped).toBe(0);
  });
});
