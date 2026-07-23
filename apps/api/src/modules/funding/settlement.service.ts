import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  SettlementSplit,
  assertSplitReconciles,
  distributableFrom,
  distributionJournal,
  payoutCompletedJournal,
} from '../ledger/settlement-postings';
import {
  PayoutResult,
  SETTLEMENT_PROVIDER,
  SettlementProvider,
} from './settlement.provider';
import type { SettlementRow } from './funding.service';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Executing the payout, and never executing it twice (INV-13).
 *
 * ## How the double-pay is actually prevented
 *
 * Three layers, in the order they engage:
 *
 *   1. **The row lock.** `SELECT … FOR UPDATE` on the settlement serializes
 *      concurrent attempts. Two simultaneous retries do not race — the second
 *      waits, then sees what the first did.
 *   2. **The status re-check inside the lock.** A settlement already
 *      `PAYOUT_COMPLETED` returns immediately and the provider is never
 *      called. This is the guard that matters, and it is inside the lock
 *      rather than before it, because a check before the lock is a check
 *      against stale state.
 *   3. **The stable idempotency key.** If a call does reach the rail, it
 *      carries the settlement id, which never changes. A rail that honours
 *      idempotency keys cannot pay twice even if layers 1 and 2 were somehow
 *      bypassed.
 *
 * The concurrent-retry drill in the integration suite exercises layer 1 and 2
 * together: two simultaneous retries, exactly one payout, exactly one payout
 * ledger leg.
 *
 * ## Why the provider call is outside the write transaction
 *
 * It is a network call to something the platform does not control. Holding a
 * row lock across it would mean a hung rail holds a lock on a financial row
 * indefinitely. So the sequence is: lock → claim `PAYOUT_INITIATED` → commit →
 * call the rail → lock again → record the outcome. The claim is what makes the
 * middle safe: a second caller arriving during the call sees `PAYOUT_INITIATED`
 * and declines to start another.
 */

interface SnapshotAmounts {
  supplier_org_id: string;
  bank_org_id: string;
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(SETTLEMENT_PROVIDER) private readonly provider: SettlementProvider,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // Payout
  // =====================================================================

  /**
   * Attempt the payout once.
   *
   * Safe to call repeatedly: a completed settlement short-circuits, and an
   * in-flight one declines rather than starting a second attempt.
   */
  async executePayout(settlementId: string): Promise<SettlementRow> {
    const claim = await this.claimForPayout(settlementId);
    if (claim.kind === 'already-completed') return claim.settlement;
    if (claim.kind === 'in-flight') return claim.settlement;

    const settlement = claim.settlement;
    const split = await this.splitFor(settlement);
    const attemptNo = settlement.retry_count + 1;

    let result: PayoutResult;
    try {
      result = await this.provider.execute({
        // INV-13: the settlement id, unchanged on every attempt.
        idempotencyKey: settlement.idempotency_key,
        netPayout: split.netPayout,
        commission: split.commission,
        listingFee: split.listingFee,
        supplierOrgId: split.supplierOrgId,
        bankOrgId: split.bankOrgId,
        attemptNo,
      });
    } catch (err) {
      // A thrown rail is a failed attempt, not an unhandled error: it must be
      // recorded and retried like any other failure, or a network blip would
      // leave a settlement stuck in PAYOUT_INITIATED forever.
      result = {
        succeeded: false,
        providerReference: null,
        failureReason: err instanceof Error ? err.message.slice(0, 500) : 'Unknown rail error',
        raw: {},
      };
    }

    return result.succeeded
      ? this.recordSuccess(settlement, split, result, attemptNo)
      : this.recordFailure(settlement, result, attemptNo);
  }

  /**
   * Take the settlement if it is ours to take.
   *
   * Marks `PAYOUT_INITIATED` inside the lock so that the window during the
   * rail call is not open to a second attempt.
   */
  private async claimForPayout(settlementId: string): Promise<
    | { kind: 'claimed'; settlement: SettlementRow }
    | { kind: 'already-completed'; settlement: SettlementRow }
    | { kind: 'in-flight'; settlement: SettlementRow }
  > {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query<SettlementRow>(
        `SELECT * FROM settlements WHERE id = $1 FOR UPDATE`,
        [settlementId],
      );
      const settlement = rows[0];
      if (!settlement) throw AppException.notFound('Settlement');

      // The guard. Nothing below runs for a settlement already paid.
      if (settlement.status === 'PAYOUT_COMPLETED') {
        return { kind: 'already-completed' as const, settlement };
      }
      if (settlement.status === 'PAYOUT_INITIATED') {
        return { kind: 'in-flight' as const, settlement };
      }
      if (!settlement.bank_marked_sent_at) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'The bank has not recorded the transfer, so there is nothing to pay out.',
          HttpStatus.CONFLICT,
        );
      }

      const { rows: claimed } = await client.query<SettlementRow>(
        `UPDATE settlements
            SET status = 'PAYOUT_INITIATED', payout_initiated_at = $2
          WHERE id = $1
        RETURNING *`,
        [settlementId, this.time.now()],
      );
      return { kind: 'claimed' as const, settlement: claimed[0] };
    });
  }

  /**
   * A completed payout: the books are finished and the obligations discharged.
   *
   * This is also where INV-5 is honoured — the commission becomes `FINALIZED`
   * here and nowhere else, because `PAYOUT_COMPLETED` is the only moment the
   * platform has actually earned it.
   */
  private async recordSuccess(
    settlement: SettlementRow,
    split: SettlementSplit,
    result: PayoutResult,
    attemptNo: number,
  ): Promise<SettlementRow> {
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      // Re-read under lock: between the claim and here, another path may have
      // completed this settlement (a replayed provider response, an operator
      // action). Completing twice would post the payout journal twice.
      const { rows: current } = await client.query<SettlementRow>(
        `SELECT * FROM settlements WHERE id = $1 FOR UPDATE`,
        [settlement.id],
      );
      if (current[0]?.status === 'PAYOUT_COMPLETED') {
        await this.recordAttempt(client, settlement.id, attemptNo, result);
        return current[0];
      }

      const { rows: completed } = await client.query<SettlementRow>(
        `UPDATE settlements
            SET status = 'PAYOUT_COMPLETED',
                payout_completed_at = $2,
                provider_reference = COALESCE($3, provider_reference),
                failure_reason = NULL
          WHERE id = $1
        RETURNING *`,
        [settlement.id, now, result.providerReference],
      );

      await this.recordAttempt(client, settlement.id, attemptNo, result);

      // The two remaining journals. Clearing is emptied into what the funding
      // became, then the supplier's payable is discharged — after which the
      // clearing balance for this transaction is zero.
      await this.ledger.post(client, {
        lines: distributionJournal(split),
        transactionId: settlement.transaction_id,
        settlementId: settlement.id,
      });
      await this.ledger.post(client, {
        lines: payoutCompletedJournal(split),
        transactionId: settlement.transaction_id,
        settlementId: settlement.id,
      });

      await this.finalizeCommission(client, settlement, now);
      await this.markListingFeeDeducted(client, settlement, now);

      await this.audit.recordIn(client, {
        actionType: 'SETTLEMENT_PAYOUT_COMPLETED',
        targetEntityType: 'SETTLEMENT',
        targetEntityId: settlement.id,
        previousValue: { status: settlement.status },
        newValue: {
          status: 'PAYOUT_COMPLETED',
          providerReference: result.providerReference,
          attemptNo,
          netSupplierPayout: split.netPayout.toString(),
        },
      });

      return completed[0];
    });
  }

  /**
   * A failed payout: recorded, counted, and escalated once the budget is out.
   *
   * `MANUAL_REVIEW` rather than endless retrying (AS-03). A payout that has
   * failed its allowance is not a transient problem, and continuing to hammer
   * a rail that keeps refusing is how a real incident gets buried under noise.
   */
  private async recordFailure(
    settlement: SettlementRow,
    result: PayoutResult,
    attemptNo: number,
  ): Promise<SettlementRow> {
    return this.db.transaction(async (client) => {
      const exhausted = attemptNo >= settlement.max_retries;
      const status = exhausted ? 'MANUAL_REVIEW' : 'PAYOUT_FAILED';

      const { rows } = await client.query<SettlementRow>(
        `UPDATE settlements
            SET status = $2, retry_count = $3, failure_reason = $4, payout_initiated_at = NULL
          WHERE id = $1
        RETURNING *`,
        [settlement.id, status, attemptNo, result.failureReason],
      );

      await this.recordAttempt(client, settlement.id, attemptNo, result);

      await this.audit.recordIn(client, {
        actionType: exhausted ? 'SETTLEMENT_MANUAL_REVIEW' : 'SETTLEMENT_PAYOUT_FAILED',
        targetEntityType: 'SETTLEMENT',
        targetEntityId: settlement.id,
        previousValue: { status: settlement.status, retryCount: settlement.retry_count },
        newValue: { status, retryCount: attemptNo, failureReason: result.failureReason },
      });

      this.logger.warn(
        `Settlement ${settlement.id} payout attempt ${attemptNo} failed: ${result.failureReason}. ` +
          `Status is now ${status}.`,
      );

      return rows[0];
    });
  }

  /** ZM-FND: every attempt is evidence, successful or not. */
  private async recordAttempt(
    client: PoolClient,
    settlementId: string,
    attemptNo: number,
    result: PayoutResult,
  ): Promise<void> {
    await client.query(
      `INSERT INTO settlement_attempts
         (settlement_id, attempt_no, request_payload, response_payload, succeeded,
          failure_reason, attempted_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)
       ON CONFLICT (settlement_id, attempt_no) DO NOTHING`,
      [
        settlementId,
        attemptNo,
        JSON.stringify({ idempotencyKey: settlementId, attemptNo }),
        JSON.stringify(result.raw ?? {}),
        result.succeeded,
        result.failureReason,
        this.time.now(),
      ],
    );
  }

  // =====================================================================
  // Retry
  // =====================================================================

  /**
   * Operator-triggered retry (`POST /settlements/{id}/retry`).
   *
   * Idempotent by the same mechanism as everything else here: a completed
   * settlement is returned untouched and the rail is never called. Retrying a
   * success is not an error — it is a no-op, which is what "never double-pays"
   * means from the caller's side.
   */
  async retry(settlementId: string, ctx: ActorContext): Promise<SettlementRow> {
    const settlement = await this.db.queryOne<SettlementRow>(
      `SELECT * FROM settlements WHERE id = $1`,
      [settlementId],
    );
    if (!settlement) throw AppException.notFound('Settlement');
    await this.requireRetryAuthority(settlement, ctx);

    if (settlement.status === 'PAYOUT_COMPLETED') return settlement;

    if (settlement.status === 'MANUAL_REVIEW' && ctx.organizationType !== 'PLATFORM') {
      // Past the automatic allowance a human decision is required, and it is
      // the platform's to make — the bank retrying its own stuck payout
      // indefinitely is how the escalation gets bypassed.
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'This settlement is under manual review; only platform staff may retry it.',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.executePayout(settlementId);
  }

  private async requireRetryAuthority(
    settlement: SettlementRow,
    ctx: ActorContext,
  ): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;
    const snapshot = await this.db.queryOne<SnapshotAmounts>(
      `SELECT supplier_org_id, bank_org_id FROM accepted_offer_snapshots
        WHERE transaction_id = $1`,
      [settlement.transaction_id],
    );
    if (ctx.organizationType === 'BANK' && snapshot?.bank_org_id === ctx.organizationId) return;
    throw AppException.notFound('Settlement');
  }

  // =====================================================================
  // Commission and listing fee
  // =====================================================================

  /**
   * INV-5: the commission is `FINALIZED` only on `PAYOUT_COMPLETED`.
   *
   * Written as an UPDATE guarded on the current status rather than a blind
   * one, so it cannot finalize a commission that was superseded or already
   * reversed. Reversals are compensating records (ZM-FEE-015), never edits, so
   * nothing here ever moves a FINALIZED row backwards.
   */
  private async finalizeCommission(
    client: PoolClient,
    settlement: SettlementRow,
    now: Date,
  ): Promise<void> {
    await client.query(
      `UPDATE commission_calculations
          SET status = 'FINALIZED', finalized_at = $2
        WHERE transaction_id = $1 AND status = 'CALCULATED'`,
      [settlement.transaction_id, now],
    );
  }

  /** The obligation was withheld from the payout, so it is settled. */
  private async markListingFeeDeducted(
    client: PoolClient,
    settlement: SettlementRow,
    now: Date,
  ): Promise<void> {
    if (Money.from(settlement.listing_fee_deducted).isZero()) return;
    await client.query(
      `UPDATE listing_fee_obligations o
          SET status = 'DEDUCTED', settled_at = $2, settlement_id = $3
         FROM listings l
        WHERE o.listing_id = l.id
          AND l.transaction_id = $1
          AND o.status = 'PAYABLE'`,
      [settlement.transaction_id, now, settlement.id],
    );
  }

  /**
   * The split, rebuilt from the settlement row.
   *
   * From the settlement rather than the snapshot: the settlement is what was
   * committed to at mark-sent, and re-deriving from the snapshot here would
   * risk paying a different figure if the two ever disagreed. They should not,
   * but "should not" is not a guarantee, and the settlement is the row the
   * database CHECK constrains.
   */
  private async splitFor(settlement: SettlementRow): Promise<SettlementSplit> {
    const parties = await this.db.queryOne<SnapshotAmounts>(
      `SELECT supplier_org_id, bank_org_id FROM accepted_offer_snapshots WHERE id = $1`,
      [settlement.snapshot_id],
    );
    if (!parties) throw AppException.notFound('Settlement');

    const commission = Money.from(settlement.platform_commission_amount);
    const listingFee = Money.from(settlement.listing_fee_deducted);
    const netPayout = Money.from(settlement.net_supplier_payout);
    const split: SettlementSplit = {
      distributable: distributableFrom(commission, listingFee, netPayout),
      commission,
      listingFee,
      netPayout,
      supplierOrgId: parties.supplier_org_id,
      bankOrgId: parties.bank_org_id,
    };
    assertSplitReconciles(split);
    return split;
  }
}
