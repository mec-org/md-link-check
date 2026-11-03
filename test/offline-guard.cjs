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
 * The M3 no-fetch test replaced only `globalThis.fetch`; this guard also covers
 * DNS, raw sockets, the HTTP/HTTPS/HTTP2/TLS clients and cache-file I/O, so a
 * regression that reaches for any of them fails the acceptance test instead of
 * silently using the network.
 */
const fs = require('node:fs');
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

const guardedFsMethods = [
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
];

for (const method of guardedFsMethods) {
  const original = fs[method];
  if (typeof original !== 'function') {
    continue;
  }
  fs[method] = function guardedFsCall(filePath, ...rest) {
    if (isCachePath(filePath)) {
      return record(`fs.${method}`, filePath);
    }
    return original.call(this, filePath, ...rest);
  };
}
