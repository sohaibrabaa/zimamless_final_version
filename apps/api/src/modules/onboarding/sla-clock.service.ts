import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import {
  HolidaySet,
  ONBOARDING_SLA_BUSINESS_SECONDS,
  addBusinessSeconds,
  businessSecondsBetween,
} from '../../common/time/business-time';

/**
 * The onboarding SLA clock (ZM-SON-008).
 *
 * The rule this module exists to honour: **elapsed time is never stored as
 * a running total.** It is recomputed from `sla_clock_events` on every read.
 * A stored counter drifts the moment a pause is recorded twice, a resume is
 * lost, or a request is retried — and the drift is undetectable after the
 * fact, because the evidence it disagrees with was never kept. Events are
 * the source of truth; anything else is a cache.
 *
 * `supplier_applications.sla_elapsed_business_secs` is exactly that cache.
 * It is written for the benefit of SQL-level reporting and is never read
 * back by this service. If it ever disagrees with the events, the events
 * are right — and `reconstruct()` is what proves which is which.
 */

export type SlaEventKind = 'START' | 'PAUSE' | 'RESUME' | 'STOP';

export interface SlaClockEvent {
  event: SlaEventKind;
  reason: string;
  occurred_at: Date;
}

export interface SlaClockState {
  /** Business seconds consumed while the clock was running. */
  elapsedBusinessSeconds: number;
  /** Business seconds left of the 24-hour budget; floors at 0. */
  remainingBusinessSeconds: number;
  /** True while the platform is waiting on someone else (ZM-SON-008). */
  paused: boolean;
  /** The reason recorded on the pause currently in force. */
  pausedReason: string | null;
  /** True once the clock has been stopped by a decision. */
  stopped: boolean;
  /** True once the SLA has been started at all. */
  started: boolean;
  /**
   * When the remaining budget runs out. Null while paused: a paused clock
   * has no deadline, and inventing one — by pretending it resumes now —
   * would show the supplier a date that moves every time they refresh.
   */
  deadlineAt: Date | null;
  /** True when the budget is exhausted and the clock is still running. */
  breached: boolean;
}

/**
 * Reconstructs clock state from the event log.
 *
 * Pure: no clock read, no database, no ambient holiday list. Everything it
 * needs is an argument, which is what makes the pause/resume cases
 * assertable at exact second boundaries.
 *
 * Events must be ordered by `occurred_at`. Redundant events are tolerated
 * rather than rejected — a duplicate PAUSE from a retried request must not
 * corrupt the total, and a PAUSE that arrives while already paused
 * contributes nothing. Being permissive here is deliberate: the reader's
 * job is to produce the truest possible answer from whatever was recorded,
 * and refusing to answer would take the SLA tracker down over a duplicate.
 */
export function reconstructSlaClock(
  events: readonly SlaClockEvent[],
  now: Date,
  holidays: HolidaySet,
  budgetBusinessSeconds: number = ONBOARDING_SLA_BUSINESS_SECONDS,
): SlaClockState {
  let running = false;
  let started = false;
  let stopped = false;
  let runStart: Date | null = null;
  let pausedReason: string | null = null;
  let elapsed = 0;

  for (const event of events) {
    if (stopped) break; // Nothing after STOP can add time.

    switch (event.event) {
      case 'START':
        // A second START is not a restart: the first one is when the SLA
        // began, and honouring a later one would hand back time already
        // spent.
        if (started) break;
        started = true;
        running = true;
        runStart = event.occurred_at;
        pausedReason = null;
        break;

      case 'PAUSE':
        if (!running || !runStart) break;
        elapsed += businessSecondsBetween(runStart, event.occurred_at, holidays);
        running = false;
        runStart = null;
        pausedReason = event.reason;
        break;

      case 'RESUME':
        if (running || !started) break;
        running = true;
        runStart = event.occurred_at;
        pausedReason = null;
        break;

      case 'STOP':
        if (running && runStart) {
          elapsed += businessSecondsBetween(runStart, event.occurred_at, holidays);
        }
        running = false;
        runStart = null;
        stopped = true;
        pausedReason = null;
        break;
    }
  }

  // The open interval: time accrued since the last START/RESUME.
  if (running && runStart) {
    elapsed += businessSecondsBetween(runStart, now, holidays);
  }

  const remaining = Math.max(0, budgetBusinessSeconds - elapsed);
  const paused = started && !running && !stopped;

  return {
    elapsedBusinessSeconds: elapsed,
    remainingBusinessSeconds: remaining,
    paused,
    pausedReason: paused ? pausedReason : null,
    stopped,
    started,
    deadlineAt: running ? addBusinessSeconds(now, remaining, holidays) : null,
    breached: running && remaining === 0,
  };
}

@Injectable()
export class SlaClockService {
  /**
   * Holidays change roughly never and are read on every SLA computation,
   * so they are cached rather than fetched per request. The window is short
   * enough that adding a holiday takes effect during a demo without a
   * restart.
   */
  private holidayCache: { loadedAtMs: number; holidays: HolidaySet } | null = null;
  private static readonly HOLIDAY_TTL_MS = 60_000;

  constructor(
    private readonly db: DatabaseService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /**
   * The holiday set, keyed by Amman-local `YYYY-MM-DD`.
   *
   * `holiday_date` is a `date` column. Formatting it through the driver's
   * Date object would reinterpret it in the server's timezone and can shift
   * it by a day; `to_char` keeps it a calendar date the whole way.
   */
  async holidays(): Promise<HolidaySet> {
    const nowMs = this.time.nowMs();
    if (this.holidayCache && nowMs - this.holidayCache.loadedAtMs < SlaClockService.HOLIDAY_TTL_MS) {
      return this.holidayCache.holidays;
    }
    const { rows } = await this.db.query<{ key: string }>(
      `SELECT to_char(holiday_date, 'YYYY-MM-DD') AS key FROM business_calendar_holidays`,
    );
    const holidays: HolidaySet = new Set(rows.map((r) => r.key));
    this.holidayCache = { loadedAtMs: nowMs, holidays };
    return holidays;
  }

  /** Every clock event for an application, oldest first. */
  async events(applicationId: string, client?: PoolClient): Promise<SlaClockEvent[]> {
    const sql = `SELECT event, reason, occurred_at
                   FROM sla_clock_events
                  WHERE application_id = $1
                  ORDER BY occurred_at ASC, id ASC`;
    const rows = client
      ? (await client.query<SlaClockEvent>(sql, [applicationId])).rows
      : (await this.db.query<SlaClockEvent>(sql, [applicationId])).rows;
    return rows;
  }

  /** Current SLA state for an application, computed from its events. */
  async stateOf(applicationId: string, client?: PoolClient): Promise<SlaClockState> {
    const [events, holidays] = await Promise.all([this.events(applicationId, client), this.holidays()]);
    return reconstructSlaClock(events, this.time.now(), holidays);
  }

  /**
   * Append a clock event.
   *
   * Takes an explicit transaction client because every caller records the
   * event in the same transaction as the state change that caused it. A
   * pause written outside the transaction that set
   * `INFORMATION_REQUIRED` could survive a rollback of the status, leaving a
   * clock stopped for a reason that no longer exists.
   */
  async record(
    client: PoolClient,
    applicationId: string,
    event: SlaEventKind,
    reason: string,
    actorUserId: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO sla_clock_events (application_id, event, reason, actor_user_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [applicationId, event, reason, actorUserId, this.time.now()],
    );
  }

  /**
   * Refresh the denormalized SLA columns on the application row.
   *
   * Derived, never authoritative — see the note at the top of the file. It
   * runs in the same transaction as the event that changed the state so the
   * cache cannot outlive its cause.
   */
  async syncApplicationColumns(client: PoolClient, applicationId: string): Promise<SlaClockState> {
    const events = await this.events(applicationId, client);
    const state = reconstructSlaClock(events, this.time.now(), await this.holidays());
    await client.query(
      `UPDATE supplier_applications
          SET sla_elapsed_business_secs = $2,
              sla_deadline_at           = $3,
              sla_paused_at             = $4,
              updated_at                = now()
        WHERE id = $1`,
      [
        applicationId,
        state.elapsedBusinessSeconds,
        state.deadlineAt,
        state.paused ? this.time.now() : null,
      ],
    );
    return state;
  }
}
