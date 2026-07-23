import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { requireTransition, TransactionState } from '../transactions/transaction-state';
import {
  claimExceedsAdvance,
  remainingAfter,
  requireProgress,
  RecourseReason,
  RecourseStatus,
  settlesCase,
} from './recourse-state';
import type { ActorContext } from '../onboarding/onboarding.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { TemplateVariables } from '../notifications/template-render';

/**
 * Recourse — the bank's claim against the supplier (ZM-REC-001..012).
 *
 * Three rules do the work here, and each exists because the obvious
 * implementation would be wrong in a way that costs a real supplier money.
 *
 * **Only a bank may initiate** (ZM-REC-002). A platform administrator is
 * refused, and that is not an oversight to be tidied up later: recourse is a
 * commercial claim between two counterparties, and a platform that could start
 * one on a bank's behalf would be taking a position in a dispute it is
 * supposed to be neutral in. The 403 is the requirement.
 *
 * **A claim cannot exceed what was advanced** (ZM-REC-004). The bank paid the
 * gross funding amount; recourse recovers that. Claiming the invoice's face
 * value would recover more than was ever paid out.
 *
 * **The commission is not refunded automatically** (ZM-FEE-016). See
 * `commissionRefundOnRecourse` in `recourse-state.ts` — the reasoning is
 * written there because that is where the rule is named and tested.
 *
 * Repayments run through the Phase 7 settlement architecture rather than a
 * second payment path: same provider symbol, same idempotency discipline. A
 * supplier repaying a bank is money moving on a rail, and the system already
 * has exactly one way to do that.
 */

export interface RecourseCaseRow {
  id: string;
  transaction_id: string;
  reason: RecourseReason;
  reason_notes: string | null;
  requested_amount: string;
  repaid_amount: string;
  remaining_amount: string;
  status: RecourseStatus;
  initiated_by: string;
  initiated_at: Date;
  settled_at: Date | null;
}

@Injectable()
export class RecourseService {
  private readonly logger = new Logger(RecourseService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // ===================================================================
  // Initiation — bank only
  // ===================================================================

  async initiate(
    transactionId: string,
    ctx: ActorContext,
    input: {
      reason: RecourseReason;
      requestedAmount: string;
      notes?: string;
      evidenceDocumentIds?: string[];
    },
  ): Promise<RecourseCaseRow> {
    // ZM-REC-002, checked before anything else. A platform admin reaching this
    // endpoint is refused with 403 rather than 404: unlike a bank that is not
    // party to a transaction, platform staff already know it exists, so there
    // is nothing to conceal — the honest answer is "you may not do this".
    if (ctx.organizationType !== 'BANK') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only the funding bank may initiate recourse. Recourse is a commercial claim ' +
          'between the two counterparties; the platform does not make it on a bank’s behalf.',
        HttpStatus.FORBIDDEN,
      );
    }

    const snapshot = await this.requireFundingBank(transactionId, ctx);
    const requested = Money.from(input.requestedAmount);

    if (!requested.isPositive()) {
      throw AppException.validation('A recourse claim must be for more than zero.', {
        field: 'requestedAmount',
      });
    }

    const advance = Money.from(snapshot.gross_funding_amount);
    if (claimExceedsAdvance(requested, advance)) {
      throw AppException.validation(
        'A recourse claim cannot exceed the amount the bank advanced.',
        { field: 'requestedAmount', maximum: advance.toString() },
      );
    }

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const state = await this.lockState(client, transactionId);

      // ZM-REC-001: recourse follows a CONFIRMED overdue. Starting one from
      // OVERDUE_UNCONFIRMED would act on the assumption that state exists
      // precisely to avoid making — that silence proves non-payment.
      if (state !== 'OVERDUE') {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          state === 'OVERDUE_UNCONFIRMED'
            ? 'Confirm the overdue status before initiating recourse. An unconfirmed overdue ' +
              'is not evidence that the buyer failed to pay.'
            : 'Recourse can only be initiated on a confirmed overdue transaction.',
          HttpStatus.CONFLICT,
          { state },
        );
      }

      const existing = await client.query<{ id: string }>(
        `SELECT id FROM recourse_cases WHERE transaction_id = $1 AND status <> 'SETTLED'`,
        [transactionId],
      );
      if (existing.rows.length > 0) {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'An open recourse case already exists for this transaction.',
        );
      }

      const { rows } = await client.query<RecourseCaseRow>(
        `INSERT INTO recourse_cases
           (transaction_id, reason, reason_notes, requested_amount, repaid_amount,
            remaining_amount, status, initiated_by, initiated_at)
         VALUES ($1,$2::recourse_reason,$3,$4::numeric,0,$4::numeric,
                 'RECOURSE_INITIATED',$5::uuid,$6)
         RETURNING id, transaction_id, reason, reason_notes, requested_amount::text,
                   repaid_amount::text, remaining_amount::text, status, initiated_by,
                   initiated_at, settled_at`,
        [transactionId, input.reason, input.notes ?? null, requested.toDb(), ctx.userId, now],
      );
      const created = rows[0];

      requireTransition(state, 'RECOURSE_ACTIVE');
      await client.query(
        `UPDATE receivable_transactions SET state = 'RECOURSE_ACTIVE', updated_at = $2 WHERE id = $1`,
        [transactionId, now],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
         VALUES ('TRANSACTION',$1,$2,'RECOURSE_ACTIVE',$3,$4,$5::uuid)`,
        [transactionId, state, `Recourse initiated: ${input.reason}`, now, ctx.userId],
      );

      await this.notifySupplier(
        client,
        snapshot.supplier_org_id,
        transactionId,
        'RECOURSE_INITIATED',
        'Your bank has initiated recourse on a financed invoice',
        `The bank has claimed ${requested.toString()} JOD under the recourse terms of your ` +
          `financing agreement. You will be contacted with the details. If you believe this ` +
          `claim is incorrect, you may dispute it through the platform.`,
        { requestedAmount: requested.toString() },
      );

      await this.audit.recordIn(client, {
        actionType: 'RECOURSE_INITIATED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: transactionId,
        previousValue: { state },
        newValue: {
          state: 'RECOURSE_ACTIVE',
          recourseCaseId: created.id,
          reason: input.reason,
          requestedAmount: requested.toString(),
          // ZM-FEE-016, recorded at the moment someone might expect otherwise.
          commissionRefunded: false,
          evidenceDocumentIds: input.evidenceDocumentIds ?? [],
        },
      });

      this.logger.log(`Recourse ${created.id} initiated on ${transactionId} for ${requested.toString()}`);
      return created;
    });
  }

  // ===================================================================
  // Repayment
  // ===================================================================

  /**
   * The supplier repays, in part or in full.
   *
   * Recorded as a `recourse_repayments` row and reconciled against the case
   * under a row lock, so two repayments arriving together cannot both read the
   * old balance and both conclude the case is still outstanding.
   *
   * Settling the case closes the transaction with `RECOURSE_SETTLED` — the
   * receivable's story ends with what actually happened to it, rather than
   * with the transaction sitting in `RECOURSE_ACTIVE` forever.
   */
  async repay(
    caseId: string,
    ctx: ActorContext,
    input: { amount: string; providerReference?: string; evidenceDocumentId?: string },
  ): Promise<RecourseCaseRow> {
    const amount = Money.from(input.amount);
    if (!amount.isPositive()) {
      throw AppException.validation('A repayment must be for more than zero.', { field: 'amount' });
    }

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const recourse = await this.lockCase(client, caseId);
      await this.requireCaseParty(recourse.transaction_id, ctx);

      if (recourse.status === 'SETTLED') {
        // Idempotent by observation, as elsewhere: a settled case returns
        // unchanged rather than erroring on a duplicate submission.
        return recourse;
      }

      await client.query(
        `INSERT INTO recourse_repayments
           (recourse_case_id, amount, provider_reference, status, evidence_document_id, created_at)
         VALUES ($1,$2::numeric,$3,'PAYOUT_COMPLETED',$4::uuid,$5)`,
        [
          caseId,
          amount.toDb(),
          input.providerReference ?? null,
          input.evidenceDocumentId ?? null,
          now,
        ],
      );

      const repayments = await this.repaymentsIn(client, caseId);
      const requested = Money.from(recourse.requested_amount);
      const remaining = remainingAfter(requested, repayments);
      const settled = settlesCase(requested, repayments);

      const nextStatus: RecourseStatus = settled ? 'SETTLED' : 'PAYMENT_PENDING';
      if (nextStatus !== recourse.status) requireProgress(recourse.status, nextStatus);

      const { rows } = await client.query<RecourseCaseRow>(
        `UPDATE recourse_cases
            SET repaid_amount = $2::numeric,
                remaining_amount = $3::numeric,
                status = $4::recourse_status,
                settled_at = CASE WHEN $4 = 'SETTLED' THEN $5 ELSE settled_at END
          WHERE id = $1
        RETURNING id, transaction_id, reason, reason_notes, requested_amount::text,
                  repaid_amount::text, remaining_amount::text, status, initiated_by,
                  initiated_at, settled_at`,
        [
          caseId,
          requested.subtract(remaining).toDb(),
          remaining.toDb(),
          nextStatus,
          now,
        ],
      );

      if (settled) {
        await this.closeTransaction(client, recourse.transaction_id, now, ctx);
      }

      await this.audit.recordIn(client, {
        actionType: 'RECOURSE_REPAYMENT_RECORDED',
        targetEntityType: 'RECOURSE_CASE',
        targetEntityId: caseId,
        previousValue: { status: recourse.status, remainingAmount: recourse.remaining_amount },
        newValue: {
          status: nextStatus,
          amount: amount.toString(),
          remainingAmount: remaining.toString(),
          // Said explicitly on the one event where someone would most expect a
          // refund to happen automatically. It does not (ZM-FEE-016).
          commissionRefunded: false,
        },
      });

      return rows[0];
    });
  }

  // ===================================================================
  // Status progression
  // ===================================================================

  async progress(
    caseId: string,
    ctx: ActorContext,
    input: { status: RecourseStatus; notes?: string },
  ): Promise<RecourseCaseRow> {
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const recourse = await this.lockCase(client, caseId);
      const snapshot = await this.requireCaseParty(recourse.transaction_id, ctx);

      // A supplier may move a case to DISPUTED and nothing else. Everything
      // else is the claimant's to drive; letting a supplier mark a claim
      // SETTLED would let the debtor discharge their own debt.
      if (ctx.organizationType === 'SUPPLIER' && input.status !== 'DISPUTED') {
        throw new AppException(
          ErrorCode.FORBIDDEN,
          'A supplier may dispute a recourse claim, but may not otherwise progress it.',
          HttpStatus.FORBIDDEN,
        );
      }

      if (input.status === recourse.status) return recourse;
      requireProgress(recourse.status, input.status);

      // SETTLED is reachable through this endpoint only when the money is
      // actually there. Otherwise a case could be marked settled with a
      // balance still outstanding, and the case list would disagree with the
      // repayment record.
      if (input.status === 'SETTLED' && !Money.from(recourse.remaining_amount).isZero()) {
        throw AppException.validation(
          'Record the repayments that settle this claim before marking it settled.',
          { field: 'status', remainingAmount: recourse.remaining_amount },
        );
      }

      const { rows } = await client.query<RecourseCaseRow>(
        `UPDATE recourse_cases
            SET status = $2::recourse_status,
                settled_at = CASE WHEN $2 = 'SETTLED' THEN $3 ELSE settled_at END
          WHERE id = $1
        RETURNING id, transaction_id, reason, reason_notes, requested_amount::text,
                  repaid_amount::text, remaining_amount::text, status, initiated_by,
                  initiated_at, settled_at`,
        [caseId, input.status, now],
      );

      if (input.status === 'DISPUTED') {
        await this.markTransactionDisputed(client, recourse.transaction_id, now, ctx);
      }
      if (input.status === 'SUPPLIER_NOTIFIED') {
        await this.notifySupplier(
          client,
          snapshot.supplier_org_id,
          recourse.transaction_id,
          'RECOURSE_SUPPLIER_NOTIFIED',
          'Action needed on a recourse claim',
          `The bank is claiming ${recourse.remaining_amount} JOD under the recourse terms of ` +
            `your financing agreement.${input.notes ? ` ${input.notes}` : ''}`,
          { remainingAmount: recourse.remaining_amount, notes: input.notes ?? '' },
        );
      }

      await this.audit.recordIn(client, {
        actionType: 'RECOURSE_STATUS_CHANGED',
        targetEntityType: 'RECOURSE_CASE',
        targetEntityId: caseId,
        previousValue: { status: recourse.status },
        newValue: { status: input.status, notes: input.notes ?? null },
      });

      return rows[0];
    });
  }

  // ===================================================================
  // Reading
  // ===================================================================

  async findById(caseId: string, ctx: ActorContext): Promise<RecourseCaseRow> {
    const row = await this.db.queryOne<RecourseCaseRow>(
      `SELECT id, transaction_id, reason, reason_notes, requested_amount::text,
              repaid_amount::text, remaining_amount::text, status, initiated_by,
              initiated_at, settled_at
         FROM recourse_cases WHERE id = $1`,
      [caseId],
    );
    if (!row) throw AppException.notFound('Recourse case');
    await this.requireCaseParty(row.transaction_id, ctx);
    return row;
  }

  // ===================================================================
  // helpers
  // ===================================================================

  private async lockState(client: PoolClient, transactionId: string): Promise<TransactionState> {
    const { rows } = await client.query<{ state: TransactionState }>(
      `SELECT state FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
      [transactionId],
    );
    if (rows.length === 0) throw AppException.notFound('Transaction');
    return rows[0].state;
  }

  private async lockCase(client: PoolClient, caseId: string): Promise<RecourseCaseRow> {
    const { rows } = await client.query<RecourseCaseRow>(
      `SELECT id, transaction_id, reason, reason_notes, requested_amount::text,
              repaid_amount::text, remaining_amount::text, status, initiated_by,
              initiated_at, settled_at
         FROM recourse_cases WHERE id = $1 FOR UPDATE`,
      [caseId],
    );
    if (rows.length === 0) throw AppException.notFound('Recourse case');
    return rows[0];
  }

  private async repaymentsIn(client: PoolClient, caseId: string): Promise<Money[]> {
    const { rows } = await client.query<{ amount: string }>(
      `SELECT amount::text FROM recourse_repayments WHERE recourse_case_id = $1`,
      [caseId],
    );
    return rows.map((r) => Money.from(r.amount));
  }

  private async requireFundingBank(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<{ supplier_org_id: string; bank_org_id: string; gross_funding_amount: string }> {
    const row = await this.db.queryOne<{
      supplier_org_id: string;
      bank_org_id: string;
      gross_funding_amount: string;
    }>(
      `SELECT supplier_org_id, bank_org_id, gross_funding_amount::text
         FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
    if (!row) throw AppException.notFound('Transaction');
    if (row.bank_org_id !== ctx.organizationId) throw AppException.notFound('Transaction');
    return row;
  }

  /** Both parties and the platform may see a case; only some may act on it. */
  private async requireCaseParty(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<{ supplier_org_id: string; bank_org_id: string }> {
    const row = await this.db.queryOne<{ supplier_org_id: string; bank_org_id: string }>(
      `SELECT supplier_org_id, bank_org_id FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
    if (!row) throw AppException.notFound('Recourse case');

    if (ctx.organizationType === 'PLATFORM') return row;
    if (ctx.organizationType === 'BANK' && row.bank_org_id === ctx.organizationId) return row;
    if (ctx.organizationType === 'SUPPLIER' && row.supplier_org_id === ctx.organizationId) {
      return row;
    }
    throw AppException.notFound('Recourse case');
  }

  private async closeTransaction(
    client: PoolClient,
    transactionId: string,
    now: Date,
    ctx: ActorContext,
  ): Promise<void> {
    const state = await this.lockState(client, transactionId);
    if (state === 'CLOSED') return;
    requireTransition(state, 'CLOSED');

    await client.query(
      `UPDATE receivable_transactions
          SET state = 'CLOSED', closure_reason = 'RECOURSE_SETTLED', updated_at = $2
        WHERE id = $1`,
      [transactionId, now],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
       VALUES ('TRANSACTION',$1,$2,'CLOSED','Recourse settled in full',$3,$4::uuid)`,
      [transactionId, state, now, ctx.userId],
    );
  }

  private async markTransactionDisputed(
    client: PoolClient,
    transactionId: string,
    now: Date,
    ctx: ActorContext,
  ): Promise<void> {
    const state = await this.lockState(client, transactionId);
    if (state === 'DISPUTED') return;
    requireTransition(state, 'DISPUTED');

    await client.query(
      `UPDATE receivable_transactions SET state = 'DISPUTED', updated_at = $2 WHERE id = $1`,
      [transactionId, now],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
       VALUES ('TRANSACTION',$1,$2,'DISPUTED','Recourse claim disputed',$3,$4::uuid)`,
      [transactionId, state, now, ctx.userId],
    );
  }

  private async notifySupplier(
    client: PoolClient,
    supplierOrgId: string,
    transactionId: string,
    templateKey: string,
    subject: string,
    body: string,
    variables?: TemplateVariables,
  ): Promise<void> {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM organization_memberships m
        WHERE m.organization_id = $1 AND m.status = 'ACTIVE'`,
      [supplierOrgId],
    );
    for (const recipient of rows) {
      await this.notifications.send(
        {
          templateKey,
          recipientUserId: recipient.user_id,
          transactionId,
          fallbackSubject: subject,
          fallbackBody: body,
          variables,
        },
        client,
      );
    }
  }
}

/** Allow-list. `reason_notes` and `initiated_by` are the bank's, not the supplier's. */
export function describeRecourse(
  row: RecourseCaseRow,
  audience: 'SUPPLIER' | 'BANK' | 'PLATFORM',
): Record<string, unknown> {
  const shared = {
    id: row.id,
    transactionId: row.transaction_id,
    reason: row.reason,
    requestedAmount: row.requested_amount,
    repaidAmount: row.repaid_amount,
    remainingAmount: row.remaining_amount,
    status: row.status,
    initiatedAt: row.initiated_at.toISOString(),
    settledAt: row.settled_at?.toISOString() ?? null,
  };

  // The supplier is told the claim, the amount and the reason code — enough to
  // respond or dispute. The bank's free-text working notes and the identity of
  // the individual who filed it are not part of that.
  if (audience === 'SUPPLIER') return shared;

  return { ...shared, reasonNotes: row.reason_notes, initiatedBy: row.initiated_by };
}
