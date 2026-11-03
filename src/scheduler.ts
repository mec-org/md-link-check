/** The finite per-host start delay ceiling enforced even for injected options. */
export const MAX_PER_HOST_DELAY_MS = 1_000;

/** One queued request: its host identity, work, and settlement callbacks. */
interface PendingRequest {
  readonly hostKey: string;
  readonly task: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export interface SchedulerOptions {
  /** Maximum requests in flight across all hosts. */
  readonly globalConcurrency: number;
  /** Maximum requests in flight to one host origin. */
  readonly perHostConcurrency: number;
  /** Minimum delay between two request starts to the same host, in milliseconds. */
  readonly perHostDelayMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * A bounded, invocation-local request scheduler.
 *
 * One scheduler is shared by initial attempts, retries and redirect hops. At
 * most `globalConcurrency` requests run at once, and at most
 * `perHostConcurrency` requests run at once for a host origin. A request for a
 * host that is already at its limit stays queued while other hosts progress, so
 * one slow host cannot block unrelated hosts.
 *
 * The queue is finite: it only holds the per-target attempt currently in
 * flight, and every retry and redirect hop passes through the same limits.
 * Scheduling is completion-driven; there is no polling loop, interval or
 * unbounded timer. An optional per-host start delay is clamped to
 * `MAX_PER_HOST_DELAY_MS` and uses the injected clock and sleeper.
 */
export class BoundedRequestScheduler {
  private readonly pending: Array<PendingRequest | undefined> = [];
  private head = 0;
  private globalActive = 0;
  private readonly hostActive = new Map<string, number>();
  private readonly hostStart = new Map<string, number>();

  constructor(private readonly options: SchedulerOptions) {}

  /** Queues one request to `hostKey`; resolves when the task settles. */
  run<T>(hostKey: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        hostKey,
        task: task as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.globalActive < this.options.globalConcurrency) {
      const index = this.nextEligible();
      if (index === -1) {
        this.compact();
        return;
      }
      const request = this.pending[index];
      this.pending[index] = undefined;
      this.advanceHead();
      if (request === undefined) {
        continue;
      }
      this.start(request);
    }
  }

  /** Returns the first queued request whose host has capacity, or -1. */
  private nextEligible(): number {
    for (let index = this.head; index < this.pending.length; index += 1) {
      const request = this.pending[index];
      if (request === undefined) {
        continue;
      }
      if ((this.hostActive.get(request.hostKey) ?? 0) < this.options.perHostConcurrency) {
        return index;
      }
    }
    return -1;
  }

  private advanceHead(): void {
    while (this.head < this.pending.length && this.pending[this.head] === undefined) {
      this.head += 1;
    }
  }

  /** Drops settled entries once they dominate the queue, keeping memory bounded. */
  private compact(): void {
    if (this.head === 0) {
      return;
    }
    this.pending.splice(0, this.head);
    this.head = 0;
  }

  private start(request: PendingRequest): void {
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
  private consumeHostWait(hostKey: string): number {
    if (this.options.perHostDelayMs <= 0) {
      return 0;
    }
    const now = this.now();
    const previous = this.hostStart.get(hostKey);
    if (previous === undefined) {
      this.hostStart.set(hostKey, now);
      return 0;
    }
    const remaining = this.options.perHostDelayMs - (now - previous);
    const wait = Number.isFinite(remaining)
      ? Math.min(Math.max(remaining, 0), MAX_PER_HOST_DELAY_MS)
      : 0;
    this.hostStart.set(hostKey, now + wait);
    return wait;
  }

  private sleepThenDispatch(request: PendingRequest, wait: number): void {
    void this.options.sleep(wait).then(
      () => {
        this.dispatch(request);
      },
      (error: unknown) => {
        this.settle(request, false, error);
      },
    );
  }

  /**
   * Starts the task in a microtask. Deferring the call keeps a task that throws
   * synchronously from recursing through the scheduler, and a task that returns
   * a rejected promise is handled by the same settlement path.
   */
  private dispatch(request: PendingRequest): void {
    void Promise.resolve()
      .then(() => request.task())
      .then(
        (value) => {
          this.settle(request, true, value);
        },
        (error: unknown) => {
          this.settle(request, false, error);
        },
      );
  }

  private settle(request: PendingRequest, succeeded: boolean, value: unknown): void {
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

  private now(): number {
    const value = this.options.now();
    return Number.isFinite(value) ? value : 0;
  }
}
