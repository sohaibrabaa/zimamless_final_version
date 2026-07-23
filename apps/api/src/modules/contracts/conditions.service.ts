import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Offer conditions after acceptance, and the `CONDITIONS_PENDING` state.
 *
 * A condition is a term the bank attached to its offer — a guarantee, a
 * document, a timeline. Once an offer is accepted those conditions become
 * obligations on the deal, and the contract cannot be generated until the
 * mandatory ones are fulfilled or explicitly waived with a record
 * (ZM-CON-006, enforced in `pre-contract-checks.ts`).
 *
 * Two asymmetries here are deliberate:
 *
 *   **The supplier fulfils; the bank waives.** Fulfilment is evidence the
 *   supplier produces, so the supplier records it. A waiver is the bank
 *   giving up its own requirement, so only the bank may do it — a supplier
 *   able to waive a condition could contract past every requirement the bank
 *   attached, which would make conditions decorative.
 *
 *   **A waiver requires a reason and a fulfilment does not.** The evidence is
 *   the fulfilment's justification; a waiver has no artifact behind it, so
 *   the reason IS the record ZM-CON-006 demands.
 */

export interface ConditionRow {
  id: string;
  offer_id: string;
  condition_type: string;
  title: string;
  description: string | null;
  is_mandatory: boolean;
  display_order: number;
  fulfilment: 'PENDING' | 'FULFILLED' | 'WAIVED' | 'FAILED';
  fulfilled_at: Date | null;
  fulfilled_by: string | null;
  waiver_reason: string | null;
}

export interface FulfilInput {
  documentIds?: string[];
  notes?: string;
  /** Bank-only. Present means "waive", and requires a reason. */
  waiverReason?: string;
}

@Injectable()
export class ConditionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /**
   * The conditions on the **accepted** offer for a transaction.
   *
   * Not the conditions on every offer that was ever made: after acceptance
   * the losing offers' conditions are of no interest to anyone, and returning
   * them to a supplier would be a small competitive leak in the one direction
   * this system is otherwise careful about.
   */
  async listForTransaction(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<ConditionRow[]> {
    const snapshot = await this.db.queryOne<{
      source_offer_id: string;
      supplier_org_id: string;
      bank_org_id: string;
    }>(
      `SELECT source_offer_id, supplier_org_id, bank_org_id
         FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
    if (!snapshot) {
      // Before acceptance there is no accepted offer, so there are no
      // conditions on the deal. An empty array rather than a 404: the
      // question "what conditions apply?" has a correct answer, and it is
      // "none yet".
      await this.requireTransactionVisible(transactionId, ctx);
      return [];
    }

    if (
      ctx.organizationType !== 'PLATFORM' &&
      ctx.organizationId !== snapshot.supplier_org_id &&
      ctx.organizationId !== snapshot.bank_org_id
    ) {
      throw AppException.notFound('Transaction');
    }

    const { rows } = await this.db.query<ConditionRow>(
      `SELECT * FROM offer_conditions WHERE offer_id = $1 ORDER BY display_order, title`,
      [snapshot.source_offer_id],
    );
    return rows;
  }

  async findById(id: string): Promise<ConditionRow | null> {
    return this.db.queryOne<ConditionRow>(`SELECT * FROM offer_conditions WHERE id = $1`, [id]);
  }

  async fulfil(
    conditionId: string,
    ctx: ActorContext,
    input: FulfilInput,
  ): Promise<ConditionRow> {
    const condition = await this.findById(conditionId);
    if (!condition) throw AppException.notFound('Condition');

    const context = await this.dealContext(condition.offer_id);
    if (!context) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'This condition belongs to an offer that was not accepted.',
        HttpStatus.CONFLICT,
      );
    }

    const isWaiver = input.waiverReason !== undefined;
    const isBank = ctx.organizationId === context.bank_org_id;
    const isSupplier = ctx.organizationId === context.supplier_org_id;

    if (!isBank && !isSupplier && ctx.organizationType !== 'PLATFORM') {
      throw AppException.notFound('Condition');
    }

    if (isWaiver && !isBank) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only the bank that attached a condition may waive it.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (isWaiver && input.waiverReason!.trim().length === 0) {
      throw AppException.validation(
        'A waiver must record a reason. ZM-CON-006 accepts a waived condition only with a record.',
      );
    }

    if (condition.fulfilment === 'FULFILLED' || condition.fulfilment === 'WAIVED') {
      // Already resolved. Returned as-is rather than re-stamped, so the
      // recorded `fulfilled_at` stays the moment it was actually satisfied.
      return condition;
    }

    // Evidence documents must belong to this transaction. Without the check a
    // caller could attach any document id they happen to know and have it
    // presented as evidence on a contract precondition.
    for (const documentId of input.documentIds ?? []) {
      const document = await this.db.queryOne<{ id: string }>(
        `SELECT id FROM documents
          WHERE id = $1 AND subject_type = 'TRANSACTION' AND subject_id = $2`,
        [documentId, context.transaction_id],
      );
      if (!document) {
        throw AppException.validation(
          'An evidence document does not belong to this transaction.',
          { documentId },
        );
      }
    }

    const now = this.time.now();

    const updated = await this.db.transaction(async (client) => {
      const { rows } = await client.query<ConditionRow>(
        `UPDATE offer_conditions
            SET fulfilment = $2, fulfilled_at = $3, fulfilled_by = $4, waiver_reason = $5
          WHERE id = $1
          RETURNING *`,
        [
          conditionId,
          isWaiver ? 'WAIVED' : 'FULFILLED',
          now,
          ctx.userId,
          isWaiver ? input.waiverReason!.trim() : null,
        ],
      );
      const row = rows[0];

      await this.audit.recordIn(client, {
        actionType: isWaiver ? 'CONDITION_WAIVED' : 'CONDITION_FULFILLED',
        targetEntityType: 'OFFER_CONDITION',
        targetEntityId: conditionId,
        previousValue: { fulfilment: condition.fulfilment },
        newValue: {
          fulfilment: row.fulfilment,
          transactionId: context.transaction_id,
          documentIds: input.documentIds ?? [],
          notes: input.notes ?? null,
          waiverReason: row.waiver_reason,
        },
      });

      await this.refreshConditionState(client, context.transaction_id, condition.offer_id, ctx, now);
      return row;
    });

    return updated;
  }

  /**
   * Moves the transaction between `OFFER_ACCEPTED` and `CONDITIONS_PENDING`.
   *
   * The state is derived from the conditions rather than set by a workflow
   * step, in both directions. That is what makes it honest: a transaction is
   * in `CONDITIONS_PENDING` exactly when a mandatory condition is unresolved,
   * so the state can never disagree with the checklist a supplier is looking
   * at. A flag someone remembers to flip would drift the first time a
   * condition was resolved by any path but the expected one.
   */
  async refreshConditionState(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    transactionId: string,
    offerId: string,
    ctx: ActorContext,
    now: Date,
  ): Promise<void> {
    const { rows: outstanding } = (await client.query(
      `SELECT count(*)::text AS n FROM offer_conditions
        WHERE offer_id = $1 AND is_mandatory
          AND fulfilment NOT IN ('FULFILLED','WAIVED')`,
      [offerId],
    )) as { rows: { n: string }[] };
    const pending = Number(outstanding[0]?.n ?? '0') > 0;

    const { rows: states } = (await client.query(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [transactionId],
    )) as { rows: { state: string }[] };
    const state = states[0]?.state;

    // Only ever between these two. A transaction that has moved on to
    // CONTRACTED or beyond must not be dragged backwards by a late condition
    // update — which is a real possibility, since a bank may record a waiver
    // after the fact for its own records.
    if (state !== 'OFFER_ACCEPTED' && state !== 'CONDITIONS_PENDING') return;

    const target = pending ? 'CONDITIONS_PENDING' : 'OFFER_ACCEPTED';
    if (target === state) return;

    await client.query(
      `UPDATE receivable_transactions SET state = $2, updated_at = now() WHERE id = $1`,
      [transactionId, target],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
       VALUES ('TRANSACTION',$1,$2,$3,$4,$5,$6)`,
      [
        transactionId,
        state,
        target,
        pending ? 'Mandatory offer conditions outstanding' : 'All mandatory conditions resolved',
        ctx.userId,
        now,
      ],
    );
  }

  private async dealContext(
    offerId: string,
  ): Promise<{ transaction_id: string; supplier_org_id: string; bank_org_id: string } | null> {
    return this.db.queryOne<{
      transaction_id: string;
      supplier_org_id: string;
      bank_org_id: string;
    }>(
      `SELECT transaction_id, supplier_org_id, bank_org_id
         FROM accepted_offer_snapshots WHERE source_offer_id = $1`,
      [offerId],
    );
  }

  private async requireTransactionVisible(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;
    const row = await this.db.queryOne<{ supplier_org_id: string }>(
      `SELECT supplier_org_id FROM receivable_transactions WHERE id = $1`,
      [transactionId],
    );
    if (!row || row.supplier_org_id !== ctx.organizationId) {
      throw AppException.notFound('Transaction');
    }
  }

  describe(condition: ConditionRow): Record<string, unknown> {
    return {
      id: condition.id,
      conditionType: condition.condition_type,
      title: condition.title,
      description: condition.description,
      isMandatory: condition.is_mandatory,
      fulfilment: condition.fulfilment,
      fulfilledAt: condition.fulfilled_at?.toISOString() ?? null,
      waiverReason: condition.waiver_reason,
    };
  }
}
