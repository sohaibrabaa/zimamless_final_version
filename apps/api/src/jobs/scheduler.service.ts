import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { ListingDeadlinesService } from '../modules/marketplace/listing-deadlines.service';
import { FundingDeadlinesService } from '../modules/funding/funding-deadlines.service';

/**
 * The thing that actually runs the sweeps.
 *
 * Both `ListingDeadlinesService` and `FundingDeadlinesService` were written to
 * be idempotent and to answer "what is overdue as of the TimeProvider's now?".
 * Neither had a caller. A deadline service nothing invokes is a deadline that
 * never passes, so this closes the loop: one interval, every sweep, in order.
 *
 * ## Why an interval and not a cron expression
 *
 * A cron library schedules against the wall clock, and the wall clock is
 * exactly what the demo time machine is not. When a demo jumps the clock
 * forward two days, every deadline in between must process on the next tick —
 * seconds later in real time — because the sweeps ask the injected
 * `TimeProvider` what time it is, not the operating system. An interval that
 * simply says "sweep again shortly" composes with that; a cron expression
 * fights it. It also avoids a dependency for something this file does in
 * fifteen lines.
 *
 * ## Why failures are swallowed per sweep
 *
 * A sweep throwing must not stop the timer, or one bad row on a Tuesday
 * silently disables every deadline in the system until someone restarts the
 * process. Each sweep is isolated and its failure is logged loudly; the next
 * tick tries again, which is safe precisely because the sweeps are idempotent.
 *
 * ## Single-instance assumption
 *
 * Two API instances would run this concurrently. Every effect below is guarded
 * by a uniqueness check the sweeps own (a notification's `template_key` +
 * `transaction_id`, a status the transition would refuse), so a double run
 * duplicates nothing — it merely wastes a query. A distributed lock would be
 * the right answer at real scale and is out of scope here.
 */

/** Deliberately not configurable per environment: one number, easy to reason about. */
const TICK_MS = 60_000;

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly listings: ListingDeadlinesService,
    private readonly funding: FundingDeadlinesService,
  ) {}

  onApplicationBootstrap(): void {
    // Tests drive `tick()` directly; a background timer there would race the
    // suite's own fixtures and make failures depend on wall-clock timing.
    if (this.config.nodeEnv === 'test') return;

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Node holds the process open for a pending timer; this one should never
    // be the reason a shutdown hangs.
    this.timer.unref();
    this.logger.log(`Deadline sweeps scheduled every ${TICK_MS / 1000}s`);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every sweep. Public so the demo time-travel handler and the
   * tests can force a pass without waiting for a tick.
   *
   * Re-entrancy is refused rather than queued: if a sweep is still running
   * when the next tick fires, the work is already in progress and starting a
   * second pass would only contend with the first for the same rows.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.run('listing deadlines', () => this.listings.sweep());
      await this.run('funding confirmations', () => this.funding.sweep());
    } finally {
      this.running = false;
    }
  }

  private async run(
    name: string,
    // Each sweep returns its own named counts; the scheduler only needs them
    // to be countable, not to know which counts a given sweep produces.
    sweep: () => Promise<{ [k: string]: number }>,
  ): Promise<void> {
    try {
      const result = await sweep();
      const did = Object.entries(result).filter(([, count]) => count > 0);
      if (did.length > 0) {
        this.logger.log(`${name}: ${did.map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
    } catch (err) {
      this.logger.error(
        `${name} sweep failed and will be retried on the next tick: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
