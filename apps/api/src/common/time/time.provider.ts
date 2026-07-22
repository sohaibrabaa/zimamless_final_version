import { Injectable, Inject } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

/**
 * TimeProvider — the single source of "now" for domain logic and jobs.
 *
 * PA-05, ratified in DECISIONS.md. Every date decision in the domain
 * (maturity, deadlines, SLA arithmetic, OTP expiry, offer validity) reads
 * the clock through here, and an ESLint rule bans `new Date()`/`Date.now()`
 * in src/modules/** and src/jobs/** so it stays that way.
 *
 * Why it matters: the demo time machine (ZM-DEMO-003/004) advances the
 * simulated clock so maturity, overdue, and recourse can be shown live. It
 * works by adding an offset here — in exactly one place — rather than by
 * touching any domain code. Master Plan R-05 rates retrofitting this as
 * high-cost, which is why it ships in Phase 1 before any feature code.
 *
 * The offset is guarded twice, server-side (hiding the UI is explicitly not
 * sufficient): the DEMO_TIME_MACHINE_ENABLED env var AND the
 * demo_time_machine_enabled platform setting must both be true. In
 * production the offset is never read and now() is the wall clock.
 */

export const TIME_PROVIDER = Symbol('TIME_PROVIDER');

export interface TimeProvider {
  /** Current instant, including the demo offset when enabled. */
  now(): Date;
  /** Current instant in epoch milliseconds. */
  nowMs(): number;
  /** Today's date at UTC midnight — for date-typed comparisons (due dates). */
  today(): Date;
  /** The active demo offset in days; 0 when the time machine is off. */
  currentOffsetDays(): number;
  /** True only when the env guard AND the platform setting both allow it. */
  isTimeMachineEnabled(): boolean;
}

@Injectable()
export class SystemTimeProvider implements TimeProvider {
  /**
   * Cached so that a per-request clock read is not a database round trip.
   * Refreshed on a short interval and immediately when the offset is
   * changed through /demo/time-travel, which calls refresh() directly.
   */
  private offsetDays = 0;
  private timeMachineEnabled = false;
  private lastRefreshMs = 0;
  private static readonly REFRESH_INTERVAL_MS = 5_000;

  constructor(
    private readonly db: DatabaseService,
    @Inject('DEMO_TIME_MACHINE_ENV_FLAG') private readonly envFlagEnabled: boolean,
  ) {}

  now(): Date {
    const wall = Date.now();
    if (!this.timeMachineEnabled || this.offsetDays === 0) return new Date(wall);
    return new Date(wall + this.offsetDays * 86_400_000);
  }

  nowMs(): number {
    return this.now().getTime();
  }

  today(): Date {
    const n = this.now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }

  currentOffsetDays(): number {
    return this.timeMachineEnabled ? this.offsetDays : 0;
  }

  isTimeMachineEnabled(): boolean {
    return this.timeMachineEnabled;
  }

  /**
   * Re-read the guard and offset. Called on an interval by the module and
   * synchronously by the demo controller after a jump, so a time-travel
   * takes effect on the very next request rather than up to 5s later.
   */
  async refresh(): Promise<void> {
    // The env guard is checked first and short-circuits: if the deployment
    // says no time machine, no database value can turn it on.
    if (!this.envFlagEnabled) {
      this.timeMachineEnabled = false;
      this.offsetDays = 0;
      this.lastRefreshMs = Date.now();
      return;
    }

    const settingRow = await this.db.query<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'demo_time_machine_enabled'`,
    );
    const enabled = settingRow.rows[0]?.value === true;
    this.timeMachineEnabled = enabled;

    if (!enabled) {
      this.offsetDays = 0;
    } else {
      const offsetRow = await this.db.query<{ offset_days: number }>(
        `SELECT offset_days FROM demo_time_offsets ORDER BY set_at DESC LIMIT 1`,
      );
      this.offsetDays = offsetRow.rows[0]?.offset_days ?? 0;
    }
    this.lastRefreshMs = Date.now();
  }

  /** Refresh if the cache is stale. Cheap enough to call per request. */
  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastRefreshMs > SystemTimeProvider.REFRESH_INTERVAL_MS) {
      await this.refresh();
    }
  }
}

/**
 * A clock frozen at a fixed instant, for tests. Domain tests assert on
 * deadlines and expiry, which is only meaningful against a clock that does
 * not move underneath them.
 */
export class FixedTimeProvider implements TimeProvider {
  constructor(
    private fixed: Date,
    private offsetDays = 0,
    private enabled = false,
  ) {}

  now(): Date {
    return new Date(this.fixed.getTime() + this.offsetDays * 86_400_000);
  }
  nowMs(): number {
    return this.now().getTime();
  }
  today(): Date {
    const n = this.now();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }
  currentOffsetDays(): number {
    return this.enabled ? this.offsetDays : 0;
  }
  isTimeMachineEnabled(): boolean {
    return this.enabled;
  }
  /** Test helper: move the frozen instant. */
  setTo(d: Date): void {
    this.fixed = d;
  }
  /** Test helper: simulate a time-machine jump. */
  advanceDays(days: number): void {
    this.offsetDays += days;
    this.enabled = true;
  }
}
