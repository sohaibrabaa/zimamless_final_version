import { Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Stalled funding confirmation (ZM-FND-011, ZM-FND-012, AS-04).
 *
 * `FUNDING_CONFIRMATION_PENDING` is the one state in the whole lifecycle where
 * the platform is waiting on a human being who has already been paid. The bank
 * says it sent the money; until the supplier confirms, the transaction is not
 * `FUNDED` and the commission is not finalized. That is correct — but it means
 * a supplier who never opens the notification leaves a real transfer sitting in
 * an unreconciled state indefinitely. ZM-FND-012 puts it plainly: the
 * transaction **must not stall silently**.
 *
 * So two things happen on a schedule while a confirmation is pending:
 *
 *   1. **Reminders to the supplier** (ZM-FND-011) at the halfway point of the
 *      escalation window — one nudge before anyone is escalated to, because
 *      most stalls are an unread notification rather than a problem.
 *   2. **Escalation** once `funding_confirmation_escalation_hours` have passed
 *      since the bank marked the transfer sent. AS-04 is specific about who
 *      receives it: **Operations Admin, not Super Admin**. A stalled
 *      confirmation is operational work, and routing it to the account with
 *      the most authority is how escalations become noise that nobody actions.
 *
 * ## Why the clock starts at `bank_marked_sent_at`
 *
 * Not at the transaction's `updated_at`, which any unrelated write moves, and
 * not at OTP generation, which the bank can repeat — a bank regenerating the
 * code every twenty hours would otherwise postpone escalation forever. The
 * event being waited on is the transfer, so the transfer's own timestamp is
 * what ages.
 *
 * ## Why a sweep rather than a scheduler
 *
 * Same reason as `ListingDeadlinesService`: every read comes from the injected
 * `TimeProvider`, so a demo that jumps the clock forward a day must escalate
 * *immediately*, not a day later in real time. A sweep asking "what is overdue
 * as of now?" is also idempotent, which is what makes it safe to run from an
 * interval, from a time-travel handler, and from a test.
 *
 * ## The gap this works within
 *
 * ZM-FND-012 says escalation "creates an administrative task with full
 * context." The frozen schema has no task table and the contract (including
 * the v3.1.0 overlay, whose `/cases` covers only FRAUD/DISPUTE/WITHDRAWAL/
 * RECOURSE) declares no endpoint that would surface one. Rather than invent a
 * table nothing can read, the escalation is delivered through the mechanism
 * that exists and that an Operations Admin actually sees — a notification
 * carrying the full context, plus an audit entry — and the gap is recorded as
 * Q-16 in OPEN_QUESTIONS.md rather than papered over.
 */

/** What one sweep did. Counts, so a caller can log or assert on them. */
export type FundingSweepResult = {
  reminded: number;
  escalated: number;
};

interface PendingRow {
  transaction_id: string;
  settlement_id: string;
  supplier_org_id: string;
  bank_marked_sent_at: Date;
  net_supplier_payout: string;
  invoice_number: string | null;
}

const REMINDER_KEY = 'FUNDING_CONFIRMATION_REMINDER';
const ESCALATION_KEY = 'FUNDING_CONFIRMATION_ESCALATED';

@Injectable()
export class FundingDeadlinesService {
  private readonly logger = new Logger(FundingDeadlinesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /** Processes everything now due. Idempotent. */
  async sweep(): Promise<FundingSweepResult> {
    const now = this.time.now();
    const windowHours = await this.escalationHours();
    const pending = await this.pending();

    let reminded = 0;
    let escalated = 0;

    for (const row of pending) {
      const elapsedHours = (now.getTime() - row.bank_marked_sent_at.getTime()) / 3_600_000;

      // Escalation is checked first and short-circuits the reminder: once the
      // window is spent, a "gentle nudge" alongside the escalation would be
      // noise, and a transaction that stalled straight past both points should
      // escalate rather than collect a reminder it is already too late for.
      if (elapsedHours >= windowHours) {
        if (await this.escalate(row, now, elapsedHours)) escalated += 1;
        continue;
      }

      if (elapsedHours >= windowHours / 2) {
        if (await this.remind(row, windowHours)) reminded += 1;
      }
    }

    return { reminded, escalated };
  }

  /**
   * Everything currently awaiting a supplier confirmation.
   *
   * Driven off the transaction state rather than the settlement status: the
   * settlement stays `FUNDING_RECEIVED` through the confirmation, so it is the
   * transaction leaving `FUNDING_CONFIRMATION_PENDING` that ends the wait. A
   * transaction that has since reached `FUNDED` disappears from this query on
   * the next sweep with no cleanup step of its own.
   */
  private async pending(): Promise<PendingRow[]> {
    const { rows } = await this.db.query<PendingRow>(
      `SELECT t.id                       AS transaction_id,
              s.id                       AS settlement_id,
              t.supplier_org_id,
              s.bank_marked_sent_at,
              s.net_supplier_payout,
              i.invoice_number
         FROM receivable_transactions t
         JOIN settlements s ON s.transaction_id = t.id
         LEFT JOIN invoices i ON i.transaction_id = t.id
        WHERE t.state = 'FUNDING_CONFIRMATION_PENDING'
          AND s.bank_marked_sent_at IS NOT NULL`,
    );
    return rows;
  }

  /**
   * ZM-FND-011's supplier reminder. Sent once, ever.
   *
   * `template_key` + `transaction_id` is the idempotency key, the same device
   * the selection reminders use — without it a sweep on a one-minute interval
   * would send a reminder every minute for the back half of the window.
   */
  private async remind(row: PendingRow, windowHours: number): Promise<boolean> {
    if (await this.alreadySent(REMINDER_KEY, row.transaction_id)) return false;

    const recipients = await this.supplierRecipients(row.supplier_org_id);
    if (recipients.length === 0) return false;

    for (const userId of recipients) {
      await this.notifications.send({
        templateKey: REMINDER_KEY,
        recipientUserId: userId,
        transactionId: row.transaction_id,
        fallbackSubject: 'Please confirm you received your funding',
        fallbackBody:
          `Your bank recorded this transfer as sent. Confirming receipt with the one-time ` +
          `code the bank gave you is what completes funding. If you have not received the ` +
          `code, ask the bank to issue a new one. After about ${windowHours} hours without ` +
          `a confirmation this is escalated to platform operations.`,
        variables: { windowHours },
      });
    }
    this.logger.log(`Reminded supplier to confirm funding on transaction ${row.transaction_id}`);
    return true;
  }

  /**
   * AS-04 — escalate to Operations Admin, never Super Admin.
   *
   * The notification and the audit entry are written in one transaction: an
   * escalation that is recorded but not delivered is worse than one that never
   * happened, because the audit trail then claims someone was told.
   */
  private async escalate(row: PendingRow, now: Date, elapsedHours: number): Promise<boolean> {
    if (await this.alreadySent(ESCALATION_KEY, row.transaction_id)) return false;

    const admins = await this.operationsAdmins();
    if (admins.length === 0) {
      // Loud, because this means AS-04 cannot be satisfied on this deployment
      // — not a transient miss that the next sweep will pick up.
      this.logger.error(
        `Transaction ${row.transaction_id} needs escalation but no active ` +
          `PLATFORM_OPS_ADMIN exists to escalate to`,
      );
      return false;
    }

    // ZM-FND-012's "full context": what is stuck, whose it is, how much is in
    // flight, and how long it has been waiting — enough for an operator to act
    // without opening four screens first.
    const context = {
      transactionId: row.transaction_id,
      settlementId: row.settlement_id,
      invoiceNumber: row.invoice_number,
      supplierOrgId: row.supplier_org_id,
      netSupplierPayout: row.net_supplier_payout,
      bankMarkedSentAt: row.bank_marked_sent_at.toISOString(),
      hoursPending: Math.floor(elapsedHours),
    };

    await this.db.transaction(async (client: PoolClient) => {
      for (const userId of admins) {
        await this.notifications.send(
          {
            templateKey: ESCALATION_KEY,
            recipientUserId: userId,
            transactionId: row.transaction_id,
            fallbackSubject: 'Funding confirmation stalled — operations action needed',
            fallbackBody:
              `Invoice ${row.invoice_number ?? row.transaction_id}: the bank marked the ` +
              `transfer sent at ${row.bank_marked_sent_at.toISOString()} and the supplier has ` +
              `not confirmed receipt in ${Math.floor(elapsedHours)} hours. ` +
              `Net payout ${row.net_supplier_payout} JOD is held pending confirmation. ` +
              `The transaction is not FUNDED and the commission is not finalized. ` +
              `Contact the supplier, or have the bank reissue the one-time code.`,
            variables: {
              invoiceNumber: row.invoice_number ?? row.transaction_id,
              markedSentAt: row.bank_marked_sent_at.toISOString(),
              hoursPending: Math.floor(elapsedHours),
              netSupplierPayout: row.net_supplier_payout,
            },
          },
          client,
        );
      }

      await this.audit.recordIn(client, {
        actionType: 'FUNDING_CONFIRMATION_ESCALATED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: row.transaction_id,
        previousValue: { escalated: false },
        newValue: { escalated: true, escalatedAt: now.toISOString(), ...context },
      });
    });

    this.logger.warn(
      `Escalated stalled funding confirmation on transaction ${row.transaction_id} ` +
        `to ${admins.length} operations admin(s) after ${Math.floor(elapsedHours)}h`,
    );
    return true;
  }

  private async alreadySent(templateKey: string, transactionId: string): Promise<boolean> {
    const row = await this.db.queryOne(
      `SELECT 1 FROM notifications WHERE template_key = $1 AND transaction_id = $2 LIMIT 1`,
      [templateKey, transactionId],
    );
    return row !== null;
  }

  private async supplierRecipients(organizationId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM organization_memberships m
         JOIN membership_roles r ON r.membership_id = m.id
        WHERE m.organization_id = $1 AND m.status = 'ACTIVE'
          AND r.role IN ('SUPPLIER_OWNER','SUPPLIER_SIGNATORY')`,
      [organizationId],
    );
    return rows.map((r) => r.user_id);
  }

  /**
   * AS-04, stated as a query: Operations Admin only.
   *
   * `PLATFORM_SUPER_ADMIN` is deliberately not in this list even though it
   * outranks the role that is. Escalating to the highest-privilege account by
   * default is exactly the habit AS-04 exists to prevent.
   */
  private async operationsAdmins(): Promise<string[]> {
    const { rows } = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM organization_memberships m
         JOIN membership_roles r ON r.membership_id = m.id
        WHERE m.status = 'ACTIVE' AND r.role = 'PLATFORM_OPS_ADMIN'`,
    );
    return rows.map((r) => r.user_id);
  }

  private async escalationHours(): Promise<number> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'funding_confirmation_escalation_hours'`,
    );
    const n = typeof row?.value === 'number' ? row.value : Number(row?.value);
    return Number.isFinite(n) && n > 0 ? n : 24;
  }
}
