import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { requireTransition, TransactionState } from '../transactions/transaction-state';
import { derivedOutstanding, overdueDays, stateAfterPayment } from './maturity';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Buyer payments, bank confirmation, and closure (ZM-PMT-*).
 *
 * Three ideas run through this file.
 *
 * **The balance is derived, never stored** (D-13 / PA-06). `invoices.paid_amount`
 * and `invoices.outstanding_amount` freeze at listing — they are what the offer
 * was priced against, and rewriting them would retroactively change the terms
 * of a deal that already closed. Nothing here writes to them. The live figure
 * is computed from `buyer_payments` on every read.
 *
 * **A bank's report is evidence; the platform's silence is not.** Recording a
 * payment moves the transaction because a bank asserted something. A due date
 * passing moves it only as far as `OVERDUE_UNCONFIRMED`, and `confirm-status`
 * is the only route to `OVERDUE`.
 *
 * **`bank_internal_notes` and evidence never reach the supplier** (ZM-PMT-018).
 * The supplier payload is built from an explicit allow-list, the same discipline
 * that keeps `minimumAcceptableAmount` away from banks. Not a filter applied to
 * a full object — a different object.
 */

export interface PaymentRow {
  id: string;
  transaction_id: string;
  amount: string;
  payment_date: Date;
  bank_reference: string | null;
  evidence_document_id: string | null;
  bank_internal_notes: string | null;
  reported_by: string;
  reported_at: Date;
}

interface TransactionRow {
  id: string;
  state: TransactionState;
  supplier_org_id: string;
}

export type PaymentsAudience = 'SUPPLIER' | 'BANK' | 'PLATFORM';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // ===================================================================
  // Recording a payment
  // ===================================================================

  /**
   * The bank reports that the buyer paid (ZM-PMT-012..017).
   *
   * The transaction moves to `PARTIALLY_PAID` or `PAID` according to the
   * *derived* total, computed inside the write transaction under a row lock so
   * two payments reported at the same instant cannot both read the old total
   * and both conclude the invoice is still partly unpaid.
   */
  async recordPayment(
    transactionId: string,
    ctx: ActorContext,
    input: {
      amount: string;
      paymentDate: string;
      bankReference?: string;
      evidenceDocumentId?: string;
      bankInternalNotes?: string;
    },
  ): Promise<{ id: string; outstandingAmount: string; transactionState: TransactionState }> {
    await this.requireFundingBank(transactionId, ctx);

    const amount = Money.from(input.amount);
    if (!amount.isPositive()) {
      throw AppException.validation('A payment amount must be greater than zero.', {
        field: 'amount',
      });
    }

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const transaction = await this.lockTransaction(client, transactionId);
      this.refuseIfPaused(transaction.state);

      if (!PAYABLE_STATES.has(transaction.state)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'A payment can only be recorded against a funded transaction.',
          HttpStatus.CONFLICT,
          { state: transaction.state },
        );
      }

      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO buyer_payments
           (transaction_id, amount, payment_date, bank_reference, evidence_document_id,
            bank_internal_notes, reported_by, reported_at)
         VALUES ($1,$2::numeric,$3::date,$4,$5::uuid,$6,$7::uuid,$8)
         RETURNING id`,
        [
          transactionId,
          amount.toDb(),
          input.paymentDate,
          input.bankReference ?? null,
          input.evidenceDocumentId ?? null,
          input.bankInternalNotes ?? null,
          ctx.userId,
          now,
        ],
      );

      const frozen = await this.frozenOutstanding(client, transactionId);
      const payments = await this.paymentsIn(client, transactionId);
      const outstanding = derivedOutstanding(frozen, payments.map(toMoney));
      const next = stateAfterPayment(frozen, payments.map(toMoney));

      // A payment that does not settle the invoice leaves an already
      // partly-paid transaction where it is rather than "transitioning" it to
      // the state it is already in.
      if (next !== transaction.state) {
        requireTransition(transaction.state, next);
        await this.moveTo(client, transaction, next, now, 'Buyer payment reported by the bank');
      }

      await this.audit.recordIn(client, {
        actionType: 'BUYER_PAYMENT_RECORDED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: transactionId,
        previousValue: { state: transaction.state },
        newValue: {
          state: next,
          paymentId: inserted[0].id,
          amount: amount.toString(),
          paymentDate: input.paymentDate,
          outstandingAmount: outstanding.toString(),
          // Deliberately absent: bankInternalNotes. The audit trail is read by
          // platform staff and the notes are the bank's own working record.
        },
      });

      this.logger.log(
        `Payment ${inserted[0].id} recorded on ${transactionId}; outstanding ${outstanding.toString()}`,
      );

      return {
        id: inserted[0].id,
        outstandingAmount: outstanding.toString(),
        transactionState: next,
      };
    });
  }

  // ===================================================================
  // Reading payments
  // ===================================================================

  /**
   * The payment history, shaped for who is asking.
   *
   * A supplier gets amounts, dates and the derived balance. It never gets
   * `bank_internal_notes` or `evidence_document_id` — the notes are the bank's
   * private working record (ZM-PMT-018) and the evidence is a document the
   * supplier has no right to fetch. Those two fields are not filtered out of a
   * shared object; the supplier's object is built without them.
   */
  async list(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<{
    payments: Record<string, unknown>[];
    outstandingAmount: string;
    overdueDays: number;
  }> {
    const audience = await this.requireVisibility(transactionId, ctx);

    const payments = await this.paymentsIn(this.db as unknown as PoolClient, transactionId);
    const frozen = await this.frozenOutstanding(
      this.db as unknown as PoolClient,
      transactionId,
    );
    const dueDate = await this.dueDate(transactionId);

    return {
      payments: payments.map((p) => describePayment(p, audience)),
      outstandingAmount: derivedOutstanding(frozen, payments.map(toMoney)).toString(),
      overdueDays: dueDate ? overdueDays(dueDate, this.time.now()) : 0,
    };
  }

  // ===================================================================
  // Bank confirmation — the only route to OVERDUE
  // ===================================================================

  /**
   * `POST /transactions/{id}/confirm-status`.
   *
   * This is the only thing in the entire system that can produce `OVERDUE`.
   * The endpoint exists so that the state means "a bank told us the buyer did
   * not pay" rather than "a date passed", and it is restricted to the funding
   * bank because no other party is in a position to know.
   *
   * `PAID` and `PARTIALLY_PAID` are equally valid confirmations: the common
   * case is that the buyer did pay and nobody had recorded it yet.
   */
  async confirmStatus(
    transactionId: string,
    ctx: ActorContext,
    input: { status: 'PAID' | 'PARTIALLY_PAID' | 'OVERDUE'; notes?: string },
  ): Promise<{ transactionState: TransactionState; outstandingAmount: string }> {
    await this.requireFundingBank(transactionId, ctx);
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const transaction = await this.lockTransaction(client, transactionId);
      this.refuseIfPaused(transaction.state);

      if (!CONFIRMABLE_STATES.has(transaction.state)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'There is nothing awaiting confirmation on this transaction.',
          HttpStatus.CONFLICT,
          { state: transaction.state },
        );
      }

      const frozen = await this.frozenOutstanding(client, transactionId);
      const payments = await this.paymentsIn(client, transactionId);
      const outstanding = derivedOutstanding(frozen, payments.map(toMoney));

      // A bank cannot confirm PAID while the recorded payments do not add up
      // to the invoice. The confirmation and the money have to agree, or the
      // derived balance and the state would tell a supplier two different
      // stories about the same invoice.
      if (input.status === 'PAID' && !outstanding.isZero()) {
        throw AppException.validation(
          'Record the payments that settle this invoice before confirming it as paid.',
          { field: 'status', outstandingAmount: outstanding.toString() },
        );
      }

      if (input.status !== transaction.state) {
        requireTransition(transaction.state, input.status);
        await this.moveTo(
          client,
          transaction,
          input.status,
          now,
          input.notes?.trim()
            ? `Bank confirmed ${input.status}: ${input.notes.trim()}`
            : `Bank confirmed ${input.status}`,
        );
      }

      await this.audit.recordIn(client, {
        actionType: 'PAYMENT_STATUS_CONFIRMED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: transactionId,
        previousValue: { state: transaction.state },
        newValue: {
          state: input.status,
          outstandingAmount: outstanding.toString(),
          // The distinction the whole phase turns on, recorded explicitly.
          confirmedByBank: true,
          notes: input.notes ?? null,
        },
      });

      return { transactionState: input.status, outstandingAmount: outstanding.toString() };
    });
  }

  // ===================================================================
  // Closure
  // ===================================================================

  /**
   * `POST /transactions/{id}/close`.
   *
   * Closure is a record, not a deletion (INV-7). Everything the transaction
   * accumulated — payments, cases, journals, notifications — stays exactly
   * where it is; the transaction simply stops being live, with a reason
   * naming why.
   */
  async close(
    transactionId: string,
    ctx: ActorContext,
    input: { closureReason: string; notes?: string },
  ): Promise<{ transactionState: TransactionState; closureReason: string }> {
    await this.requireFundingBankOrPlatform(transactionId, ctx);
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const transaction = await this.lockTransaction(client, transactionId);

      if (transaction.state === 'CLOSED') {
        // Idempotent by observation, like mark-sent: closing a closed
        // transaction is not a mistake worth an error.
        const { rows } = await client.query<{ closure_reason: string }>(
          `SELECT closure_reason FROM receivable_transactions WHERE id = $1`,
          [transactionId],
        );
        return { transactionState: 'CLOSED' as const, closureReason: rows[0]?.closure_reason };
      }

      requireTransition(transaction.state, 'CLOSED');

      await client.query(
        `UPDATE receivable_transactions
            SET state = 'CLOSED', closure_reason = $2::closure_reason,
                closure_notes = $3, updated_at = $4
          WHERE id = $1`,
        [transactionId, input.closureReason, input.notes ?? null, now],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
         VALUES ('TRANSACTION',$1,$2,'CLOSED',$3,$4,$5::uuid)`,
        [transactionId, transaction.state, `Closed: ${input.closureReason}`, now, ctx.userId],
      );

      await this.audit.recordIn(client, {
        actionType: 'TRANSACTION_CLOSED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: transactionId,
        previousValue: { state: transaction.state },
        newValue: { state: 'CLOSED', closureReason: input.closureReason, notes: input.notes ?? null },
      });

      return { transactionState: 'CLOSED' as const, closureReason: input.closureReason };
    });
  }

  // ===================================================================
  // helpers
  // ===================================================================

  private async lockTransaction(client: PoolClient, id: string): Promise<TransactionRow> {
    const { rows } = await client.query<TransactionRow>(
      `SELECT id, state, supplier_org_id FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (rows.length === 0) throw AppException.notFound('Transaction');
    return rows[0];
  }

  /** ZM-REC-013, enforced on writes as well as in the sweep. */
  private refuseIfPaused(state: TransactionState): void {
    if (state === 'DISPUTED' || state === 'FRAUD_REVIEW') {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        state === 'DISPUTED'
          ? 'This transaction is under dispute. Resolve the dispute before recording payments.'
          : 'This transaction is under fraud review.',
        HttpStatus.CONFLICT,
        { state },
      );
    }
  }

  /**
   * The frozen outstanding the balance is derived from.
   *
   * Read from `invoices.outstanding_amount`, which is exactly the point of
   * D-13: the column is a *snapshot* taken at listing, not a running total.
   * Nothing in this phase writes to it.
   */
  private async frozenOutstanding(client: PoolClient, transactionId: string): Promise<Money> {
    const { rows } = await client.query<{ outstanding_amount: string }>(
      `SELECT outstanding_amount::text FROM invoices WHERE transaction_id = $1`,
      [transactionId],
    );
    if (rows.length === 0) throw AppException.notFound('Invoice');
    return Money.from(rows[0].outstanding_amount);
  }

  private async paymentsIn(client: PoolClient, transactionId: string): Promise<PaymentRow[]> {
    const { rows } = await client.query<PaymentRow>(
      `SELECT id, transaction_id, amount::text, payment_date, bank_reference,
              evidence_document_id, bank_internal_notes, reported_by, reported_at
         FROM buyer_payments WHERE transaction_id = $1
        ORDER BY payment_date, reported_at`,
      [transactionId],
    );
    return rows;
  }

  private async dueDate(transactionId: string): Promise<Date | null> {
    const row = await this.db.queryOne<{ due_date: Date }>(
      `SELECT due_date FROM invoices WHERE transaction_id = $1`,
      [transactionId],
    );
    return row?.due_date ?? null;
  }

  private async moveTo(
    client: PoolClient,
    transaction: TransactionRow,
    next: TransactionState,
    now: Date,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE receivable_transactions SET state = $2::transaction_state, updated_at = $3 WHERE id = $1`,
      [transaction.id, next, now],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at)
       VALUES ('TRANSACTION',$1,$2,$3,$4,$5)`,
      [transaction.id, transaction.state, next, reason, now],
    );
  }

  /** Only the bank that funded this transaction may report or confirm. */
  private async requireFundingBank(transactionId: string, ctx: ActorContext): Promise<void> {
    if (ctx.organizationType !== 'BANK') {
      throw AppException.insufficientRole(['BANK_OPERATIONS']);
    }
    const row = await this.db.queryOne<{ bank_org_id: string }>(
      `SELECT bank_org_id FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
    // 404, not 403: a bank that is not party to this transaction must not
    // learn that it exists.
    if (!row) throw AppException.notFound('Transaction');
    if (row.bank_org_id !== ctx.organizationId) throw AppException.notFound('Transaction');
  }

  private async requireFundingBankOrPlatform(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;
    await this.requireFundingBank(transactionId, ctx);
  }

  /** Both parties and the platform may read the payment history. */
  private async requireVisibility(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<PaymentsAudience> {
    if (ctx.organizationType === 'PLATFORM') return 'PLATFORM';

    const row = await this.db.queryOne<{ supplier_org_id: string; bank_org_id: string | null }>(
      `SELECT t.supplier_org_id, s.bank_org_id
         FROM receivable_transactions t
         LEFT JOIN accepted_offer_snapshots s ON s.transaction_id = t.id
        WHERE t.id = $1`,
      [transactionId],
    );
    if (!row) throw AppException.notFound('Transaction');

    if (ctx.organizationType === 'SUPPLIER' && row.supplier_org_id === ctx.organizationId) {
      return 'SUPPLIER';
    }
    if (ctx.organizationType === 'BANK' && row.bank_org_id === ctx.organizationId) {
      return 'BANK';
    }
    throw AppException.notFound('Transaction');
  }
}

/** States in which a buyer payment can be recorded. */
const PAYABLE_STATES: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'FUNDED',
  'PARTIALLY_PAID',
  'OVERDUE_UNCONFIRMED',
  'OVERDUE',
]);

/** States a bank may confirm out of. */
const CONFIRMABLE_STATES: ReadonlySet<TransactionState> = new Set<TransactionState>([
  'OVERDUE_UNCONFIRMED',
  'PARTIALLY_PAID',
  'FUNDED',
]);

function toMoney(row: PaymentRow): { amount: Money } {
  return { amount: Money.from(row.amount) };
}

/**
 * ZM-PMT-018 — the supplier's payload is a different object, not a filtered one.
 *
 * Written as two explicit literals rather than one object with deletions,
 * because a `delete` is a step someone can forget to add when a column is
 * introduced, whereas a field absent from a literal has to be deliberately
 * typed in to leak.
 */
export function describePayment(
  payment: PaymentRow,
  audience: PaymentsAudience,
): Record<string, unknown> {
  const shared = {
    id: payment.id,
    amount: payment.amount,
    paymentDate: payment.payment_date.toISOString().slice(0, 10),
    bankReference: payment.bank_reference,
    reportedAt: payment.reported_at.toISOString(),
  };

  if (audience === 'SUPPLIER') return shared;

  return {
    ...shared,
    evidenceDocumentId: payment.evidence_document_id,
    bankInternalNotes: payment.bank_internal_notes,
    reportedBy: payment.reported_by,
  };
}
