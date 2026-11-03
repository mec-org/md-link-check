import type { LinkKind } from './parser.js';
import {
  EXTERNAL_CACHE_FRESHNESS_MS,
  externalCacheKey,
  isFreshExternalCacheEntry,
  loadExternalCache,
  sanitizeFinalUrl,
  saveExternalCache,
  type ExternalCacheEntry,
} from './cache.js';
import { BoundedRequestScheduler, MAX_PER_HOST_DELAY_MS } from './scheduler.js';

/**
 * The part of the built-in `fetch` the external checker needs. Tests inject
 * their own implementation; production uses `globalThis.fetch`.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Default timeout for one external HTTP request (attempt or redirect hop), in milliseconds. */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 5_000;

/** Default total attempts per distinct external target: the first plus one retry. */
export const DEFAULT_EXTERNAL_MAX_ATTEMPTS = 2;

/** Default number of distinct external requests in flight across all hosts. */
export const DEFAULT_EXTERNAL_CONCURRENCY = 4;

/** Default number of requests in flight to one host origin. */
export const DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY = 1;

/** Default minimum delay between starts to the same host, in milliseconds. */
export const DEFAULT_EXTERNAL_PER_HOST_DELAY_MS = 0;

/** Finite ceiling applied to any internal per-host start delay. */
export const MAX_EXTERNAL_PER_HOST_DELAY_MS = MAX_PER_HOST_DELAY_MS;

/** Default maximum number of redirects followed for one attempt. */
export const DEFAULT_EXTERNAL_MAX_REDIRECTS = 5;

/** Why a distinct external target ended as a failure. */
export type ExternalFailureKind =
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid-url'
  | 'redirect'
  | 'invalid-redirect';

/** Where a structured result came from when persistent caching is active. */
export type ExternalResultSource = 'cache' | 'network';

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
  /** Requests performed in this invocation; 0 for cache hits and invalid URLs. */
  attempts: number;
  /** Final HTTP status after redirects, when a response was received. */
  httpStatus?: number;
  /** Final URL after redirects, when a response was received. */
  finalUrl?: string;
  /** Present only for failed results. */
  failureKind?: ExternalFailureKind;
  /** Number of followed redirects when a redirect limit was hit. */
  redirectCount?: number;
  /** Present only when persistent caching is active for this invocation. */
  source?: ExternalResultSource;
}

/** Additive cache counters for one checking run. */
export interface ExternalCacheSummary {
  /** Whether a persistent cache document was configured for this run. */
  enabled: boolean;
  /** Distinct targets answered from a fresh cache entry. */
  hits: number;
  /** Distinct targets with no usable entry that needed a live check. */
  misses: number;
  /** Distinct targets whose entry was stale or invalid and needed a refresh. */
  stale: number;
}

/**
 * Internal knobs for the external checker; production uses the exported
 * defaults. Tests inject fetch, clock, sleeper, cache path and limits; none of
 * these are CLI flags.
 */
export interface ExternalCheckOptions {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Global concurrency limit across all hosts. */
  concurrency?: number;
  perHostConcurrency?: number;
  perHostDelayMs?: number;
  maxRedirects?: number;
  /** Absolute cache path; `false` (or omitted in the core API) disables caching. */
  cachePath?: string | false;
  cacheFreshnessMs?: number;
}

/** Structured external results for one checking run. */
export interface ExternalCheckOutcome {
  /** One result per distinct target, ordered by first source occurrence. */
  results: ExternalTargetResult[];
  /** One result per occurrence, aligned with the occurrence list passed in. */
  byOccurrence: ExternalTargetResult[];
  /** Additive cache counters; disabled caching reports zeros. */
  cache: ExternalCacheSummary;
}

/** One distinct network target after source deduplication. */
interface TargetPlan {
  /** Value reported in structured results: normalized URL or trimmed target. */
  displayTarget: string;
  /** URL used for live requests, without the fragment; null when invalid. */
  requestTarget: string | null;
  /** Persistent cache key without the fragment; null when not cacheable. */
  cacheKey: string | null;
}

/**
 * Normalizes an HTTP(S) target for request deduplication. The URL serialization
 * produced by `new URL(...).href` is used as written: paths and queries are
 * preserved, and `http:` and `https:` never merge. Returns `null` when the
 * target previously classified as HTTP(S) cannot be parsed as a URL.
 */
export function normalizeExternalTarget(rawTarget: string): string | null {
  try {
    return new URL(rawTarget.trim()).href;
  } catch {
    return null;
  }
}

/**
 * Checks every occurrence once per distinct network target, sharing the result
 * among duplicate occurrences. Targets are deduplicated by their normalized URL
 * with the fragment removed, cache hits are resolved before any request is
 * scheduled, and results stay in first-occurrence order independent of response
 * completion order. All requests, retries and redirect hops share one bounded
 * scheduler and one per-invocation cache snapshot.
 */
export async function checkExternalOccurrences(
  occurrences: readonly ExternalOccurrence[],
  options: ExternalCheckOptions = {},
): Promise<ExternalCheckOutcome> {
  const fetchFunction = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_EXTERNAL_TIMEOUT_MS);
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_EXTERNAL_MAX_ATTEMPTS);
  const concurrency = positiveInteger(options.concurrency, DEFAULT_EXTERNAL_CONCURRENCY);
  const perHostConcurrency = positiveInteger(
    options.perHostConcurrency,
    DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY,
  );
  const maxRedirects = positiveInteger(options.maxRedirects, DEFAULT_EXTERNAL_MAX_REDIRECTS);
  const perHostDelayMs = boundedDelay(options.perHostDelayMs);
  const cacheFreshnessMs = positiveInteger(
    options.cacheFreshnessMs,
    EXTERNAL_CACHE_FRESHNESS_MS,
  );
  const now = clockOption(options.now);
  const sleep = options.sleep ?? defaultSleep;
  const cachePath =
    typeof options.cachePath === 'string' && options.cachePath !== ''
      ? options.cachePath
      : null;

  const { targets, occurrenceTarget, invalid } = groupOccurrences(occurrences);
  const checkable: number[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (invalid[index] !== true) {
      checkable.push(index);
    }
  }

  const cache: ExternalCacheSummary = {
    enabled: cachePath !== null,
    hits: 0,
    misses: 0,
    stale: 0,
  };
  let cacheEntries = new Map<string, ExternalCacheEntry>();
  if (cachePath !== null && checkable.length > 0) {
    cacheEntries = loadExternalCache(cachePath).entries;
  }

  const results: Array<ExternalTargetResult | undefined> = targets.map((plan, index) =>
    invalid[index] === true
      ? { target: plan.displayTarget, status: 'failed', attempts: 0, failureKind: 'invalid-url' }
      : undefined,
  );

  const scheduler = new BoundedRequestScheduler({
    globalConcurrency: concurrency,
    perHostConcurrency,
    perHostDelayMs,
    now,
    sleep,
  });

  let cacheDirty = false;
  const work: Promise<void>[] = [];

  for (const index of checkable) {
    const plan = targets[index];
    if (plan === undefined || plan.requestTarget === null) {
      continue;
    }
    const requestTarget = plan.requestTarget;

    if (cachePath !== null) {
      const entry = plan.cacheKey === null ? undefined : cacheEntries.get(plan.cacheKey);
      if (entry !== undefined && isFreshExternalCacheEntry(entry, now(), cacheFreshnessMs)) {
        cache.hits += 1;
        results[index] = cachedResult(plan.displayTarget, entry);
        continue;
      }
      if (entry !== undefined) {
        cache.stale += 1;
      } else {
        cache.misses += 1;
      }
    }

    work.push(
      (async () => {
        const result = await checkTarget(requestTarget, {
          fetchFunction,
          scheduler,
          timeoutMs,
          maxAttempts,
          maxRedirects,
        });
        // Requests use the fragment-free network key; structured results keep
        // the first source occurrence's normalized target, including fragment.
        result.target = plan.displayTarget;
        if (cachePath !== null) {
          if (result.attempts > 0) {
            result.source = 'network';
          }
          const entry = plan.cacheKey === null ? null : cacheEntryFor(result, now());
          if (entry !== null && plan.cacheKey !== null) {
            cacheEntries.set(plan.cacheKey, entry);
            cacheDirty = true;
          }
        }
        results[index] = result;
      })(),
    );
  }

  await Promise.all(work);

  if (cachePath !== null && cacheDirty) {
    saveExternalCache(cachePath, cacheEntries, now(), cacheFreshnessMs);
  }

  return {
    results: results.map((result, index) => {
      if (result === undefined) {
        throw new Error(
          `external check produced no result for "${targets[index]?.displayTarget ?? ''}"`,
        );
      }
      return result;
    }),
    byOccurrence: occurrenceTarget.map((index) => {
      const result = results[index];
      if (result === undefined) {
        throw new Error('external check produced no result for a source occurrence');
      }
      return result;
    }),
    cache,
  };
}

/** Groups occurrences by normalized network target, preserving first occurrence. */
function groupOccurrences(occurrences: readonly ExternalOccurrence[]): {
  targets: TargetPlan[];
  occurrenceTarget: number[];
  invalid: boolean[];
} {
  const targets: TargetPlan[] = [];
  const invalid: boolean[] = [];
  const occurrenceTarget: number[] = [];
  const targetIndex = new Map<string, number>();

  for (const occurrence of occurrences) {
    const trimmed = occurrence.target.trim();
    const normalized = normalizeExternalTarget(trimmed);
    const requestTarget = normalized === null ? null : networkKeyOf(normalized);
    const cacheKey = normalized === null ? null : externalCacheKey(normalized);
    const key = requestTarget === null ? `invalid\0${trimmed}` : requestTarget;
    let index = targetIndex.get(key);
    if (index === undefined) {
      index = targets.length;
      targetIndex.set(key, index);
      targets.push({
        displayTarget: normalized ?? trimmed,
        requestTarget,
        cacheKey,
      });
      invalid.push(normalized === null);
    }
    occurrenceTarget.push(index);
  }

  return { targets, occurrenceTarget, invalid };
}

/** Canonical request key: the normalized URL without its fragment. */
function networkKeyOf(normalizedTarget: string): string {
  const url = new URL(normalizedTarget);
  url.hash = '';
  return url.href;
}

/** Recreates a substantive outcome from a fresh cache entry without any request. */
function cachedResult(displayTarget: string, entry: ExternalCacheEntry): ExternalTargetResult {
  const finalUrl = entry.finalUrl === undefined ? {} : { finalUrl: entry.finalUrl };
  const httpStatus = entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus };
  if (entry.outcome === 'succeeded') {
    return {
      target: displayTarget,
      status: 'succeeded',
      attempts: 0,
      ...httpStatus,
      ...finalUrl,
      source: 'cache',
    };
  }
  return {
    target: displayTarget,
    status: 'failed',
    attempts: 0,
    ...httpStatus,
    ...finalUrl,
    failureKind: 'http',
    source: 'cache',
  };
}

/** Maps a live result to a cache entry only for the documented cacheable outcomes. */
function cacheEntryFor(
  result: ExternalTargetResult,
  checkedAt: number,
): ExternalCacheEntry | null {
  const finalUrl = sanitizeStoredFinalUrl(result.finalUrl);
  if (result.status === 'succeeded') {
    return {
      checkedAt,
      outcome: 'succeeded',
      attempts: result.attempts,
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
      ...(finalUrl === undefined ? {} : { finalUrl }),
    };
  }

  if (
    result.failureKind === 'http' &&
    result.httpStatus !== undefined &&
    result.httpStatus >= 400 &&
    result.httpStatus <= 499 &&
    !isRetryableStatus(result.httpStatus)
  ) {
    return {
      checkedAt,
      outcome: 'permanent-failure',
      attempts: result.attempts,
      httpStatus: result.httpStatus,
      ...(finalUrl === undefined ? {} : { finalUrl }),
    };
  }

  return null;
}

function sanitizeStoredFinalUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return sanitizeFinalUrl(value) ?? undefined;
}

/** One observation from a single scheduled request hop. */
type AttemptObservation =
  | {
      kind: 'response';
      status: number;
      location: string | null;
      finalUrl: string | undefined;
    }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'redirect-limit'; redirects: number; status: number; finalUrl: string | undefined }
  | { kind: 'invalid-redirect'; status: number; finalUrl: string | undefined };

/** The bounded transport context shared by one invocation's checks. */
interface TransportContext {
  fetchFunction: FetchLike;
  scheduler: BoundedRequestScheduler;
  timeoutMs: number;
  maxAttempts: number;
  maxRedirects: number;
}

/** Applies the bounded retry and redirect policy and returns the final outcome. */
async function checkTarget(
  target: string,
  context: TransportContext,
): Promise<ExternalTargetResult> {
  for (let attempt = 1; attempt <= context.maxAttempts; attempt += 1) {
    const observation = await performAttempt(target, context);

    if (observation.kind === 'response') {
      const httpStatus = observation.status;
      const finalUrl =
        observation.finalUrl === undefined ? {} : { finalUrl: observation.finalUrl };
      if (httpStatus >= 200 && httpStatus <= 399) {
        return {
          target,
          status: 'succeeded',
          attempts: attempt,
          httpStatus,
          ...finalUrl,
        };
      }
      if (isRetryableStatus(httpStatus) && attempt < context.maxAttempts) {
        continue;
      }
      return {
        target,
        status: 'failed',
        attempts: attempt,
        httpStatus,
        ...finalUrl,
        failureKind: 'http',
      };
    }

    if (observation.kind === 'redirect-limit' || observation.kind === 'invalid-redirect') {
      return {
        target,
        status: 'failed',
        attempts: attempt,
        httpStatus: observation.status,
        ...(observation.finalUrl === undefined ? {} : { finalUrl: observation.finalUrl }),
        failureKind:
          observation.kind === 'redirect-limit' ? 'redirect' : 'invalid-redirect',
        ...(observation.kind === 'redirect-limit'
          ? { redirectCount: observation.redirects }
          : {}),
      };
    }

    if (attempt < context.maxAttempts) {
      continue;
    }
    return { target, status: 'failed', attempts: attempt, failureKind: observation.kind };
  }

  // Unreachable for maxAttempts >= 1, which positiveInteger guarantees.
  return { target, status: 'failed', attempts: context.maxAttempts, failureKind: 'network' };
}

/**
 * Performs one attempt: a bounded redirect chain in which every hop is a fresh
 * request with its own timeout. A hop's timer starts only when the scheduler
 * runs it, so waiting for a global or per-host slot is never charged against
 * the request. One attempt is bounded by
 * `(maxRedirects + 1) x timeoutMs`; retries repeat that finite chain.
 */
async function performAttempt(
  startTarget: string,
  context: TransportContext,
): Promise<AttemptObservation> {
  let current = startTarget;
  let redirects = 0;

  while (true) {
    const observation = await context.scheduler.run(hostKeyOf(current), async () =>
      fetchHop(current, context.fetchFunction, context.timeoutMs),
    );

    if (observation.kind !== 'response') {
      return observation;
    }

    const location = observation.location;
    if (!isRedirectStatus(observation.status) || location === null) {
      return observation;
    }

    if (redirects >= context.maxRedirects) {
      return {
        kind: 'redirect-limit',
        redirects,
        status: observation.status,
        finalUrl: observation.finalUrl,
      };
    }

    const next = resolveRedirectTarget(location, current);
    if (next === null) {
      return {
        kind: 'invalid-redirect',
        status: observation.status,
        finalUrl: observation.finalUrl,
      };
    }
    current = next;
    redirects += 1;
  }
}

/**
 * Performs one manual-redirect GET request and releases its body. The fresh
 * timeout starts when the request runs and stops as soon as headers arrive, so
 * queued time and response-body release are not charged against it.
 */
async function fetchHop(
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
      redirect: 'manual',
      signal: controller.signal,
    });
    if (timedOut) {
      return { kind: 'timeout' };
    }
    clearTimeout(timer);
    const finalUrl = response.url === '' ? undefined : response.url;
    let location: string | null = null;
    try {
      location = response.headers.get('location');
    } catch {
      location = null;
    }
    try {
      await response.body?.cancel();
    } catch {
      // Releasing the body is best effort; the HTTP outcome is already known.
    }
    return { kind: 'response', status: response.status, location, finalUrl };
  } catch {
    return timedOut ? { kind: 'timeout' } : { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves one redirect location against the current URL, or rejects it. */
function resolveRedirectTarget(location: string, current: string): string | null {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') {
    return null;
  }
  if (next.username !== '' || next.password !== '') {
    return null;
  }
  next.hash = '';
  return next.href;
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/** Retry network failures are handled by the caller; statuses are retryable here. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Host identity for scheduling: the URL origin, including non-default ports. */
function hostKeyOf(target: string): string {
  try {
    return new URL(target).origin;
  } catch {
    return target;
  }
}

/** Returns a positive integer option, or the fallback for missing/invalid input. */
function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/** Returns a non-negative finite delay clamped to the documented ceiling. */
function boundedDelay(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_EXTERNAL_PER_HOST_DELAY_MS;
  }
  return Math.min(Math.floor(value), MAX_EXTERNAL_PER_HOST_DELAY_MS);
}

/** Wraps an injected clock so a broken clock can never produce unbounded data. */
function clockOption(now: (() => number) | undefined): () => number {
  if (now === undefined) {
    return () => Date.now();
  }
  return () => {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  };
}

/** Default sleeper for the optional per-host start delay. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
