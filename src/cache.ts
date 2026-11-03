import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Version of the persistent external-result cache document. */
export const EXTERNAL_CACHE_SCHEMA_VERSION = 1;

/** How long a cache entry stays fresh: 24 hours. */
export const EXTERNAL_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1_000;

/** Maximum cache file size read or written: 5 MiB. */
export const EXTERNAL_CACHE_MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Maximum number of entries kept in the cache: 10,000. */
export const EXTERNAL_CACHE_MAX_ENTRIES = 10_000;

/** Maximum length of a cache key or final URL: 8 KiB. */
export const EXTERNAL_CACHE_MAX_URL_LENGTH = 8 * 1024;

/**
 * Allowed clock skew for a cache timestamp slightly in the future. A larger
 * future date is not fresh and triggers one live refresh.
 */
export const EXTERNAL_CACHE_CLOCK_SKEW_MS = 60_000;

/** Highest attempt count accepted from a cache document. */
const MAX_CACHED_ATTEMPTS = 1_000;

/** The two outcomes that are safe to persist across invocations. */
export type ExternalCacheOutcome = 'succeeded' | 'permanent-failure';

/** One bounded, structured cache entry. */
export interface ExternalCacheEntry {
  /** Epoch milliseconds when the live check finished. */
  checkedAt: number;
  outcome: ExternalCacheOutcome;
  /** Final HTTP status, when a response was received. */
  httpStatus?: number;
  /** Sanitized final URL, when a response was received. */
  finalUrl?: string;
  /** Attempts used by the cached live check, always at least one. */
  attempts: number;
}

/** Why a cache document could not be used as stored. */
export type ExternalCacheState =
  | 'ok'
  | 'missing'
  | 'malformed'
  | 'oversized'
  | 'wrong-version'
  | 'unreadable';

/** The usable cache entries and the state of the document that held them. */
export interface LoadedExternalCache {
  state: ExternalCacheState;
  entries: Map<string, ExternalCacheEntry>;
}

/** The platform-specific default cache path, or null when none is safe. */
export function resolveExternalCachePath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory?: string,
): string | null {
  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA;
    if (typeof localAppData === 'string' && isWindowsAbsolute(localAppData)) {
      const base = localAppData.replace(/[\\/]+$/, '');
      return `${base}\\md-link-check\\external-v1.json`;
    }
    return null;
  }

  const cacheHome = environment.XDG_CACHE_HOME;
  if (typeof cacheHome === 'string' && isAbsolute(cacheHome)) {
    return join(cacheHome, 'md-link-check', 'external-v1.json');
  }

  const home = homeDirectory !== undefined ? homeDirectory : environment.HOME ?? defaultHome();
  if (typeof home === 'string' && isAbsolute(home)) {
    return join(home, '.cache', 'md-link-check', 'external-v1.json');
  }
  return null;
}

function defaultHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/** True for an absolute drive-letter path such as `C:\Users\owner`. */
function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * The canonical persistent-cache key for a normalized HTTP(S) URL.
 *
 * The fragment is dropped because it is never sent to the server, so URLs that
 * differ only by fragment share one cache entry. HTTP and HTTPS, hostnames,
 * effective ports, paths and queries stay distinct. Credential-bearing URLs
 * return null: they are checked when external checking is enabled but are never
 * persisted.
 */
export function externalCacheKey(normalizedTarget: string): string | null {
  let url: URL;
  try {
    url = new URL(normalizedTarget);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  url.hash = '';
  const key = url.href;
  return key.length <= EXTERNAL_CACHE_MAX_URL_LENGTH ? key : null;
}

/**
 * Reads the cache document with finite bounds. A missing, malformed,
 * oversized, unreadable or wrong-version document yields an empty map; valid
 * entries are kept even when other entries in the same document are invalid.
 */
export function loadExternalCache(cachePath: string): LoadedExternalCache {
  const empty = (state: ExternalCacheState): LoadedExternalCache => ({
    state,
    entries: new Map(),
  });

  let descriptor: number;
  try {
    descriptor = openSync(cachePath, 'r');
  } catch (error) {
    if (isMissingFile(error)) {
      return empty('missing');
    }
    return empty('unreadable');
  }

  let raw: string;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      return empty('unreadable');
    }
    if (stats.size > EXTERNAL_CACHE_MAX_FILE_BYTES) {
      return empty('oversized');
    }
    if (stats.size === 0) {
      return empty('malformed');
    }
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) {
        return empty('malformed');
      }
      offset += read;
    }
    raw = buffer.toString('utf8');
  } catch {
    return empty('unreadable');
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The document was already read; a failed close is not user-visible.
    }
  }

  return parseExternalCache(raw);
}

function parseExternalCache(raw: string): LoadedExternalCache {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { state: 'malformed', entries: new Map() };
  }

  if (!isRecord(document)) {
    return { state: 'malformed', entries: new Map() };
  }
  if (document.version !== EXTERNAL_CACHE_SCHEMA_VERSION) {
    return { state: 'wrong-version', entries: new Map() };
  }
  if (!isRecord(document.entries)) {
    return { state: 'malformed', entries: new Map() };
  }

  const entries = new Map<string, ExternalCacheEntry>();
  let inspected = 0;
  for (const key of Object.keys(document.entries)) {
    if (inspected >= EXTERNAL_CACHE_MAX_ENTRIES) {
      break;
    }
    inspected += 1;
    const entry = parseCacheEntry(document.entries[key]);
    if (entry !== null && isValidCacheKey(key)) {
      entries.set(key, entry);
    }
  }
  return { state: 'ok', entries };
}

function parseCacheEntry(value: unknown): ExternalCacheEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.checkedAt !== 'string') {
    return null;
  }
  const checkedAt = Date.parse(value.checkedAt);
  if (!Number.isFinite(checkedAt)) {
    return null;
  }
  if (value.outcome !== 'succeeded' && value.outcome !== 'permanent-failure') {
    return null;
  }
  if (
    typeof value.attempts !== 'number' ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 1 ||
    value.attempts > MAX_CACHED_ATTEMPTS
  ) {
    return null;
  }

  let httpStatus: number | undefined;
  if (value.httpStatus !== undefined) {
    if (
      typeof value.httpStatus !== 'number' ||
      !Number.isInteger(value.httpStatus) ||
      value.httpStatus < 100 ||
      value.httpStatus > 599
    ) {
      return null;
    }
    httpStatus = value.httpStatus;
  }

  let finalUrl: string | undefined;
  if (value.finalUrl !== undefined) {
    if (typeof value.finalUrl !== 'string') {
      return null;
    }
    const sanitized = sanitizeFinalUrl(value.finalUrl);
    if (sanitized === null) {
      return null;
    }
    finalUrl = sanitized;
  }

  if (value.outcome === 'succeeded') {
    if (httpStatus === undefined || httpStatus < 200 || httpStatus > 399) {
      return null;
    }
  } else if (
    httpStatus === undefined ||
    httpStatus < 400 ||
    httpStatus > 499 ||
    isRetryableHttpStatus(httpStatus)
  ) {
    return null;
  }

  return {
    checkedAt,
    outcome: value.outcome,
    attempts: value.attempts,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(finalUrl === undefined ? {} : { finalUrl }),
  };
}

function isValidCacheKey(key: string): boolean {
  if (key.length === 0 || key.length > EXTERNAL_CACHE_MAX_URL_LENGTH) {
    return false;
  }
  return externalCacheKey(key) === key;
}

/** Removes credentials and rejects values that are not bounded HTTP(S) URLs. */
export function sanitizeFinalUrl(value: string): string | null {
  if (value.length === 0 || value.length > EXTERNAL_CACHE_MAX_URL_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  url.username = '';
  url.password = '';
  const sanitized = url.href;
  return sanitized.length <= EXTERNAL_CACHE_MAX_URL_LENGTH ? sanitized : null;
}

/**
 * True when an entry may be used without a request: a finite non-negative age
 * (allowing small clock skew) no greater than the freshness period. The exact
 * boundary is inclusive: an entry exactly `freshnessMs` old is still fresh.
 */
export function isFreshExternalCacheEntry(
  entry: ExternalCacheEntry,
  now: number,
  freshnessMs: number,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(entry.checkedAt)) {
    return false;
  }
  const age = now - entry.checkedAt;
  if (age < -EXTERNAL_CACHE_CLOCK_SKEW_MS) {
    return false;
  }
  return age <= freshnessMs;
}

/**
 * Persists the still-fresh entries atomically and deterministically.
 *
 * Stale and invalid entries are pruned, the newest entries win when the entry
 * or byte ceiling is exceeded, keys are written in sorted order, and the
 * document is only ever visible as a complete file: it is written to a
 * same-directory temporary file and renamed over the cache path. Any failure
 * returns false after removing the temporary file; no error is thrown.
 */
export function saveExternalCache(
  cachePath: string,
  entries: ReadonlyMap<string, ExternalCacheEntry>,
  now: number,
  freshnessMs: number,
): boolean {
  const directory = dirname(cachePath);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }

  const kept: Array<{ key: string; entry: ExternalCacheEntry }> = [];
  for (const [key, entry] of entries) {
    if (!isValidCacheKey(key)) {
      continue;
    }
    if (!isFreshExternalCacheEntry(entry, now, freshnessMs)) {
      continue;
    }
    kept.push({ key, entry });
  }

  if (kept.length === 0) {
    return false;
  }

  kept.sort(
    (left, right) =>
      right.entry.checkedAt - left.entry.checkedAt || compareStrings(left.key, right.key),
  );

  const fitting = fitEntries(kept);
  if (fitting.length === 0) {
    return false;
  }
  const sorted = [...fitting].sort((left, right) => compareStrings(left.key, right.key));
  const serialized = serializeEntries(sorted);
  if (Buffer.byteLength(serialized, 'utf8') > EXTERNAL_CACHE_MAX_FILE_BYTES) {
    return false;
  }
  return writeAtomically(cachePath, serialized);
}

/** Finds the largest newest-first prefix whose serialized form fits the byte cap. */
function fitEntries(
  newestFirst: ReadonlyArray<{ key: string; entry: ExternalCacheEntry }>,
): Array<{ key: string; entry: ExternalCacheEntry }> {
  let low = 0;
  let high = Math.min(newestFirst.length, EXTERNAL_CACHE_MAX_ENTRIES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = newestFirst.slice(0, middle);
    const serialized = serializeEntries(candidate);
    if (Buffer.byteLength(serialized, 'utf8') <= EXTERNAL_CACHE_MAX_FILE_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return newestFirst.slice(0, low);
}

function serializeEntries(
  entries: ReadonlyArray<{ key: string; entry: ExternalCacheEntry }>,
): string {
  const documentEntries: Record<string, unknown> = {};
  for (const { key, entry } of entries) {
    documentEntries[key] = {
      checkedAt: new Date(entry.checkedAt).toISOString(),
      outcome: entry.outcome,
      ...(entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus }),
      ...(entry.finalUrl === undefined ? {} : { finalUrl: entry.finalUrl }),
      attempts: entry.attempts,
    };
  }
  return `${JSON.stringify(
    { version: EXTERNAL_CACHE_SCHEMA_VERSION, entries: documentEntries },
    null,
    2,
  )}\n`;
}

function writeAtomically(cachePath: string, contents: string): boolean {
  const temporaryPath = join(
    dirname(cachePath),
    `.external-v1.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    const buffer = Buffer.from(contents, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(descriptor, buffer, offset, buffer.length - offset);
    }
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, cachePath);
    return true;
  } catch {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Best effort: the write already failed.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may never have been created.
    }
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
