import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { canTransition, requireTransition, TransactionState } from '../transactions/transaction-state';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Disputes (ZM-REC-012, ZM-REC-013, ZM-REC-014).
 *
 * Two things define this file, and both are refusals.
 *
 * **The platform does not adjudicate.** `resolve` records the resolution the
 * parties reached; it does not decide one. There is no field for the
 * platform's view of who was right, no scoring, no automatic outcome. The
 * platform is a marketplace, not an arbitrator, and a system that quietly
 * decided commercial disputes between a bank and an SME would be exercising
 * an authority nobody granted it and no regulator has approved.
 *
 * **An open dispute pauses automation** (ZM-REC-013). While a dispute is open
 * the transaction sits in `DISPUTED` and the maturity sweep skips it entirely
 * — no reminders, no state changes. The facts are contested; a job that
 * carried on relabelling the transaction would be asserting one side of the
 * argument on a timer.
 *
 * ## Returning to where it was
 *
 * Resolving a dispute has to put the transaction back. The prior state is read
 * from `status_history` — the row this service wrote when it moved the
 * transaction to `DISPUTED` carries `previous_status`, which is exactly the
 * question "where was it before?". No new column, no migration, and no risk of
 * a remembered-state field drifting out of sync with the history that is
 * already the system's record of what happened.
 */

export type DisputeStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'REJECTED';

export interface DisputeRow {
  id: string;
  transaction_id: string;
  dispute_type: string;
  amount: string | null;
  status: DisputeStatus;
  raised_by_org_id: string;
  raised_by: string;
  description: string;
  resolution_notes: string | null;
  raised_at: Date;
  resolved_at: Date | null;
}

/** Where a resolved dispute returns to when the history cannot say. */
const FALLBACK_STATE: TransactionState = 'FUNDED';

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /**
   * Either party opens a dispute.
   *
   * Both sides can: a supplier contesting a recourse claim and a bank
   * contesting an invoice are the same mechanism. What matters is that opening
   * one is *cheap and immediate* — a party that believes something is wrong
   * must be able to stop the machinery before it does something irreversible,
   * without waiting for the platform to agree with them first.
   */
  async open(
    transactionId: string,
    ctx: ActorContext,
    input: { disputeType: string; description: string; amount?: string },
  ): Promise<DisputeRow> {
    await this.requireParty(transactionId, ctx);

    if (!input.description?.trim()) {
      throw AppException.validation('A dispute needs a description of what is contested.', {
        field: 'description',
      });
    }

    const amount = input.amount ? Money.from(input.amount) : null;
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const state = await this.lockState(client, transactionId);

      if (state === 'DISPUTED') {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'This transaction already has an open dispute.',
        );
      }
      if (!canTransition(state, 'DISPUTED')) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'This transaction is not in a state that can be disputed.',
          HttpStatus.CONFLICT,
          { state },
        );
      }

      const { rows } = await client.query<DisputeRow>(
        `INSERT INTO disputes
           (transaction_id, dispute_type, amount, status, raised_by_org_id, raised_by,
            description, raised_at)
         VALUES ($1,$2,$3::numeric,'OPEN',$4::uuid,$5::uuid,$6,$7)
         RETURNING id, transaction_id, dispute_type, amount::text, status,
                   raised_by_org_id, raised_by, description, resolution_notes,
                   raised_at, resolved_at`,
        [
          transactionId,
          input.disputeType,
          amount ? amount.toDb() : null,
          ctx.organizationId,
          ctx.userId,
          input.description.trim(),
          now,
        ],
      );

      requireTransition(state, 'DISPUTED');
      await client.query(
        `UPDATE receivable_transactions SET state = 'DISPUTED', updated_at = $2 WHERE id = $1`,
        [transactionId, now],
      );
      // The row that lets `resolve` put the transaction back. `previous_status`
      // is the system's own record of where it was, so nothing has to remember
      // it separately.
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
         VALUES ('TRANSACTION',$1,$2,'DISPUTED',$3,$4,$5::uuid)`,
        [
          transactionId,
          state,
          `Dispute opened: ${input.disputeType}`,
          now,
          ctx.userId,
        ],
      );

      await this.audit.recordIn(client, {
        actionType: 'DISPUTE_OPENED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: transactionId,
        previousValue: { state },
        newValue: {
          state: 'DISPUTED',
          disputeId: rows[0].id,
          disputeType: input.disputeType,
          amount: amount?.toString() ?? null,
          raisedByOrgId: ctx.organizationId,
          // The point of the state, recorded so an auditor can see it was the
          // intent rather than a side effect.
          automationPaused: true,
        },
      });

      this.logger.log(
        `Dispute ${rows[0].id} opened on ${transactionId}; automation paused (ZM-REC-013)`,
      );
      return rows[0];
    });
  }

  /**
   * Record the resolution the parties reached — ZM-REC-012/014.
   *
   * `resolutionNotes` is required and free text because it is a *record of
   * what the parties agreed*, not a verdict the platform computed. The
   * `outcome` field distinguishes a dispute that was resolved from one that
   * was withdrawn or found baseless; neither is the platform taking a side,
   * and there is deliberately no third value meaning "the platform decided".
   *
   * The transaction returns to where it was and automation resumes.
   */
  async resolve(
    disputeId: string,
    ctx: ActorContext,
    input: { resolutionNotes: string; outcome?: 'RESOLVED' | 'REJECTED' },
  ): Promise<DisputeRow> {
    if (!input.resolutionNotes?.trim()) {
      throw AppException.validation(
        'Record what the parties agreed. The platform does not adjudicate disputes, so the ' +
          'resolution has to be written down by someone who knows what was decided.',
        { field: 'resolutionNotes' },
      );
    }

    const now = this.time.now();
    const outcome = input.outcome ?? 'RESOLVED';

    return this.db.transaction(async (client) => {
      const dispute = await this.lockDispute(client, disputeId);
      await this.requireResolver(dispute, ctx);

      if (dispute.status === 'RESOLVED' || dispute.status === 'REJECTED') {
        return dispute;
      }

      const { rows } = await client.query<DisputeRow>(
        `UPDATE disputes
            SET status = $2::dispute_status, resolution_notes = $3, resolved_at = $4
          WHERE id = $1
        RETURNING id, transaction_id, dispute_type, amount::text, status,
                  raised_by_org_id, raised_by, description, resolution_notes,
                  raised_at, resolved_at`,
        [disputeId, outcome, input.resolutionNotes.trim(), now],
      );

      const restored = await this.restoreTransaction(client, dispute.transaction_id, now, ctx);

      await this.audit.recordIn(client, {
        actionType: 'DISPUTE_RESOLVED',
        targetEntityType: 'DISPUTE',
        targetEntityId: disputeId,
        previousValue: { status: dispute.status },
        newValue: {
          status: outcome,
          restoredState: restored,
          automationPaused: false,
          // Recorded because it is the whole posture of this endpoint: what is
          // stored is the parties' resolution, not the platform's.
          adjudicatedByPlatform: false,
          resolutionNotes: input.resolutionNotes.trim(),
        },
      });

      this.logger.log(`Dispute ${disputeId} recorded as ${outcome}; transaction back to ${restored}`);
      return rows[0];
    });
  }

  async findById(disputeId: string, ctx: ActorContext): Promise<DisputeRow> {
    const row = await this.db.queryOne<DisputeRow>(
      `SELECT id, transaction_id, dispute_type, amount::text, status, raised_by_org_id,
              raised_by, description, resolution_notes, raised_at, resolved_at
         FROM disputes WHERE id = $1`,
      [disputeId],
    );
    if (!row) throw AppException.notFound('Dispute');
    await this.requireParty(row.transaction_id, ctx);
    return row;
  }

  // ===================================================================
  // helpers
  // ===================================================================

  /**
   * Puts the transaction back where it was before the dispute.
   *
   * Reads `previous_status` from the history row this service wrote. If that
   * state is no longer reachable — the lifecycle moved on underneath, or the
   * history is missing because the transaction was disputed by some other
   * path — it falls back to `FUNDED` rather than leaving the transaction stuck
   * in `DISPUTED` forever. A transaction nobody can move is worse than one in
   * a slightly conservative state.
   */
  private async restoreTransaction(
    client: PoolClient,
    transactionId: string,
    now: Date,
    ctx: ActorContext,
  ): Promise<TransactionState> {
    const state = await this.lockState(client, transactionId);
    if (state !== 'DISPUTED') return state;

    const { rows } = await client.query<{ previous_status: string }>(
      `SELECT previous_status FROM status_history
        WHERE entity_type = 'TRANSACTION' AND entity_id = $1 AND new_status = 'DISPUTED'
        ORDER BY changed_at DESC LIMIT 1`,
      [transactionId],
    );

    const remembered = rows[0]?.previous_status as TransactionState | undefined;
    const target =
      remembered && canTransition('DISPUTED', remembered) ? remembered : FALLBACK_STATE;

    requireTransition('DISPUTED', target);
    await client.query(
      `UPDATE receivable_transactions SET state = $2::transaction_state, updated_at = $3 WHERE id = $1`,
      [transactionId, target, now],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
       VALUES ('TRANSACTION',$1,'DISPUTED',$2,'Dispute resolved; automation resumes',$3,$4::uuid)`,
      [transactionId, target, now, ctx.userId],
    );
    return target;
  }

  private async lockState(client: PoolClient, transactionId: string): Promise<TransactionState> {
    const { rows } = await client.query<{ state: TransactionState }>(
      `SELECT state FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
      [transactionId],
    );
    if (rows.length === 0) throw AppException.notFound('Transaction');
    return rows[0].state;
  }

  private async lockDispute(client: PoolClient, disputeId: string): Promise<DisputeRow> {
    const { rows } = await client.query<DisputeRow>(
      `SELECT id, transaction_id, dispute_type, amount::text, status, raised_by_org_id,
              raised_by, description, resolution_notes, raised_at, resolved_at
         FROM disputes WHERE id = $1 FOR UPDATE`,
      [disputeId],
    );
    if (rows.length === 0) throw AppException.notFound('Dispute');
    return rows[0];
  }

  private async requireParty(transactionId: string, ctx: ActorContext): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;

    const row = await this.db.queryOne<{ supplier_org_id: string; bank_org_id: string | null }>(
      `SELECT t.supplier_org_id, s.bank_org_id
         FROM receivable_transactions t
         LEFT JOIN accepted_offer_snapshots s ON s.transaction_id = t.id
        WHERE t.id = $1`,
      [transactionId],
    );
    if (!row) throw AppException.notFound('Transaction');

    const isSupplier =
      ctx.organizationType === 'SUPPLIER' && row.supplier_org_id === ctx.organizationId;
    const isBank = ctx.organizationType === 'BANK' && row.bank_org_id === ctx.organizationId;
    if (!isSupplier && !isBank) throw AppException.notFound('Transaction');
  }

  /**
   * Who may record a resolution.
   *
   * Either party or platform staff — because the resolution is a *record*, and
   * whoever has the agreement in hand should be able to enter it. What none of
   * them can do is have the platform decide the outcome for them, which is why
   * `resolutionNotes` is mandatory: there is no way to close a dispute without
   * someone stating what was agreed.
   */
  private async requireResolver(dispute: DisputeRow, ctx: ActorContext): Promise<void> {
    await this.requireParty(dispute.transaction_id, ctx);
  }
}

/** Allow-list. Both parties see the same dispute — it is a shared record. */
export function describeDispute(row: DisputeRow): Record<string, unknown> {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    disputeType: row.dispute_type,
    amount: row.amount,
    status: row.status,
    description: row.description,
    resolutionNotes: row.resolution_notes,
    raisedByOrgId: row.raised_by_org_id,
    raisedAt: row.raised_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  };
}
