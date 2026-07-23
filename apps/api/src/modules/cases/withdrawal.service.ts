import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import {
  assessPenalty,
  canProgressWithdrawal,
  statusAfterDecision,
  type PenaltyRule,
  type WithdrawalReason,
  type WithdrawalStatus,
} from './withdrawal-penalty';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Post-acceptance bank withdrawal (ZM-WDR-*, AS-07, D-03).
 *
 * A bank that accepted an offer and then pulls out has broken a commitment the
 * supplier relied on. Three things follow, and the second is the one this
 * module exists for:
 *
 *   1. A case is opened recording who withdrew, why, and when.
 *   2. A penalty is **calculated and recorded — never deducted** (LT-12). See
 *      `withdrawal-penalty.ts`; the reasoning lives with the rule.
 *   3. Relisting is **manual**. The receivable does not silently return to the
 *      marketplace; an administrator decides, because a supplier whose deal
 *      just collapsed may need the fee waived, the risk re-run, or simply to
 *      be told what happened before their invoice reappears (D-03).
 */

export interface WithdrawalCaseRow {
  id: string;
  transaction_id: string;
  offer_id: string;
  bank_org_id: string;
  reason: WithdrawalReason;
  reason_notes: string | null;
  status: WithdrawalStatus;
  penalty_applicable: boolean | null;
  penalty_amount: string | null;
  relisting_eligible: boolean | null;
  admin_decision_notes: string | null;
  decided_by: string | null;
  requested_at: Date;
  closed_at: Date | null;
}

@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /**
   * The bank opens a withdrawal case against its own accepted offer.
   *
   * Only the bank that made the offer may withdraw it — an obvious statement
   * that still needs enforcing, since the endpoint is keyed on the offer id
   * and a bank could otherwise name another bank's offer.
   */
  async open(
    offerId: string,
    ctx: ActorContext,
    input: { reason: WithdrawalReason; notes?: string },
  ): Promise<WithdrawalCaseRow> {
    if (ctx.organizationType !== 'BANK') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only the bank that made the offer may withdraw it.',
        HttpStatus.FORBIDDEN,
      );
    }

    const offer = await this.db.queryOne<{
      id: string;
      bank_org_id: string;
      transaction_id: string;
      gross_funding_amount: string;
    }>(
      `SELECT o.id, o.bank_org_id, l.transaction_id, o.gross_funding_amount::text
         FROM bank_offers o
         JOIN listings l ON l.id = o.listing_id
        WHERE o.id = $1`,
      [offerId],
    );
    if (!offer) throw AppException.notFound('Offer');
    if (offer.bank_org_id !== ctx.organizationId) throw AppException.notFound('Offer');

    const policy = await this.penaltyPolicy();
    const assessment = assessPenalty(input.reason, policy);
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM withdrawal_cases WHERE offer_id = $1 AND status <> 'CLOSED'`,
        [offerId],
      );
      if (existing.rows.length > 0) {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'An open withdrawal case already exists for this offer.',
        );
      }

      const { rows } = await client.query<WithdrawalCaseRow>(
        `INSERT INTO withdrawal_cases
           (transaction_id, offer_id, bank_org_id, reason, reason_notes, status,
            penalty_applicable, penalty_amount, requested_at)
         VALUES ($1,$2,$3,$4::withdrawal_reason,$5,'WITHDRAWAL_REQUESTED',
                 $6,$7::numeric,$8)
         RETURNING id, transaction_id, offer_id, bank_org_id, reason, reason_notes, status,
                   penalty_applicable, penalty_amount::text, relisting_eligible,
                   admin_decision_notes, decided_by, requested_at, closed_at`,
        [
          offer.transaction_id,
          offerId,
          ctx.organizationId,
          input.reason,
          input.notes ?? null,
          // The policy's *suggestion*, recorded so an administrator sees what
          // the platform would have said. `null` means "no default opinion,
          // you decide" and is stored as null rather than coerced to false.
          assessment.applicable,
          assessment.amount ? assessment.amount.toDb() : null,
          now,
        ],
      );

      await this.audit.recordIn(client, {
        actionType: 'WITHDRAWAL_CASE_OPENED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: offer.transaction_id,
        previousValue: null,
        newValue: {
          withdrawalCaseId: rows[0].id,
          offerId,
          reason: input.reason,
          suggestedPenaltyApplicable: assessment.applicable,
          suggestedPenaltyAmount: assessment.amount?.toString() ?? null,
          requiresManualReview: assessment.requiresManualReview,
          // The two rules that would otherwise be invisible in the record.
          penaltyDeducted: false,
          relistingAutomatic: false,
        },
      });

      this.logger.log(
        `Withdrawal case ${rows[0].id} opened on offer ${offerId} (${input.reason}); ` +
          `penalty ${assessment.applicable === null ? 'for review' : assessment.applicable ? 'suggested' : 'not applicable'}`,
      );
      return rows[0];
    });
  }

  /**
   * The administrator's decision (D-03, AS-07).
   *
   * Takes `penaltyApplicable` verbatim. The policy's suggestion is a default
   * for a human to consider, never an answer that overrides them — an admin
   * who waives a penalty the policy proposed must be able to, because the
   * policy cannot see the commercial context.
   *
   * `relistingEligible` is a separate deliberate answer for the same reason:
   * the receivable returning to the marketplace is a decision, not a
   * consequence.
   */
  async decide(
    caseId: string,
    ctx: ActorContext,
    input: {
      penaltyApplicable: boolean;
      penaltyAmount?: string;
      relistingEligible: boolean;
      notes?: string;
    },
  ): Promise<WithdrawalCaseRow> {
    if (ctx.organizationType !== 'PLATFORM') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only platform staff may decide a withdrawal case.',
        HttpStatus.FORBIDDEN,
      );
    }

    const penalty = input.penaltyAmount ? Money.from(input.penaltyAmount) : null;
    if (input.penaltyApplicable && (!penalty || !penalty.isPositive())) {
      throw AppException.validation(
        'State the penalty amount when a penalty applies.',
        { field: 'penaltyAmount' },
      );
    }

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const withdrawal = await this.lockCase(client, caseId);
      const next = statusAfterDecision(input.penaltyApplicable);

      if (!canProgressWithdrawal(withdrawal.status, next) && withdrawal.status !== next) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'This withdrawal case has already been decided.',
          HttpStatus.CONFLICT,
          { status: withdrawal.status },
        );
      }

      const { rows } = await client.query<WithdrawalCaseRow>(
        `UPDATE withdrawal_cases
            SET status = $2::withdrawal_status,
                penalty_applicable = $3,
                penalty_amount = $4::numeric,
                relisting_eligible = $5,
                admin_decision_notes = $6,
                decided_by = $7::uuid
          WHERE id = $1
        RETURNING id, transaction_id, offer_id, bank_org_id, reason, reason_notes, status,
                  penalty_applicable, penalty_amount::text, relisting_eligible,
                  admin_decision_notes, decided_by, requested_at, closed_at`,
        [
          caseId,
          next,
          input.penaltyApplicable,
          // A waived penalty stores 0, not null: "decided, nothing due" and
          // "nobody has decided" must stay distinguishable on the row.
          input.penaltyApplicable ? penalty!.toDb() : Money.zero().toDb(),
          input.relistingEligible,
          input.notes ?? null,
          ctx.userId,
        ],
      );

      // D-03: an eligible relisting raises a *request*, and raises it as
      // REQUESTED rather than APPROVED. ZM-REC-018 requires seven verification
      // outcomes (still unpaid, not financed elsewhere, unchanged, still
      // valid, no fraud indicator, supplier eligible, buyer eligible) to be
      // recorded before a receivable goes back on the market. This decision
      // establishes the supplier *may* relist; it does not certify that the
      // receivable is still financeable weeks after the deal collapsed.
      if (input.relistingEligible) {
        await client.query(
          `INSERT INTO relisting_requests
             (transaction_id, requested_by, status, notes, requested_at)
           VALUES ($1,$2::uuid,'REQUESTED',$3,$4)`,
          [
            withdrawal.transaction_id,
            ctx.userId,
            `Bank withdrawal (${withdrawal.reason}) — relisting permitted by platform; ` +
              `ZM-REC-018 verification still required before it returns to the marketplace.`,
            now,
          ],
        );
      }

      await this.audit.recordIn(client, {
        actionType: 'WITHDRAWAL_CASE_DECIDED',
        targetEntityType: 'WITHDRAWAL_CASE',
        targetEntityId: caseId,
        previousValue: {
          status: withdrawal.status,
          penaltyApplicable: withdrawal.penalty_applicable,
        },
        newValue: {
          status: next,
          penaltyApplicable: input.penaltyApplicable,
          penaltyAmount: input.penaltyApplicable ? penalty!.toString() : '0.000',
          relistingEligible: input.relistingEligible,
          notes: input.notes ?? null,
          // Recorded at the exact moment a reader would assume money moved.
          penaltyDeducted: false,
        },
      });

      return rows[0];
    });
  }

  async findById(caseId: string, ctx: ActorContext): Promise<WithdrawalCaseRow> {
    const row = await this.db.queryOne<WithdrawalCaseRow>(
      `SELECT id, transaction_id, offer_id, bank_org_id, reason, reason_notes, status,
              penalty_applicable, penalty_amount::text, relisting_eligible,
              admin_decision_notes, decided_by, requested_at, closed_at
         FROM withdrawal_cases WHERE id = $1`,
      [caseId],
    );
    if (!row) throw AppException.notFound('Withdrawal case');

    if (ctx.organizationType === 'PLATFORM') return row;
    if (ctx.organizationType === 'BANK' && row.bank_org_id === ctx.organizationId) return row;

    // The supplier is a party to the transaction and entitled to know its
    // offer was withdrawn.
    const supplier = await this.db.queryOne<{ supplier_org_id: string }>(
      `SELECT supplier_org_id FROM receivable_transactions WHERE id = $1`,
      [row.transaction_id],
    );
    if (ctx.organizationType === 'SUPPLIER' && supplier?.supplier_org_id === ctx.organizationId) {
      return row;
    }
    throw AppException.notFound('Withdrawal case');
  }

  private async lockCase(client: PoolClient, caseId: string): Promise<WithdrawalCaseRow> {
    const { rows } = await client.query<WithdrawalCaseRow>(
      `SELECT id, transaction_id, offer_id, bank_org_id, reason, reason_notes, status,
              penalty_applicable, penalty_amount::text, relisting_eligible,
              admin_decision_notes, decided_by, requested_at, closed_at
         FROM withdrawal_cases WHERE id = $1 FOR UPDATE`,
      [caseId],
    );
    if (rows.length === 0) throw AppException.notFound('Withdrawal case');
    return rows[0];
  }

  private async penaltyPolicy(): Promise<Record<string, PenaltyRule> | null> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'withdrawal_penalty_policy'`,
    );
    return (row?.value as Record<string, PenaltyRule> | undefined) ?? null;
  }
}

/**
 * Allow-list.
 *
 * `reason_notes` and `admin_decision_notes` are internal working records and
 * are withheld from the *bank* as well as the supplier — the platform's
 * reasoning about a penalty it may levy on that bank is not the bank's to
 * read while the case is live.
 */
export function describeWithdrawal(
  row: WithdrawalCaseRow,
  audience: 'SUPPLIER' | 'BANK' | 'PLATFORM',
): Record<string, unknown> {
  const shared = {
    id: row.id,
    transactionId: row.transaction_id,
    offerId: row.offer_id,
    reason: row.reason,
    status: row.status,
    penaltyApplicable: row.penalty_applicable,
    penaltyAmount: row.penalty_amount,
    relistingEligible: row.relisting_eligible,
    requestedAt: row.requested_at.toISOString(),
  };

  if (audience !== 'PLATFORM') return shared;

  return {
    ...shared,
    reasonNotes: row.reason_notes,
    adminDecisionNotes: row.admin_decision_notes,
    decidedBy: row.decided_by,
    bankOrgId: row.bank_org_id,
  };
}
