import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the fixture server received, in arrival order. */
export interface FixtureRequest {
  method: string;
  path: string;
}

/**
 * A loopback HTTP fixture bound to an ephemeral port. Every test that exercises
 * real network behavior uses one of these; no fixture contacts an external
 * address or resolves DNS outside the loopback interface.
 */
export interface FixtureServer {
  /** Base URL such as `http://127.0.0.1:54321`. */
  readonly url: string;
  /** Requests received so far, in arrival order. */
  readonly requests: readonly FixtureRequest[];
  /**
   * Request targets received so far, as path plus query, in arrival order.
   * Kept separate from `requests` so existing method/path assertions stay
   * stable while normalization tests can observe the transmitted query.
   */
  readonly requestTargets: readonly string[];
  /**
   * The number of gated requests (`/gate` and `/gate-not-found`) currently
   * waiting for `releaseGated()`.
   */
  readonly gated: number;
  /**
   * Resolves once at least `count` gated requests are waiting at the same time.
   */
  waitForGated(count: number): Promise<void>;
  /** Answers every gated request that is currently waiting. */
  releaseGated(): void;
  /** True once `close()` finished successfully. */
  readonly closed: boolean;
  /** Absolute URL for a fixture path. */
  urlFor(path: string): string;
  /** Closes the listener and every open connection; rejects if shutdown fails. */
  close(): Promise<void>;
}

/** Starts a fixture with the endpoints documented in test/server.ts. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const requestTargets: string[] = [];
  const counters = new Map<string, number>();
  const gateResponses: Array<() => void> = [];
  const gateWaiters: Array<{ count: number; resolve: () => void }> = [];
  let gated = 0;

  const notifyGateWaiters = (): void => {
    for (let index = gateWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = gateWaiters[index];
      if (waiter !== undefined && gated >= waiter.count) {
        gateWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = requestUrl.pathname;
    requests.push({ method: request.method ?? 'GET', path });
    requestTargets.push(`${path}${requestUrl.search}`);

    const hit = (counters.get(path) ?? 0) + 1;
    counters.set(path, hit);

    const chain = /^\/chain\/(\d+)$/.exec(path);
    if (chain !== null) {
      const remaining = Number(chain[1]);
      if (remaining > 0) {
        response.writeHead(302, { location: `/chain/${remaining - 1}` });
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      }
      return;
    }

    switch (path) {
      case '/ok':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
        return;
      case '/gate':
        gated += 1;
        gateResponses.push(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('ok');
        });
        notifyGateWaiters();
        return;
      case '/gate-not-found':
        // A gated terminal failure: the test controls when the permanent 404
        // is delivered so completion order can differ from source order.
        gated += 1;
        gateResponses.push(() => {
          response.writeHead(404, { 'content-type': 'text/plain' });
          response.end('not found');
        });
        notifyGateWaiters();
        return;
      case '/redirect':
        response.writeHead(302, { location: '/ok' });
        response.end();
        return;
      case '/redirect-to-not-found':
        response.writeHead(302, { location: '/not-found' });
        response.end();
        return;
      case '/redirect-to-slow':
        response.writeHead(302, { location: '/slow' });
        response.end();
        return;
      case '/redirect-loop':
        response.writeHead(302, { location: '/redirect-loop' });
        response.end();
        return;
      case '/redirect-bad-location':
        response.writeHead(302, { location: 'mailto:owner@example.com' });
        response.end();
        return;
      case '/not-found':
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      case '/server-error':
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('server error');
        return;
      case '/flaky':
        if (hit === 1) {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end('temporary failure');
        } else {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('ok');
        }
        return;
      case '/always-flaky':
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('still failing');
        return;
      case '/slow':
        // Deliberately never respond; the client's timeout and the teardown
        // close are what end this request.
        return;
      case '/drop':
        // Accept the connection and destroy it before a response, producing a
        // deterministic local network failure.
        request.socket.destroy();
        return;
      default:
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('unknown fixture path');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('fixture server did not expose a loopback TCP address');
  }
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

  let closed = false;
  let closing: Promise<void> | null = null;

  return {
    url: baseUrl,
    requests,
    requestTargets,
    get gated() {
      return gated;
    },
    waitForGated(count: number): Promise<void> {
      if (gated >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        gateWaiters.push({ count, resolve });
      });
    },
    releaseGated(): void {
      const pending = gateResponses.splice(0);
      gated = 0;
      for (const respond of pending) {
        respond();
      }
    },
    get closed() {
      return closed;
    },
    urlFor(path: string) {
      return `${baseUrl}${path}`;
    },
    close(): Promise<void> {
      closing ??= closeServer(server).then(() => {
        closed = true;
      });
      return closing;
    },
  };
}

/** Destroys open keep-alive and hanging connections, then closes the listener. */
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
