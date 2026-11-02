import type { LinkKind } from './parser.js';

/**
 * The part of the built-in `fetch` the external checker needs. Tests inject
 * their own implementation; production uses `globalThis.fetch`.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Default timeout for one external request attempt, in milliseconds. */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 5_000;

/** Default total attempts per distinct external target: the first plus one retry. */
export const DEFAULT_EXTERNAL_MAX_ATTEMPTS = 2;

/** Default number of distinct external targets checked at the same time. */
export const DEFAULT_EXTERNAL_CONCURRENCY = 4;

/** Why a distinct external target ended as a failure. */
export type ExternalFailureKind = 'http' | 'timeout' | 'network' | 'invalid-url';

/** One supported Markdown or raw HTML use of an external target, in source order. */
export interface ExternalOccurrence {
  file: string;
  line: number;
  column: number;
  kind: LinkKind;
  /** The target exactly as written in the source. */
  target: string;
}

/** The final outcome of one distinct normalized external target. */
export interface ExternalTargetResult {
  /** Normalized URL, or the trimmed source target when it cannot be parsed. */
  target: string;
  status: 'succeeded' | 'failed';
  /** Requests performed; 0 when the target is not a parseable URL. */
  attempts: number;
  /** Final HTTP status after redirects, when a response was received. */
  httpStatus?: number;
  /** Final URL after redirects, when a response was received. */
  finalUrl?: string;
  /** Present only for failed results. */
  failureKind?: ExternalFailureKind;
}

/** Internal knobs for the external checker; production uses the exported defaults. */
export interface ExternalCheckOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  concurrency?: number;
}

/** Structured external results for one checking run. */
export interface ExternalCheckOutcome {
  /** One result per distinct target, ordered by first source occurrence. */
  results: ExternalTargetResult[];
  /** One result per occurrence, aligned with the occurrence list passed in. */
  byOccurrence: ExternalTargetResult[];
}

/**
 * Normalizes an HTTP(S) target for request deduplication. The URL serialization
 * produced by `new URL(...).href` is used as written: paths, queries and
 * fragments are preserved, and `http:` and `https:` never merge. Returns `null`
 * when the target previously classified as HTTP(S) cannot be parsed as a URL.
 */
export function normalizeExternalTarget(rawTarget: string): string | null {
  try {
    return new URL(rawTarget.trim()).href;
  } catch {
    return null;
  }
}

/**
 * Checks every occurrence once per distinct normalized target, sharing the
 * result among duplicate occurrences. Targets are checked with at most
 * `concurrency` requests in flight and results stay in first-occurrence order,
 * independent of response completion order.
 */
export async function checkExternalOccurrences(
  occurrences: readonly ExternalOccurrence[],
  options: ExternalCheckOptions = {},
): Promise<ExternalCheckOutcome> {
  const fetchFunction = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_EXTERNAL_TIMEOUT_MS);
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_EXTERNAL_MAX_ATTEMPTS);
  const concurrency = positiveInteger(options.concurrency, DEFAULT_EXTERNAL_CONCURRENCY);

  const targets: string[] = [];
  const invalid: boolean[] = [];
  const occurrenceTarget: number[] = [];
  const targetIndex = new Map<string, number>();

  for (const occurrence of occurrences) {
    const trimmed = occurrence.target.trim();
    const normalized = normalizeExternalTarget(trimmed);
    const key = normalized === null ? `invalid\0${trimmed}` : normalized;
    let index = targetIndex.get(key);
    if (index === undefined) {
      index = targets.length;
      targetIndex.set(key, index);
      targets.push(normalized ?? trimmed);
      invalid.push(normalized === null);
    }
    occurrenceTarget.push(index);
  }

  const results: Array<ExternalTargetResult | undefined> = targets.map((target, index) =>
    invalid[index] === true
      ? { target, status: 'failed', attempts: 0, failureKind: 'invalid-url' }
      : undefined,
  );

  const checkable: number[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (invalid[index] !== true) {
      checkable.push(index);
    }
  }

  await runWithConcurrency(checkable, concurrency, async (index) => {
    results[index] = await checkTarget(
      targets[index] ?? '',
      fetchFunction,
      timeoutMs,
      maxAttempts,
    );
  });

  return {
    results: results.map((result, index) => {
      if (result === undefined) {
        // Every checkable target is assigned exactly once by the pool above.
        throw new Error(`external check produced no result for "${targets[index] ?? ''}"`);
      }
      return result;
    }),
    byOccurrence: occurrenceTarget.map((index) => results[index]!),
  };
}

/** One observation from a single fetch attempt. */
type AttemptObservation =
  | { kind: 'response'; status: number; finalUrl: string | undefined }
  | { kind: 'timeout' }
  | { kind: 'network' };

/**
 * Performs one GET attempt with a fresh timeout signal. The timer is always
 * cleared; the response body is released so keep-alive sockets are not left
 * waiting on unread data.
 */
async function attemptRequest(
  target: string,
  fetchFunction: FetchLike,
  timeoutMs: number,
): Promise<AttemptObservation> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchFunction(target, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const finalUrl = response.url === '' ? undefined : response.url;
    try {
      await response.body?.cancel();
    } catch {
      // Releasing the body is best effort; the HTTP outcome is already known.
    }
    return { kind: 'response', status: response.status, finalUrl };
  } catch {
    return timedOut ? { kind: 'timeout' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Applies the bounded retry policy and returns the final structured outcome. */
async function checkTarget(
  target: string,
  fetchFunction: FetchLike,
  timeoutMs: number,
  maxAttempts: number,
): Promise<ExternalTargetResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const observation = await attemptRequest(target, fetchFunction, timeoutMs);

    if (observation.kind === 'response') {
      const httpStatus = observation.status;
      if (httpStatus >= 200 && httpStatus <= 399) {
        return {
          target,
          status: 'succeeded',
          attempts: attempt,
          httpStatus,
          ...(observation.finalUrl === undefined ? {} : { finalUrl: observation.finalUrl }),
        };
      }

      if (isRetryableStatus(httpStatus) && attempt < maxAttempts) {
        continue;
      }

      return {
        target,
        status: 'failed',
        attempts: attempt,
        httpStatus,
        ...(observation.finalUrl === undefined ? {} : { finalUrl: observation.finalUrl }),
        failureKind: 'http',
      };
    }

    if (attempt < maxAttempts) {
      continue;
    }

    return { target, status: 'failed', attempts: attempt, failureKind: observation.kind };
  }

  // Unreachable for maxAttempts >= 1, which positiveInteger guarantees.
  return { target, status: 'failed', attempts: maxAttempts, failureKind: 'network' };
}

/** Retry network failures are handled by the caller; statuses are retryable here. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Runs `worker` over `items` with at most `limit` calls in flight. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];

  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async () => {
        while (true) {
          const itemIndex = nextIndex;
          nextIndex += 1;
          if (itemIndex >= items.length) {
            return;
          }
          await worker(items[itemIndex]!);
        }
      })(),
    );
  }

  await Promise.all(workers);
}

/** Returns a positive integer option, or the fallback for missing/invalid input. */
function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}
