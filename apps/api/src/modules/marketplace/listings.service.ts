import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { plusSeconds } from '../../common/time/business-time';
import { AuditService } from '../../common/audit/audit.service';
import type { ActorContext } from '../onboarding/onboarding.service';
import { TransactionsService } from '../transactions/transactions.service';
import { evaluateBank, type ListingFacts, type PolicyFilter, type RiskBand } from './eligibility';
import { canTransitionListing, type ListingStatus } from './offer-state';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Listing activation and lifecycle (ZM-MKT-001..009, ZM-FEE-001..005).
 *
 * The hard part of this service is not the listing row — it is everything
 * that must happen with it, atomically:
 *
 *   listing + fee obligation + balanced ledger journal + eligibility for
 *   every active bank + notifications + the transaction's state change
 *
 * All of it is one database transaction. A listing that exists without its
 * fee obligation would be free financing; a fee obligation without its ledger
 * entries would be revenue that never reaches the books; eligibility rows
 * written after the commit would leave a window in which the listing is open
 * and no bank can see it. ZM-FEE-002 is explicit that the fee is incurred at
 * activation *regardless of whether financing later succeeds*, which only
 * means anything if the two are inseparable.
 */

export interface ListingRow {
  id: string;
  transaction_id: string;
  round_number: number;
  status: ListingStatus;
  activated_at: Date;
  offer_submission_deadline: Date;
  supplier_selection_deadline: Date;
  closed_at: Date | null;
  activated_by: string;
}

@Injectable()
export class ListingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly transactions: TransactionsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // Reads
  // =====================================================================

  async findById(id: string): Promise<ListingRow | null> {
    return this.db.queryOne<ListingRow>(`SELECT * FROM listings WHERE id = $1`, [id]);
  }

  /** The current round's listing for a transaction (D-06). */
  async currentForTransaction(transactionId: string): Promise<ListingRow | null> {
    return this.db.queryOne<ListingRow>(
      `SELECT * FROM listings
        WHERE transaction_id = $1
        ORDER BY round_number DESC
        LIMIT 1`,
      [transactionId],
    );
  }

  /**
   * The listing fee, from settings rather than a constant (AS-06).
   *
   * Read at activation and then *frozen into the obligation row*. A supplier
   * who was shown 25 JOD before confirming must be charged 25 JOD even if an
   * administrator changes the setting a minute later.
   */
  async currentListingFee(): Promise<Money> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'listing_fee_amount'`,
    );
    const raw = typeof row?.value === 'string' ? row.value.replace(/^"|"$/g, '') : '25.000';
    // A negative fee would flow into funding math as a payout bonus; the
    // settings PATCH refuses one, and this fallback holds if anything else
    // ever writes the row.
    const fee = Money.isValidMoneyString(raw) ? Money.from(raw) : null;
    return fee && !fee.isNegative() ? fee : Money.from('25.000');
  }

  private async windowHours(key: string, fallback: number): Promise<number> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = $1`,
      [key],
    );
    const parsed = Number(row?.value ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  // =====================================================================
  // Activation
  // =====================================================================

  async activate(transactionId: string, ctx: ActorContext): Promise<ListingRow> {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) throw AppException.notFound('Transaction');
    if (transaction.supplier_org_id !== ctx.organizationId) {
      throw AppException.notFound('Transaction');
    }

    if (transaction.state !== 'ELIGIBLE') {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Only an eligible transaction can be listed.',
        HttpStatus.CONFLICT,
        { state: transaction.state },
      );
    }

    const invoice = await this.transactions.invoiceOf(transactionId);
    if (!invoice) {
      throw AppException.validation('The transaction has no invoice to list.');
    }

    const now = this.time.now();
    const offerHours = await this.windowHours('offer_submission_window_hours', 24);
    const selectionHours = await this.windowHours('supplier_selection_window_hours', 12);
    // plusSeconds rather than `new Date(now + ms)`: the constructor is banned
    // in domain code because it is how the wall clock slips past the
    // TimeProvider, and deriving from `now` through the shared helper keeps
    // both deadlines on the demo-shifted clock.
    const offerDeadline = plusSeconds(now, offerHours * 3600);
    const selectionDeadline = plusSeconds(offerDeadline, selectionHours * 3600);
    const fee = await this.currentListingFee();

    // Facts for eligibility, gathered before the transaction so the write
    // path stays short — a long-held transaction on the hosted pooler is a
    // good way to turn a slow registry read into a lock timeout.
    const facts = await this.listingFacts(transactionId, transaction.supplier_org_id, invoice);
    const banks = await this.activeBanksWithFilters();

    const listing = await this.db.transaction(async (client) => {
      const round = await this.nextRoundNumber(client, transactionId);

      const { rows } = await client.query<ListingRow>(
        `INSERT INTO listings
           (transaction_id, round_number, status, activated_at,
            offer_submission_deadline, supplier_selection_deadline, activated_by)
         VALUES ($1,$2,'OPEN_FOR_OFFERS',$3,$4,$5,$6)
         RETURNING *`,
        [transactionId, round, now, offerDeadline, selectionDeadline, ctx.userId],
      );
      const created = rows[0];

      await this.createFeeObligation(client, created, transaction.supplier_org_id, fee);
      await this.writeEligibility(client, created.id, banks, facts, now);
      await this.notifyEligibleBanks(client, created, banks, facts);

      await client.query(
        `UPDATE receivable_transactions SET state = 'OPEN_FOR_OFFERS', updated_at = now()
          WHERE id = $1`,
        [transactionId],
      );
      await client.query(
        `INSERT INTO status_history
           (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
         VALUES ('TRANSACTION',$1,'ELIGIBLE','OPEN_FOR_OFFERS','Listing activated',$2,$3)`,
        [transactionId, ctx.userId, now],
      );

      return created;
    });

    await this.audit.record({
      actionType: 'LISTING_ACTIVATED',
      targetEntityType: 'LISTING',
      targetEntityId: listing.id,
      previousValue: { state: 'ELIGIBLE' },
      newValue: {
        transactionId,
        roundNumber: listing.round_number,
        listingFeeAmount: fee.toString(),
        offerSubmissionDeadline: listing.offer_submission_deadline.toISOString(),
      },
    });

    return listing;
  }

  private async nextRoundNumber(client: PoolClient, transactionId: string): Promise<number> {
    const { rows } = await client.query<{ next: string }>(
      `SELECT COALESCE(MAX(round_number), 0) + 1 AS next FROM listings WHERE transaction_id = $1`,
      [transactionId],
    );
    return Number(rows[0].next);
  }

  /**
   * The fee obligation and its ledger journal (ZM-FEE-001..005, 016..019).
   *
   * Double-entry: the platform has earned revenue and the supplier owes it.
   * The two entries share a `journal_id` and must sum to zero across the
   * debit/credit pair — `ledger_entries` is append-only (INV-7), so a
   * mistake here cannot be edited away later, only reversed.
   *
   * The fee is `PAYABLE` immediately, not on funding. That is the whole point
   * of ZM-FEE-002: the supplier owes it for the service of being listed,
   * whether or not a bank ever offers.
   */
  private async createFeeObligation(
    client: PoolClient,
    listing: ListingRow,
    supplierOrgId: string,
    fee: Money,
  ): Promise<void> {
    if (!fee.isPositive()) {
      // A zero fee is a legitimate configuration (a promotional period), and
      // writing a zero-amount ledger entry would violate the amount > 0 CHECK.
      // The obligation is still recorded so the listing's fee history is not
      // a gap that has to be interpreted.
      await client.query(
        `INSERT INTO listing_fee_obligations (listing_id, supplier_org_id, amount, status)
         VALUES ($1,$2,0,'WAIVED')`,
        [listing.id, supplierOrgId],
      );
      return;
    }

    await client.query(
      `INSERT INTO listing_fee_obligations (listing_id, supplier_org_id, amount, status)
       VALUES ($1,$2,$3,'PAYABLE')`,
      [listing.id, supplierOrgId, fee.toDb()],
    );

    const journalId = randomUUID();
    const description = `Listing fee, round ${listing.round_number}`;

    // Debit the supplier's receivable (they owe us), credit platform revenue.
    await client.query(
      `INSERT INTO ledger_entries
         (journal_id, entry_type, account_kind, organization_id, amount,
          transaction_id, description)
       VALUES
         ($1,'DEBIT','SUPPLIER_RECEIVABLE',$2,$3,$4,$5),
         ($1,'CREDIT','PLATFORM_LISTING_FEE_REVENUE',NULL,$3,$4,$5)`,
      [journalId, supplierOrgId, fee.toDb(), listing.transaction_id, description],
    );
  }

  // =====================================================================
  // Eligibility (ZM-MKT-003)
  // =====================================================================

  private async listingFacts(
    transactionId: string,
    supplierOrgId: string,
    invoice: { due_date: string; outstanding_amount: string },
  ): Promise<ListingFacts> {
    const now = this.time.now();
    const tenorDays = Math.floor(
      (Date.parse(`${invoice.due_date}T00:00:00Z`) -
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
        86_400_000,
    );

    const risk = await this.db.queryOne<{ composite_score: number; band: RiskBand }>(
      `SELECT composite_score, band FROM risk_assessments
        WHERE transaction_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
      [transactionId],
    );

    // Sector and governorate are NOT columns on `organizations` — they are
    // government-sourced facts, so they live in `entity_field_values` with
    // their provenance, written by the CCD adapter during Phase 2
    // verification. Reading them from the provenance table rather than
    // denormalising onto the org row is what keeps "the registry said this,
    // on this date" true for the fields a bank's policy filter acts on.
    const { rows: supplierFields } = await this.db.query<{
      field_key: string;
      field_value: string | null;
    }>(
      `SELECT DISTINCT ON (field_key) field_key, field_value
         FROM entity_field_values
        WHERE entity_type = 'ORGANIZATION' AND entity_id = $1
          AND field_key IN ('sector', 'governorate')
        ORDER BY field_key, retrieved_at DESC`,
      [supplierOrgId],
    );
    const supplierField = (key: string): string | null =>
      supplierFields.find((f) => f.field_key === key)?.field_value ?? null;

    const transaction = await this.transactions.findById(transactionId);

    return {
      outstandingAmount: Money.from(invoice.outstanding_amount),
      tenorDays,
      // Null rather than a default: an unscored listing must not fail a
      // trust-score rule (see `eligibility.ts`).
      trustScore: risk?.composite_score ?? null,
      riskBand: risk?.band ?? null,
      supplierOrgId,
      supplierSector: supplierField('sector'),
      supplierGovernorate: supplierField('governorate'),
      buyerId: transaction?.buyer_id ?? null,
    };
  }

  /** Every ACTIVE bank organization, with its policy filters attached. */
  private async activeBanksWithFilters(): Promise<
    { orgId: string; name: string; filters: PolicyFilter[] }[]
  > {
    const { rows: banks } = await this.db.query<{ id: string; legal_name: string }>(
      `SELECT id, legal_name FROM organizations
        WHERE organization_type = 'BANK' AND status = 'ACTIVE'
        ORDER BY legal_name`,
    );

    const { rows: filters } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM bank_policy_filters WHERE is_active`,
    );

    return banks.map((bank) => ({
      orgId: bank.id,
      name: bank.legal_name,
      filters: filters
        .filter((f) => f.bank_org_id === bank.id)
        .map((f) => this.toPolicyFilter(f)),
    }));
  }

  toPolicyFilter(row: Record<string, unknown>): PolicyFilter {
    const money = (v: unknown): Money | null =>
      v === null || v === undefined ? null : Money.from(String(v));
    const num = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    const arr = (v: unknown): string[] | null =>
      Array.isArray(v) && v.length > 0 ? (v as string[]) : null;

    return {
      id: String(row.id),
      name: String(row.name),
      isActive: row.is_active === true,
      minAmount: money(row.min_amount),
      maxAmount: money(row.max_amount),
      minTenorDays: num(row.min_tenor_days),
      maxTenorDays: num(row.max_tenor_days),
      acceptedTransactionTypes: arr(row.accepted_transaction_types),
      acceptedRecourseTypes: arr(row.accepted_recourse_types),
      minTrustScore: num(row.min_trust_score),
      maxRiskBand: (row.max_risk_band as RiskBand | null) ?? null,
      sectorsInclude: arr(row.sectors_include),
      sectorsExclude: arr(row.sectors_exclude),
      governoratesInclude: arr(row.governorates_include),
      buyerExcludeIds: arr(row.buyer_exclude_ids),
      supplierExcludeIds: arr(row.supplier_exclude_ids),
    };
  }

  /**
   * One `bank_eligibility` row per active bank — **including the ineligible
   * ones**, with the rules that excluded them.
   *
   * Writing only the eligible banks would make "why did bank C not see this?"
   * unanswerable, which is precisely what ZM-MKT-003's `rules_applied` exists
   * to prevent. The rows for ineligible banks are the audit trail.
   */
  private async writeEligibility(
    client: PoolClient,
    listingId: string,
    banks: { orgId: string; filters: PolicyFilter[] }[],
    facts: ListingFacts,
    now: Date,
  ): Promise<void> {
    for (const bank of banks) {
      const decision = evaluateBank(bank.filters, facts);
      await client.query(
        `INSERT INTO bank_eligibility
           (listing_id, bank_org_id, status, reason, rules_applied, evaluated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (listing_id, bank_org_id) DO UPDATE SET
           status = EXCLUDED.status,
           reason = EXCLUDED.reason,
           rules_applied = EXCLUDED.rules_applied,
           evaluated_at = EXCLUDED.evaluated_at`,
        [
          listingId,
          bank.orgId,
          decision.status,
          decision.reason,
          JSON.stringify(decision.rulesApplied),
          now,
        ],
      );
    }
  }

  private async notifyEligibleBanks(
    client: PoolClient,
    listing: ListingRow,
    banks: { orgId: string; filters: PolicyFilter[] }[],
    facts: ListingFacts,
  ): Promise<void> {
    for (const bank of banks) {
      if (evaluateBank(bank.filters, facts).status !== 'ELIGIBLE') continue;

      // One notification per eligible bank's users with a marketplace role.
      // Deliberately not addressed to the org: notifications have a
      // recipient_user_id, and a bank with no configured users should
      // produce no rows rather than a null-recipient one.
      const { rows: recipients } = await client.query<{ user_id: string }>(
        `SELECT DISTINCT m.user_id
           FROM organization_memberships m
           JOIN membership_roles r ON r.membership_id = m.id
          WHERE m.organization_id = $1 AND m.status = 'ACTIVE'
            AND r.role IN ('BANK_ADMIN','BANK_ANALYST','BANK_OFFER_MAKER')`,
        [bank.orgId],
      );

      for (const recipient of recipients) {
        await this.notifications.send(
          {
            templateKey: 'LISTING_AVAILABLE',
            recipientUserId: recipient.user_id,
            transactionId: listing.transaction_id,
            fallbackSubject: 'A new receivable is available',
            fallbackBody:
              `A receivable of ${facts.outstandingAmount.toString()} JOD is open for offers until ` +
              `${listing.offer_submission_deadline.toISOString()}.`,
            variables: {
              outstandingAmount: facts.outstandingAmount.toString(),
              offerDeadline: listing.offer_submission_deadline.toISOString(),
            },
          },
          client,
        );
      }
    }
  }

  // =====================================================================
  // Deadlines
  // =====================================================================

  /**
   * Moves a listing on, guarding the transition against the whitelist.
   *
   * Exposed for the deadline job, which is the only caller that changes a
   * listing's status without a user behind it.
   */
  async transition(
    client: PoolClient,
    listing: ListingRow,
    to: ListingStatus,
    reason: string,
  ): Promise<void> {
    if (!canTransitionListing(listing.status, to)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        `A listing cannot move from ${listing.status} to ${to}.`,
        HttpStatus.CONFLICT,
      );
    }
    // Both uses of $2 carry an explicit cast: bare, `status = $2` makes the
    // planner deduce listing_status while `$2 IN ('EXPIRED',…)` deduces text
    // — "inconsistent types deduced for parameter $2" (42P08). That error
    // killed every sweep transition since Phase 5, silently: no suite ever
    // drove a listing through the sweep (they hand-wrote statuses in SQL),
    // so the first caller to actually reach this line was the production
    // scheduler, failing once a minute in the logs.
    await client.query(
      `UPDATE listings
          SET status = $2::listing_status,
              closed_at = CASE WHEN $2::listing_status IN ('EXPIRED','CANCELLED','OFFER_SELECTED')
                               THEN $3 ELSE closed_at END
        WHERE id = $1`,
      [listing.id, to, this.time.now()],
    );
    await client.query(
      `INSERT INTO status_history
         (entity_type, entity_id, previous_status, new_status, reason, changed_at)
       VALUES ('LISTING',$1,$2,$3,$4,$5)`,
      [listing.id, listing.status, to, reason, this.time.now()],
    );
  }

  // =====================================================================
  // Presentation
  // =====================================================================

  /**
   * The supplier's / platform's view of a listing.
   *
   * `offerCount` is included here and **nowhere in any bank-facing shape**
   * (ZM-MKT-011): the number of competitors is the supplier's information and
   * a bank knowing it would change how it bids. `BankListingView` is built by
   * `OffersService` from a separate allow-list precisely so this object can
   * never be handed to a bank by accident.
   */
  async describe(listing: ListingRow, options: { offerCount?: number } = {}): Promise<Record<string, unknown>> {
    const fee = await this.db.queryOne<{ amount: string }>(
      `SELECT amount FROM listing_fee_obligations WHERE listing_id = $1`,
      [listing.id],
    );

    return {
      id: listing.id,
      transactionId: listing.transaction_id,
      roundNumber: listing.round_number,
      status: listing.status,
      activatedAt: listing.activated_at.toISOString(),
      offerSubmissionDeadline: listing.offer_submission_deadline.toISOString(),
      supplierSelectionDeadline: listing.supplier_selection_deadline.toISOString(),
      listingFeeAmount: fee?.amount ?? null,
      ...(options.offerCount === undefined ? {} : { offerCount: options.offerCount }),
    };
  }
}
