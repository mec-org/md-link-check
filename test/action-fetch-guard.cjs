'use strict';
/**
 * Test-only preload used when the committed action artifact runs in a child
 * process. The suite's `test/setup.ts` guard only covers this process, so the
 * same rule is applied to action children: HTTP(S) requests may target the
 * loopback interface only. Attempts are appended to
 * MD_LINK_CHECK_ACTION_FETCH_LOG (when set) before the request is allowed or
 * refused, which lets tests prove both "no fetch" and "loopback only".
 */
const { appendFileSync } = require('node:fs');

const originalFetch = globalThis.fetch;

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase();
  if (host === '127.0.0.1' || host === '[::1]' || host === '::1') {
    return true;
  }
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function requestUrl(input) {
  if (typeof input === 'string') {
    return new URL(input);
  }
  if (input instanceof URL) {
    return new URL(input.href);
  }
  return new URL(input.url);
}

globalThis.fetch = function guardedFetch(input, init) {
  let url;
  try {
    url = requestUrl(input);
  } catch {
    return originalFetch(input, init);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return originalFetch(input, init);
  }

  const allowed = isLoopbackHostname(url.hostname);
  const logPath = process.env.MD_LINK_CHECK_ACTION_FETCH_LOG;
  if (logPath !== undefined && logPath !== '') {
    try {
      appendFileSync(logPath, `${allowed ? 'allowed' : 'refused'} ${url.href}\n`);
    } catch {
      // The log is test diagnostics only; never change action behavior for it.
    }
  }

  if (!allowed) {
    throw new Error(`action test guard: refused non-loopback request to ${url.origin}`);
  }
  return originalFetch(input, init);
};
