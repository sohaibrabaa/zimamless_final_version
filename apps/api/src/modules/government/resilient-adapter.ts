import { GovSource, GovernmentAdapter, GovernmentLookupResult } from './government-adapter';

/**
 * Retry, timeout, and circuit breaker around a government adapter.
 *
 * The invariant that governs every path through this file: **giving up is
 * an UNANSWERED result, never an adverse one.** A timeout, an exhausted
 * retry budget, and an open circuit are all facts about the registry's
 * availability. None of them is evidence about the supplier, and none may
 * ever surface as NOT_FOUND — which is the shape that would quietly feed a
 * government outage into a risk score (hard rule 7).
 *
 * Equally: a source that answered NOT_FOUND is *not retried*. It answered.
 * Retrying an answer we dislike would turn a definitive adverse finding
 * into an availability problem, which is the same confusion in the other
 * direction.
 */

export interface ResilienceOptions {
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Attempts in total, including the first. */
  maxAttempts: number;
  /** Base delay for exponential backoff between attempts. */
  backoffMs: number;
  /** Consecutive unanswered results before the circuit opens. */
  circuitThreshold: number;
  /** How long the circuit stays open before a trial call is allowed. */
  circuitResetMs: number;
}

export const DEFAULT_RESILIENCE: ResilienceOptions = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  backoffMs: 200,
  circuitThreshold: 5,
  circuitResetMs: 30_000,
};

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Clock access is injected rather than read directly: this file sits under
 * src/modules/**, where the lint rule bans direct wall-clock reads so the
 * demo time machine cannot be bypassed. The circuit breaker measures
 * elapsed real time, so callers pass the TimeProvider's reading in.
 */
export type NowMs = () => number;

export class CircuitBreaker {
  private failures = 0;
  private openedAtMs = 0;
  private state: CircuitState = 'CLOSED';

  constructor(
    private readonly options: ResilienceOptions,
    private readonly nowMs: NowMs,
  ) {}

  /** Whether a call may proceed, transitioning to HALF_OPEN when due. */
  allowsRequest(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF_OPEN') return true;
    if (this.nowMs() - this.openedAtMs >= this.options.circuitResetMs) {
      // One trial call decides whether the source is back.
      this.state = 'HALF_OPEN';
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.options.circuitThreshold) {
      this.state = 'OPEN';
      this.openedAtMs = this.nowMs();
    }
  }

  currentState(): CircuitState {
    return this.state;
  }

  /** Test and diagnostic hook. */
  consecutiveFailures(): number {
    return this.failures;
  }
}

export class ResilientGovernmentAdapter implements GovernmentAdapter {
  readonly source: GovSource;
  readonly version: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: GovernmentAdapter,
    private readonly options: ResilienceOptions,
    nowMs: NowMs,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.source = inner.source;
    this.version = inner.version;
    this.breaker = new CircuitBreaker(options, nowMs);
  }

  circuitState(): string {
    return this.breaker.currentState();
  }

  async lookup(lookupKey: string): Promise<GovernmentLookupResult> {
    if (!this.breaker.allowsRequest()) {
      // Fail fast while the source is known to be down. Still UNANSWERED —
      // the supplier is not penalised for our own breaker being open.
      return {
        kind: 'UNANSWERED',
        status: 'UNAVAILABLE',
        errorCode: 'CIRCUIT_OPEN',
        errorMessage: `${this.source} is unavailable; requests are being short-circuited.`,
      };
    }

    let last: GovernmentLookupResult = {
      kind: 'UNANSWERED',
      status: 'UNAVAILABLE',
      errorCode: 'NO_ATTEMPT',
      errorMessage: `${this.source} was never called.`,
    };

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      last = await this.attempt(lookupKey);

      if (last.kind === 'ANSWERED') {
        // Includes NOT_FOUND: the source answered, so the circuit is healthy
        // and there is nothing to retry.
        this.breaker.recordSuccess();
        return last;
      }

      this.breaker.recordFailure();
      if (attempt < this.options.maxAttempts) {
        await this.sleep(this.options.backoffMs * 2 ** (attempt - 1));
      }
    }

    return last;
  }

  /**
   * One attempt, bounded by the timeout.
   *
   * A thrown error is converted to UNANSWERED rather than propagated: an
   * adapter that throws must not become a 500 on an onboarding request, and
   * it definitely must not become an adverse finding.
   */
  private async attempt(lookupKey: string): Promise<GovernmentLookupResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<GovernmentLookupResult>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              kind: 'UNANSWERED',
              status: 'UNAVAILABLE',
              errorCode: 'SOURCE_TIMEOUT',
              errorMessage: `${this.source} did not respond within ${this.options.timeoutMs}ms.`,
            }),
          this.options.timeoutMs,
        );
      });
      return await Promise.race([this.inner.lookup(lookupKey), timeout]);
    } catch (err) {
      return {
        kind: 'UNANSWERED',
        status: 'ERROR',
        errorCode: 'ADAPTER_EXCEPTION',
        errorMessage: err instanceof Error ? err.message : 'The adapter threw.',
      };
    } finally {
      // Without this the timer keeps the event loop alive for its full
      // duration after a fast success — which in a 5s-timeout adapter makes
      // every request appear to hang at shutdown.
      if (timer) clearTimeout(timer);
    }
  }
}
