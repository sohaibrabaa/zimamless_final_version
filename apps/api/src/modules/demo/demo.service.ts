import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { SystemTimeProvider } from '../../common/time/time.provider';
import { AppException } from '../../common/errors/app.exception';
import { AuditService } from '../../common/audit/audit.service';
import { SchedulerService } from '../../jobs/scheduler.service';
import type { ActorContext } from '../onboarding/onboarding.service';

/** Who may move the clock once the machine is armed. */
const TIME_TRAVEL_ROLES = ['PLATFORM_OPS_ADMIN', 'PLATFORM_SUPER_ADMIN'];

/**
 * The demo time machine (ZM-DEMO-003/004).
 *
 * Advances a simulated clock by whole days so maturity, overdue-confirmation,
 * deadlines and escalation can be shown in a live demo without waiting real
 * time. The offset is applied in exactly one place — `SystemTimeProvider.now()`
 * — so every sweep and every date decision in the domain moves together.
 *
 * ## Guarded twice, and both are checked here before anything is written
 *
 * `DEMO_TIME_MACHINE_ENV_FLAG` (the `DEMO_TIME_MACHINE_ENABLED` env var, which
 * the config refuses to set true under `NODE_ENV=production`) **and** the
 * `demo_time_machine_enabled` platform setting must both be true. Either off
 * means the endpoint does not exist as far as a caller can tell — a 404, never
 * a 403, because the contract says "Returns 404 in production" and because the
 * existence of a clock-moving control is not something to confirm to a caller
 * who cannot use it. Hiding the UI is explicitly not sufficient protection, so
 * the guard lives on the server and is enforced on every call.
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly time: SystemTimeProvider,
    private readonly audit: AuditService,
    private readonly scheduler: SchedulerService,
    @Inject('DEMO_TIME_MACHINE_ENV_FLAG') private readonly envFlagEnabled: boolean,
  ) {}

  /**
   * Set the simulated clock offset. Returns the new effective instant.
   *
   * `offsetDays` is absolute, not relative: it replaces the current offset
   * rather than adding to it, so a demo can jump to a specific day and back to
   * 0 without arithmetic. A new row is appended (never updated in place — the
   * offset history is itself a record), and `SystemTimeProvider.refresh()` is
   * called synchronously so the very next request sees the new clock rather
   * than waiting up to the cache interval.
   */
  async travel(offsetDays: number, ctx: ActorContext): Promise<Record<string, unknown>> {
    this.requireAvailable();
    await this.requireArmed();

    // Role wall AFTER both 404 guards, deliberately: a supplier probing a
    // disarmed machine learns "not found", never "forbidden" — a 403 from a
    // route decorator would confirm the control exists before the guards got
    // to deny its existence.
    if (!ctx.roles.some((role) => TIME_TRAVEL_ROLES.includes(role))) {
      throw AppException.insufficientRole(TIME_TRAVEL_ROLES);
    }

    if (!Number.isInteger(offsetDays)) {
      throw AppException.validation('offsetDays must be a whole number of days.');
    }

    await this.db.query(
      `INSERT INTO demo_time_offsets (offset_days, set_by, note)
       VALUES ($1, $2::uuid, $3)`,
      [offsetDays, ctx.userId, `Set via /demo/time-travel by ${ctx.organizationType}`],
    );

    await this.time.refresh();

    await this.audit.record({
      actionType: 'DEMO_TIME_TRAVEL',
      targetEntityType: 'DEMO_CLOCK',
      targetEntityId: null,
      previousValue: null,
      newValue: { offsetDays, effectiveDate: this.time.today().toISOString().slice(0, 10) },
    });

    this.logger.warn(
      `Demo clock moved to offsetDays=${offsetDays} (effective ${this.time
        .today()
        .toISOString()
        .slice(0, 10)}) by user ${ctx.userId}`,
    );

    // The response promises "scheduled jobs re-evaluated", so keep that
    // promise before answering: a jump exists to make deadlines pass, and a
    // presenter should not stand waiting for the next 60s tick. The sweeps
    // are idempotent; tick() itself refuses re-entrancy.
    await this.scheduler.tick();

    return {
      offsetDays: this.time.currentOffsetDays(),
      effectiveDate: this.time.today().toISOString().slice(0, 10),
      now: this.time.now().toISOString(),
    };
  }

  /** The env guard. Off → the endpoint is invisible (404). */
  private requireAvailable(): void {
    if (!this.envFlagEnabled) {
      throw AppException.notFound('Resource');
    }
  }

  /**
   * The platform-setting guard. Off → 404 as well, not a 409: an unarmed time
   * machine is indistinguishable from an absent one to a caller, which is the
   * point of arming it separately.
   */
  private async requireArmed(): Promise<void> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'demo_time_machine_enabled'`,
    );
    if (row?.value !== true) {
      throw AppException.notFound('Resource');
    }
  }
}
