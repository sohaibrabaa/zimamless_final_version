import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import type { ActorContext } from '../onboarding/onboarding.service';
import { TransactionsService } from '../transactions/transactions.service';
import { CommissionService } from './commission.service';
import { ListingsService, type ListingRow } from './listings.service';
import { meetsFloor, validateOffer, type OfferRejection } from './offer-math';
import {
  acceptsOfferActivity,
  isVisibleToSupplier,
  isWithdrawable,
  type OfferStatus,
} from './offer-state';

/**
 * Bank offers: creation, revision, internal approval, withdrawal — and the
 * confidentiality rules that make the marketplace worth having.
 *
 * Three invariants converge in this file:
 *
 *   **INV-8** — `minimumAcceptableAmount` never reaches a bank. The floor is
 *   read here to decide whether an offer clears it, and the decision is a
 *   bare boolean (`meetsFloor`) so there is no shortfall value in scope to
 *   leak. The refusal carries no numeric detail at all.
 *
 *   **INV-11** — bank A can never read bank B's offer, and must not be able
 *   to infer that bank B exists. That means no competitor data, and no
 *   *count* either: `offerCount` is supplier-only, and the bank-facing
 *   queries filter by `bank_org_id` in SQL rather than fetching and then
 *   discarding, so a serializer bug cannot expose rows the query never read.
 *
 *   **INV-12** — an offer cannot be approved by the user who created it. The
 *   service refuses first with a precise error; the database CHECK
 *   (`chk_maker_approver_differ`) is the backstop that catches any path that
 *   forgets to ask.
 *
 * Every response body in this file is built from an explicit allow-list. The
 * entities are never spread, because a spread is how a column added in Phase
 * 7 ends up in a bank's payload in Phase 8 with nobody noticing.
 */

export interface OfferRow {
  id: string;
  listing_id: string;
  bank_org_id: string;
  status: OfferStatus;
  version_number: number;
  previous_offer_id: string | null;
  transaction_type: string;
  recourse_type: string;
  gross_funding_amount: string;
  bank_discount_amount: string;
  bank_fees_amount: string;
  platform_commission_amount: string;
  listing_fee_amount: string;
  other_deductions_amount: string;
  net_supplier_payout: string;
  expected_payout_date: string | null;
  valid_until: Date;
  created_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  submitted_at: Date | null;
  withdrawn_at: Date | null;
  created_at: Date;
}

export interface OfferConditionInput {
  conditionType: string;
  title: string;
  description?: string;
  isMandatory?: boolean;
}

export interface OfferInput {
  transactionType: string;
  recourseType: string;
  grossFundingAmount: string;
  bankDiscountAmount?: string;
  bankFeesAmount?: string;
  otherDeductionsAmount?: string;
  expectedPayoutDate?: string;
  validUntil: string;
  conditions?: OfferConditionInput[];
  /** Optional client-computed net. Checked, never trusted. */
  netSupplierPayout?: string;
}

export type OfferAudience = 'SUPPLIER' | 'OWNING_BANK' | 'PLATFORM';

/** Maps a math rejection to a client-facing error. */
const REJECTION_MESSAGES: Record<OfferRejection, string> = {
  GROSS_NOT_POSITIVE: 'The gross funding amount must be greater than zero.',
  GROSS_EXCEEDS_OUTSTANDING:
    'The gross funding amount cannot exceed the invoice outstanding amount.',
  NET_NOT_POSITIVE: 'The deductions leave no net payout for the supplier.',
  DEDUCTIONS_NEGATIVE: 'Deductions cannot be negative.',
  NET_MISMATCH:
    'The submitted net payout does not match the server calculation. ' +
    'Resubmit using the server-computed figure.',
};

@Injectable()
export class OffersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly listings: ListingsService,
    private readonly transactions: TransactionsService,
    private readonly commission: CommissionService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // Reads and authorization
  // =====================================================================

  async findById(id: string): Promise<OfferRow | null> {
    return this.db.queryOne<OfferRow>(`SELECT * FROM bank_offers WHERE id = $1`, [id]);
  }

  /**
   * Resolves an offer and the caller's relationship to it.
   *
   * 404 rather than 403 for a stranger, as everywhere else — a 403 would
   * confirm the offer exists, and to a competing bank that is itself the
   * leak INV-11 forbids.
   */
  async requireVisible(
    id: string,
    ctx: ActorContext,
  ): Promise<{ offer: OfferRow; audience: OfferAudience }> {
    const offer = await this.findById(id);
    if (!offer) throw AppException.notFound('Offer');

    if (ctx.organizationType === 'PLATFORM') return { offer, audience: 'PLATFORM' };
    if (offer.bank_org_id === ctx.organizationId) return { offer, audience: 'OWNING_BANK' };

    if (ctx.organizationType === 'SUPPLIER') {
      const owns = await this.db.queryOne(
        `SELECT 1 FROM listings l
           JOIN receivable_transactions t ON t.id = l.transaction_id
          WHERE l.id = $1 AND t.supplier_org_id = $2`,
        [offer.listing_id, ctx.organizationId],
      );
      // A supplier sees ACTIVE offers on their own listing — a draft another
      // bank has not yet published is not theirs to see.
      if (owns && isVisibleToSupplier(offer.status)) {
        return { offer, audience: 'SUPPLIER' };
      }
    }
    throw AppException.notFound('Offer');
  }

  /**
   * Offers on a listing, scoped by role (ZM-MKT-011, INV-11).
   *
   * The scoping is in the WHERE clause, not in a filter after the fact. A
   * bank's query cannot return another bank's row even if the serializer
   * below were wrong tomorrow, which is the difference between a rule and a
   * defence.
   */
  async listForListing(listingId: string, ctx: ActorContext): Promise<OfferRow[]> {
    const listing = await this.listings.findById(listingId);
    if (!listing) throw AppException.notFound('Listing');

    if (ctx.organizationType === 'BANK') {
      const { rows } = await this.db.query<OfferRow>(
        `SELECT * FROM bank_offers
          WHERE listing_id = $1 AND bank_org_id = $2
          ORDER BY version_number DESC`,
        [listingId, ctx.organizationId],
      );
      return rows;
    }

    const transaction = await this.transactions.findById(listing.transaction_id);
    const isOwner = transaction?.supplier_org_id === ctx.organizationId;
    if (!isOwner && ctx.organizationType !== 'PLATFORM') {
      throw AppException.notFound('Listing');
    }

    const { rows } = await this.db.query<OfferRow>(
      `SELECT * FROM bank_offers
        WHERE listing_id = $1 AND status IN ('ACTIVE','SELECTED')
        ORDER BY created_at`,
      [listingId],
    );
    return rows;
  }

  /** The active bank org's own offers (D-08 approval queue / my offers). */
  async listForBank(
    ctx: ActorContext,
    filters: { status?: string; page: number; pageSize: number },
  ): Promise<{ items: OfferRow[]; total: number }> {
    const conditions = ['bank_org_id = $1'];
    const params: unknown[] = [ctx.organizationId];
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.join(' AND ');

    const countRow = await this.db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_offers WHERE ${where}`,
      params,
    );
    const offset = (filters.page - 1) * filters.pageSize;
    const { rows } = await this.db.query<OfferRow>(
      `SELECT * FROM bank_offers WHERE ${where}
        ORDER BY created_at DESC LIMIT ${filters.pageSize} OFFSET ${offset}`,
      params,
    );
    return { items: rows, total: Number(countRow?.n ?? 0) };
  }

  /** Supplier-only. Never returned in any bank-facing shape (ZM-MKT-011). */
  async activeOfferCount(listingId: string): Promise<number> {
    const row = await this.db.queryOne<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_offers
        WHERE listing_id = $1 AND status IN ('ACTIVE','SELECTED')`,
      [listingId],
    );
    return Number(row?.n ?? 0);
  }

  // =====================================================================
  // Creation and revision
  // =====================================================================

  async create(listingId: string, ctx: ActorContext, input: OfferInput): Promise<OfferRow> {
    const listing = await this.requireOpenListing(listingId);
    await this.requireEligible(listing, ctx);

    const existing = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM bank_offers
        WHERE listing_id = $1 AND bank_org_id = $2
          AND status IN ('DRAFT','PENDING_INTERNAL_APPROVAL','ACTIVE')`,
      [listingId, ctx.organizationId],
    );
    if (existing) {
      throw AppException.conflict(
        ErrorCode.CONFLICT,
        'This bank already has a current offer on this listing. Revise it instead.',
        { offerId: existing.id },
      );
    }

    return this.writeOffer(listing, ctx, input, null);
  }

  /**
   * Revision creates a NEW version and supersedes the old one (ZM-OFR-012).
   *
   * The lineage is kept via `previous_offer_id`, and the superseded row moves
   * to REVISED rather than being updated in place — a supplier who was
   * looking at version 1 must be able to see that it existed and what it
   * said, or "the bank changed its offer" becomes unauditable.
   */
  async revise(offerId: string, ctx: ActorContext, input: OfferInput): Promise<OfferRow> {
    const current = await this.findById(offerId);
    if (!current) throw AppException.notFound('Offer');
    if (current.bank_org_id !== ctx.organizationId) throw AppException.notFound('Offer');

    const listing = await this.requireOpenListing(current.listing_id);

    if (!['DRAFT', 'PENDING_INTERNAL_APPROVAL', 'ACTIVE'].includes(current.status)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        `An offer in status ${current.status} can no longer be revised.`,
        HttpStatus.CONFLICT,
      );
    }

    return this.writeOffer(listing, ctx, input, current);
  }

  /**
   * The shared write path for create and revise.
   *
   * Ordering matters and is deliberate:
   *   1. compute the platform's numbers (commission, listing fee) — the bank
   *      does not supply them and they are not read from the body
   *   2. validate the arithmetic
   *   3. check the floor, LAST and separately, so its refusal carries nothing
   */
  private async writeOffer(
    listing: ListingRow,
    ctx: ActorContext,
    input: OfferInput,
    superseding: OfferRow | null,
  ): Promise<OfferRow> {
    const invoice = await this.transactions.invoiceOf(listing.transaction_id);
    if (!invoice) throw AppException.validation('The listed transaction has no invoice.');

    const gross = Money.from(input.grossFundingAmount);
    const quote = await this.commission.quote(gross);
    const listingFee = await this.unpaidListingFee(listing.id);

    const components = {
      grossFundingAmount: gross,
      bankDiscountAmount: Money.from(input.bankDiscountAmount ?? '0.000'),
      bankFeesAmount: Money.from(input.bankFeesAmount ?? '0.000'),
      // Server-injected. Never read from the request body.
      platformCommissionAmount: quote.amount,
      listingFeeAmount: listingFee,
      otherDeductionsAmount: Money.from(input.otherDeductionsAmount ?? '0.000'),
    };

    const validation = validateOffer(
      components,
      Money.from(invoice.outstanding_amount),
      input.netSupplierPayout ? Money.from(input.netSupplierPayout) : undefined,
    );
    if (!validation.ok) {
      throw AppException.validation(REJECTION_MESSAGES[validation.rejection!], {
        rejection: validation.rejection,
      });
    }

    // --- the floor (INV-8) -------------------------------------------
    // Read late, used once, and discarded. The only thing that escapes this
    // block is a boolean.
    const transaction = await this.transactions.findById(listing.transaction_id);
    const floor = transaction?.minimum_acceptable_amount
      ? Money.from(transaction.minimum_acceptable_amount)
      : null;

    if (!meetsFloor(validation.net, floor)) {
      throw new AppException(
        ErrorCode.OFFER_BELOW_SUPPLIER_REQUIREMENT,
        // Generic by design (ZM-MKT-012). No amount, no gap, no percentage,
        // no "try at least X". A bank learning the floor could bid exactly
        // it every time, which is the auction this product refuses to be.
        'This offer does not meet the supplier’s requirements for this transaction.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        // `details` is deliberately absent. Not an empty object that a later
        // edit might fill — absent.
      );
    }

    const now = this.time.now();
    const created = await this.db.transaction(async (client) => {
      if (superseding) {
        // Free the partial unique index slot before inserting the successor.
        await client.query(
          `UPDATE bank_offers SET status = 'REVISED' WHERE id = $1`,
          [superseding.id],
        );
      }

      const { rows } = await client.query<OfferRow>(
        `INSERT INTO bank_offers
           (listing_id, bank_org_id, status, version_number, previous_offer_id,
            transaction_type, recourse_type, gross_funding_amount,
            bank_discount_amount, bank_fees_amount, platform_commission_amount,
            listing_fee_amount, other_deductions_amount, net_supplier_payout,
            expected_payout_date, valid_until, created_by, created_at)
         VALUES ($1,$2,'PENDING_INTERNAL_APPROVAL',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          listing.id,
          ctx.organizationId,
          superseding ? superseding.version_number + 1 : 1,
          superseding?.id ?? null,
          input.transactionType,
          input.recourseType,
          components.grossFundingAmount.toDb(),
          components.bankDiscountAmount.toDb(),
          components.bankFeesAmount.toDb(),
          components.platformCommissionAmount.toDb(),
          components.listingFeeAmount.toDb(),
          components.otherDeductionsAmount.toDb(),
          validation.net.toDb(),
          input.expectedPayoutDate ?? null,
          // Passed through as the ISO string the client sent. Postgres parses
          // it into timestamptz; constructing a JS Date here would add a
          // banned clock touch for no gain.
          input.validUntil,
          ctx.userId,
          now,
        ],
      );
      const offer = rows[0];

      for (const [index, condition] of (input.conditions ?? []).entries()) {
        await client.query(
          `INSERT INTO offer_conditions
             (offer_id, condition_type, title, description, is_mandatory, display_order)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            offer.id,
            condition.conditionType,
            condition.title,
            condition.description ?? null,
            condition.isMandatory !== false,
            index,
          ],
        );
      }
      return offer;
    });

    await this.audit.record({
      actionType: superseding ? 'OFFER_REVISED' : 'OFFER_CREATED',
      targetEntityType: 'BANK_OFFER',
      targetEntityId: created.id,
      previousValue: superseding
        ? { offerId: superseding.id, version: superseding.version_number }
        : null,
      // The audit trail carries the bank's own numbers, which is correct —
      // audit is platform-facing. It does NOT carry the supplier's floor.
      newValue: {
        listingId: listing.id,
        version: created.version_number,
        grossFundingAmount: created.gross_funding_amount,
        netSupplierPayout: created.net_supplier_payout,
      },
    });

    return created;
  }

  /**
   * The unpaid portion of the listing fee, deducted from the offer.
   *
   * Already-settled fees are not deducted twice. A waived fee contributes
   * zero rather than being skipped, so the offer breakdown still shows the
   * line and the supplier can see it was nil rather than wonder.
   */
  private async unpaidListingFee(listingId: string): Promise<Money> {
    const row = await this.db.queryOne<{ amount: string; status: string }>(
      `SELECT amount, status FROM listing_fee_obligations WHERE listing_id = $1`,
      [listingId],
    );
    if (!row) return Money.zero();
    if (row.status === 'PAID' || row.status === 'WAIVED' || row.status === 'WRITTEN_OFF') {
      return Money.zero();
    }
    return Money.from(row.amount);
  }

  private async requireOpenListing(listingId: string): Promise<ListingRow> {
    const listing = await this.listings.findById(listingId);
    if (!listing) throw AppException.notFound('Listing');

    if (!acceptsOfferActivity(listing.status)) {
      // ZM-MKT-009: nothing moves after the submission deadline.
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'The offer submission window for this listing has closed.',
        HttpStatus.CONFLICT,
        { listingStatus: listing.status },
      );
    }
    return listing;
  }

  private async requireEligible(listing: ListingRow, ctx: ActorContext): Promise<void> {
    const row = await this.db.queryOne<{ status: string }>(
      `SELECT status FROM bank_eligibility WHERE listing_id = $1 AND bank_org_id = $2`,
      [listing.id, ctx.organizationId],
    );
    if (!row || row.status !== 'ELIGIBLE') {
      // 404, not 403: a bank that is not eligible was never shown this
      // listing, and confirming it exists would leak the marketplace's
      // contents past the policy filter.
      throw AppException.notFound('Listing');
    }
  }

  // =====================================================================
  // Approval (INV-12) and withdrawal
  // =====================================================================

  async approve(offerId: string, ctx: ActorContext): Promise<OfferRow> {
    const offer = await this.findById(offerId);
    if (!offer) throw AppException.notFound('Offer');
    if (offer.bank_org_id !== ctx.organizationId) throw AppException.notFound('Offer');

    if (offer.status !== 'PENDING_INTERNAL_APPROVAL') {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        `An offer in status ${offer.status} is not awaiting internal approval.`,
        HttpStatus.CONFLICT,
      );
    }

    // INV-12 / ZM-ROL-002. Checked here so the caller gets a precise 403
    // rather than a constraint violation; `chk_maker_approver_differ` in the
    // schema is the backstop for any path that forgets to ask.
    if (offer.created_by === ctx.userId) {
      throw new AppException(
        ErrorCode.SELF_APPROVAL_FORBIDDEN,
        'An offer must be approved by a different user from the one who created it.',
        HttpStatus.FORBIDDEN,
      );
    }

    // The window must still be open at approval, not merely at creation:
    // publishing an offer after the deadline would put it in front of the
    // supplier when ZM-MKT-009 says the round is closed.
    await this.requireOpenListing(offer.listing_id);

    const now = this.time.now();
    const { rows } = await this.db.query<OfferRow>(
      `UPDATE bank_offers
          SET status = 'ACTIVE', approved_by = $2, approved_at = $3, submitted_at = $3
        WHERE id = $1
        RETURNING *`,
      [offerId, ctx.userId, now],
    );

    await this.audit.record({
      actionType: 'OFFER_APPROVED',
      targetEntityType: 'BANK_OFFER',
      targetEntityId: offerId,
      previousValue: { status: 'PENDING_INTERNAL_APPROVAL' },
      newValue: { status: 'ACTIVE', approvedBy: ctx.userId },
    });

    return rows[0];
  }

  async withdraw(offerId: string, ctx: ActorContext, reason?: string): Promise<OfferRow> {
    const offer = await this.findById(offerId);
    if (!offer) throw AppException.notFound('Offer');
    if (offer.bank_org_id !== ctx.organizationId) throw AppException.notFound('Offer');

    if (offer.status === 'SELECTED') {
      // ZM-OFR-015: withdrawal before acceptance is free and unilateral.
      // After acceptance it is a withdrawal *case* with a penalty policy,
      // which is Phase 8's, so this refuses rather than silently unwinding.
      throw AppException.conflict(
        ErrorCode.CONFLICT,
        'This offer has been accepted. Withdrawal after acceptance is handled as a withdrawal case.',
      );
    }
    if (!isWithdrawable(offer.status)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        `An offer in status ${offer.status} cannot be withdrawn.`,
        HttpStatus.CONFLICT,
      );
    }

    const now = this.time.now();
    const { rows } = await this.db.query<OfferRow>(
      `UPDATE bank_offers SET status = 'WITHDRAWN', withdrawn_at = $2 WHERE id = $1 RETURNING *`,
      [offerId, now],
    );

    await this.audit.record({
      actionType: 'OFFER_WITHDRAWN',
      targetEntityType: 'BANK_OFFER',
      targetEntityId: offerId,
      previousValue: { status: offer.status },
      newValue: { status: 'WITHDRAWN', reason: reason ?? null },
    });

    return rows[0];
  }

  // =====================================================================
  // Presentation — allow-lists only
  // =====================================================================

  async describe(offer: OfferRow, audience: OfferAudience): Promise<Record<string, unknown>> {
    const bank = await this.db.queryOne<{ legal_name: string }>(
      `SELECT legal_name FROM organizations WHERE id = $1`,
      [offer.bank_org_id],
    );
    const { rows: conditions } = await this.db.query<{
      id: string;
      condition_type: string;
      title: string;
      description: string | null;
      is_mandatory: boolean;
      fulfilment: string;
    }>(
      `SELECT id, condition_type, title, description, is_mandatory, fulfilment
         FROM offer_conditions WHERE offer_id = $1 ORDER BY display_order`,
      [offer.id],
    );

    // Every field enumerated. Note the absence of bank_org_id: the supplier
    // gets the bank's NAME, which is what the comparison screen shows, and
    // nothing that identifies the organization as a queryable id.
    return {
      id: offer.id,
      listingId: offer.listing_id,
      bankName: bank?.legal_name ?? null,
      status: offer.status,
      versionNumber: offer.version_number,
      transactionType: offer.transaction_type,
      recourseType: offer.recourse_type,
      grossFundingAmount: offer.gross_funding_amount,
      bankDiscountAmount: offer.bank_discount_amount,
      bankFeesAmount: offer.bank_fees_amount,
      platformCommissionAmount: offer.platform_commission_amount,
      listingFeeAmount: offer.listing_fee_amount,
      otherDeductionsAmount: offer.other_deductions_amount,
      netSupplierPayout: offer.net_supplier_payout,
      expectedPayoutDate: offer.expected_payout_date,
      validUntil: offer.valid_until.toISOString(),
      submittedAt: offer.submitted_at?.toISOString() ?? null,
      conditions: conditions.map((c) => ({
        id: c.id,
        conditionType: c.condition_type,
        title: c.title,
        description: c.description,
        isMandatory: c.is_mandatory,
        fulfilment: c.fulfilment,
      })),
      // Internal workflow fields belong to the bank that owns the offer and
      // to platform staff. A supplier has no business knowing which employee
      // of the bank approved it.
      ...(audience === 'OWNING_BANK' || audience === 'PLATFORM'
        ? {
            createdBy: offer.created_by,
            approvedBy: offer.approved_by,
            approvedAt: offer.approved_at?.toISOString() ?? null,
            previousOfferId: offer.previous_offer_id,
          }
        : {}),
    };
  }

  /**
   * `BankListingView` — the bank's view of a listing (D-07, ZM-MKT-011).
   *
   * The exclusions are the contract's own words: no `minimumAcceptableAmount`,
   * no `offerCount`, no competitor data. Built field by field from separate
   * queries rather than by trimming a supplier payload, because trimming is
   * subtractive and this needs to be additive — anything not written here
   * cannot appear, whereas anything not deleted there would.
   */
  async describeForBank(
    listing: ListingRow,
    ctx: ActorContext,
  ): Promise<Record<string, unknown>> {
    const transaction = await this.transactions.findById(listing.transaction_id);
    if (!transaction) throw AppException.notFound('Listing');

    const supplier = await this.db.queryOne<{
      legal_name: string;
      national_establishment_no: string | null;
      status: string;
    }>(
      `SELECT legal_name, national_establishment_no, status
         FROM organizations WHERE id = $1`,
      [transaction.supplier_org_id],
    );

    const invoice = await this.transactions.invoiceOf(listing.transaction_id);
    const risk = await this.db.queryOne<Record<string, unknown>>(
      `SELECT composite_score, band, supplier_verification_score, data_confidence_score,
              buyer_profile_score, invoice_score, platform_behavior_score,
              data_availability_pct, positive_factors, risk_factors, reason_codes,
              ml_used, ml_fallback_reason, calculated_at
         FROM risk_assessments WHERE transaction_id = $1
        ORDER BY calculated_at DESC LIMIT 1`,
      [listing.transaction_id],
    );

    const { rows: documents } = await this.db.query<{ id: string; document_type: string }>(
      `SELECT id, document_type FROM documents
        WHERE subject_type = 'TRANSACTION' AND subject_id = $1`,
      [listing.transaction_id],
    );

    const own = await this.db.queryOne<OfferRow>(
      `SELECT * FROM bank_offers
        WHERE listing_id = $1 AND bank_org_id = $2
          AND status IN ('DRAFT','PENDING_INTERNAL_APPROVAL','ACTIVE','SELECTED')
        ORDER BY version_number DESC LIMIT 1`,
      [listing.id, ctx.organizationId],
    );

    const buyer = transaction.buyer_id
      ? await this.db.queryOne<Record<string, unknown>>(
          `SELECT id, national_establishment_no, legal_company_name, registry_status,
                  registration_date::text AS registration_date
             FROM buyers WHERE id = $1`,
          [transaction.buyer_id],
        )
      : null;

    return {
      listingId: listing.id,
      transactionId: listing.transaction_id,
      offerSubmissionDeadline: listing.offer_submission_deadline.toISOString(),
      supplier: {
        legalName: supplier?.legal_name ?? null,
        nationalEstablishmentNumber: supplier?.national_establishment_no ?? null,
        registryStatus: supplier?.status ?? null,
      },
      buyer: buyer
        ? {
            id: buyer.id,
            nationalEstablishmentNumber: buyer.national_establishment_no,
            legalCompanyName: buyer.legal_company_name,
            registryStatus: buyer.registry_status,
            registrationDate: buyer.registration_date,
          }
        : null,
      invoice: invoice
        ? {
            invoiceNumber: invoice.invoice_number,
            einvoiceIdentifier: invoice.einvoice_identifier,
            issueDate: invoice.issue_date,
            dueDate: invoice.due_date,
            currency: invoice.currency,
            faceValue: invoice.face_value,
            paidAmount: invoice.paid_amount,
            outstandingAmount: invoice.outstanding_amount,
            paymentTerms: invoice.payment_terms,
          }
        : null,
      risk: risk
        ? {
            compositeScore: risk.composite_score,
            band: risk.band,
            components: {
              supplierVerification: risk.supplier_verification_score,
              dataConfidence: risk.data_confidence_score,
              buyerProfile: risk.buyer_profile_score,
              invoiceScore: risk.invoice_score,
              platformBehavior: risk.platform_behavior_score,
            },
            dataAvailabilityPct:
              risk.data_availability_pct === null ? null : Number(risk.data_availability_pct),
            positiveFactors: risk.positive_factors ?? [],
            riskFactors: risk.risk_factors ?? [],
            reasonCodes: risk.reason_codes ?? [],
            mlUsed: risk.ml_used,
            ...(risk.ml_used === false
              ? { mlFallbackReason: risk.ml_fallback_reason ?? 'The risk model service was unavailable.' }
              : {}),
            calculatedAt: (risk.calculated_at as Date).toISOString(),
          }
        : null,
      documents: documents.map((d) => ({ id: d.id, documentType: d.document_type })),
      myOffer: own ? await this.describe(own, 'OWNING_BANK') : null,
      // Deliberately absent, and listed here so a future edit has to delete a
      // comment to add them: minimumAcceptableAmount, offerCount, any other
      // bank's offer, any aggregate over other banks' offers.
    };
  }
}
