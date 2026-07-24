import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import type { ActorContext } from '../onboarding/onboarding.service';
import { contentHash } from './content-hash';
import { CommissionService } from '../marketplace/commission.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Offer acceptance — the highest-risk code in the system (brief §5).
 *
 * Four invariants live or die here:
 *
 *   **INV-1** acceptance is atomic; concurrent accepts yield exactly one
 *   winner. **INV-2** net ≥ floor at accept time. **INV-3** gross ≤
 *   outstanding. **INV-4** a transaction locks exactly once.
 *
 * ## Why the row lock is the whole design
 *
 * The temptation is to check `locked_at IS NULL`, then update. Between those
 * two statements a second request can do the same, and both commit — two
 * banks each believing they won. The `SELECT … FOR UPDATE` is not an
 * optimization or a nicety: it is the only thing that makes the check and the
 * write one indivisible act. The second transaction blocks on the lock, and
 * when it proceeds it re-reads the row and sees `locked_at` set.
 *
 * Note the shape of the guard. The predicate is `WHERE id = $1` and the lock
 * check happens *after* the row is held — not `WHERE id = $1 AND locked_at IS
 * NULL`, which would return zero rows for an already-locked transaction and
 * leave the service unable to distinguish "already accepted" from "no such
 * transaction". Those need different answers.
 *
 * ## Re-validation is not paranoia
 *
 * Everything checked at offer creation is checked again here, because time
 * has passed: the offer may have expired, the buyer may have part-paid the
 * invoice (reducing `outstanding_amount` below the accepted gross), the
 * supplier may have raised the floor. The offer was valid when made. The
 * question at acceptance is whether it is valid *now*.
 *
 * ## Idempotency without an idempotency table
 *
 * The contract declares an `Idempotency-Key` header on this endpoint. There
 * is no key-store table in the frozen schema, and this service does not need
 * one: `offer_selections` is `UNIQUE (offer_id)` and `UNIQUE (listing_id)`, so
 * the selection *is* the idempotency record. A replayed accept of the same
 * offer by the same supplier returns the original snapshot with 200 and
 * executes nothing; an accept of a *different* offer on a locked transaction
 * is a 409. That is stronger than key matching, because it holds even when
 * the client loses the key or retries from a different process — and it
 * cannot drift out of sync with the thing it protects.
 */

export interface SnapshotRow {
  id: string;
  selection_id: string;
  transaction_id: string;
  bank_org_id: string;
  supplier_org_id: string;
  source_offer_id: string;
  source_offer_version: number;
  transaction_type: string;
  recourse_type: string;
  gross_funding_amount: string;
  bank_discount_amount: string;
  bank_fees_amount: string;
  platform_commission_amount: string;
  listing_fee_amount: string;
  other_deductions_amount: string;
  net_supplier_payout: string;
  conditions_snapshot: unknown;
  snapshot_hash: string;
  captured_at: Date;
}

/** Roles permitted to accept, per AS-01 (configurable, default owner/admin). */
const DEFAULT_ACCEPTANCE_ROLES = ['SUPPLIER_OWNER', 'SUPPLIER_SIGNATORY'];

@Injectable()
export class AcceptanceService {
  private readonly logger = new Logger(AcceptanceService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly commission: CommissionService,
    private readonly notifications: NotificationsService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // Accept
  // =====================================================================

  async accept(offerId: string, ctx: ActorContext): Promise<SnapshotRow> {
    await this.requireAcceptanceRole(ctx);

    // Replay check before the transaction. A retried accept is a normal
    // client behaviour, not an error condition, and it should not have to
    // contend for a row lock to be told "yes, that already happened".
    const replay = await this.existingSelectionFor(offerId, ctx.organizationId);
    if (replay) return replay;

    const now = this.time.now();

    const snapshot = await this.db.transaction(async (client) => {
      // ---- 1. the offer, and the transaction it belongs to --------------
      const offer = await this.lockedOfferContext(client, offerId, ctx);

      // ---- 2. the row lock (INV-1, INV-4) ------------------------------
      const { rows: locked } = await client.query<{
        id: string;
        state: string;
        locked_at: Date | null;
        locked_by_offer_id: string | null;
        minimum_acceptable_amount: string | null;
        supplier_org_id: string;
      }>(
        `SELECT id, state, locked_at, locked_by_offer_id, minimum_acceptable_amount, supplier_org_id
           FROM receivable_transactions WHERE id = $1 FOR UPDATE`,
        [offer.transaction_id],
      );
      const transaction = locked[0];
      if (!transaction) throw AppException.notFound('Transaction');

      if (transaction.locked_at !== null) {
        // Reached only when a *different* offer won the race — the same-offer
        // replay was answered above, and re-checked below after the lock in
        // case the winner committed between the two.
        const already = await this.existingSelectionFor(offerId, ctx.organizationId, client);
        if (already) return already;

        throw new AppException(
          ErrorCode.TRANSACTION_ALREADY_LOCKED,
          'Another offer has already been accepted for this transaction.',
          HttpStatus.CONFLICT,
        );
      }

      if (transaction.supplier_org_id !== ctx.organizationId) {
        throw AppException.notFound('Offer');
      }

      // ---- 3. re-validate the offer ------------------------------------
      if (offer.status !== 'ACTIVE') {
        throw new AppException(
          ErrorCode.OFFER_NOT_ACTIVE,
          `This offer is ${offer.status.toLowerCase().replace(/_/g, ' ')} and cannot be accepted.`,
          HttpStatus.CONFLICT,
        );
      }
      if (offer.valid_until.getTime() <= now.getTime()) {
        throw new AppException(
          ErrorCode.OFFER_EXPIRED,
          'This offer has expired and can no longer be accepted.',
          HttpStatus.CONFLICT,
        );
      }

      // ---- 4. INV-2: net ≥ floor, re-checked at accept time -------------
      const net = Money.from(offer.net_supplier_payout);
      if (transaction.minimum_acceptable_amount !== null) {
        const floor = Money.from(transaction.minimum_acceptable_amount);
        if (!net.greaterThanOrEqual(floor)) {
          // The supplier is the caller here, so naming the floor would leak
          // nothing they do not already own. It still says nothing numeric:
          // this error text is rendered on a screen a screen-share might be
          // showing, and the discipline is worth more than the convenience.
          throw new AppException(
            ErrorCode.OFFER_BELOW_SUPPLIER_REQUIREMENT,
            'This offer no longer meets the minimum you have set for this transaction.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
      }

      // ---- 5. INV-3: gross ≤ outstanding, re-checked --------------------
      const { rows: invoices } = await client.query<{
        id: string;
        outstanding_amount: string;
      }>(
        `SELECT id, outstanding_amount FROM invoices WHERE transaction_id = $1`,
        [offer.transaction_id],
      );
      const invoice = invoices[0];
      if (!invoice) throw AppException.validation('The transaction has no invoice.');

      if (!Money.from(invoice.outstanding_amount).greaterThanOrEqual(
        Money.from(offer.gross_funding_amount),
      )) {
        throw AppException.validation(
          'The invoice outstanding amount has fallen below this offer’s gross funding amount.',
        );
      }

      // ---- 6. lock, select, deselect ------------------------------------
      await client.query(
        `UPDATE receivable_transactions
            SET locked_at = $2, locked_by_offer_id = $3, state = 'OFFER_ACCEPTED', updated_at = now()
          WHERE id = $1`,
        [offer.transaction_id, now, offerId],
      );
      await client.query(`UPDATE bank_offers SET status = 'SELECTED' WHERE id = $1`, [offerId]);
      await client.query(
        `UPDATE bank_offers SET status = 'NOT_SELECTED'
          WHERE listing_id = $1 AND id <> $2 AND status = 'ACTIVE'`,
        [offer.listing_id, offerId],
      );
      await client.query(
        `UPDATE listings SET status = 'OFFER_SELECTED', closed_at = $2 WHERE id = $1`,
        [offer.listing_id, now],
      );

      // ---- 7. the selection and the immutable snapshot ------------------
      const { rows: selections } = await client.query<{ id: string }>(
        `INSERT INTO offer_selections (listing_id, offer_id, selected_by, selected_at)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [offer.listing_id, offerId, ctx.userId, now],
      );
      const selectionId = selections[0].id;

      const snapshot = await this.writeSnapshot(client, {
        selectionId,
        offer,
        supplierOrgId: transaction.supplier_org_id,
        invoiceId: invoice.id,
        capturedAt: now,
      });

      // ---- 8. the commission becomes a real charge (ZM-FEE-012, INV-5) --
      // Inside this transaction on purpose: the charge and the snapshot that
      // justifies it commit together or not at all. Until now the platform's
      // commission existed only as a figure on the offer; from here it is a
      // recorded calculation with a tier behind it. It is CALCULATED, never
      // FINALIZED — the platform has not earned it until the supplier is
      // actually paid, which is INV-5 and happens in SettlementService.
      await this.recordCommission(client, offer, now);

      // ---- 9. history, notifications, audit ----------------------------
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
         VALUES ('TRANSACTION',$1,'OPEN_FOR_OFFERS','OFFER_ACCEPTED','Supplier accepted an offer',$2,$3)`,
        [offer.transaction_id, ctx.userId, now],
      );

      // If the accepted offer carries unresolved mandatory conditions, the
      // deal genuinely is pending them from this moment — so the state says
      // so immediately rather than after someone opens a checklist. The
      // brief's §5 sequence ends at OFFER_ACCEPTED and this follows it inside
      // the same transaction, so a rollback takes both or neither.
      await this.markConditionsPendingIfAny(client, offer, ctx, now);

      await this.notifyOutcome(client, offer.listing_id, offerId, offer.transaction_id);

      await this.audit.recordIn(client, {
        actionType: 'OFFER_ACCEPTED',
        targetEntityType: 'BANK_OFFER',
        targetEntityId: offerId,
        previousValue: { status: 'ACTIVE', transactionState: 'OPEN_FOR_OFFERS' },
        newValue: {
          status: 'SELECTED',
          transactionState: 'OFFER_ACCEPTED',
          selectionId,
          snapshotHash: snapshot.snapshot_hash,
          netSupplierPayout: snapshot.net_supplier_payout,
        },
      });

      return snapshot;
    });

    return snapshot;
  }

  /**
   * The offer and its listing, read inside the caller's transaction.
   *
   * 404 for an offer belonging to another supplier's listing, as everywhere:
   * a 403 would confirm it exists.
   */
  private async lockedOfferContext(
    client: PoolClient,
    offerId: string,
    ctx: ActorContext,
  ): Promise<{
    id: string;
    listing_id: string;
    transaction_id: string;
    bank_org_id: string;
    status: string;
    version_number: number;
    transaction_type: string;
    recourse_type: string;
    gross_funding_amount: string;
    bank_discount_amount: string;
    bank_fees_amount: string;
    platform_commission_amount: string;
    listing_fee_amount: string;
    other_deductions_amount: string;
    net_supplier_payout: string;
    valid_until: Date;
  }> {
    const { rows } = await client.query<{
      id: string;
      listing_id: string;
      transaction_id: string;
      bank_org_id: string;
      status: string;
      version_number: number;
      transaction_type: string;
      recourse_type: string;
      gross_funding_amount: string;
      bank_discount_amount: string;
      bank_fees_amount: string;
      platform_commission_amount: string;
      listing_fee_amount: string;
      other_deductions_amount: string;
      net_supplier_payout: string;
      valid_until: Date;
      supplier_org_id: string;
    }>(
      `SELECT o.*, l.transaction_id, t.supplier_org_id
         FROM bank_offers o
         JOIN listings l ON l.id = o.listing_id
         JOIN receivable_transactions t ON t.id = l.transaction_id
        WHERE o.id = $1`,
      [offerId],
    );
    const offer = rows[0];
    if (!offer) throw AppException.notFound('Offer');
    if (offer.supplier_org_id !== ctx.organizationId) throw AppException.notFound('Offer');
    return offer;
  }

  /**
   * The immutable freeze (ZM-SEL-007).
   *
   * Everything the requirement enumerates: both party identities, the invoice
   * reference, transaction and recourse type, every money component, the net,
   * the accepted conditions, the source offer's version, and a content hash
   * over all of it.
   *
   * The conditions are copied by value, not referenced. `offer_conditions`
   * rows stay mutable — a condition gets fulfilled, which is a status change
   * on the live row — so a snapshot that pointed at them would silently
   * change meaning as the deal progressed. ZM-SEL-008 requires the opposite.
   */
  /**
   * Record the platform commission as a CALCULATED charge.
   *
   * `CommissionService.record` was written in Phase 5 for exactly this moment
   * and never called — Phase 5 quoted, and nothing recorded. This is the call
   * it was waiting for.
   *
   * ## Which figure is charged when the tier has moved
   *
   * `quote()` prices the gross against the tier that is active *now*. The
   * offer, however, committed a specific `platform_commission_amount`, and the
   * supplier accepted a net payout computed from it. If an administrator
   * changed the tiers between the offer being made and accepted, those two
   * disagree — and the committed figure wins, every time. Charging the new
   * tier would mean charging the supplier something other than the deal they
   * agreed to, which the immutable snapshot exists to prevent.
   *
   * So the tier metadata comes from the live lookup (there is nowhere else to
   * get it — the offer stores an amount, not a tier), while the amount is the
   * one that was agreed. A divergence is recorded in the audit trail rather
   * than silently reconciled, because it means the tier table moved under a
   * live offer and somebody should know.
   */
  private async recordCommission(
    client: PoolClient,
    offer: { transaction_id: string; gross_funding_amount: string; platform_commission_amount: string },
    now: Date,
  ): Promise<void> {
    const gross = Money.from(offer.gross_funding_amount);
    const committed = Money.from(offer.platform_commission_amount);
    const quote = await this.commission.quote(gross, client);

    const diverged = !quote.amount.equals(committed);
    if (diverged) {
      this.logger.warn(
        `Commission tier drift on transaction ${offer.transaction_id}: the active tier prices ` +
          `${gross.toString()} at ${quote.amount.toString()}, but the accepted offer committed ` +
          `${committed.toString()}. Charging the committed amount.`,
      );
    }

    await this.commission.record(client, {
      transactionId: offer.transaction_id,
      gross,
      // The agreed amount, with the tier that was found for this gross.
      quote: diverged ? { ...quote, amount: committed } : quote,
    });

    if (diverged) {
      await this.audit.recordIn(client, {
        actionType: 'COMMISSION_TIER_DRIFT',
        targetEntityType: 'TRANSACTION',
        targetEntityId: offer.transaction_id,
        previousValue: { tierWouldCharge: quote.amount.toString() },
        newValue: { charged: committed.toString(), tierId: quote.tierId, capturedAt: now.toISOString() },
      });
    }
  }

  private async writeSnapshot(
    client: PoolClient,
    input: {
      selectionId: string;
      offer: {
        id: string;
        listing_id: string;
        transaction_id: string;
        bank_org_id: string;
        version_number: number;
        transaction_type: string;
        recourse_type: string;
        gross_funding_amount: string;
        bank_discount_amount: string;
        bank_fees_amount: string;
        platform_commission_amount: string;
        listing_fee_amount: string;
        other_deductions_amount: string;
        net_supplier_payout: string;
      };
      supplierOrgId: string;
      invoiceId: string;
      capturedAt: Date;
    },
  ): Promise<SnapshotRow> {
    const { offer } = input;

    const { rows: conditions } = await client.query<{
      condition_type: string;
      title: string;
      description: string | null;
      is_mandatory: boolean;
      display_order: number;
    }>(
      `SELECT condition_type, title, description, is_mandatory, display_order
         FROM offer_conditions WHERE offer_id = $1 ORDER BY display_order, title`,
      [offer.id],
    );

    const conditionsSnapshot = conditions.map((c) => ({
      conditionType: c.condition_type,
      title: c.title,
      description: c.description,
      // A string, not a number — the hasher rejects numbers so that one value
      // has exactly one canonical form. See `content-hash.ts`.
      displayOrder: String(c.display_order),
      isMandatory: c.is_mandatory,
    }));

    const hashed = {
      transactionId: offer.transaction_id,
      invoiceId: input.invoiceId,
      bankOrgId: offer.bank_org_id,
      supplierOrgId: input.supplierOrgId,
      sourceOfferId: offer.id,
      sourceOfferVersion: String(offer.version_number),
      transactionType: offer.transaction_type,
      recourseType: offer.recourse_type,
      grossFundingAmount: offer.gross_funding_amount,
      bankDiscountAmount: offer.bank_discount_amount,
      bankFeesAmount: offer.bank_fees_amount,
      platformCommissionAmount: offer.platform_commission_amount,
      listingFeeAmount: offer.listing_fee_amount,
      otherDeductionsAmount: offer.other_deductions_amount,
      netSupplierPayout: offer.net_supplier_payout,
      conditions: conditionsSnapshot,
      capturedAt: input.capturedAt.toISOString(),
    };

    const { rows } = await client.query<SnapshotRow>(
      `INSERT INTO accepted_offer_snapshots
         (selection_id, transaction_id, bank_org_id, supplier_org_id, source_offer_id,
          source_offer_version, transaction_type, recourse_type, gross_funding_amount,
          bank_discount_amount, bank_fees_amount, platform_commission_amount,
          listing_fee_amount, other_deductions_amount, net_supplier_payout,
          conditions_snapshot, snapshot_hash, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
       RETURNING *`,
      [
        input.selectionId,
        offer.transaction_id,
        offer.bank_org_id,
        input.supplierOrgId,
        offer.id,
        offer.version_number,
        offer.transaction_type,
        offer.recourse_type,
        offer.gross_funding_amount,
        offer.bank_discount_amount,
        offer.bank_fees_amount,
        offer.platform_commission_amount,
        offer.listing_fee_amount,
        offer.other_deductions_amount,
        offer.net_supplier_payout,
        JSON.stringify(conditionsSnapshot),
        contentHash(hashed),
        input.capturedAt,
      ],
    );
    return rows[0];
  }

  /**
   * `OFFER_ACCEPTED` → `CONDITIONS_PENDING` when the accepted offer has
   * unresolved mandatory conditions.
   *
   * Derived from the conditions rather than set as a workflow flag, here and
   * in `ConditionsService.refreshConditionState`, so the state can never
   * disagree with the checklist the supplier is looking at.
   */
  private async markConditionsPendingIfAny(
    client: PoolClient,
    offer: { id: string; transaction_id: string },
    ctx: ActorContext,
    now: Date,
  ): Promise<void> {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM offer_conditions
        WHERE offer_id = $1 AND is_mandatory AND fulfilment NOT IN ('FULFILLED','WAIVED')`,
      [offer.id],
    );
    if (Number(rows[0]?.n ?? '0') === 0) return;

    await client.query(
      `UPDATE receivable_transactions SET state = 'CONDITIONS_PENDING', updated_at = now()
        WHERE id = $1`,
      [offer.transaction_id],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
       VALUES ('TRANSACTION',$1,'OFFER_ACCEPTED','CONDITIONS_PENDING',
               'Mandatory offer conditions outstanding',$2,$3)`,
      [offer.transaction_id, ctx.userId, now],
    );
  }

  /**
   * All three outcomes, and none carries competitive information (ZM-MKT-013).
   *
   * The winning bank is told it won. The losing banks are told they were not
   * selected — not by how much, not by whom, not how many others there were.
   * A "you were the second-best offer" message would be a competitive signal
   * dressed as courtesy. And when the supplier rejects the whole round
   * (`selectedOfferId` null), the banks are told the round closed without a
   * selection — NOT that "another offer was selected", which would be a
   * fabricated competitive signal: a bank that believes it lost on price
   * behaves differently from one that knows the round was scrapped.
   */
  private async notifyOutcome(
    client: PoolClient,
    listingId: string,
    selectedOfferId: string | null,
    transactionId: string,
  ): Promise<void> {
    const { rows: offers } = await client.query<{ id: string; bank_org_id: string }>(
      `SELECT id, bank_org_id FROM bank_offers
        WHERE listing_id = $1 AND status IN ('SELECTED','NOT_SELECTED')`,
      [listingId],
    );

    for (const offer of offers) {
      const won = selectedOfferId !== null && offer.id === selectedOfferId;
      const roundClosed = selectedOfferId === null;
      const { rows: recipients } = await client.query<{ user_id: string }>(
        `SELECT DISTINCT m.user_id
           FROM organization_memberships m
           JOIN membership_roles r ON r.membership_id = m.id
          WHERE m.organization_id = $1 AND m.status = 'ACTIVE'
            AND r.role IN ('BANK_ADMIN','BANK_OFFER_MAKER','BANK_OFFER_APPROVER')`,
        [offer.bank_org_id],
      );

      for (const recipient of recipients) {
        // No variables on any of the three templates deliberately: the
        // not-selected message must carry nothing about the winning terms
        // (ZM-MKT-013), and a placeholder is a hole a future template edit
        // could leak through. Fixed prose only, in both languages.
        await this.notifications.send(
          {
            templateKey: won
              ? 'OFFER_SELECTED'
              : roundClosed
                ? 'OFFER_ROUND_CLOSED'
                : 'OFFER_NOT_SELECTED',
            recipientUserId: recipient.user_id,
            transactionId,
            fallbackSubject: won
              ? 'Your offer has been accepted'
              : roundClosed
                ? 'This offer round has closed'
                : 'Your offer was not selected',
            fallbackBody: won
              ? 'The supplier has accepted your offer. The contract will be generated next.'
              : roundClosed
                ? // True and nothing more: no offer won, and saying otherwise
                  // would be a fabricated signal about a competitor.
                  'The supplier closed this offer round without selecting an offer.'
                : // Deliberately terse. Anything about the winning terms, the
                  // number of competitors, or the margin would be exactly the
                  // information the confidential marketplace exists to withhold.
                  'The supplier has selected another offer for this receivable.',
          },
          client,
        );
      }
    }
  }

  // =====================================================================
  // Reject all
  // =====================================================================

  /**
   * The supplier rejects every offer; the transaction returns to `ELIGIBLE`.
   *
   * Symmetrical with a lapsed deadline, and for the same reason: the
   * receivable is untouched and the supplier may relist. Whether a new round
   * costs another listing fee is ZM-MKT-017's question and is not decided
   * here — the existing obligation is left exactly as it stands.
   */
  async rejectAll(listingId: string, ctx: ActorContext): Promise<{ rejected: number }> {
    await this.requireAcceptanceRole(ctx);
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        transaction_id: string;
        supplier_org_id: string;
        locked_at: Date | null;
      }>(
        `SELECT l.id, l.status, l.transaction_id, t.supplier_org_id, t.locked_at
           FROM listings l
           JOIN receivable_transactions t ON t.id = l.transaction_id
          WHERE l.id = $1
          FOR UPDATE OF t`,
        [listingId],
      );
      const listing = rows[0];
      if (!listing) throw AppException.notFound('Listing');
      if (listing.supplier_org_id !== ctx.organizationId) throw AppException.notFound('Listing');

      if (listing.locked_at !== null) {
        throw new AppException(
          ErrorCode.TRANSACTION_ALREADY_LOCKED,
          'An offer has already been accepted for this transaction.',
          HttpStatus.CONFLICT,
        );
      }

      const { rowCount } = await client.query(
        `UPDATE bank_offers SET status = 'NOT_SELECTED'
          WHERE listing_id = $1 AND status = 'ACTIVE'`,
        [listingId],
      );

      await client.query(
        `UPDATE listings SET status = 'CANCELLED', closed_at = $2 WHERE id = $1`,
        [listingId, now],
      );
      await client.query(
        `UPDATE receivable_transactions SET state = 'ELIGIBLE', updated_at = now()
          WHERE id = $1 AND state = 'OPEN_FOR_OFFERS'`,
        [listing.transaction_id],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
         VALUES ('TRANSACTION',$1,'OPEN_FOR_OFFERS','ELIGIBLE','Supplier rejected all offers',$2,$3)`,
        [listing.transaction_id, ctx.userId, now],
      );

      await this.notifyOutcome(client, listingId, null, listing.transaction_id);

      await this.audit.recordIn(client, {
        actionType: 'OFFERS_REJECTED',
        targetEntityType: 'LISTING',
        targetEntityId: listingId,
        previousValue: { status: listing.status },
        newValue: { status: 'CANCELLED', rejectedOffers: rowCount ?? 0 },
      });

      return { rejected: rowCount ?? 0 };
    });
  }

  // =====================================================================
  // Reads
  // =====================================================================

  async snapshotForTransaction(transactionId: string): Promise<SnapshotRow | null> {
    return this.db.queryOne<SnapshotRow>(
      `SELECT * FROM accepted_offer_snapshots WHERE transaction_id = $1`,
      [transactionId],
    );
  }

  /**
   * An existing selection for this exact offer, made by this supplier.
   *
   * Scoped by supplier org so that a replay can never be answered across
   * organizations — the check is a read of someone's accepted terms.
   */
  private async existingSelectionFor(
    offerId: string,
    supplierOrgId: string,
    client?: PoolClient,
  ): Promise<SnapshotRow | null> {
    const sql = `SELECT s.* FROM accepted_offer_snapshots s
                   WHERE s.source_offer_id = $1 AND s.supplier_org_id = $2`;
    if (client) {
      const { rows } = await client.query<SnapshotRow>(sql, [offerId, supplierOrgId]);
      return rows[0] ?? null;
    }
    return this.db.queryOne<SnapshotRow>(sql, [offerId, supplierOrgId]);
  }

  /**
   * AS-01: acceptance is a Supplier Owner/Admin act by default, configurable.
   *
   * Read from `platform_settings` rather than hard-coded, because AS-01 says
   * "configurable to allow Invoice Uploader" and an assumption whose
   * configurability exists only in prose is not configurable.
   */
  private async requireAcceptanceRole(ctx: ActorContext): Promise<void> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'offer_acceptance_roles'`,
    );
    const configured = Array.isArray(row?.value)
      ? (row.value as unknown[]).map(String).filter((r) => r.length > 0)
      : [];
    const permitted = configured.length > 0 ? configured : DEFAULT_ACCEPTANCE_ROLES;

    if (!ctx.roles.some((role) => permitted.includes(role))) {
      throw AppException.insufficientRole(permitted);
    }
  }
}
