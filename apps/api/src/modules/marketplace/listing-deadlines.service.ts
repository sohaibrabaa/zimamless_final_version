import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { ListingsService, type ListingRow } from './listings.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Listing deadline processing (ZM-MKT-009, AS-02).
 *
 * Three things happen on a schedule:
 *
 *   1. **Offer window closes.** At `offer_submission_deadline` the listing
 *      moves to `OFFER_PERIOD_CLOSED` and then `AWAITING_SELECTION`. After
 *      that no offer can be created, revised or withdrawn — enforced on the
 *      listing *status* rather than by comparing the clock at each call site,
 *      so one place decides the window has closed and writes it down.
 *   2. **Selection reminders** at 50% and 15% of the selection window (AS-02).
 *   3. **Selection deadline lapses.** Offers go `EXPIRED`, the listing closes,
 *      and the transaction returns to `ELIGIBLE` — the receivable is
 *      untouched and the supplier may relist. Returning it to a terminal
 *      state would destroy value over a missed deadline.
 *
 * ## Why a sweep rather than a scheduler
 *
 * Every time this service reads comes from the injected `TimeProvider`, which
 * carries the demo offset (ZM-DEMO-003). A wall-clock cron would be actively
 * wrong here: when a demo jumps the clock forward three days, the deadlines
 * in between must process *immediately*, not three days later in real time.
 * A sweep that asks "what is overdue as of the provider's now?" handles both
 * the real case and the demo case with the same code, and is idempotent — it
 * can run twice with no second effect, which is what makes it safe to invoke
 * from an interval, from a time-travel handler, and from a test.
 */

@Injectable()
export class ListingDeadlinesService {
  private readonly logger = new Logger(ListingDeadlinesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly listings: ListingsService,
    private readonly notifications: NotificationsService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /** Processes everything now due. Idempotent. Returns what it did. */
  async sweep(): Promise<{ closed: number; lapsed: number; reminded: number }> {
    const now = this.time.now();
    return {
      closed: await this.closeExpiredOfferWindows(now),
      lapsed: await this.lapseSelectionDeadlines(now),
      reminded: await this.sendSelectionReminders(now),
    };
  }

  /**
   * `OPEN_FOR_OFFERS` → `AWAITING_SELECTION` once the offer window passes.
   *
   * The schema has an intermediate `OFFER_PERIOD_CLOSED`, and the transition
   * runs through it rather than skipping to `AWAITING_SELECTION` directly, so
   * the status history reads as what actually happened rather than as a jump
   * the state machine would have refused.
   */
  private async closeExpiredOfferWindows(now: Date): Promise<number> {
    const { rows } = await this.db.query<ListingRow>(
      `SELECT * FROM listings
        WHERE status = 'OPEN_FOR_OFFERS' AND offer_submission_deadline <= $1`,
      [now],
    );

    for (const listing of rows) {
      await this.db.transaction(async (client) => {
        await this.listings.transition(
          client, listing, 'OFFER_PERIOD_CLOSED', 'Offer submission deadline reached',
        );
        await this.listings.transition(
          client,
          { ...listing, status: 'OFFER_PERIOD_CLOSED' },
          'AWAITING_SELECTION',
          'Awaiting supplier selection',
        );

        // Offers still sitting in internal approval never became visible to
        // the supplier, so they expire rather than lingering as a slot the
        // bank cannot use in the next round.
        await client.query(
          `UPDATE bank_offers SET status = 'EXPIRED'
            WHERE listing_id = $1 AND status IN ('DRAFT','PENDING_INTERNAL_APPROVAL')`,
          [listing.id],
        );
      });
      this.logger.log(`Listing ${listing.id} offer window closed`);
    }
    return rows.length;
  }

  /**
   * The selection deadline passes with nothing selected.
   *
   * All active offers expire, the listing expires, and the transaction goes
   * back to `ELIGIBLE` so the supplier can relist (ZM-MKT-017 governs whether
   * a new round costs another fee).
   */
  private async lapseSelectionDeadlines(now: Date): Promise<number> {
    const { rows } = await this.db.query<ListingRow>(
      `SELECT * FROM listings
        WHERE status IN ('OFFER_PERIOD_CLOSED','AWAITING_SELECTION','OPEN_FOR_OFFERS')
          AND supplier_selection_deadline <= $1`,
      [now],
    );

    for (const listing of rows) {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE bank_offers SET status = 'EXPIRED'
            WHERE listing_id = $1
              AND status IN ('DRAFT','PENDING_INTERNAL_APPROVAL','ACTIVE')`,
          [listing.id],
        );
        await this.listings.transition(
          client, listing, 'EXPIRED', 'Supplier selection deadline lapsed',
        );

        // Only if it is still sitting in OPEN_FOR_OFFERS. A transaction that
        // has moved on (accepted, cancelled) must not be dragged backwards by
        // a late sweep.
        await client.query(
          `UPDATE receivable_transactions
              SET state = 'ELIGIBLE', updated_at = now()
            WHERE id = $1 AND state = 'OPEN_FOR_OFFERS'`,
          [listing.transaction_id],
        );
        await client.query(
          `INSERT INTO status_history
             (entity_type, entity_id, previous_status, new_status, reason, changed_at)
           SELECT 'TRANSACTION', $1, 'OPEN_FOR_OFFERS', 'ELIGIBLE',
                  'Listing lapsed with no offer selected', $2
            WHERE EXISTS (SELECT 1 FROM receivable_transactions
                           WHERE id = $1 AND state = 'ELIGIBLE')`,
          [listing.transaction_id, now],
        );
      });
      this.logger.log(`Listing ${listing.id} lapsed; transaction returned to ELIGIBLE`);
    }
    return rows.length;
  }

  /**
   * AS-02 reminders at 50% and 15% of the selection window remaining.
   *
   * `template_key` doubles as the idempotency key: a reminder is sent only if
   * no notification with that key already exists for the transaction. Without
   * that, a sweep running every minute would send a reminder every minute for
   * the whole second half of the window.
   */
  private async sendSelectionReminders(now: Date): Promise<number> {
    const thresholds = await this.reminderThresholds();
    const { rows } = await this.db.query<ListingRow>(
      `SELECT * FROM listings WHERE status IN ('OFFER_PERIOD_CLOSED','AWAITING_SELECTION')`,
    );

    let sent = 0;
    for (const listing of rows) {
      const start = listing.offer_submission_deadline.getTime();
      const end = listing.supplier_selection_deadline.getTime();
      const total = end - start;
      if (total <= 0) continue;

      const remainingPct = ((end - now.getTime()) / total) * 100;

      for (const threshold of thresholds) {
        if (remainingPct > threshold) continue;
        const key = `SELECTION_REMINDER_${threshold}`;

        const already = await this.db.queryOne(
          `SELECT 1 FROM notifications
            WHERE template_key = $1 AND transaction_id = $2`,
          [key, listing.transaction_id],
        );
        if (already) continue;

        const { rows: recipients } = await this.db.query<{ user_id: string }>(
          `SELECT DISTINCT m.user_id
             FROM organization_memberships m
             JOIN receivable_transactions t ON t.supplier_org_id = m.organization_id
            WHERE t.id = $1 AND m.status = 'ACTIVE'`,
          [listing.transaction_id],
        );

        // A displayed percentage, not money — truncated rather than rounded
        // so the notification never claims more time remains than does.
        const pctRemaining = Math.max(0, Math.trunc(remainingPct));
        for (const recipient of recipients) {
          await this.notifications.send({
            templateKey: key,
            recipientUserId: recipient.user_id,
            transactionId: listing.transaction_id,
            fallbackSubject: 'Offer selection deadline approaching',
            fallbackBody:
              `About ${pctRemaining}% of your selection window remains. ` +
              `It closes at ${listing.supplier_selection_deadline.toISOString()}.`,
            variables: {
              percentRemaining: pctRemaining,
              selectionDeadline: listing.supplier_selection_deadline.toISOString(),
            },
          });
          sent += 1;
        }
      }
    }
    return sent;
  }

  private async reminderThresholds(): Promise<number[]> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'reminder_thresholds_pct'`,
    );
    const parsed = Array.isArray(row?.value) ? row.value : [50, 15];
    return (parsed as unknown[])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v > 0)
      // Descending, so the 50% reminder is considered before the 15% one and
      // a listing that skipped straight past both still gets each recorded.
      .sort((a, b) => b - a);
  }
}
