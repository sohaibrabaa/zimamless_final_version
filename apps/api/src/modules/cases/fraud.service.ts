import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { canTransition, requireTransition, TransactionState } from '../transactions/transaction-state';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Fraud review (ZM-FRD-001..006).
 *
 * Opening a review **freezes** the transaction and stops funding. Deciding one
 * is restricted to compliance — and `ZM-FRD-004` is explicit that only that
 * decision records a confirmed status. The distinction is the point of the
 * whole module: an *indicator* is a machine or a person noticing something;
 * a *finding* is a qualified human concluding something. A system that let the
 * first become the second would blacklist Jordanian businesses on the strength
 * of a heuristic.
 *
 * So `open()` records suspicion and stops the money. It sets no verdict, files
 * no report, and restricts nobody. Everything consequential waits for
 * `decide()`, which only compliance can call.
 *
 * ## Why freezing is safe and labelling is not
 *
 * Stopping a payout is reversible: if the review clears, the transaction
 * returns to where it was and the money moves a day later. Recording an
 * organization as fraudulent is not reversible in any way that matters — it
 * follows a business around. So the cheap, reversible action happens
 * immediately on suspicion, and the expensive, irreversible one requires a
 * decision.
 */

export type FraudCaseStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'INFORMATION_REQUESTED'
  | 'CLEARED'
  | 'RESTRICTED'
  | 'SUSPENDED'
  | 'BLACKLISTED'
  | 'REPORTED'
  | 'CLOSED';

/** The decisions `POST /fraud-cases/{id}/decide` accepts (overlay). */
export type FraudDecision = 'CLEARED' | 'RESTRICTED' | 'SUSPENDED' | 'BLACKLISTED' | 'REPORTED';

export interface FraudCaseRow {
  id: string;
  transaction_id: string | null;
  organization_id: string | null;
  status: FraudCaseStatus;
  summary: string;
  opened_by: string | null;
  assigned_to: string | null;
  decision_notes: string | null;
  opened_at: Date;
  closed_at: Date | null;
}

@Injectable()
export class FraudService {
  private readonly logger = new Logger(FraudService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /**
   * Open a review and freeze the transaction.
   *
   * Any party to the transaction may raise one, plus platform staff. Fraud is
   * most often spotted by whoever is closest to the paperwork, and requiring
   * them to route it through the platform first would cost the hours in which
   * a payout goes out of the door.
   */
  async open(
    transactionId: string,
    ctx: ActorContext,
    input: { summary: string; indicators?: string[] },
  ): Promise<FraudCaseRow> {
    if (!input.summary?.trim()) {
      throw AppException.validation('Describe what prompted the review.', { field: 'summary' });
    }
    await this.requireParty(transactionId, ctx);

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const state = await this.lockState(client, transactionId);

      if (state === 'FRAUD_REVIEW') {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'This transaction is already under fraud review.',
        );
      }
      if (!canTransition(state, 'FRAUD_REVIEW')) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'This transaction cannot be placed under fraud review from its current state.',
          HttpStatus.CONFLICT,
          { state },
        );
      }

      const supplier = await client.query<{ supplier_org_id: string }>(
        `SELECT supplier_org_id FROM receivable_transactions WHERE id = $1`,
        [transactionId],
      );

      const { rows } = await client.query<FraudCaseRow>(
        `INSERT INTO fraud_cases
           (transaction_id, organization_id, status, summary, opened_by, opened_at)
         VALUES ($1,$2,'OPEN',$3,$4::uuid,$5)
         RETURNING id, transaction_id, organization_id, status, summary, opened_by,
                   assigned_to, decision_notes, opened_at, closed_at`,
        [
          transactionId,
          supplier.rows[0]?.supplier_org_id ?? null,
          input.summary.trim(),
          ctx.userId,
          now,
        ],
      );

      for (const indicator of input.indicators ?? []) {
        await client.query(
          `INSERT INTO fraud_indicators (fraud_case_id, indicator_type, detected_at, source_reference)
           VALUES ($1,$2,$3,$4)`,
          [rows[0].id, indicator, now, `Reported by ${ctx.organizationType}`],
        );
      }

      requireTransition(state, 'FRAUD_REVIEW');
      await client.query(
        `UPDATE receivable_transactions SET state = 'FRAUD_REVIEW', updated_at = $2 WHERE id = $1`,
        [transactionId, now],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
         VALUES ('TRANSACTION',$1,$2,'FRAUD_REVIEW','Fraud review opened; funding frozen',$3,$4::uuid)`,
        [transactionId, state, now, ctx.userId],
      );

      await this.notifyCompliance(client, transactionId, rows[0].id, input.summary.trim());

      await this.audit.recordIn(client, {
        actionType: 'FRAUD_REVIEW_OPENED',
        targetEntityType: 'TRANSACTION',
        targetEntityId: transactionId,
        previousValue: { state },
        newValue: {
          state: 'FRAUD_REVIEW',
          fraudCaseId: rows[0].id,
          indicators: input.indicators ?? [],
          fundingFrozen: true,
          // ZM-FRD-004, recorded at the moment a reader might assume otherwise:
          // opening a review concludes nothing about anybody.
          confirmedFinding: false,
        },
      });

      this.logger.warn(`Fraud review ${rows[0].id} opened on ${transactionId}; funding frozen`);
      return rows[0];
    });
  }

  /**
   * The compliance decision — ZM-FRD-004.
   *
   * The only thing in the system that records a confirmed status. Restricted
   * to `PLATFORM_COMPLIANCE` and the two admin roles: a bank that reported a
   * suspicion must not also be the one that concludes its counterparty is
   * fraudulent, and an operations admin should not be blacklisting businesses
   * as a routine queue action.
   *
   * `CLEARED` returns the transaction to where it was and funding resumes.
   * Everything else closes it — a transaction under a confirmed finding is not
   * one to keep processing.
   */
  async decide(
    caseId: string,
    ctx: ActorContext,
    input: { decision: FraudDecision; notes?: string },
  ): Promise<FraudCaseRow> {
    if (ctx.organizationType !== 'PLATFORM') {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Only platform compliance may decide a fraud case (ZM-FRD-004).',
        HttpStatus.FORBIDDEN,
      );
    }

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const fraud = await this.lockCase(client, caseId);

      if (fraud.status !== 'OPEN' && fraud.status !== 'UNDER_REVIEW' && fraud.status !== 'INFORMATION_REQUESTED') {
        // Already decided. Returned unchanged rather than erroring, so a
        // double submission does not look like a second finding.
        return fraud;
      }

      const { rows } = await client.query<FraudCaseRow>(
        // Every decision closes the case, cleared or not — so this is a plain
        // assignment, not a CASE with two identical branches. The ::timestamptz
        // cast is required: a parameter used only inside an expression gives
        // Postgres nothing to infer from and it defaults to text.
        `UPDATE fraud_cases
            SET status = $2::fraud_case_status, decision_notes = $3, assigned_to = $4::uuid,
                closed_at = $5::timestamptz
          WHERE id = $1
        RETURNING id, transaction_id, organization_id, status, summary, opened_by,
                  assigned_to, decision_notes, opened_at, closed_at`,
        [caseId, input.decision, input.notes ?? null, ctx.userId, now],
      );

      let restored: TransactionState | null = null;
      if (fraud.transaction_id) {
        restored =
          input.decision === 'CLEARED'
            ? await this.unfreeze(client, fraud.transaction_id, now, ctx)
            : await this.closeUnderFinding(client, fraud.transaction_id, now, ctx, input.decision);
      }

      await this.audit.recordIn(client, {
        actionType: 'FRAUD_CASE_DECIDED',
        targetEntityType: 'FRAUD_CASE',
        targetEntityId: caseId,
        previousValue: { status: fraud.status },
        newValue: {
          status: input.decision,
          transactionState: restored,
          notes: input.notes ?? null,
          // The inverse of what `open` recorded: this IS the confirmed status.
          confirmedFinding: input.decision !== 'CLEARED',
          decidedBy: ctx.userId,
        },
      });

      this.logger.warn(`Fraud case ${caseId} decided ${input.decision}`);
      return rows[0];
    });
  }

  async findById(caseId: string, ctx: ActorContext): Promise<FraudCaseRow> {
    const row = await this.db.queryOne<FraudCaseRow>(
      `SELECT id, transaction_id, organization_id, status, summary, opened_by,
              assigned_to, decision_notes, opened_at, closed_at
         FROM fraud_cases WHERE id = $1`,
      [caseId],
    );
    if (!row) throw AppException.notFound('Fraud case');

    // Fraud cases are platform-only to read. Telling a supplier that a fraud
    // review naming them exists, before compliance has concluded anything,
    // turns an unproven suspicion into an accusation they have to answer.
    if (ctx.organizationType !== 'PLATFORM') throw AppException.notFound('Fraud case');
    return row;
  }

  // ===================================================================
  // helpers
  // ===================================================================

  /** Cleared: back to where it was, funding resumes. */
  private async unfreeze(
    client: PoolClient,
    transactionId: string,
    now: Date,
    ctx: ActorContext,
  ): Promise<TransactionState> {
    const state = await this.lockState(client, transactionId);
    if (state !== 'FRAUD_REVIEW') return state;

    const { rows } = await client.query<{ previous_status: string }>(
      `SELECT previous_status FROM status_history
        WHERE entity_type = 'TRANSACTION' AND entity_id = $1 AND new_status = 'FRAUD_REVIEW'
        ORDER BY changed_at DESC LIMIT 1`,
      [transactionId],
    );
    const remembered = rows[0]?.previous_status as TransactionState | undefined;
    const target =
      remembered && canTransition('FRAUD_REVIEW', remembered) ? remembered : 'FUNDED';

    requireTransition('FRAUD_REVIEW', target);
    await client.query(
      `UPDATE receivable_transactions SET state = $2::transaction_state, updated_at = $3 WHERE id = $1`,
      [transactionId, target, now],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
       VALUES ('TRANSACTION',$1,'FRAUD_REVIEW',$2,'Fraud review cleared; funding resumes',$3,$4::uuid)`,
      [transactionId, target, now, ctx.userId],
    );
    return target;
  }

  /** Any finding other than CLEARED: the transaction closes, it is not deleted (INV-7). */
  private async closeUnderFinding(
    client: PoolClient,
    transactionId: string,
    now: Date,
    ctx: ActorContext,
    decision: FraudDecision,
  ): Promise<TransactionState> {
    const state = await this.lockState(client, transactionId);
    if (state === 'CLOSED') return state;
    requireTransition(state, 'CLOSED');

    await client.query(
      `UPDATE receivable_transactions
          SET state = 'CLOSED', closure_reason = 'WRITTEN_OFF', closure_notes = $2, updated_at = $3
        WHERE id = $1`,
      [transactionId, `Fraud case decided ${decision}`, now],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at, changed_by)
       VALUES ('TRANSACTION',$1,$2,'CLOSED',$3,$4,$5::uuid)`,
      [transactionId, state, `Fraud case decided ${decision}`, now, ctx.userId],
    );
    return 'CLOSED';
  }

  private async lockState(client: PoolClient, transactionId: string): Promise<TransactionState> {
    const { rows } = await client.query<{ state: TransactionState }>(
      `SELECT state FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
      [transactionId],
    );
    if (rows.length === 0) throw AppException.notFound('Transaction');
    return rows[0].state;
  }

  private async lockCase(client: PoolClient, caseId: string): Promise<FraudCaseRow> {
    const { rows } = await client.query<FraudCaseRow>(
      `SELECT id, transaction_id, organization_id, status, summary, opened_by,
              assigned_to, decision_notes, opened_at, closed_at
         FROM fraud_cases WHERE id = $1 FOR UPDATE`,
      [caseId],
    );
    if (rows.length === 0) throw AppException.notFound('Fraud case');
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

  private async notifyCompliance(
    client: PoolClient,
    transactionId: string,
    caseId: string,
    summary: string,
  ): Promise<void> {
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM organization_memberships m
         JOIN membership_roles r ON r.membership_id = m.id
        WHERE m.status = 'ACTIVE' AND r.role = 'PLATFORM_COMPLIANCE'`,
    );

    if (rows.length === 0) {
      // Loud: a fraud review nobody is told about is a frozen transaction that
      // sits frozen.
      this.logger.error(
        `Fraud case ${caseId} opened but no active PLATFORM_COMPLIANCE user exists to review it`,
      );
      return;
    }

    for (const recipient of rows) {
      await client.query(
        `INSERT INTO notifications
           (template_key, channel, language, recipient_user_id, destination,
            subject, body, status, transaction_id)
         VALUES ('FRAUD_REVIEW_OPENED','IN_PLATFORM','EN',$1,'in-platform',$2,$3,'QUEUED',$4)`,
        [
          recipient.user_id,
          'A fraud review needs compliance attention',
          `A fraud review was opened on a transaction and funding is frozen pending your ` +
            `decision. Reported: ${summary}. No finding has been recorded — only a compliance ` +
            `decision can do that (ZM-FRD-004).`,
          transactionId,
        ],
      );
    }
  }
}

/** Allow-list. Platform-only by the time this is reached, but explicit anyway. */
export function describeFraudCase(row: FraudCaseRow): Record<string, unknown> {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    organizationId: row.organization_id,
    status: row.status,
    summary: row.summary,
    decisionNotes: row.decision_notes,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}
