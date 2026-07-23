import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  fundingReceivedJournal,
} from '../ledger/settlement-postings';
import { requireTransition, TransactionState } from '../transactions/transaction-state';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Funding — the bank's half of defining behaviour #5.
 *
 * `mark-sent` is the bank asserting it has executed the transfer. The single
 * most important thing about this file is what it does **not** do: it never
 * sets `FUNDED`. `FUNDED` requires the supplier's OTP confirmation as well
 * (INV-10), and a bank that could reach it alone would make "funding requires
 * both parties" a slogan rather than a control.
 *
 * So this moves the transaction to `FUNDING_CONFIRMATION_PENDING` and stops.
 * The state name is the honest description of where things stand: the money
 * has been sent according to one party, and nobody else has said so yet.
 */

export interface SettlementRow {
  id: string;
  transaction_id: string;
  snapshot_id: string;
  status: string;
  gross_funding_amount: string;
  platform_commission_amount: string;
  listing_fee_deducted: string;
  net_supplier_payout: string;
  provider_name: string;
  provider_reference: string | null;
  idempotency_key: string;
  bank_marked_sent_at: Date | null;
  bank_marked_sent_by: string | null;
  funding_received_at: Date | null;
  payout_initiated_at: Date | null;
  payout_completed_at: Date | null;
  retry_count: number;
  max_retries: number;
  failure_reason: string | null;
}

interface SnapshotRow {
  id: string;
  bank_org_id: string;
  supplier_org_id: string;
  gross_funding_amount: string;
  platform_commission_amount: string;
  listing_fee_amount: string;
  net_supplier_payout: string;
}

@Injectable()
export class FundingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // mark-sent
  // =====================================================================

  async markSent(
    transactionId: string,
    ctx: ActorContext,
    input: { providerReference?: string; evidenceDocumentId?: string },
  ): Promise<SettlementRow> {
    const snapshot = await this.requireBankParty(transactionId, ctx);

    // Evidence is validated before the write transaction opens: a document
    // that does not belong to this bank is a client error, not something to
    // discover halfway through a settlement insert.
    if (input.evidenceDocumentId) {
      await this.requireOwnDocument(input.evidenceDocumentId, ctx);
    }

    const now = this.time.now();

    return this.db.transaction(async (client) => {
      // Row-lock the transaction for the same reason acceptance does: two
      // simultaneous mark-sent calls must not both create a settlement or both
      // perform the transition.
      const { rows: locked } = await client.query<{ id: string; state: TransactionState }>(
        `SELECT id, state FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
        [transactionId],
      );
      if (locked.length === 0) throw AppException.notFound('Transaction');
      const state = locked[0].state;

      const existing = await this.findSettlementIn(client, transactionId);

      // Idempotent by observation, not by an idempotency key store: if this
      // settlement has already been marked sent, return it unchanged. A bank
      // clicking twice, or a retried request, must not produce a second
      // journal or a second notification.
      if (existing?.bank_marked_sent_at) return existing;

      if (state !== 'CONTRACTED') {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          state === 'FUNDING_CONFIRMATION_PENDING'
            ? 'Funding has already been marked as sent for this transaction.'
            : 'Funding can only be marked sent once the contract is fully signed.',
          HttpStatus.CONFLICT,
          { state },
        );
      }
      requireTransition(state, 'FUNDING_CONFIRMATION_PENDING');

      const split = this.splitFrom(snapshot);
      // Refuse to write books that do not describe real money, before any row
      // exists to be corrected later.
      assertSplitReconciles(split);

      const settlement =
        existing ?? (await this.createSettlement(client, transactionId, snapshot, split));

      const { rows: marked } = await client.query<SettlementRow>(
        `UPDATE settlements
            SET status = 'FUNDING_RECEIVED',
                provider_reference = $2,
                bank_marked_sent_at = $3,
                bank_marked_sent_by = $4,
                funding_received_at = $3
          WHERE id = $1
        RETURNING *`,
        [settlement.id, input.providerReference ?? null, now, ctx.userId],
      );

      // The bank's assertion is now on the books: the funding it says it sent
      // lands in clearing, where it stays until the payout distributes it.
      // Note this posts the DISTRIBUTABLE amount — the bank retains its own
      // discount and fees and never remits them (see settlement-postings).
      await this.ledger.post(client, {
        lines: fundingReceivedJournal(split),
        transactionId,
        settlementId: settlement.id,
      });

      if (input.evidenceDocumentId) {
        await client.query(
          `UPDATE documents SET subject_type = 'TRANSACTION', subject_id = $2 WHERE id = $1`,
          [input.evidenceDocumentId, transactionId],
        );
      }

      await client.query(
        `UPDATE receivable_transactions
            SET state = 'FUNDING_CONFIRMATION_PENDING', updated_at = now()
          WHERE id = $1`,
        [transactionId],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
         VALUES ('TRANSACTION',$1,$2,'FUNDING_CONFIRMATION_PENDING',
                 'Bank marked the transfer executed',$3,$4)`,
        [transactionId, state, ctx.userId, now],
      );

      await this.notifySupplierFundingSent(client, snapshot.supplier_org_id, transactionId);

      await this.audit.recordIn(client, {
        actionType: 'FUNDING_MARKED_SENT',
        targetEntityType: 'SETTLEMENT',
        targetEntityId: settlement.id,
        previousValue: { transactionState: state, settlementStatus: settlement.status },
        newValue: {
          transactionState: 'FUNDING_CONFIRMATION_PENDING',
          settlementStatus: 'FUNDING_RECEIVED',
          providerReference: input.providerReference ?? null,
          distributableAmount: split.distributable.toString(),
        },
      });

      return marked[0];
    });
  }

  // =====================================================================
  // Reads and helpers
  // =====================================================================

  async findSettlement(transactionId: string): Promise<SettlementRow | null> {
    return this.db.queryOne<SettlementRow>(
      `SELECT * FROM settlements WHERE transaction_id = $1`,
      [transactionId],
    );
  }

  private async findSettlementIn(
    client: PoolClient,
    transactionId: string,
  ): Promise<SettlementRow | null> {
    const { rows } = await client.query<SettlementRow>(
      `SELECT * FROM settlements WHERE transaction_id = $1`,
      [transactionId],
    );
    return rows[0] ?? null;
  }

  /**
   * The settlement row, created once from the immutable snapshot.
   *
   * INV-13's mechanism: `idempotency_key` **is** the settlement id. Not a
   * random value stored alongside it — the same uuid, so the key is stable
   * across every retry for the lifetime of the settlement and cannot be
   * regenerated by accident. `settlements.transaction_id` is UNIQUE, so a
   * second settlement for one transaction is impossible at the database level
   * rather than by convention.
   *
   * Amounts come from the snapshot verbatim. The supplier accepted a specific
   * net payout; recomputing it here from live tiers or obligations could pay
   * them something other than what they agreed to, and the snapshot exists
   * precisely so that cannot happen (ZM-SEL-008).
   */
  private async createSettlement(
    client: PoolClient,
    transactionId: string,
    snapshot: SnapshotRow,
    split: SettlementSplit,
  ): Promise<SettlementRow> {
    const id = randomUUID();
    const { rows } = await client.query<SettlementRow>(
      `INSERT INTO settlements
         (id, transaction_id, snapshot_id, status, gross_funding_amount,
          platform_commission_amount, listing_fee_deducted, net_supplier_payout,
          provider_name, idempotency_key)
       VALUES ($1,$2,$3,'PENDING',$4::numeric,$5::numeric,$6::numeric,$7::numeric,'DUMMY',$1)
       RETURNING *`,
      [
        id,
        transactionId,
        snapshot.id,
        // The HEADLINE gross goes in this column, not the distributable
        // amount: `chk_settlement_split` compares against it and the bank's
        // retained margin is the difference it tolerates.
        Money.from(snapshot.gross_funding_amount).toDb(),
        split.commission.toDb(),
        split.listingFee.toDb(),
        split.netPayout.toDb(),
      ],
    );
    return rows[0];
  }

  private splitFrom(snapshot: SnapshotRow): SettlementSplit {
    const commission = Money.from(snapshot.platform_commission_amount);
    const listingFee = Money.from(snapshot.listing_fee_amount);
    const netPayout = Money.from(snapshot.net_supplier_payout);
    return {
      distributable: distributableFrom(commission, listingFee, netPayout),
      commission,
      listingFee,
      netPayout,
      supplierOrgId: snapshot.supplier_org_id,
      bankOrgId: snapshot.bank_org_id,
    };
  }

  /**
   * Only the bank that won this deal may mark its funding sent.
   *
   * 404 rather than 403 for everyone else, as everywhere else in this API: a
   * bank that lost the deal must not be able to confirm the transaction even
   * reached contracting.
   */
  private async requireBankParty(
    transactionId: string,
    ctx: ActorContext,
  ): Promise<SnapshotRow> {
    const snapshot = await this.db.queryOne<SnapshotRow>(
      `SELECT id, bank_org_id, supplier_org_id, gross_funding_amount,
              platform_commission_amount, listing_fee_amount, net_supplier_payout
         FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
    if (!snapshot) throw AppException.notFound('Transaction');

    if (ctx.organizationType === 'PLATFORM') return snapshot;
    if (ctx.organizationType === 'BANK' && snapshot.bank_org_id === ctx.organizationId) {
      return snapshot;
    }
    throw AppException.notFound('Transaction');
  }

  /**
   * A settlement is visible to its two parties and to platform staff.
   *
   * The supplier is the one party `requireBankParty` cannot admit, so it is
   * handled here: they reach it through the snapshot that names them, not
   * through the transaction table, because the snapshot is the record of who
   * the deal is actually between.
   *
   * 404 for anyone else, consistently with the rest of the API — a competing
   * bank must not learn that this receivable was funded at all.
   */
  async requireSettlementVisible(transactionId: string, ctx: ActorContext): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;

    const snapshot = await this.db.queryOne<{
      supplier_org_id: string;
      bank_org_id: string;
    }>(
      `SELECT supplier_org_id, bank_org_id FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
    if (
      snapshot?.supplier_org_id === ctx.organizationId ||
      snapshot?.bank_org_id === ctx.organizationId
    ) {
      return;
    }
    throw AppException.notFound('Settlement');
  }

  /** Evidence must be the bank's own document, not one it merely knows the id of. */
  private async requireOwnDocument(documentId: string, ctx: ActorContext): Promise<void> {
    const row = await this.db.queryOne<{ owner_org_id: string }>(
      `SELECT owner_org_id FROM documents WHERE id = $1`,
      [documentId],
    );
    if (!row || row.owner_org_id !== ctx.organizationId) {
      throw AppException.notFound('Document');
    }
  }

  /**
   * Tell the supplier the money is on its way and their confirmation is next.
   *
   * Carries no amount. The supplier already knows the agreed net from the
   * accepted snapshot, and a figure restated in a notification is a figure
   * that can disagree with the contract.
   */
  private async notifySupplierFundingSent(
    client: PoolClient,
    supplierOrgId: string,
    transactionId: string,
  ): Promise<void> {
    const { rows: recipients } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT m.user_id
         FROM organization_memberships m
         JOIN membership_roles r ON r.membership_id = m.id
        WHERE m.organization_id = $1 AND m.status = 'ACTIVE'
          AND r.role IN ('SUPPLIER_OWNER','SUPPLIER_SIGNATORY')`,
      [supplierOrgId],
    );

    for (const recipient of recipients) {
      await client.query(
        `INSERT INTO notifications
           (template_key, channel, language, recipient_user_id, destination,
            subject, body, status, transaction_id)
         VALUES ('FUNDING_MARKED_SENT','IN_PLATFORM','EN',$1,'in-platform',$2,$3,'QUEUED',$4)`,
        [
          recipient.user_id,
          'The bank has sent your funding',
          'The bank has recorded the transfer. To complete funding, confirm receipt with the ' +
            'one-time code the bank will provide to you directly.',
          transactionId,
        ],
      );
    }
  }

  /**
   * Whether settlement evidence exists for INV-10.
   *
   * "Evidence" is the bank's recorded assertion that it executed the transfer:
   * a settlement row that has been marked sent. Deliberately a single named
   * predicate rather than an inline condition, because INV-10 is enforced in
   * one place and tested by name.
   */
  hasSettlementEvidence(settlement: SettlementRow | null): boolean {
    return settlement !== null && settlement.bank_marked_sent_at !== null;
  }
}
