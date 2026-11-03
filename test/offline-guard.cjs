'use strict';
/**
 * Test-only preload for the M8 offline-acceptance suite.
 *
 * The CLI runs in a child process with this file preloaded. Every practical
 * Node network entry point and every filesystem operation beneath
 * MDLC_ACCEPTANCE_CACHE_ROOT is recorded in MDLC_ACCEPTANCE_GUARD_LOG and then
 * refused. A missing log after a run is executable evidence that the process
 * neither attempted network access nor touched the external cache.
 *
 * The patches are applied to the CommonJS builtin module objects and then
 * published to ESM named imports with syncBuiltinESMExports(). This matters
 * because the built CLI is ESM and imports builtins by name
 * (`import { openSync } from 'node:fs'`); patching only the CommonJS properties
 * would not reliably cover those imports.
 *
 * The suite proves the guard itself is live with positive controls: an ESM
 * named-import probe and a real guarded CLI run with `--external` must both
 * produce guard entries. Negative acceptance runs are only evidence when those
 * controls pass.
 */
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { sep } = require('node:path');

const logPath = process.env.MDLC_ACCEPTANCE_GUARD_LOG;
const cacheRoot = process.env.MDLC_ACCEPTANCE_CACHE_ROOT;
const appendGuardEntry = fs.appendFileSync.bind(fs);

function record(api, detail) {
  if (typeof logPath === 'string' && logPath !== '') {
    try {
      appendGuardEntry(logPath, JSON.stringify({ api, detail: String(detail ?? '') }) + '\n');
    } catch {
      // The log is test evidence only; never change CLI behavior for it.
    }
  }
  throw new Error(`M8 offline acceptance guard: ${api} attempted`);
}

// Web-style fetch.
globalThis.fetch = function guardedFetch(input) {
  const detail = typeof input === 'string' ? input : input?.url ?? String(input);
  return record('fetch', detail);
};

// Node HTTP clients.
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  for (const method of ['request', 'get']) {
    module[method] = function guardedRequest() {
      return record(`${name}.${method}`);
    };
  }
}

const http2 = require('node:http2');
if (typeof http2.connect === 'function') {
  http2.connect = function guardedHttp2Connect() {
    return record('node:http2.connect');
  };
}

// Raw sockets and TLS.
const net = require('node:net');
net.connect = function guardedNetConnect() {
  return record('net.connect');
};
net.createConnection = net.connect;
net.Socket.prototype.connect = function guardedSocketConnect() {
  return record('net.Socket.connect');
};
const tls = require('node:tls');
tls.connect = function guardedTlsConnect() {
  return record('tls.connect');
};
const dgram = require('node:dgram');
if (typeof dgram.createSocket === 'function') {
  dgram.createSocket = function guardedCreateSocket() {
    return record('dgram.createSocket');
  };
}

// DNS, callback and promise APIs.
const dns = require('node:dns');
const dnsMethods = [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
];
for (const method of dnsMethods) {
  if (typeof dns[method] === 'function') {
    dns[method] = function guardedDnsCall() {
      return record(`dns.${method}`);
    };
  }
  if (dns.promises && typeof dns.promises[method] === 'function') {
    dns.promises[method] = function guardedDnsPromiseCall() {
      return record(`dns.promises.${method}`);
    };
  }
}

function isCachePath(value) {
  if (typeof cacheRoot !== 'string' || cacheRoot === '') {
    return false;
  }
  let filePath;
  if (typeof value === 'string') {
    filePath = value;
  } else if (value instanceof URL) {
    filePath = value.pathname;
  } else if (Buffer.isBuffer(value)) {
    filePath = value.toString();
  } else {
    return false;
  }
  return filePath === cacheRoot || filePath.startsWith(`${cacheRoot}${sep}`);
}

/**
 * Replaces one path-taking method with a wrapper that refuses the cache root.
 * Callback APIs receive the original arguments; promise APIs surface the
 * synchronous throw as a rejected call, matching how the real API behaves when
 * the guard is not installed.
 */
function guardPathMethod(target, method, apiName) {
  const original = target[method];
  if (typeof original !== 'function') {
    return;
  }
  target[method] = function guardedPathCall(filePath, ...rest) {
    if (isCachePath(filePath)) {
      return record(apiName, filePath);
    }
    return original.call(this, filePath, ...rest);
  };
}

const syncMethods = [
  'existsSync',
  'readFileSync',
  'openSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'writeFileSync',
  'appendFileSync',
  'mkdirSync',
  'renameSync',
  'copyFileSync',
  'unlinkSync',
  'rmSync',
  'chmodSync',
  'utimesSync',
  'accessSync',
  'realpathSync',
  'opendirSync',
  'readlinkSync',
  'symlinkSync',
  'linkSync',
  'truncateSync',
  'mkdtempSync',
];
for (const method of syncMethods) {
  guardPathMethod(fs, method, `fs.${method}`);
}

const callbackMethods = [
  'readFile',
  'writeFile',
  'appendFile',
  'open',
  'rename',
  'copyFile',
  'mkdir',
  'rm',
  'unlink',
  'stat',
  'lstat',
  'access',
  'chmod',
  'utimes',
  'readdir',
  'realpath',
  'opendir',
  'readlink',
  'symlink',
  'link',
  'truncate',
];
for (const method of callbackMethods) {
  guardPathMethod(fs, method, `fs.${method}`);
}

for (const method of [
  'readFile',
  'writeFile',
  'appendFile',
  'open',
  'rename',
  'copyFile',
  'mkdir',
  'rm',
  'unlink',
  'stat',
  'lstat',
  'access',
  'chmod',
  'utimes',
  'readdir',
  'realpath',
  'opendir',
  'readlink',
  'symlink',
  'link',
  'truncate',
  'mkdtemp',
]) {
  if (fs.promises && typeof fs.promises[method] === 'function') {
    guardPathMethod(fs.promises, method, `fs.promises.${method}`);
  }
}

for (const method of ['createReadStream', 'createWriteStream']) {
  guardPathMethod(fs, method, `fs.${method}`);
}

// Publish the patched CommonJS properties to ESM named imports of the Node
// builtins. Without this, the built CLI's `import { openSync } from 'node:fs'`
// can keep the original binding, making a missing log meaningless.
syncBuiltinESMExports();
