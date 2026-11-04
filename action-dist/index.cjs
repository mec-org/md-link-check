"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/action.ts
var action_exports = {};
__export(action_exports, {
  ActionInputError: () => ActionInputError,
  buildCommandLine: () => buildCommandLine,
  createProcessIo: () => createProcessIo,
  readActionInputs: () => readActionInputs,
  runAction: () => runAction
});
module.exports = __toCommonJS(action_exports);

// src/annotation.ts
var ANNOTATION_LIMITS = Object.freeze({
  /** Maximum characters in the rendered `file` property. */
  file: 4096,
  /** Maximum characters in the rendered target part of the message. */
  target: 8192,
  /** Maximum characters in the rendered reason part of the message. */
  reason: 8192,
  /** Maximum characters in the rendered annotation message. */
  message: 16384
});
var TRUNCATION_MARKER = "…";
var DATA_CHANNEL_ESCAPES = /* @__PURE__ */ new Map([
  ["%", "%25"],
  ["\r", "%0D"],
  ["\n", "%0A"]
]);
var PROPERTY_CHANNEL_ESCAPES = new Map([
  ...DATA_CHANNEL_ESCAPES,
  [":", "%3A"],
  [",", "%2C"]
]);
function formatAnnotation(finding) {
  const file = renderBounded(
    finding.file,
    escapePropertyCharacter,
    ANNOTATION_LIMITS.file
  );
  const target = renderBounded(
    finding.target,
    escapeDataCharacter,
    ANNOTATION_LIMITS.target
  );
  const separator = " — ";
  const reasonBudget = Math.max(
    1,
    ANNOTATION_LIMITS.message - target.points - separator.length
  );
  const reason = renderBounded(
    finding.reason,
    escapeDataCharacter,
    Math.min(ANNOTATION_LIMITS.reason, reasonBudget)
  );
  return `::error file=${file.text},line=${formatSourceLine(finding.line)}::${target.text}${separator}${reason.text}`;
}
function formatAnnotations(findings) {
  return findings.map((finding) => formatAnnotation(finding));
}
function renderBounded(value, escapeCharacter, limit) {
  const atoms = [];
  let points = 0;
  let complete = true;
  for (const character of value) {
    const atom = escapeCharacter(character);
    const atomPoints = atom === character ? 1 : atom.length;
    if (points + atomPoints > limit) {
      complete = false;
      break;
    }
    atoms.push({ text: atom, points: atomPoints });
    points += atomPoints;
  }
  if (complete) {
    return { text: atoms.map((atom) => atom.text).join(""), points };
  }
  while (points > limit - TRUNCATION_MARKER.length) {
    const removed = atoms.pop();
    if (removed === void 0) {
      break;
    }
    points -= removed.points;
  }
  return {
    text: `${atoms.map((atom) => atom.text).join("")}${TRUNCATION_MARKER}`,
    points: points + TRUNCATION_MARKER.length
  };
}
function formatSourceLine(line) {
  if (!Number.isInteger(line) || line < 1) {
    throw new RangeError(`invalid broken-link line: ${String(line)}`);
  }
  return String(line);
}
function escapeDataCharacter(character) {
  return DATA_CHANNEL_ESCAPES.get(character) ?? character;
}
function escapePropertyCharacter(character) {
  return PROPERTY_CHANNEL_ESCAPES.get(character) ?? character;
}

// src/checker.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

// src/cache.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var EXTERNAL_CACHE_SCHEMA_VERSION = 1;
var EXTERNAL_CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1e3;
var EXTERNAL_CACHE_MAX_FILE_BYTES = 5 * 1024 * 1024;
var EXTERNAL_CACHE_MAX_ENTRIES = 1e4;
var EXTERNAL_CACHE_MAX_URL_LENGTH = 8 * 1024;
var EXTERNAL_CACHE_CLOCK_SKEW_MS = 6e4;
var MAX_CACHED_ATTEMPTS = 1e3;
function resolveExternalCachePath(environment = process.env, platform = process.platform, homeDirectory) {
  if (platform === "win32") {
    const localAppData = environment.LOCALAPPDATA;
    if (typeof localAppData === "string" && isWindowsAbsolute(localAppData)) {
      const base = localAppData.replace(/[\\/]+$/, "");
      return `${base}\\md-link-check\\external-v1.json`;
    }
    return null;
  }
  const cacheHome = environment.XDG_CACHE_HOME;
  if (typeof cacheHome === "string" && (0, import_node_path.isAbsolute)(cacheHome)) {
    return (0, import_node_path.join)(cacheHome, "md-link-check", "external-v1.json");
  }
  const home = homeDirectory !== void 0 ? homeDirectory : environment.HOME ?? defaultHome();
  if (typeof home === "string" && (0, import_node_path.isAbsolute)(home)) {
    return (0, import_node_path.join)(home, ".cache", "md-link-check", "external-v1.json");
  }
  return null;
}
function defaultHome() {
  try {
    return (0, import_node_os.homedir)();
  } catch {
    return void 0;
  }
}
function isWindowsAbsolute(value) {
  return /^[A-Za-z]:[\\/]/.test(value);
}
function externalCacheKey(normalizedTarget) {
  let url;
  try {
    url = new URL(normalizedTarget);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  url.hash = "";
  const key = url.href;
  return key.length <= EXTERNAL_CACHE_MAX_URL_LENGTH ? key : null;
}
function loadExternalCache(cachePath) {
  const empty = (state) => ({
    state,
    entries: /* @__PURE__ */ new Map()
  });
  let descriptor;
  try {
    descriptor = (0, import_node_fs.openSync)(cachePath, "r");
  } catch (error) {
    if (isMissingFile(error)) {
      return empty("missing");
    }
    return empty("unreadable");
  }
  let raw;
  try {
    const stats = (0, import_node_fs.fstatSync)(descriptor);
    if (!stats.isFile()) {
      return empty("unreadable");
    }
    if (stats.size > EXTERNAL_CACHE_MAX_FILE_BYTES) {
      return empty("oversized");
    }
    if (stats.size === 0) {
      return empty("malformed");
    }
    const buffer = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = (0, import_node_fs.readSync)(descriptor, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) {
        return empty("malformed");
      }
      offset += read;
    }
    raw = buffer.toString("utf8");
  } catch {
    return empty("unreadable");
  } finally {
    try {
      (0, import_node_fs.closeSync)(descriptor);
    } catch {
    }
  }
  return parseExternalCache(raw);
}
function parseExternalCache(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return { state: "malformed", entries: /* @__PURE__ */ new Map() };
  }
  if (!isRecord(document)) {
    return { state: "malformed", entries: /* @__PURE__ */ new Map() };
  }
  if (document.version !== EXTERNAL_CACHE_SCHEMA_VERSION) {
    return { state: "wrong-version", entries: /* @__PURE__ */ new Map() };
  }
  if (!isRecord(document.entries)) {
    return { state: "malformed", entries: /* @__PURE__ */ new Map() };
  }
  const entries = /* @__PURE__ */ new Map();
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
  return { state: "ok", entries };
}
function parseCacheEntry(value) {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.checkedAt !== "string") {
    return null;
  }
  const checkedAt = Date.parse(value.checkedAt);
  if (!Number.isFinite(checkedAt)) {
    return null;
  }
  if (value.outcome !== "succeeded" && value.outcome !== "permanent-failure") {
    return null;
  }
  if (typeof value.attempts !== "number" || !Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > MAX_CACHED_ATTEMPTS) {
    return null;
  }
  let httpStatus;
  if (value.httpStatus !== void 0) {
    if (typeof value.httpStatus !== "number" || !Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599) {
      return null;
    }
    httpStatus = value.httpStatus;
  }
  let finalUrl;
  if (value.finalUrl !== void 0) {
    if (typeof value.finalUrl !== "string") {
      return null;
    }
    const sanitized = sanitizeFinalUrl(value.finalUrl);
    if (sanitized === null) {
      return null;
    }
    finalUrl = sanitized;
  }
  if (value.outcome === "succeeded") {
    if (httpStatus === void 0 || httpStatus < 200 || httpStatus > 399) {
      return null;
    }
  } else if (httpStatus === void 0 || httpStatus < 400 || httpStatus > 499 || isRetryableHttpStatus(httpStatus)) {
    return null;
  }
  return {
    checkedAt,
    outcome: value.outcome,
    attempts: value.attempts,
    ...httpStatus === void 0 ? {} : { httpStatus },
    ...finalUrl === void 0 ? {} : { finalUrl }
  };
}
function isValidCacheKey(key) {
  if (key.length === 0 || key.length > EXTERNAL_CACHE_MAX_URL_LENGTH) {
    return false;
  }
  return externalCacheKey(key) === key;
}
function sanitizeFinalUrl(value) {
  if (value.length === 0 || value.length > EXTERNAL_CACHE_MAX_URL_LENGTH) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.username = "";
  url.password = "";
  const sanitized = url.href;
  return sanitized.length <= EXTERNAL_CACHE_MAX_URL_LENGTH ? sanitized : null;
}
function isFreshExternalCacheEntry(entry, now, freshnessMs) {
  if (!Number.isFinite(now) || !Number.isFinite(entry.checkedAt)) {
    return false;
  }
  const age = now - entry.checkedAt;
  if (age < -EXTERNAL_CACHE_CLOCK_SKEW_MS) {
    return false;
  }
  return age <= freshnessMs;
}
function saveExternalCache(cachePath, entries, now, freshnessMs) {
  const directory = (0, import_node_path.dirname)(cachePath);
  try {
    (0, import_node_fs.mkdirSync)(directory, { recursive: true, mode: 448 });
  } catch {
    return false;
  }
  const kept = [];
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
    (left, right) => right.entry.checkedAt - left.entry.checkedAt || compareStrings(left.key, right.key)
  );
  const fitting = fitEntries(kept);
  if (fitting.length === 0) {
    return false;
  }
  const sorted = [...fitting].sort((left, right) => compareStrings(left.key, right.key));
  const serialized = serializeEntries(sorted);
  if (Buffer.byteLength(serialized, "utf8") > EXTERNAL_CACHE_MAX_FILE_BYTES) {
    return false;
  }
  return writeAtomically(cachePath, serialized);
}
function fitEntries(newestFirst) {
  let low = 0;
  let high = Math.min(newestFirst.length, EXTERNAL_CACHE_MAX_ENTRIES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = newestFirst.slice(0, middle);
    const serialized = serializeEntries(candidate);
    if (Buffer.byteLength(serialized, "utf8") <= EXTERNAL_CACHE_MAX_FILE_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return newestFirst.slice(0, low);
}
function serializeEntries(entries) {
  const documentEntries = {};
  for (const { key, entry } of entries) {
    documentEntries[key] = {
      checkedAt: new Date(entry.checkedAt).toISOString(),
      outcome: entry.outcome,
      ...entry.httpStatus === void 0 ? {} : { httpStatus: entry.httpStatus },
      ...entry.finalUrl === void 0 ? {} : { finalUrl: entry.finalUrl },
      attempts: entry.attempts
    };
  }
  return `${JSON.stringify(
    { version: EXTERNAL_CACHE_SCHEMA_VERSION, entries: documentEntries },
    null,
    2
  )}
`;
}
function writeAtomically(cachePath, contents) {
  const temporaryPath = (0, import_node_path.join)(
    (0, import_node_path.dirname)(cachePath),
    `.external-v1.${process.pid}.${(0, import_node_crypto.randomBytes)(6).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    descriptor = (0, import_node_fs.openSync)(temporaryPath, "wx", 384);
    const buffer = Buffer.from(contents, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      offset += (0, import_node_fs.writeSync)(descriptor, buffer, offset, buffer.length - offset);
    }
    (0, import_node_fs.closeSync)(descriptor);
    descriptor = void 0;
    (0, import_node_fs.renameSync)(temporaryPath, cachePath);
    return true;
  } catch {
    if (descriptor !== void 0) {
      try {
        (0, import_node_fs.closeSync)(descriptor);
      } catch {
      }
    }
    try {
      (0, import_node_fs.unlinkSync)(temporaryPath);
    } catch {
    }
    return false;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}
function isMissingFile(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// src/scheduler.ts
var MAX_PER_HOST_DELAY_MS = 1e3;
var BoundedRequestScheduler = class {
  constructor(options) {
    this.options = options;
  }
  options;
  pending = [];
  head = 0;
  globalActive = 0;
  hostActive = /* @__PURE__ */ new Map();
  hostStart = /* @__PURE__ */ new Map();
  /** Queues one request to `hostKey`; resolves when the task settles. */
  run(hostKey, task) {
    return new Promise((resolve3, reject) => {
      this.pending.push({
        hostKey,
        task,
        resolve: resolve3,
        reject
      });
      this.pump();
    });
  }
  pump() {
    while (this.globalActive < this.options.globalConcurrency) {
      const index = this.nextEligible();
      if (index === -1) {
        this.compact();
        return;
      }
      const request = this.pending[index];
      this.pending[index] = void 0;
      this.advanceHead();
      if (request === void 0) {
        continue;
      }
      this.start(request);
    }
  }
  /** Returns the first queued request whose host has capacity, or -1. */
  nextEligible() {
    for (let index = this.head; index < this.pending.length; index += 1) {
      const request = this.pending[index];
      if (request === void 0) {
        continue;
      }
      if ((this.hostActive.get(request.hostKey) ?? 0) < this.options.perHostConcurrency) {
        return index;
      }
    }
    return -1;
  }
  advanceHead() {
    while (this.head < this.pending.length && this.pending[this.head] === void 0) {
      this.head += 1;
    }
  }
  /** Drops settled entries once they dominate the queue, keeping memory bounded. */
  compact() {
    if (this.head === 0) {
      return;
    }
    this.pending.splice(0, this.head);
    this.head = 0;
  }
  start(request) {
    this.globalActive += 1;
    this.hostActive.set(request.hostKey, (this.hostActive.get(request.hostKey) ?? 0) + 1);
    const wait = this.consumeHostWait(request.hostKey);
    if (wait > 0) {
      this.sleepThenDispatch(request, wait);
      return;
    }
    this.dispatch(request);
  }
  /** Returns the bounded per-host start wait and records the intended start. */
  consumeHostWait(hostKey) {
    if (this.options.perHostDelayMs <= 0) {
      return 0;
    }
    const now = this.now();
    const previous = this.hostStart.get(hostKey);
    if (previous === void 0) {
      this.hostStart.set(hostKey, now);
      return 0;
    }
    const remaining = this.options.perHostDelayMs - (now - previous);
    const wait = Number.isFinite(remaining) ? Math.min(Math.max(remaining, 0), MAX_PER_HOST_DELAY_MS) : 0;
    this.hostStart.set(hostKey, now + wait);
    return wait;
  }
  sleepThenDispatch(request, wait) {
    void this.options.sleep(wait).then(
      () => {
        this.dispatch(request);
      },
      (error) => {
        this.settle(request, false, error);
      }
    );
  }
  /**
   * Starts the task in a microtask. Deferring the call keeps a task that throws
   * synchronously from recursing through the scheduler, and a task that returns
   * a rejected promise is handled by the same settlement path.
   */
  dispatch(request) {
    void Promise.resolve().then(() => request.task()).then(
      (value) => {
        this.settle(request, true, value);
      },
      (error) => {
        this.settle(request, false, error);
      }
    );
  }
  settle(request, succeeded, value) {
    this.globalActive -= 1;
    const active = (this.hostActive.get(request.hostKey) ?? 0) - 1;
    if (active <= 0) {
      this.hostActive.delete(request.hostKey);
    } else {
      this.hostActive.set(request.hostKey, active);
    }
    if (succeeded) {
      request.resolve(value);
    } else {
      request.reject(value);
    }
    this.pump();
  }
  now() {
    const value = this.options.now();
    return Number.isFinite(value) ? value : 0;
  }
};

// src/external.ts
var DEFAULT_EXTERNAL_TIMEOUT_MS = 5e3;
var DEFAULT_EXTERNAL_MAX_ATTEMPTS = 2;
var DEFAULT_EXTERNAL_CONCURRENCY = 4;
var DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY = 1;
var DEFAULT_EXTERNAL_PER_HOST_DELAY_MS = 0;
var MAX_EXTERNAL_PER_HOST_DELAY_MS = MAX_PER_HOST_DELAY_MS;
var DEFAULT_EXTERNAL_MAX_REDIRECTS = 5;
function normalizeExternalTarget(rawTarget) {
  try {
    return new URL(rawTarget.trim()).href;
  } catch {
    return null;
  }
}
async function checkExternalOccurrences(occurrences, options = {}) {
  const fetchFunction = options.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_EXTERNAL_TIMEOUT_MS);
  const maxAttempts = positiveInteger(options.maxAttempts, DEFAULT_EXTERNAL_MAX_ATTEMPTS);
  const concurrency = positiveInteger(options.concurrency, DEFAULT_EXTERNAL_CONCURRENCY);
  const perHostConcurrency = positiveInteger(
    options.perHostConcurrency,
    DEFAULT_EXTERNAL_PER_HOST_CONCURRENCY
  );
  const maxRedirects = positiveInteger(options.maxRedirects, DEFAULT_EXTERNAL_MAX_REDIRECTS);
  const perHostDelayMs = boundedDelay(options.perHostDelayMs);
  const cacheFreshnessMs = positiveInteger(
    options.cacheFreshnessMs,
    EXTERNAL_CACHE_FRESHNESS_MS
  );
  const now = clockOption(options.now);
  const sleep = options.sleep ?? defaultSleep;
  const cachePath = typeof options.cachePath === "string" && options.cachePath !== "" ? options.cachePath : null;
  const { targets, occurrenceTarget, invalid } = groupOccurrences(occurrences);
  const checkable = [];
  for (let index = 0; index < targets.length; index += 1) {
    if (invalid[index] !== true) {
      checkable.push(index);
    }
  }
  const cache = {
    enabled: cachePath !== null,
    hits: 0,
    misses: 0,
    stale: 0
  };
  let cacheEntries = /* @__PURE__ */ new Map();
  if (cachePath !== null && checkable.length > 0) {
    cacheEntries = loadExternalCache(cachePath).entries;
  }
  const results = targets.map(
    (plan, index) => invalid[index] === true ? { target: plan.displayTarget, status: "failed", attempts: 0, failureKind: "invalid-url" } : void 0
  );
  const scheduler = new BoundedRequestScheduler({
    globalConcurrency: concurrency,
    perHostConcurrency,
    perHostDelayMs,
    now,
    sleep
  });
  let cacheDirty = false;
  const work = [];
  for (const index of checkable) {
    const plan = targets[index];
    if (plan === void 0 || plan.requestTarget === null) {
      continue;
    }
    const requestTarget = plan.requestTarget;
    if (cachePath !== null) {
      const entry = plan.cacheKey === null ? void 0 : cacheEntries.get(plan.cacheKey);
      if (entry !== void 0 && isFreshExternalCacheEntry(entry, now(), cacheFreshnessMs)) {
        cache.hits += 1;
        results[index] = cachedResult(plan.displayTarget, entry);
        continue;
      }
      if (entry !== void 0) {
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
          maxRedirects
        });
        result.target = plan.displayTarget;
        if (cachePath !== null) {
          if (result.attempts > 0) {
            result.source = "network";
          }
          const entry = plan.cacheKey === null ? null : cacheEntryFor(result, now());
          if (entry !== null && plan.cacheKey !== null) {
            cacheEntries.set(plan.cacheKey, entry);
            cacheDirty = true;
          }
        }
        results[index] = result;
      })()
    );
  }
  await Promise.all(work);
  if (cachePath !== null && cacheDirty) {
    saveExternalCache(cachePath, cacheEntries, now(), cacheFreshnessMs);
  }
  return {
    results: results.map((result, index) => {
      if (result === void 0) {
        throw new Error(
          `external check produced no result for "${targets[index]?.displayTarget ?? ""}"`
        );
      }
      return result;
    }),
    byOccurrence: occurrenceTarget.map((index) => {
      const result = results[index];
      if (result === void 0) {
        throw new Error("external check produced no result for a source occurrence");
      }
      return result;
    }),
    cache
  };
}
function groupOccurrences(occurrences) {
  const targets = [];
  const invalid = [];
  const occurrenceTarget = [];
  const targetIndex = /* @__PURE__ */ new Map();
  for (const occurrence of occurrences) {
    const trimmed = occurrence.target.trim();
    const normalized = normalizeExternalTarget(trimmed);
    const requestTarget = normalized === null ? null : networkKeyOf(normalized);
    const cacheKey = normalized === null ? null : externalCacheKey(normalized);
    const key = requestTarget === null ? `invalid\0${trimmed}` : requestTarget;
    let index = targetIndex.get(key);
    if (index === void 0) {
      index = targets.length;
      targetIndex.set(key, index);
      targets.push({
        displayTarget: normalized ?? trimmed,
        requestTarget,
        cacheKey
      });
      invalid.push(normalized === null);
    }
    occurrenceTarget.push(index);
  }
  return { targets, occurrenceTarget, invalid };
}
function networkKeyOf(normalizedTarget) {
  const url = new URL(normalizedTarget);
  url.hash = "";
  return url.href;
}
function cachedResult(displayTarget, entry) {
  const finalUrl = entry.finalUrl === void 0 ? {} : { finalUrl: entry.finalUrl };
  const httpStatus = entry.httpStatus === void 0 ? {} : { httpStatus: entry.httpStatus };
  if (entry.outcome === "succeeded") {
    return {
      target: displayTarget,
      status: "succeeded",
      attempts: 0,
      ...httpStatus,
      ...finalUrl,
      source: "cache"
    };
  }
  return {
    target: displayTarget,
    status: "failed",
    attempts: 0,
    ...httpStatus,
    ...finalUrl,
    failureKind: "http",
    source: "cache"
  };
}
function cacheEntryFor(result, checkedAt) {
  const finalUrl = sanitizeStoredFinalUrl(result.finalUrl);
  if (result.status === "succeeded") {
    return {
      checkedAt,
      outcome: "succeeded",
      attempts: result.attempts,
      ...result.httpStatus === void 0 ? {} : { httpStatus: result.httpStatus },
      ...finalUrl === void 0 ? {} : { finalUrl }
    };
  }
  if (result.failureKind === "http" && result.httpStatus !== void 0 && result.httpStatus >= 400 && result.httpStatus <= 499 && !isRetryableStatus(result.httpStatus)) {
    return {
      checkedAt,
      outcome: "permanent-failure",
      attempts: result.attempts,
      httpStatus: result.httpStatus,
      ...finalUrl === void 0 ? {} : { finalUrl }
    };
  }
  return null;
}
function sanitizeStoredFinalUrl(value) {
  if (value === void 0) {
    return void 0;
  }
  return sanitizeFinalUrl(value) ?? void 0;
}
async function checkTarget(target, context) {
  for (let attempt = 1; attempt <= context.maxAttempts; attempt += 1) {
    const observation = await performAttempt(target, context);
    if (observation.kind === "response") {
      const httpStatus = observation.status;
      const finalUrl = observation.finalUrl === void 0 ? {} : { finalUrl: observation.finalUrl };
      if (httpStatus >= 200 && httpStatus <= 399) {
        return {
          target,
          status: "succeeded",
          attempts: attempt,
          httpStatus,
          ...finalUrl
        };
      }
      if (isRetryableStatus(httpStatus) && attempt < context.maxAttempts) {
        continue;
      }
      return {
        target,
        status: "failed",
        attempts: attempt,
        httpStatus,
        ...finalUrl,
        failureKind: "http"
      };
    }
    if (observation.kind === "redirect-limit" || observation.kind === "invalid-redirect") {
      return {
        target,
        status: "failed",
        attempts: attempt,
        httpStatus: observation.status,
        ...observation.finalUrl === void 0 ? {} : { finalUrl: observation.finalUrl },
        failureKind: observation.kind === "redirect-limit" ? "redirect" : "invalid-redirect",
        ...observation.kind === "redirect-limit" ? { redirectCount: observation.redirects } : {}
      };
    }
    if (attempt < context.maxAttempts) {
      continue;
    }
    return { target, status: "failed", attempts: attempt, failureKind: observation.kind };
  }
  return { target, status: "failed", attempts: context.maxAttempts, failureKind: "network" };
}
async function performAttempt(startTarget, context) {
  let current = startTarget;
  let redirects = 0;
  while (true) {
    const observation = await context.scheduler.run(
      hostKeyOf(current),
      async () => fetchHop(current, context.fetchFunction, context.timeoutMs)
    );
    if (observation.kind !== "response") {
      return observation;
    }
    const location = observation.location;
    if (!isRedirectStatus(observation.status) || location === null) {
      return observation;
    }
    if (redirects >= context.maxRedirects) {
      return {
        kind: "redirect-limit",
        redirects,
        status: observation.status,
        finalUrl: observation.finalUrl
      };
    }
    const next = resolveRedirectTarget(location, current);
    if (next === null) {
      return {
        kind: "invalid-redirect",
        status: observation.status,
        finalUrl: observation.finalUrl
      };
    }
    current = next;
    redirects += 1;
  }
}
async function fetchHop(target, fetchFunction, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchFunction(target, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });
    if (timedOut) {
      return { kind: "timeout" };
    }
    clearTimeout(timer);
    const finalUrl = response.url === "" ? void 0 : response.url;
    let location = null;
    try {
      location = response.headers.get("location");
    } catch {
      location = null;
    }
    try {
      await response.body?.cancel();
    } catch {
    }
    return { kind: "response", status: response.status, location, finalUrl };
  } catch {
    return timedOut ? { kind: "timeout" } : { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}
function resolveRedirectTarget(location, current) {
  let next;
  try {
    next = new URL(location, current);
  } catch {
    return null;
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    return null;
  }
  if (next.username !== "" || next.password !== "") {
    return null;
  }
  next.hash = "";
  return next.href;
}
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500 && status <= 599;
}
function hostKeyOf(target) {
  try {
    return new URL(target).origin;
  } catch {
    return target;
  }
}
function positiveInteger(value, fallback) {
  if (value === void 0 || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}
function boundedDelay(value) {
  if (value === void 0 || !Number.isFinite(value) || value < 0) {
    return DEFAULT_EXTERNAL_PER_HOST_DELAY_MS;
  }
  return Math.min(Math.floor(value), MAX_EXTERNAL_PER_HOST_DELAY_MS);
}
function clockOption(now) {
  if (now === void 0) {
    return () => Date.now();
  }
  return () => {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  };
}
function defaultSleep(ms) {
  return new Promise((resolve3) => {
    setTimeout(resolve3, ms);
  });
}

// src/parser.ts
var SUPPORTED_HTML_TAGS = /* @__PURE__ */ new Set(["a", "img"]);
var OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
var CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
var BLANK_LINE = /^[ \t]*$/;
var INDENTED_CODE = /^(?: {4,}|\t)/;
var DEFINITION_START = /^( {0,3})\[/;
function scanMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const { masked: codeMaskedLines } = maskCodeLines(lines);
  const maskedLines = maskSupportedHtmlTags(codeMaskedLines, findHtmlTags(codeMaskedLines));
  const definitions = /* @__PURE__ */ new Map();
  const definitionLines = /* @__PURE__ */ new Set();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const definition = parseReferenceDefinition(
      lines[lineIndex] ?? "",
      maskedLines[lineIndex] ?? "",
      lineIndex + 1
    );
    if (definition === null) {
      continue;
    }
    definitionLines.add(lineIndex);
    if (!definitions.has(definition.label)) {
      definitions.set(definition.label, definition);
    }
  }
  const references = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (definitionLines.has(lineIndex)) {
      continue;
    }
    const original = lines[lineIndex] ?? "";
    const masked = maskedLines[lineIndex] ?? "";
    let index = 0;
    while (index < masked.length) {
      const imageStart = masked.charAt(index) === "!" && masked.charAt(index + 1) === "[";
      const linkStart = masked.charAt(index) === "[";
      if (!imageStart && !linkStart) {
        index += 1;
        continue;
      }
      const bracket = imageStart ? index + 1 : index;
      if (isEscaped(masked, index) || isEscaped(masked, bracket)) {
        index += 1;
        continue;
      }
      const kind = imageStart ? "image" : "link";
      const inline = parseInlineLink(masked, original, bracket);
      if (inline !== null) {
        if (inline.target !== "") {
          references.push({
            style: "inline",
            kind,
            target: inline.target,
            line: lineIndex + 1,
            column: index + 1
          });
        }
        index = inline.end;
        continue;
      }
      const reference = parseReferenceUse(
        masked,
        original,
        bracket,
        kind,
        lineIndex + 1,
        index + 1,
        definitions
      );
      if (reference !== null) {
        references.push({ style: "reference", ...reference.reference });
        index = reference.end;
        continue;
      }
      index += 1;
    }
  }
  return { references, definitions };
}
function scanHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const { masked: codeMaskedLines } = maskCodeLines(lines);
  const anchors = [];
  const references = [];
  for (const tag of findHtmlTags(codeMaskedLines)) {
    const line = tag.lineIndex + 1;
    const column = tag.start + 1;
    const original = lines[tag.lineIndex] ?? "";
    if (tag.name === "a") {
      const id = attributeValue(tag, original, "id");
      if (id !== null) {
        anchors.push({ value: id, line });
      }
      const name = attributeValue(tag, original, "name");
      if (name !== null) {
        anchors.push({ value: name, line });
      }
      const href = attributeValue(tag, original, "href");
      if (href !== null) {
        references.push({ kind: "link", target: href, line, column });
      }
      continue;
    }
    if (tag.name === "img") {
      const src = attributeValue(tag, original, "src");
      if (src !== null) {
        references.push({ kind: "image", target: src, line, column });
      }
    }
  }
  return { anchors, references };
}
function maskCodeLines(lines) {
  const masked = [];
  const codeBlock = [];
  let fence = null;
  let inIndentedCode = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence !== null) {
      masked.push(" ".repeat(line.length));
      codeBlock.push(true);
      const closing = CLOSING_FENCE.exec(line);
      const marker = closing?.[1];
      if (marker !== void 0 && marker.charAt(0) === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const opening = OPENING_FENCE.exec(line)?.[1];
    if (opening !== void 0) {
      fence = { character: opening.charAt(0), length: opening.length };
      masked.push(" ".repeat(line.length));
      codeBlock.push(true);
      inIndentedCode = false;
      continue;
    }
    if (isIndentedCodeLine(lines, index, inIndentedCode)) {
      masked.push(" ".repeat(line.length));
      codeBlock.push(true);
      inIndentedCode = true;
      continue;
    }
    inIndentedCode = false;
    masked.push(maskInlineCode(line));
    codeBlock.push(false);
  }
  return { masked, codeBlock };
}
function findHtmlTags(maskedLines) {
  const tags = [];
  for (let lineIndex = 0; lineIndex < maskedLines.length; lineIndex += 1) {
    const line = maskedLines[lineIndex] ?? "";
    let index = 0;
    while (index < line.length) {
      const start = line.indexOf("<", index);
      if (start === -1) {
        break;
      }
      const tag = parseHtmlTag(line, lineIndex, start);
      if (tag === null) {
        index = start + 1;
        continue;
      }
      tags.push(tag);
      index = tag.end + 1;
    }
  }
  return tags;
}
function parseHtmlTag(line, lineIndex, start) {
  let cursor = start + 1;
  if (!isAsciiLetter(line.charAt(cursor))) {
    return null;
  }
  const nameStart = cursor;
  cursor += 1;
  while (cursor < line.length && isHtmlTagNameCharacter(line.charAt(cursor))) {
    cursor += 1;
  }
  const name = line.slice(nameStart, cursor).toLowerCase();
  const attributesStart = cursor;
  let quote = null;
  while (cursor < line.length) {
    const character = line.charAt(cursor);
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === ">") {
      return {
        name,
        lineIndex,
        start,
        end: cursor,
        attributes: parseHtmlAttributes(line, attributesStart, cursor)
      };
    }
    cursor += 1;
  }
  return null;
}
function parseHtmlAttributes(line, start, end) {
  const attributes = /* @__PURE__ */ new Map();
  let cursor = start;
  while (cursor < end) {
    while (cursor < end && isHtmlWhitespace(line.charAt(cursor))) {
      cursor += 1;
    }
    if (cursor >= end) {
      break;
    }
    if (line.charAt(cursor) === "/") {
      cursor += 1;
      continue;
    }
    if (!isHtmlAttributeNameStartCharacter(line.charAt(cursor))) {
      cursor += 1;
      continue;
    }
    const nameStart = cursor;
    cursor += 1;
    while (cursor < end && isHtmlAttributeNameCharacter(line.charAt(cursor))) {
      cursor += 1;
    }
    const name = line.slice(nameStart, cursor).toLowerCase();
    let equalCursor = cursor;
    while (equalCursor < end && isHtmlWhitespace(line.charAt(equalCursor))) {
      equalCursor += 1;
    }
    if (line.charAt(equalCursor) !== "=") {
      if (!attributes.has(name)) {
        attributes.set(name, null);
      }
      continue;
    }
    cursor = equalCursor + 1;
    while (cursor < end && isHtmlWhitespace(line.charAt(cursor))) {
      cursor += 1;
    }
    const quote = line.charAt(cursor);
    let range = null;
    if (quote === '"' || quote === "'") {
      const valueStart = cursor + 1;
      const closing = line.indexOf(quote, valueStart);
      if (closing !== -1 && closing < end) {
        range = { start: valueStart, end: closing };
        cursor = closing + 1;
      } else {
        cursor = end;
      }
    } else if (cursor < end) {
      const valueStart = cursor;
      while (cursor < end && !isHtmlWhitespace(line.charAt(cursor))) {
        cursor += 1;
      }
      range = { start: valueStart, end: cursor };
    }
    if (!attributes.has(name)) {
      attributes.set(name, range);
    }
  }
  return attributes;
}
function attributeValue(tag, line, name) {
  const range = tag.attributes.get(name);
  if (range === void 0 || range === null) {
    return null;
  }
  const value = line.slice(range.start, range.end);
  return value === "" ? null : value;
}
function maskSupportedHtmlTags(maskedLines, tags) {
  const rangesByLine = /* @__PURE__ */ new Map();
  for (const tag of tags) {
    if (!SUPPORTED_HTML_TAGS.has(tag.name)) {
      continue;
    }
    const ranges = rangesByLine.get(tag.lineIndex);
    const range = { start: tag.start, end: tag.end };
    if (ranges === void 0) {
      rangesByLine.set(tag.lineIndex, [range]);
    } else {
      ranges.push(range);
    }
  }
  if (rangesByLine.size === 0) {
    return maskedLines;
  }
  const masked = [...maskedLines];
  for (const [lineIndex, ranges] of rangesByLine) {
    const line = masked[lineIndex] ?? "";
    let result = "";
    let cursor = 0;
    for (const range of ranges) {
      result += line.slice(cursor, range.start);
      result += " ".repeat(range.end + 1 - range.start);
      cursor = range.end + 1;
    }
    masked[lineIndex] = result + line.slice(cursor);
  }
  return masked;
}
function isAsciiLetter(character) {
  return character >= "A" && character <= "Z" || character >= "a" && character <= "z";
}
function isAsciiDigit(character) {
  return character >= "0" && character <= "9";
}
function isHtmlTagNameCharacter(character) {
  return isAsciiLetter(character) || isAsciiDigit(character) || character === "-" || character === "_" || character === ":" || character === ".";
}
function isHtmlAttributeNameStartCharacter(character) {
  return isAsciiLetter(character) || character === "_" || character === ":";
}
function isHtmlAttributeNameCharacter(character) {
  return isHtmlAttributeNameStartCharacter(character) || isAsciiDigit(character) || character === "-" || character === ".";
}
function isHtmlWhitespace(character) {
  return character === " " || character === "	" || character === "\f" || character === "\r";
}
function isIndentedCodeLine(lines, index, continuing) {
  const line = lines[index] ?? "";
  if (!INDENTED_CODE.test(line)) {
    return false;
  }
  if (continuing || index === 0) {
    return true;
  }
  return BLANK_LINE.test(lines[index - 1] ?? "");
}
function maskInlineCode(line) {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line.charAt(index) !== "`" || isEscaped(line, index)) {
      result += line.charAt(index);
      index += 1;
      continue;
    }
    const openingLength = countCharacterRun(line, index, "`");
    const closing = findClosingBackticks(line, index + openingLength, openingLength);
    if (closing === -1) {
      result += line.slice(index, index + openingLength);
      index += openingLength;
      continue;
    }
    const end = closing + openingLength;
    result += " ".repeat(end - index);
    index = end;
  }
  return result;
}
function parseReferenceDefinition(original, masked, line) {
  const start = DEFINITION_START.exec(masked);
  if (start === null) {
    return null;
  }
  const bracket = (start[1] ?? "").length;
  const labelEnd = findClosingBracket(masked, bracket);
  if (labelEnd === -1 || masked.charAt(labelEnd + 1) !== ":") {
    return null;
  }
  const rawLabel = original.slice(bracket + 1, labelEnd);
  const labelText = rawLabel.trim();
  const label = normalizeLabel(labelText);
  if (label === "" || hasUnescapedBracket(labelText)) {
    return null;
  }
  const destination = parseDefinitionDestination(masked, original, labelEnd + 2);
  if (destination === null) {
    return null;
  }
  return { label, labelText, target: destination, line, column: bracket + 1 };
}
function parseDefinitionDestination(masked, original, afterColon) {
  let cursor = afterColon;
  while (cursor < masked.length && isWhitespace(masked.charAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= masked.length) {
    return null;
  }
  let target;
  if (masked.charAt(cursor) === "<") {
    const targetStart = cursor + 1;
    cursor = targetStart;
    while (cursor < masked.length) {
      if (masked.charAt(cursor) === ">" && !isEscaped(masked, cursor)) {
        break;
      }
      cursor += 1;
    }
    if (cursor >= masked.length) {
      return null;
    }
    target = original.slice(targetStart, cursor);
    cursor += 1;
  } else {
    const targetStart = cursor;
    while (cursor < masked.length && !isWhitespace(masked.charAt(cursor))) {
      cursor += 1;
    }
    target = original.slice(targetStart, cursor);
  }
  while (cursor < masked.length && isWhitespace(masked.charAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= masked.length) {
    return target;
  }
  const opener = masked.charAt(cursor);
  if (opener !== '"' && opener !== "'" && opener !== "(") {
    return null;
  }
  const closer = opener === "(" ? ")" : opener;
  cursor += 1;
  let closed = false;
  while (cursor < masked.length) {
    const character = masked.charAt(cursor);
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    cursor += 1;
    if (character === closer) {
      closed = true;
      break;
    }
  }
  if (!closed) {
    return null;
  }
  while (cursor < masked.length && isWhitespace(masked.charAt(cursor))) {
    cursor += 1;
  }
  return cursor === masked.length ? target : null;
}
function parseReferenceUse(masked, original, bracket, kind, line, column, definitions) {
  const linkTextEnd = findClosingBracket(masked, bracket);
  if (linkTextEnd === -1) {
    return null;
  }
  const linkText = original.slice(bracket + 1, linkTextEnd);
  if (masked.charAt(linkTextEnd + 1) === "[") {
    const labelEnd = findClosingBracket(masked, linkTextEnd + 1);
    if (labelEnd === -1) {
      return null;
    }
    const rawLabel = original.slice(linkTextEnd + 2, labelEnd);
    const collapsed = rawLabel === "";
    if (!collapsed && rawLabel.trim() === "") {
      return null;
    }
    const labelText2 = (collapsed ? linkText : rawLabel).trim();
    const label2 = normalizeLabel(labelText2);
    if (label2 === "" || hasUnescapedBracket(labelText2)) {
      return null;
    }
    return {
      reference: { kind, label: label2, labelText: labelText2, line, column },
      end: labelEnd + 1
    };
  }
  const labelText = linkText.trim();
  const label = normalizeLabel(labelText);
  if (label === "" || hasUnescapedBracket(labelText) || !definitions.has(label)) {
    return null;
  }
  return {
    reference: { kind, label, labelText, line, column },
    end: linkTextEnd + 1
  };
}
function normalizeLabel(label) {
  return label.trim().replace(/[ \t]+/g, " ").toLowerCase();
}
function hasUnescapedBracket(text) {
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[" || character === "]") {
      return true;
    }
  }
  return false;
}
function parseInlineLink(masked, original, bracket) {
  const close = findClosingBracket(masked, bracket);
  if (close === -1 || masked.charAt(close + 1) !== "(") {
    return null;
  }
  let position = close + 2;
  while (position < masked.length && isWhitespace(masked.charAt(position))) {
    position += 1;
  }
  if (position >= masked.length) {
    return null;
  }
  if (masked.charAt(position) === "<") {
    const targetStart = position + 1;
    let cursor2 = targetStart;
    while (cursor2 < masked.length) {
      if (masked.charAt(cursor2) === ">" && !isEscaped(masked, cursor2)) {
        break;
      }
      cursor2 += 1;
    }
    if (cursor2 >= masked.length) {
      return null;
    }
    const end2 = parseTitleAndClosingParen(masked, cursor2 + 1);
    if (end2 === null) {
      return null;
    }
    return { target: original.slice(targetStart, cursor2), end: end2 };
  }
  let cursor = position;
  let depth = 0;
  while (cursor < masked.length) {
    const character = masked.charAt(cursor);
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === "(") {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ")") {
      if (depth === 0) {
        return { target: original.slice(position, cursor), end: cursor + 1 };
      }
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (isWhitespace(character)) {
      break;
    }
    cursor += 1;
  }
  const end = parseTitleAndClosingParen(masked, cursor);
  if (end === null) {
    return null;
  }
  return { target: original.slice(position, cursor), end };
}
function parseTitleAndClosingParen(text, start) {
  let position = start;
  while (position < text.length && isWhitespace(text.charAt(position))) {
    position += 1;
  }
  if (position >= text.length) {
    return null;
  }
  const opener = text.charAt(position);
  if (opener === ")") {
    return position + 1;
  }
  if (opener !== '"' && opener !== "'" && opener !== "(") {
    return null;
  }
  const closer = opener === "(" ? ")" : opener;
  position += 1;
  let closed = false;
  while (position < text.length) {
    const character = text.charAt(position);
    if (character === "\\") {
      position += 2;
      continue;
    }
    position += 1;
    if (character === closer) {
      closed = true;
      break;
    }
  }
  if (!closed) {
    return null;
  }
  while (position < text.length && isWhitespace(text.charAt(position))) {
    position += 1;
  }
  if (text.charAt(position) !== ")") {
    return null;
  }
  return position + 1;
}
function findClosingBracket(text, open) {
  let depth = 0;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character !== "]") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return -1;
}
function findClosingBackticks(line, start, length) {
  let index = start;
  while (index < line.length) {
    if (line.charAt(index) !== "`") {
      index += 1;
      continue;
    }
    const runLength = countCharacterRun(line, index, "`");
    if (runLength === length) {
      return index;
    }
    index += runLength;
  }
  return -1;
}
function countCharacterRun(text, start, character) {
  let length = 0;
  while (text.charAt(start + length) === character) {
    length += 1;
  }
  return length;
}
function isEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
function isWhitespace(character) {
  return character === " " || character === "	";
}

// src/headings.ts
var ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;
var SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
var CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
var THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
var BLOCK_MARKER = /^ {0,3}(?:>[ \t]?|[*+-][ \t]|\d{1,9}[.)][ \t])/;
function scanHeadings(markdown) {
  const lines = markdown.split(/\r?\n/);
  const { masked, codeBlock } = maskCodeLines(lines);
  const headings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (codeBlock[index] === true) {
      continue;
    }
    const atx = parseAtxHeading(line);
    if (atx !== null) {
      headings.push({ level: atx.level, text: atx.text, line: index + 1 });
      continue;
    }
    const underline = SETEXT_UNDERLINE.exec(lines[index + 1] ?? "");
    if (underline === null || codeBlock[index + 1] === true) {
      continue;
    }
    if (!isSetextParagraphText(line, masked[index] ?? "")) {
      continue;
    }
    const marker = underline[1] ?? "";
    headings.push({
      level: marker.charAt(0) === "=" ? 1 : 2,
      text: line.trim(),
      line: index + 1
    });
  }
  return headings;
}
function slugifyHeading(text) {
  return renderedHeadingText(text.trim()).toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/\s/gu, "-");
}
function collectHeadingSlugs(markdown) {
  const reserved = /* @__PURE__ */ new Map();
  return scanHeadings(markdown).map(
    (heading) => reserveSlug(slugifyHeading(heading.text), reserved)
  );
}
function collectDocumentAnchors(markdown) {
  const anchors = new Set(collectHeadingSlugs(markdown));
  for (const explicit of scanHtml(markdown).anchors) {
    anchors.add(explicit.value);
  }
  return [...anchors];
}
function reserveSlug(base, reserved) {
  if (!reserved.has(base)) {
    reserved.set(base, 0);
    return base;
  }
  let slug = base;
  while (reserved.has(slug)) {
    const suffix = (reserved.get(base) ?? 0) + 1;
    reserved.set(base, suffix);
    slug = `${base}-${suffix}`;
  }
  reserved.set(slug, 0);
  return slug;
}
function renderedHeadingText(text) {
  const withoutLinkDestinations = stripInlineLinkDestinations(text);
  const codeRanges = inlineCodeRanges(withoutLinkDestinations);
  return removeUnderscoreEmphasis(withoutLinkDestinations, codeRanges);
}
function stripInlineLinkDestinations(text) {
  let result = "";
  let index = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === "`" && !isEscaped2(text, index)) {
      const fenceLength = countCharacterRun2(text, index, "`");
      const closing = findClosingBackticks2(text, index + fenceLength, fenceLength);
      if (closing !== -1) {
        result += text.slice(index, closing + fenceLength);
        index = closing + fenceLength;
        continue;
      }
    }
    if (character === "!" && text.charAt(index + 1) === "[" && !isEscaped2(text, index)) {
      const image = parseLinkLike(text, index + 1);
      if (image !== null) {
        result += stripInlineLinkDestinations(text.slice(index + 2, image.labelEnd));
        index = image.end;
        continue;
      }
    }
    if (character === "[" && !isEscaped2(text, index)) {
      const link = parseLinkLike(text, index);
      if (link !== null) {
        result += stripInlineLinkDestinations(text.slice(index + 1, link.labelEnd));
        index = link.end;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}
function parseLinkLike(text, bracket) {
  const labelEnd = findClosingBracket2(text, bracket);
  if (labelEnd === -1) {
    return null;
  }
  if (text.charAt(labelEnd + 1) === "(") {
    const closing = findClosingParen(text, labelEnd + 1);
    if (closing === -1) {
      return null;
    }
    return { labelEnd, end: closing + 1 };
  }
  if (text.charAt(labelEnd + 1) === "[") {
    const referenceEnd = findClosingBracket2(text, labelEnd + 1);
    if (referenceEnd !== -1) {
      return { labelEnd, end: referenceEnd + 1 };
    }
  }
  return null;
}
function inlineCodeRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) !== "`" || isEscaped2(text, index)) {
      index += 1;
      continue;
    }
    const fenceLength = countCharacterRun2(text, index, "`");
    const closing = findClosingBackticks2(text, index + fenceLength, fenceLength);
    if (closing === -1) {
      index += fenceLength;
      continue;
    }
    const end = closing + fenceLength;
    ranges.push({ start: index, end });
    index = end;
  }
  return ranges;
}
function removeUnderscoreEmphasis(text, codeRanges) {
  const runs = [];
  let codeIndex = 0;
  let index = 0;
  while (index < text.length) {
    while (codeIndex < codeRanges.length && (codeRanges[codeIndex]?.end ?? 0) <= index) {
      codeIndex += 1;
    }
    const codeRange = codeRanges[codeIndex];
    if (codeRange !== void 0 && index >= codeRange.start) {
      index = codeRange.end;
      continue;
    }
    if (text.charAt(index) !== "_" || isEscaped2(text, index)) {
      index += 1;
      continue;
    }
    const length = countCharacterRun2(text, index, "_");
    runs.push(classifyUnderscoreRun(text, index, length));
    index += length;
  }
  if (runs.length === 0) {
    return text;
  }
  const removed = /* @__PURE__ */ new Set();
  const openers = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run2 = runs[runIndex];
    if (run2 === void 0) {
      continue;
    }
    if (run2.canClose && openers.length > 0) {
      removed.add(runIndex);
      const opener = openers.pop();
      if (opener !== void 0) {
        removed.add(opener);
      }
      continue;
    }
    if (run2.canOpen) {
      openers.push(runIndex);
    }
  }
  if (removed.size === 0) {
    return text;
  }
  let result = "";
  let cursor = 0;
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run2 = runs[runIndex];
    if (run2 === void 0 || !removed.has(runIndex)) {
      continue;
    }
    result += text.slice(cursor, run2.start);
    cursor = run2.start + run2.length;
  }
  return result + text.slice(cursor);
}
function classifyUnderscoreRun(text, start, length) {
  const previous = start === 0 ? "" : text.charAt(start - 1);
  const next = text.charAt(start + length);
  const leftFlanking = next !== "" && !isWhitespaceCharacter(next);
  const rightFlanking = previous !== "" && !isWhitespaceCharacter(previous);
  return {
    start,
    length,
    canOpen: leftFlanking && (previous === "" || isWhitespaceCharacter(previous) || isPunctuationCharacter(previous)),
    canClose: rightFlanking && (next === "" || isWhitespaceCharacter(next) || isPunctuationCharacter(next))
  };
}
function parseAtxHeading(line) {
  const match = ATX_HEADING.exec(line);
  if (match === null) {
    return null;
  }
  const indent = (match[1] ?? "").length;
  const level = (match[2] ?? "").length;
  const text = line.slice(indent + level).replace(CLOSING_HASHES, "").trim();
  return { level, text };
}
function isSetextParagraphText(line, maskedLine) {
  if (line.trim() === "" || maskedLine.trim() === "") {
    return false;
  }
  if (parseAtxHeading(line) !== null) {
    return false;
  }
  return !SETEXT_UNDERLINE.test(line) && !THEMATIC_BREAK.test(line) && !BLOCK_MARKER.test(line);
}
function findClosingBracket2(text, open) {
  let depth = 0;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character !== "]") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return -1;
}
function findClosingParen(text, open) {
  let depth = 0;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return -1;
}
function findClosingBackticks2(text, start, length) {
  let index = start;
  while (index < text.length) {
    if (text.charAt(index) !== "`") {
      index += 1;
      continue;
    }
    const runLength = countCharacterRun2(text, index, "`");
    if (runLength === length) {
      return index;
    }
    index += runLength;
  }
  return -1;
}
function countCharacterRun2(text, start, character) {
  let length = 0;
  while (text.charAt(start + length) === character) {
    length += 1;
  }
  return length;
}
function isEscaped2(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
function isWhitespaceCharacter(character) {
  return /\s/u.test(character);
}
function isPunctuationCharacter(character) {
  return /[\p{P}\p{S}]/u.test(character);
}

// src/target.ts
var URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
function classifyTarget(rawTarget) {
  const target = rawTarget.trim();
  if (target === "") {
    return { kind: "skipped", reason: "empty" };
  }
  if (target.startsWith("//") || URI_SCHEME.test(target)) {
    return { kind: "skipped", reason: "external" };
  }
  if (target.startsWith("#")) {
    return { kind: "skipped", reason: "fragment" };
  }
  if (target.startsWith("/")) {
    return { kind: "skipped", reason: "absolute" };
  }
  const hash = target.indexOf("#");
  if (hash === -1) {
    return { kind: "relative", path: target, fragment: null };
  }
  const path = target.slice(0, hash);
  if (path === "") {
    return { kind: "skipped", reason: "fragment" };
  }
  return { kind: "relative", path, fragment: target.slice(hash + 1) };
}

// src/checker.ts
var MARKDOWN_FILE = /\.(?:md|markdown)$/i;
var COUNTED_EXTERNAL = /^https?:/i;
function checkMarkdown(files) {
  const plan = collectCheckPlan(files);
  const occurrences = externalOccurrencesOf(plan);
  const diagnostics = plan.entries.flatMap(
    (entry) => entry.kind === "finding" ? [entry.diagnostic] : []
  );
  return {
    diagnostics,
    filesChecked: plan.filesChecked,
    broken: diagnostics.length,
    externalSkipped: occurrences.length,
    external: {
      enabled: false,
      occurrences: occurrences.length,
      skipped: occurrences.length,
      distinctChecked: 0,
      succeeded: 0,
      failed: 0,
      brokenOccurrences: 0,
      cache: { enabled: false, hits: 0, misses: 0, stale: 0 },
      results: []
    }
  };
}
async function checkMarkdownWithExternal(files, options = {}) {
  const plan = collectCheckPlan(files);
  const occurrences = externalOccurrencesOf(plan);
  const outcome = await checkExternalOccurrences(occurrences, options);
  const diagnostics = [];
  let occurrenceIndex = 0;
  let brokenOccurrences = 0;
  for (const entry of plan.entries) {
    if (entry.kind === "finding") {
      diagnostics.push(entry.diagnostic);
      continue;
    }
    const result = outcome.byOccurrence[occurrenceIndex];
    occurrenceIndex += 1;
    if (result === void 0 || result.status !== "failed") {
      continue;
    }
    brokenOccurrences += 1;
    diagnostics.push({ ...entry.occurrence, reason: externalFailureReason(result) });
  }
  const succeeded = outcome.results.filter((result) => result.status === "succeeded").length;
  return {
    diagnostics,
    filesChecked: plan.filesChecked,
    broken: diagnostics.length,
    externalSkipped: 0,
    external: {
      enabled: true,
      occurrences: occurrenceIndex,
      skipped: 0,
      distinctChecked: outcome.results.length,
      succeeded,
      failed: outcome.results.length - succeeded,
      brokenOccurrences,
      cache: outcome.cache,
      results: outcome.results
    }
  };
}
function collectCheckPlan(files) {
  const entries = [];
  const documentAnchors = /* @__PURE__ */ new Map();
  for (const file of files) {
    const markdown = (0, import_node_fs2.readFileSync)(file, "utf8");
    const sourceAnchors = anchorsOf(file, markdown, documentAnchors);
    const markdownScan = scanMarkdown(markdown);
    const htmlScan = scanHtml(markdown);
    for (const use of documentOrder(markdownScan, htmlScan.references)) {
      let target;
      if (use.style === "reference") {
        const definition = markdownScan.definitions.get(use.label);
        if (definition === void 0) {
          entries.push({
            kind: "finding",
            diagnostic: {
              file,
              line: use.line,
              column: use.column,
              kind: use.kind,
              target: use.labelText,
              reason: "reference definition does not exist"
            }
          });
          continue;
        }
        target = definition.target;
      } else {
        target = use.target;
      }
      if (isCountedExternal(target)) {
        entries.push({
          kind: "external",
          occurrence: {
            file,
            line: use.line,
            column: use.column,
            kind: use.kind,
            target
          }
        });
        continue;
      }
      const diagnostic = checkTarget2(
        file,
        target,
        use.kind,
        use.line,
        use.column,
        sourceAnchors,
        documentAnchors
      );
      if (diagnostic !== null) {
        entries.push({ kind: "finding", diagnostic });
      }
    }
  }
  return { filesChecked: files.length, entries };
}
function externalOccurrencesOf(plan) {
  return plan.entries.flatMap((entry) => entry.kind === "external" ? [entry.occurrence] : []);
}
function externalFailureReason(result) {
  const suffix = `${result.attempts} ${result.attempts === 1 ? "attempt" : "attempts"}`;
  switch (result.failureKind) {
    case "http": {
      const status = result.httpStatus === void 0 ? "error" : String(result.httpStatus);
      return result.attempts > 1 ? `external HTTP ${status} after ${suffix}` : `external HTTP ${status}`;
    }
    case "timeout":
      return `external request timed out after ${suffix}`;
    case "network":
      return `external network failure after ${suffix}`;
    case "invalid-url":
      return "external invalid URL";
    case "redirect": {
      const count2 = result.redirectCount ?? 0;
      return `external redirect limit exceeded after ${count2} ${count2 === 1 ? "redirect" : "redirects"}`;
    }
    case "invalid-redirect":
      return "external invalid redirect target";
    default:
      return "external check failed";
  }
}
function documentOrder(markdownScan, htmlReferences) {
  const uses = [];
  for (const reference of markdownScan.references) {
    if (reference.style === "reference") {
      uses.push({
        style: "reference",
        kind: reference.kind,
        label: reference.label,
        labelText: reference.labelText,
        line: reference.line,
        column: reference.column
      });
      continue;
    }
    uses.push({
      style: "direct",
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column
    });
  }
  for (const reference of htmlReferences) {
    uses.push({
      style: "direct",
      kind: reference.kind,
      target: reference.target,
      line: reference.line,
      column: reference.column
    });
  }
  return uses.sort((left, right) => left.line - right.line || left.column - right.column);
}
function isCountedExternal(target) {
  return COUNTED_EXTERNAL.test(target.trim());
}
function checkTarget2(file, target, kind, line, column, sourceAnchors, documentAnchors) {
  const trimmed = target.trim();
  if (trimmed.startsWith("#")) {
    const fragment2 = decodeFragment(trimmed.slice(1));
    if (fragment2 !== "" && !sourceAnchors.has(fragment2)) {
      return { file, line, column, kind, target, reason: "anchor does not exist" };
    }
    return null;
  }
  const classification = classifyTarget(target);
  if (classification.kind !== "relative") {
    return null;
  }
  const targetPath = (0, import_node_path2.resolve)((0, import_node_path2.dirname)(file), classification.path);
  const stats = statOf(targetPath);
  if (stats === null) {
    return { file, line, column, kind, target, reason: "target does not exist" };
  }
  const fragment = classification.fragment;
  if (fragment === null || fragment === "") {
    return null;
  }
  if (!stats.isFile() || !MARKDOWN_FILE.test(classification.path)) {
    return null;
  }
  const targetAnchors = anchorsOf(targetPath, null, documentAnchors);
  if (!targetAnchors.has(decodeFragment(fragment))) {
    return { file, line, column, kind, target, reason: "anchor does not exist" };
  }
  return null;
}
function anchorsOf(file, markdown, cache) {
  const key = (0, import_node_path2.resolve)(file);
  const cached = cache.get(key);
  if (cached !== void 0) {
    return cached;
  }
  const contents = markdown ?? (0, import_node_fs2.readFileSync)(key, "utf8");
  const anchors = new Set(collectDocumentAnchors(contents));
  cache.set(key, anchors);
  return anchors;
}
function statOf(targetPath) {
  try {
    return (0, import_node_fs2.statSync)(targetPath);
  } catch {
    return null;
  }
}
function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

// src/discovery.ts
var import_node_fs3 = require("node:fs");
var import_node_path3 = require("node:path");
var MARKDOWN_FILE2 = /\.(?:md|markdown)$/i;
var SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set([".git", "node_modules"]);
var InputError = class extends Error {
};
function discoverMarkdownFiles(inputs) {
  const found = /* @__PURE__ */ new Map();
  for (const input of inputs) {
    let inputStat;
    try {
      inputStat = (0, import_node_fs3.statSync)(input);
    } catch {
      throw new InputError(`cannot access input path "${input}"`);
    }
    if (inputStat.isFile()) {
      found.set((0, import_node_path3.resolve)(input), input);
      continue;
    }
    if (!inputStat.isDirectory()) {
      throw new InputError(`input path "${input}" is not a file or directory`);
    }
    walk(input, input, found);
  }
  return [...found.entries()].sort(([left], [right]) => compare(left, right)).map(([, displayPath]) => displayPath);
}
function walk(directory, displayDirectory, found) {
  const entries = (0, import_node_fs3.readdirSync)(directory, { withFileTypes: true }).sort(
    (left, right) => compare(left.name, right.name)
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walk((0, import_node_path3.join)(directory, entry.name), (0, import_node_path3.join)(displayDirectory, entry.name), found);
      continue;
    }
    if (entry.isFile() && MARKDOWN_FILE2.test(entry.name)) {
      found.set((0, import_node_path3.resolve)(directory, entry.name), (0, import_node_path3.join)(displayDirectory, entry.name));
    }
  }
}
function compare(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// src/report.ts
var USAGE_LINE = "Usage: md-link-check [--json] [--external] <path...>";
var HELP = `md-link-check — checks relative links, images and heading anchors in Markdown.

Usage:
  md-link-check [--json] [--external] [--] <path...>
  md-link-check --help

Arguments:
  <path...>    Markdown files or directories to check. Directories are scanned
               recursively for .md and .markdown files.

Options:
  --json       Write one JSON document to stdout instead of text output.
  --external   Also check http: and https: targets over the network. This is
               opt-in: without it, external targets are counted as skipped and
               no request is made. With it, the CLI sends GET requests for each
               distinct target and may use the network. Requests, retries,
               redirects and the persistent result cache have documented finite
               bounds. See README.md for the complete contract.
  --help, -h   Show this help and exit 0.
  --           Treat every remaining argument as a path.

Exit codes:
  0  checking completed and no broken targets were found
  1  checking completed and at least one broken target was found
  2  usage error, or an internal failure that prevented checking from completing

Output:
  Text diagnostics go to stdout as file:line: target — reason, followed by a
  summary line. Usage errors go to stderr. A --json check run writes only the
  JSON document to stdout; --help always prints this help to stdout. See
  README.md for the JSON schema and the external-checking contract.
`;
function formatDiagnostic(diagnostic) {
  return `${diagnostic.file}:${diagnostic.line}: ${diagnostic.target} — ${diagnostic.reason}`;
}
function formatSummary(result) {
  const files = count(result.filesChecked, "file");
  const broken = count(result.broken, "broken target");
  const skipped = count(result.externalSkipped, "external link");
  const summary = `Checked ${files}: ${broken}, ${skipped} skipped.
`;
  if (!result.external.enabled) {
    return summary;
  }
  const externals = result.external;
  const occurrences = count(externals.occurrences, "occurrence");
  const distinct = count(externals.distinctChecked, "distinct target");
  const brokenOccurrences = count(externals.brokenOccurrences, "broken occurrence");
  return summary + `External checks: ${occurrences}, ${distinct} checked (${externals.succeeded} succeeded, ${externals.failed} failed), ${brokenOccurrences}.
`;
}
function createJsonReport(result, exitCode, error) {
  return {
    version: 1,
    ok: exitCode === 0,
    exitCode,
    ...error === void 0 ? {} : { error },
    summary: {
      filesChecked: result.filesChecked,
      broken: result.broken,
      externalSkipped: result.externalSkipped
    },
    external: {
      enabled: result.external.enabled,
      occurrences: result.external.occurrences,
      skipped: result.external.skipped,
      distinctChecked: result.external.distinctChecked,
      succeeded: result.external.succeeded,
      failed: result.external.failed,
      brokenOccurrences: result.external.brokenOccurrences,
      cache: {
        enabled: result.external.cache.enabled,
        hits: result.external.cache.hits,
        misses: result.external.cache.misses,
        stale: result.external.cache.stale
      },
      results: result.external.results.map((target) => ({
        target: target.target,
        status: target.status,
        attempts: target.attempts,
        ...target.httpStatus === void 0 ? {} : { httpStatus: target.httpStatus },
        ...target.finalUrl === void 0 ? {} : { finalUrl: target.finalUrl },
        ...target.failureKind === void 0 ? {} : { failureKind: target.failureKind },
        ...target.redirectCount === void 0 ? {} : { redirectCount: target.redirectCount },
        ...target.source === void 0 ? {} : { source: target.source }
      }))
    },
    diagnostics: result.diagnostics.map((diagnostic) => ({
      file: diagnostic.file,
      line: diagnostic.line,
      column: diagnostic.column,
      kind: diagnostic.kind,
      target: diagnostic.target,
      reason: diagnostic.reason
    }))
  };
}
function formatJson(result, exitCode, error) {
  return `${JSON.stringify(createJsonReport(result, exitCode, error), null, 2)}
`;
}
function count(value, noun) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

// src/run.ts
var NO_DIAGNOSTICS = Object.freeze([]);
function emptyResult(externalEnabled) {
  return {
    diagnostics: [],
    filesChecked: 0,
    broken: 0,
    externalSkipped: 0,
    external: {
      enabled: externalEnabled,
      occurrences: 0,
      skipped: 0,
      distinctChecked: 0,
      succeeded: 0,
      failed: 0,
      brokenOccurrences: 0,
      cache: { enabled: false, hits: 0, misses: 0, stale: 0 },
      results: []
    }
  };
}
async function run(args, io2, options = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    io2.writeOut(HELP);
    return { exitCode: 0, diagnostics: NO_DIAGNOSTICS };
  }
  if (parsed.error !== null) {
    return {
      exitCode: reportUsageError(parsed.error, parsed.json, parsed.external, io2),
      diagnostics: NO_DIAGNOSTICS
    };
  }
  let result;
  try {
    const files = discoverMarkdownFiles(parsed.paths);
    result = parsed.external ? await checkMarkdownWithExternal(files, externalOptions(options.external)) : checkMarkdown(files);
  } catch (error) {
    if (error instanceof InputError) {
      return {
        exitCode: reportUsageError(error.message, parsed.json, parsed.external, io2),
        diagnostics: NO_DIAGNOSTICS
      };
    }
    return {
      exitCode: reportInternalError(error, parsed.json, parsed.external, io2),
      diagnostics: NO_DIAGNOSTICS
    };
  }
  const exitCode = result.diagnostics.length === 0 ? 0 : 1;
  const diagnostics = brokenLinkResults(result.diagnostics);
  if (parsed.json) {
    io2.writeOut(formatJson(result, exitCode));
    return { exitCode, diagnostics };
  }
  for (const diagnostic of result.diagnostics) {
    io2.writeOut(`${formatDiagnostic(diagnostic)}
`);
  }
  io2.writeOut(formatSummary(result));
  return { exitCode, diagnostics };
}
function brokenLinkResults(diagnostics) {
  return Object.freeze(
    diagnostics.map(
      ({ file, line, target, reason }) => Object.freeze({ file, line, target, reason })
    )
  );
}
function externalOptions(options) {
  const cachePath = options?.cachePath ?? resolveExternalCachePath();
  return { ...options, cachePath: cachePath ?? false };
}
function parseArgs(args) {
  const paths = [];
  let json = false;
  let external = false;
  let help = false;
  let endOfOptions = false;
  let error = null;
  for (const argument of args) {
    if (!endOfOptions && argument === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && argument === "--json") {
      json = true;
      continue;
    }
    if (!endOfOptions && argument === "--external") {
      external = true;
      continue;
    }
    if (!endOfOptions && (argument === "--help" || argument === "-h")) {
      help = true;
      continue;
    }
    if (!endOfOptions && argument.startsWith("-") && argument.length > 1) {
      error ??= `unknown option "${argument}"`;
      continue;
    }
    paths.push(argument);
  }
  if (!help && error === null && paths.length === 0) {
    error = "no input paths";
  }
  return { json, external, help, paths, error };
}
function formatUsageErrorText(message) {
  return `md-link-check: ${message}

${USAGE_LINE}
Run "md-link-check --help" for usage and exit codes.
`;
}
function formatInternalErrorText(error) {
  return `md-link-check: internal error: ${internalErrorDetail(error)}
`;
}
function reportUsageError(message, json, external, io2) {
  if (json) {
    io2.writeOut(formatJson(emptyResult(external), 2, { kind: "usage", message }));
    return 2;
  }
  io2.writeError(formatUsageErrorText(message));
  return 2;
}
function reportInternalError(error, json, external, io2) {
  const detail = internalErrorDetail(error);
  const failure = { kind: "internal", message: detail };
  if (json) {
    io2.writeOut(formatJson(emptyResult(external), 2, failure));
    return 2;
  }
  io2.writeError(formatInternalErrorText(error));
  return 2;
}
function internalErrorDetail(error) {
  return error instanceof Error && error.message !== "" ? error.message : "unexpected failure";
}

// src/action-runner.ts
var ActionInputError = class extends Error {
};
function readActionInputs(environment) {
  return {
    paths: parsePaths(environment.INPUT_PATHS),
    external: parseExternal(environment.INPUT_EXTERNAL)
  };
}
function buildCommandLine(inputs) {
  return [...inputs.external ? ["--external"] : [], "--", ...inputs.paths];
}
function createProcessIo() {
  return {
    writeOut: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text)
  };
}
async function runAction(environment, io2) {
  let inputs;
  try {
    inputs = readActionInputs(environment);
  } catch (error) {
    if (error instanceof ActionInputError) {
      io2.writeError(formatUsageErrorText(error.message));
      return { exitCode: 2, diagnostics: [] };
    }
    throw error;
  }
  const result = await run(buildCommandLine(inputs), io2);
  emitAnnotations(result.diagnostics, io2);
  return result;
}
function emitAnnotations(findings, io2) {
  for (const annotation of formatAnnotations(findings)) {
    io2.writeOut(`${annotation}
`);
  }
}
function parsePaths(raw) {
  if (raw === void 0) {
    return [];
  }
  return raw.split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line !== "");
}
function parseExternal(raw) {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new ActionInputError(
    'invalid action input "external": expected "true" or "false"'
  );
}

// src/action.ts
var io = createProcessIo();
void runAction(process.env, io).then((result) => {
  process.exitCode = result.exitCode;
}).catch((error) => {
  io.writeError(formatInternalErrorText(error));
  process.exitCode = 2;
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ActionInputError,
  buildCommandLine,
  createProcessIo,
  readActionInputs,
  runAction
});
