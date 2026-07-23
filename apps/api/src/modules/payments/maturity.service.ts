import { Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { requireTransition, TransactionState } from '../transactions/transaction-state';
import { automationPaused, daysUntilDue, maturityAction, overdueDays, reminderDue } from './maturity';
import { NotificationsService } from '../notifications/notifications.service';
import type { TemplateVariables } from '../notifications/template-render';

/**
 * The maturity sweep (ZM-PMT-006..011, AS-05).
 *
 * Two jobs, both idempotent, both reading the injected `TimeProvider` so a
 * demo that jumps the clock forward processes every date in between on the
 * next tick:
 *
 *   1. **Pre-maturity reminders** at `maturity_reminder_days` (30/14/7) and on
 *      the due date, to the supplier.
 *   2. **The due date passing** — `FUNDED`/`PARTIALLY_PAID` →
 *      `OVERDUE_UNCONFIRMED`, and *never* to `OVERDUE`.
 *
 * ## Why this job cannot produce OVERDUE
 *
 * `maturityAction()` has no code path that returns it and no return type that
 * could express it. That is deliberate belt-and-braces: this service is the
 * one place in the system where a clock alone decides something about a
 * supplier's standing, and the strongest available guarantee is that the
 * function it delegates to cannot even name the state.
 *
 * A transaction becomes `OVERDUE` only when a bank says so, through
 * `POST /transactions/{id}/confirm-status`. Until then the honest description
 * is "past due, unconfirmed", and the UI is required to say exactly that.
 *
 * ## What it will not touch
 *
 * A `DISPUTED` or `FRAUD_REVIEW` transaction is skipped entirely (ZM-REC-013).
 * While the facts are contested, an automated job that carried on relabelling
 * the transaction would be picking a side without being asked to.
 */

export type MaturitySweepResult = {
  reminded: number;
  markedUnconfirmed: number;
  skippedPaused: number;
};

interface MaturingRow {
  transaction_id: string;
  state: TransactionState;
  supplier_org_id: string;
  due_date: Date;
  invoice_number: string;
}

@Injectable()
export class MaturityService {
  private readonly logger = new Logger(MaturityService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /** Processes everything now due. Idempotent. */
  async sweep(): Promise<MaturitySweepResult> {
    const now = this.time.now();
    const thresholds = await this.reminderThresholds();
    const rows = await this.maturing();

    let reminded = 0;
    let markedUnconfirmed = 0;
    let skippedPaused = 0;

    for (const row of rows) {
      // Counted rather than silently filtered in SQL: "we skipped 3 disputed
      // transactions" is an operationally useful thing for the log to say,
      // and a silent WHERE clause could not say it.
      if (automationPaused(row.state)) {
        skippedPaused += 1;
        continue;
      }

      reminded += await this.sendReminders(row, now, thresholds);

      if (maturityAction(row.state, row.due_date, now) === 'OVERDUE_UNCONFIRMED') {
        if (await this.markUnconfirmed(row, now)) markedUnconfirmed += 1;
      }
    }

    return { reminded, markedUnconfirmed, skippedPaused };
  }

  /**
   * Every funded transaction with a due date, plus the disputed ones.
   *
   * The paused states are selected rather than excluded so the sweep can
   * report how many it declined to touch. Everything terminal (`PAID`,
   * `CLOSED`, `OVERDUE`, `RECOURSE_ACTIVE`) is excluded here: those have moved
   * beyond what a clock decides.
   */
  private async maturing(): Promise<MaturingRow[]> {
    const { rows } = await this.db.query<MaturingRow>(
      `SELECT t.id            AS transaction_id,
              t.state,
              t.supplier_org_id,
              i.due_date,
              i.invoice_number
         FROM receivable_transactions t
         JOIN invoices i ON i.transaction_id = t.id
        WHERE t.state IN ('FUNDED','PARTIALLY_PAID','OVERDUE_UNCONFIRMED','DISPUTED','FRAUD_REVIEW')`,
    );
    return rows;
  }

  /**
   * `FUNDED` → `OVERDUE_UNCONFIRMED`, under a row lock.
   *
   * Re-reads the state inside the transaction because the sweep's snapshot may
   * be seconds old: a bank confirming a payment while the sweep runs must win,
   * rather than having its confirmation overwritten by a job that decided the
   * invoice was late before the payment arrived.
   */
  private async markUnconfirmed(row: MaturingRow, now: Date): Promise<boolean> {
    return this.db.transaction(async (client: PoolClient) => {
      const { rows: locked } = await client.query<{ state: TransactionState }>(
        `SELECT state FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
        [row.transaction_id],
      );
      const state = locked[0]?.state;
      if (!state) return false;

      // Re-checked, not assumed. Between the sweep's SELECT and this lock the
      // transaction may have been paid, disputed, or already marked.
      if (maturityAction(state, row.due_date, now) !== 'OVERDUE_UNCONFIRMED') return false;

      requireTransition(state, 'OVERDUE_UNCONFIRMED');

      await client.query(
        `UPDATE receivable_transactions SET state = 'OVERDUE_UNCONFIRMED', updated_at = $2
          WHERE id = $1`,
        [row.transaction_id, now],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_at)
         VALUES ('TRANSACTION',$1,$2,'OVERDUE_UNCONFIRMED',$3,$4)`,
        [
          row.transaction_id,
          state,
          // The reason line is read by humans and must not overstate what
          // happened either.
          'Due date passed with no payment reported by the bank. Awaiting bank confirmation.',
          now,
        ],
      );

      await this.notifySupplier(
        client,
        row,
        'PAYMENT_OVERDUE_UNCONFIRMED',
        'Your invoice is past its due date',
        `Invoice ${row.invoice_number} passed its due date on ` +
          `${row.due_date.toISOString().slice(0, 10)} and the bank has not yet reported whether ` +
          `the buyer paid. This is not a record of non-payment — it means we are waiting for ` +
          `the bank to confirm. No action is needed from you.`,
        {
          invoiceNumber: row.invoice_number,
          dueDate: row.due_date.toISOString().slice(0, 10),
        },
      );

      await this.audit.recordIn(client, {
        actionType: 'TRANSACTION_OVERDUE_UNCONFIRMED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: row.transaction_id,
        previousValue: { state },
        newValue: {
          state: 'OVERDUE_UNCONFIRMED',
          dueDate: row.due_date.toISOString().slice(0, 10),
          overdueDays: overdueDays(row.due_date, now),
          // Recorded explicitly so an auditor can see the platform asserted
          // nothing about the buyer's conduct.
          bankConfirmed: false,
        },
      });

      this.logger.log(
        `Transaction ${row.transaction_id} is past due and awaiting bank confirmation`,
      );
      return true;
    });
  }

  /**
   * Pre-maturity reminders (AS-05).
   *
   * `template_key` doubles as the idempotency key, as everywhere else in this
   * codebase: without it a sweep on a one-minute tick would remind the
   * supplier every minute for the last thirty days of the invoice's life.
   */
  private async sendReminders(
    row: MaturingRow,
    now: Date,
    thresholds: readonly number[],
  ): Promise<number> {
    if (row.state !== 'FUNDED' && row.state !== 'PARTIALLY_PAID') return 0;

    const threshold = reminderDue(row.due_date, now, thresholds);
    if (threshold === null) return 0;

    const key = `MATURITY_REMINDER_${threshold}`;
    const already = await this.db.queryOne(
      `SELECT 1 FROM notifications WHERE template_key = $1 AND transaction_id = $2 LIMIT 1`,
      [key, row.transaction_id],
    );
    if (already) return 0;

    // The wording comes from the real number of days left, never from the
    // threshold that triggered it. They are equal on the day a threshold is
    // crossed and differ whenever the sweep picks a transaction up late — and
    // in that case the *date* is the truth and the bucket label is not.
    const remaining = daysUntilDue(row.due_date, now);

    await this.db.transaction(async (client) => {
      await this.notifySupplier(
        client,
        row,
        key,
        remaining <= 0 ? 'Your invoice is due today' : `Your invoice is due in ${remaining} days`,
        `Invoice ${row.invoice_number} is due on ` +
          `${row.due_date.toISOString().slice(0, 10)}. The buyer pays the bank directly; ` +
          `this is for your records.`,
        {
          invoiceNumber: row.invoice_number,
          dueDate: row.due_date.toISOString().slice(0, 10),
          remainingDays: remaining,
        },
      );
    });
    return 1;
  }

  /**
   * Routed through `NotificationsService.send` (Phase 9): the template row
   * and the recipient's `preferred_language` decide the final wording, and
   * the literal text here is the fallback when no template exists — the
   * degrade direction ZM-NOT-004 requires (the message still goes out).
   */
  private async notifySupplier(
    client: PoolClient,
    row: MaturingRow,
    templateKey: string,
    subject: string,
    body: string,
    variables: TemplateVariables,
  ): Promise<void> {
    const { rows: recipients } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM organization_memberships m
        WHERE m.organization_id = $1 AND m.status = 'ACTIVE'`,
      [row.supplier_org_id],
    );

    for (const recipient of recipients) {
      await this.notifications.send(
        {
          templateKey,
          recipientUserId: recipient.user_id,
          transactionId: row.transaction_id,
          fallbackSubject: subject,
          fallbackBody: body,
          variables,
        },
        client,
      );
    }
  }

  private async reminderThresholds(): Promise<number[]> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'maturity_reminder_days'`,
    );
    const parsed = Array.isArray(row?.value) ? row.value : [30, 14, 7];
    const days = (parsed as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    // 0 is the due-date reminder itself, which the setting does not carry.
    return [...new Set([...days, 0])];
  }
}
