import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { ActorContext } from '../onboarding/onboarding.service';
import { GovernmentService, SNAPSHOT_VALIDITY_DAYS } from '../government/government.service';
import { BuyersService } from '../buyers/buyers.service';
import { DocumentsService } from '../documents/documents.service';
import { computeFingerprint } from './fingerprint';

/**
 * The placeholder an unsubmitted invoice carries.
 *
 * Unique per transaction, so two drafts of the same invoice coexist
 * happily and `uq_active_invoice_fingerprint` — which covers DRAFT along
 * with every other non-terminal state — has nothing to object to until
 * one of them is actually submitted.
 */
const draftFingerprint = (transactionId: string): string => `draft:${transactionId}`;
import {
  TransactionState,
  InvalidTransition,
  isEditable,
  outcomeOf,
  requireTransition,
} from './transaction-state';
import {
  CheckOutcome,
  VerificationFacts,
  overallResultOf,
  runChecks,
} from './verification';

/**
 * Receivable transactions: the invoice submission aggregate.
 *
 * The shape of this service mirrors onboarding's deliberately: one private
 * `transition()` that is the only writer of `state`, registry and storage
 * calls kept outside database transactions, and reads that 404 rather than
 * 403 for anything the caller may not see.
 *
 * The bank-facing rule (INV-8 / hard rule 3) is enforced by construction:
 * `describe()` takes an explicit audience and builds the bank view from an
 * allow-list. There is no code path that spreads a transaction row into a
 * response.
 */

export interface TransactionRow {
  id: string;
  reference_number: string;
  supplier_org_id: string;
  buyer_id: string | null;
  state: TransactionState;
  minimum_acceptable_amount: string | null;
  currency: string;
  locked_at: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  closure_reason: string | null;
}

export interface InvoiceInput {
  invoiceNumber: string;
  einvoiceIdentifier: string;
  issueDate: string;
  dueDate: string;
  subtotalAmount: string;
  taxAmount: string;
  faceValue: string;
  paidAmount?: string;
  paymentTerms?: string;
  goodsDescription?: string;
  purchaseOrderNumber?: string;
  deliveryNoteNumber?: string;
  items?: { description: string; quantity: string; unitPrice: string; lineAmount: string }[];
}

export type Audience = 'SUPPLIER' | 'PLATFORM' | 'BANK';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly government: GovernmentService,
    private readonly buyers: BuyersService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // ------------------------------------------------------------------
  // Create and read
  // ------------------------------------------------------------------

  async createDraft(ctx: ActorContext): Promise<Record<string, unknown>> {
    if (ctx.organizationType !== 'SUPPLIER') {
      throw AppException.insufficientRole(['SUPPLIER_OWNER', 'SUPPLIER_UPLOADER']);
    }

    const row = await this.db.queryOne<TransactionRow>(
      // next_transaction_reference() is a sequence-backed function from
      // migration 0005. Allocating in the INSERT keeps it atomic — a
      // reference read then written would race under concurrent creates.
      `INSERT INTO receivable_transactions (reference_number, supplier_org_id, state, created_by)
       VALUES (next_transaction_reference(), $1, 'DRAFT', $2)
       RETURNING id, reference_number, supplier_org_id, buyer_id, state,
                 minimum_acceptable_amount::text, currency, locked_at, created_by,
                 created_at, updated_at, closure_reason`,
      [ctx.organizationId, ctx.userId],
    );
    if (!row) throw new Error('Failed to create the transaction.');
    return this.describe(row, 'SUPPLIER');
  }

  async findById(id: string): Promise<TransactionRow | null> {
    return this.db.queryOne<TransactionRow>(
      `SELECT id, reference_number, supplier_org_id, buyer_id, state,
              minimum_acceptable_amount::text, currency, locked_at, created_by,
              created_at, updated_at, closure_reason
         FROM receivable_transactions WHERE id = $1`,
      [id],
    );
  }

  /**
   * Fetch a transaction the caller may see, and say in what capacity.
   *
   * The audience is returned alongside the row rather than recomputed by
   * callers, because it decides whether the supplier's floor appears in the
   * response. Deriving it twice is how the two derivations eventually
   * disagree.
   */
  async requireVisible(
    id: string,
    ctx: ActorContext,
  ): Promise<{ row: TransactionRow; audience: Audience }> {
    const row = await this.findById(id);
    if (!row) throw AppException.notFound('Transaction');

    if (ctx.organizationType === 'PLATFORM') return { row, audience: 'PLATFORM' };
    if (row.supplier_org_id === ctx.organizationId) return { row, audience: 'SUPPLIER' };

    if (ctx.organizationType === 'BANK' && (await this.bankMaySee(ctx.organizationId, id))) {
      return { row, audience: 'BANK' };
    }
    // 404, not 403 — no enumeration oracle over the transaction table.
    throw AppException.notFound('Transaction');
  }

  private async bankMaySee(bankOrgId: string, transactionId: string): Promise<boolean> {
    const row = await this.db.queryOne(
      `SELECT 1
         FROM listings l
         LEFT JOIN bank_eligibility e ON e.listing_id = l.id AND e.bank_org_id = $2
         LEFT JOIN bank_offers o      ON o.listing_id = l.id AND o.bank_org_id = $2
        WHERE l.transaction_id = $1 AND (e.id IS NOT NULL OR o.id IS NOT NULL)
        LIMIT 1`,
      [transactionId, bankOrgId],
    );
    return row !== null;
  }

  private requireSupplierOwner(row: TransactionRow, ctx: ActorContext): void {
    if (row.supplier_org_id !== ctx.organizationId) throw AppException.notFound('Transaction');
  }

  private requireEditable(row: TransactionRow): void {
    if (!isEditable(row.state)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'This transaction can no longer be edited in its current state.',
        HttpStatus.CONFLICT,
        { state: row.state },
      );
    }
  }

  /**
   * The response body, built per audience.
   *
   * INV-8: `minimumAcceptableAmount` is added only for SUPPLIER and
   * PLATFORM. The bank branch cannot leak it because it never reads the
   * field — the object is constructed from an allow-list rather than by
   * spreading the row and deleting what must not travel, which is the
   * pattern that fails the moment someone adds a column.
   */
  async describe(
    row: TransactionRow,
    audience: Audience,
    options: { includeDetail?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const invoice = await this.invoiceOf(row.id);
    const buyer = row.buyer_id ? await this.buyers.findById(row.buyer_id) : null;

    const summary: Record<string, unknown> = {
      id: row.id,
      referenceNumber: row.reference_number,
      state: row.state,
      invoiceNumber: invoice?.invoice_number ?? null,
      buyerName: buyer?.legal_company_name ?? null,
      faceValue: invoice?.face_value ?? null,
      outstandingAmount: invoice?.outstanding_amount ?? null,
      dueDate: invoice ? invoice.due_date : null,
      createdAt: row.created_at.toISOString(),
    };

    if (!options.includeDetail) return summary;

    const detail: Record<string, unknown> = {
      ...summary,
      closureReason: row.closure_reason,
      lockedAt: row.locked_at?.toISOString() ?? null,
      buyer: buyer ? this.buyers.describe(buyer) : null,
      invoice: invoice ? this.describeInvoice(invoice) : null,
    };

    if (audience !== 'BANK') {
      detail.minimumAcceptableAmount = row.minimum_acceptable_amount;
    }
    return detail;
  }

  private describeInvoice(invoice: InvoiceRow): Record<string, unknown> {
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoice_number,
      einvoiceIdentifier: invoice.einvoice_identifier,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      currency: invoice.currency,
      subtotalAmount: invoice.subtotal_amount,
      taxAmount: invoice.tax_amount,
      faceValue: invoice.face_value,
      paidAmount: invoice.paid_amount,
      outstandingAmount: invoice.outstanding_amount,
      paymentTerms: invoice.payment_terms,
      goodsDescription: invoice.goods_description,
      purchaseOrderNumber: invoice.purchase_order_number,
      deliveryNoteNumber: invoice.delivery_note_number,
    };
  }

  async list(
    ctx: ActorContext,
    filters: { state?: string; page: number; pageSize: number },
  ): Promise<Record<string, unknown>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (ctx.organizationType === 'SUPPLIER') {
      params.push(ctx.organizationId);
      conditions.push(`supplier_org_id = $${params.length}`);
    } else if (ctx.organizationType === 'BANK') {
      // A bank sees only transactions it has been given sight of. In Phase
      // 3 there are no listings, so this correctly returns nothing rather
      // than the whole table.
      params.push(ctx.organizationId);
      conditions.push(`EXISTS (
        SELECT 1 FROM listings l
        LEFT JOIN bank_eligibility e ON e.listing_id = l.id AND e.bank_org_id = $${params.length}
        LEFT JOIN bank_offers o      ON o.listing_id = l.id AND o.bank_org_id = $${params.length}
        WHERE l.transaction_id = receivable_transactions.id
          AND (e.id IS NOT NULL OR o.id IS NOT NULL))`);
    }

    if (filters.state) {
      params.push(filters.state);
      conditions.push(`state = $${params.length}::transaction_state`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM receivable_transactions ${where}`,
      params,
    );
    const total = Number(totalRow?.count ?? '0');

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const { rows } = await this.db.query<TransactionRow>(
      `SELECT id, reference_number, supplier_org_id, buyer_id, state,
              minimum_acceptable_amount::text, currency, locked_at, created_by,
              created_at, updated_at, closure_reason
         FROM receivable_transactions ${where}
        ORDER BY created_at DESC, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const audience: Audience =
      ctx.organizationType === 'PLATFORM' ? 'PLATFORM' : ctx.organizationType === 'BANK' ? 'BANK' : 'SUPPLIER';

    return {
      items: await Promise.all(rows.map((row) => this.describe(row, audience))),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize) || 1,
      },
    };
  }

  // ------------------------------------------------------------------
  // Invoice
  // ------------------------------------------------------------------

  /**
   * Set or replace the invoice.
   *
   * `outstandingAmount` is recomputed here and never accepted from the
   * client, as the phase file requires. It is also a DB CHECK
   * (`chk_outstanding`), so a bug in this method fails loudly at the
   * database rather than producing an invoice whose arithmetic does not
   * hold.
   */
  async putInvoice(
    id: string,
    ctx: ActorContext,
    input: InvoiceInput,
  ): Promise<Record<string, unknown>> {
    const { row } = await this.requireVisible(id, ctx);
    this.requireSupplierOwner(row, ctx);
    this.requireEditable(row);

    const paid = Money.from(input.paidAmount ?? '0.000');
    const face = Money.from(input.faceValue);
    const subtotal = Money.from(input.subtotalAmount);
    const tax = Money.from(input.taxAmount);
    const outstanding = face.subtract(paid);

    if (!outstanding.isPositive()) {
      throw AppException.validation(
        'The outstanding amount must be greater than zero (ZM-INV-001).',
        { faceValue: face.toString(), paidAmount: paid.toString() },
      );
    }
    if (face.isNegative() || subtotal.isNegative() || tax.isNegative() || paid.isNegative()) {
      throw AppException.validation('Invoice amounts cannot be negative.');
    }
    if (Date.parse(`${input.dueDate}T00:00:00Z`) < Date.parse(`${input.issueDate}T00:00:00Z`)) {
      throw AppException.validation('The due date cannot precede the issue date.', {
        field: 'dueDate',
      });
    }

    // A draft carries a placeholder fingerprint, unique to the transaction.
    //
    // The real fingerprint is written at submit, and only there. That is not
    // laziness: `uq_active_invoice_fingerprint` covers every non-terminal
    // transaction including DRAFT, so writing the real value while editing
    // made the *second* draft of a duplicate fail with a raw unique
    // violation — surfacing as a 500 from PUT /buyer, at which point the
    // service's own duplicate check never ran and submit saw no collision.
    // Deferring it puts the refusal exactly where the contract declares it
    // (409 on submit, with a review record) and leaves the index as the
    // backstop for two submissions racing.
    const fingerprint = draftFingerprint(row.id);

    // Both endpoints are midnight UTC, so their difference is an exact
    // multiple of a day and the division is exact. Math.trunc rather than
    // Math.round: the lint ban on Math.round is about money, and using it
    // here would suggest this value needed rounding at all.
    const paymentPeriodDays = Math.trunc(
      (Date.parse(`${input.dueDate}T00:00:00Z`) - Date.parse(`${input.issueDate}T00:00:00Z`)) /
        86_400_000,
    );

    return this.db.transaction(async (client) => {
      const invoice = await client.query<InvoiceRow>(
        `INSERT INTO invoices
           (transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
            subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount,
            payment_terms, payment_period_days, goods_description,
            purchase_order_number, delivery_note_number, fingerprint)
         VALUES ($1, $2, $3, $4::date, $5::date, $6::numeric, $7::numeric, $8::numeric,
                 $9::numeric, $10::numeric, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (transaction_id) DO UPDATE SET
           invoice_number        = EXCLUDED.invoice_number,
           einvoice_identifier   = EXCLUDED.einvoice_identifier,
           issue_date            = EXCLUDED.issue_date,
           due_date              = EXCLUDED.due_date,
           subtotal_amount       = EXCLUDED.subtotal_amount,
           tax_amount            = EXCLUDED.tax_amount,
           face_value            = EXCLUDED.face_value,
           paid_amount           = EXCLUDED.paid_amount,
           outstanding_amount    = EXCLUDED.outstanding_amount,
           payment_terms         = EXCLUDED.payment_terms,
           payment_period_days   = EXCLUDED.payment_period_days,
           goods_description     = EXCLUDED.goods_description,
           purchase_order_number = EXCLUDED.purchase_order_number,
           delivery_note_number  = EXCLUDED.delivery_note_number,
           fingerprint           = EXCLUDED.fingerprint,
           updated_at            = now()
         RETURNING id, transaction_id, invoice_number, einvoice_identifier, issue_date::text,
                   due_date::text, currency, subtotal_amount::text, tax_amount::text,
                   face_value::text, paid_amount::text, outstanding_amount::text,
                   payment_terms, goods_description, purchase_order_number,
                   delivery_note_number, fingerprint`,
        [
          id,
          input.invoiceNumber,
          input.einvoiceIdentifier,
          input.issueDate,
          input.dueDate,
          subtotal.toDb(),
          tax.toDb(),
          face.toDb(),
          paid.toDb(),
          outstanding.toDb(),
          input.paymentTerms ?? null,
          Number.isFinite(paymentPeriodDays) ? paymentPeriodDays : null,
          input.goodsDescription ?? null,
          input.purchaseOrderNumber ?? null,
          input.deliveryNoteNumber ?? null,
          fingerprint,
        ],
      );

      const invoiceRow = invoice.rows[0];
      await this.replaceItems(client, invoiceRow.id, input.items ?? []);

      return this.describeInvoice(invoiceRow);
    });
  }

  private async replaceItems(
    client: PoolClient,
    invoiceId: string,
    items: NonNullable<InvoiceInput['items']>,
  ): Promise<void> {
    // Line items are wholly derived from the submitted invoice, so a
    // replace is correct here where it would not be for anything carrying
    // its own history. invoice_items is ON DELETE CASCADE by design.
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [invoiceId]);
    let lineNo = 1;
    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, line_no, description, quantity, unit_price, line_amount)
         VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric)`,
        [
          invoiceId,
          lineNo++,
          item.description,
          Money.from(item.quantity).toDb(),
          Money.from(item.unitPrice).toDb(),
          Money.from(item.lineAmount).toDb(),
        ],
      );
    }
  }

  async invoiceOf(transactionId: string): Promise<InvoiceRow | null> {
    return this.db.queryOne<InvoiceRow>(
      `SELECT id, transaction_id, invoice_number, einvoice_identifier, issue_date::text, due_date::text,
              currency, subtotal_amount::text, tax_amount::text, face_value::text,
              paid_amount::text, outstanding_amount::text, payment_terms, goods_description,
              purchase_order_number, delivery_note_number, fingerprint
         FROM invoices WHERE transaction_id = $1`,
      [transactionId],
    );
  }

  /**
   * The real fingerprint for a transaction's invoice data.
   *
   * Both parties are identified by national establishment number, which is
   * why this needs the transaction row: the supplier's comes from their
   * organization and the buyer's from the resolved buyer. Returns null when
   * either is missing — a transaction with no buyer cannot be fingerprinted,
   * and submit refuses one anyway.
   */
  private async fingerprintFor(
    row: TransactionRow,
    invoice: { invoiceNumber: string; issueDate: string; faceValue: string; taxAmount: string },
  ): Promise<string | null> {
    const supplier = await this.db.queryOne<{ national_establishment_no: string | null }>(
      `SELECT national_establishment_no FROM organizations WHERE id = $1`,
      [row.supplier_org_id],
    );
    const buyer = row.buyer_id ? await this.buyers.findById(row.buyer_id) : null;

    if (!supplier?.national_establishment_no || !buyer?.national_establishment_no) return null;

    return computeFingerprint({
      supplierEstablishmentNumber: supplier.national_establishment_no,
      buyerEstablishmentNumber: buyer.national_establishment_no,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      faceValue: invoice.faceValue,
      taxAmount: invoice.taxAmount,
    });
  }

  // ------------------------------------------------------------------
  // Buyer link
  // ------------------------------------------------------------------

  async putBuyer(
    id: string,
    ctx: ActorContext,
    input: { buyerId: string; contact?: { contactName: string; contactRole: string; contactPhone: string; contactEmail?: string } },
  ): Promise<void> {
    const { row } = await this.requireVisible(id, ctx);
    this.requireSupplierOwner(row, ctx);
    this.requireEditable(row);

    const buyer = await this.buyers.findById(input.buyerId);
    if (!buyer) throw AppException.notFound('Buyer');

    // The buyer must already have been resolved by this supplier. Linking a
    // buyer the supplier never confirmed would route around ZM-BUY-009 —
    // resolve is where the explicit confirmation is recorded, and skipping
    // it is exactly the auto-selection the requirement forbids.
    if (!(await this.buyers.hasRelationship(ctx.organizationId, input.buyerId))) {
      throw AppException.validation(
        'Resolve this buyer first — a buyer must be explicitly confirmed before it can be linked.',
        { field: 'buyerId' },
      );
    }

    if (['SUSPENDED', 'STRUCK_OFF'].includes(buyer.registry_status)) {
      throw AppException.conflict(
        ErrorCode.BUYER_BLOCKED,
        'This buyer is blocked in the commercial register and cannot be financed.',
        { registryStatus: buyer.registry_status },
      );
    }

    if (input.contact) {
      await this.buyers.linkToTransaction(ctx, input.buyerId, input.contact);
    }

    await this.db.query(
      `UPDATE receivable_transactions SET buyer_id = $2, updated_at = now() WHERE id = $1`,
      [id, input.buyerId],
    );
    // No fingerprint recomputation here — see the comment in putInvoice.
    // The real value is written once, inside submit's duplicate check.
  }

  // ------------------------------------------------------------------
  // Minimum acceptable amount (the supplier's private floor)
  // ------------------------------------------------------------------

  /**
   * Set the floor.
   *
   * Never echoed back in any response built for a bank, never logged, and
   * redacted from audit before/after values by AuditService. The contract
   * declares 422 when it exceeds the outstanding amount; a floor above what
   * the invoice is worth could never be met and would leave the supplier
   * waiting for an offer that cannot legally exist.
   */
  async putMinimumAmount(id: string, ctx: ActorContext, amount: string): Promise<void> {
    const { row } = await this.requireVisible(id, ctx);
    this.requireSupplierOwner(row, ctx);
    this.requireEditable(row);

    const floor = Money.from(amount);
    if (!floor.isPositive()) {
      throw AppException.validation('The minimum acceptable amount must be greater than zero.');
    }

    const invoice = await this.invoiceOf(id);
    if (!invoice) {
      throw AppException.validation('Set the invoice details before the minimum amount.');
    }
    // A floor exactly equal to the outstanding amount is legitimate — the
    // supplier is saying they will not accept any discount at all. Only a
    // floor strictly above it is impossible to satisfy.
    if (Money.from(invoice.outstanding_amount).lessThan(floor)) {
      throw AppException.validation(
        'The minimum acceptable amount cannot exceed the invoice outstanding amount.',
        // Deliberately does NOT echo the floor back. The message is built
        // from the invoice's own figures only.
        { outstandingAmount: invoice.outstanding_amount },
      );
    }

    await this.db.query(
      `UPDATE receivable_transactions
          SET minimum_acceptable_amount = $2::numeric, updated_at = now()
        WHERE id = $1`,
      [id, floor.toDb()],
    );
  }

  // ------------------------------------------------------------------
  // Declarations
  // ------------------------------------------------------------------

  /**
   * Record the eight supplier declarations (ZM-INV-004).
   *
   * All must be true. The DB enforces it too (`chk_all_declared`), so a
   * false slipping through this method fails at the database rather than
   * producing a submission with an unaffirmed declaration — which is the
   * one thing the recourse and indemnity provisions rest on.
   */
  async recordDeclarations(
    id: string,
    ctx: ActorContext,
    input: Record<string, boolean | string>,
  ): Promise<void> {
    const { row } = await this.requireVisible(id, ctx);
    this.requireSupplierOwner(row, ctx);
    this.requireEditable(row);

    const flags = [
      'isAuthentic',
      'goodsDelivered',
      'unpaidAndNotCancelled',
      'noKnownDispute',
      'notPreviouslyFinanced',
      'buyerIsNamedEntity',
      'contactIsBuyerRep',
      'acceptsRecourse',
    ] as const;

    const notAffirmed = flags.filter((flag) => input[flag] !== true);
    if (notAffirmed.length > 0) {
      throw AppException.validation(
        'Every declaration must be affirmed before the invoice can be submitted.',
        { notAffirmed },
      );
    }
    const templateVersion = String(input.declarationTemplateVersion ?? '').trim();
    if (!templateVersion) {
      throw AppException.validation(
        'The declaration template version must be recorded with the declarations (LT-04).',
        { field: 'declarationTemplateVersion' },
      );
    }

    await this.db.query(
      `INSERT INTO invoice_declarations
         (transaction_id, declaration_template_version, is_authentic, goods_delivered,
          unpaid_and_not_cancelled, no_known_dispute, not_previously_financed,
          buyer_is_named_entity, contact_is_buyer_rep, accepts_recourse,
          declared_by, declared_at)
       VALUES ($1, $2, true, true, true, true, true, true, true, true, $3, $4)
       ON CONFLICT (transaction_id) DO UPDATE SET
         declaration_template_version = EXCLUDED.declaration_template_version,
         declared_by = EXCLUDED.declared_by,
         declared_at = EXCLUDED.declared_at`,
      [id, templateVersion, ctx.userId, this.time.now()],
    );
  }

  // ------------------------------------------------------------------
  // Submit
  // ------------------------------------------------------------------

  /**
   * Submit for verification.
   *
   * Order of operations is the requirement:
   *   1. duplicate check — a collision blocks with 409 and opens a review
   *      record (ZM-VER-001) before the transaction enters the pipeline;
   *   2. snapshot freshness — re-query the registry if stale (ZM-GOV-005);
   *   3. transition to SUBMITTED then AUTOMATED_CHECKS;
   *   4. run the eight checks and route the outcome.
   */
  async submit(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    const { row } = await this.requireVisible(id, ctx);
    this.requireSupplierOwner(row, ctx);

    if (row.state !== 'DRAFT' && row.state !== 'INFORMATION_REQUIRED') {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'This transaction has already been submitted.',
        HttpStatus.CONFLICT,
        { state: row.state },
      );
    }

    const invoice = await this.invoiceOf(id);
    if (!invoice) {
      throw AppException.validation('Add the invoice details before submitting.');
    }
    if (!row.buyer_id) {
      throw AppException.validation('Resolve and link a buyer before submitting (ZM-BUY-003).');
    }

    await this.assertNoDuplicate(row, invoice, ctx);
    await this.refreshStaleGovernmentData(row);

    await this.db.transaction(async (client) => {
      await this.transition(client, row, 'SUBMITTED', ctx.userId);
      await this.transition(client, row, 'AUTOMATED_CHECKS', ctx.userId);
    });

    await this.runVerification(id, ctx);

    const refreshed = await this.findById(id);
    if (!refreshed) throw AppException.notFound('Transaction');
    return this.describe(refreshed, 'SUPPLIER', { includeDetail: true });
  }

  /**
   * Duplicate detection (ZM-VER-001).
   *
   * Checked in the service so the caller gets the contract's 409 with a
   * review reference rather than a raw unique-violation. The database index
   * from migration 0002 is still the enforcer — this is the explanation
   * layer, not the guarantee, and the two are deliberately both present:
   * a race between two concurrent submits would slip past this check and
   * be caught by the index.
   */
  private async assertNoDuplicate(
    row: TransactionRow,
    invoice: InvoiceRow,
    ctx: ActorContext,
  ): Promise<void> {
    // Computed here rather than during editing, so a draft never trips the
    // unique index. See putInvoice.
    const fingerprint = await this.fingerprintFor(row, {
      invoiceNumber: invoice.invoice_number,
      issueDate: invoice.issue_date,
      faceValue: invoice.face_value,
      taxAmount: invoice.tax_amount,
    });
    if (!fingerprint) {
      throw AppException.validation('Resolve and link a buyer before submitting (ZM-BUY-003).');
    }

    const existing = await this.db.queryOne<{
      transaction_id: string;
      reference_number: string;
      supplier_org_id: string;
    }>(
      `SELECT i.transaction_id, t.reference_number, t.supplier_org_id
         FROM invoices i
         JOIN receivable_transactions t ON t.id = i.transaction_id
        WHERE i.fingerprint = $1
          AND i.is_active_fingerprint
          AND i.transaction_id <> $2
        LIMIT 1`,
      [fingerprint, row.id],
    );

    if (!existing) {
      // No collision — persist the real fingerprint. The unique index is
      // the backstop: if a concurrent submit claimed it between the SELECT
      // above and this UPDATE, Postgres refuses and the caller gets the
      // same 409 rather than two financeable copies of one receivable.
      try {
        await this.db.query(
          `UPDATE invoices SET fingerprint = $2, updated_at = now() WHERE id = $1`,
          [invoice.id, fingerprint],
        );
        invoice.fingerprint = fingerprint;
        return;
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        this.logger.warn(
          `Concurrent submit claimed fingerprint ${fingerprint.slice(0, 12)} first — ` +
            `transaction ${row.id} refused by the unique index.`,
        );
        const reference = await this.openDuplicateReview(
          row,
          { ...invoice, fingerprint },
          { transaction_id: 'concurrent', supplier_org_id: row.supplier_org_id },
          ctx,
        );
        throw AppException.conflict(
          ErrorCode.DUPLICATE_INVOICE,
          'This invoice has already been submitted to the platform. It has been referred for review.',
          { reviewReference: reference, fingerprintMatched: true },
        );
      }
    }

    invoice.fingerprint = fingerprint;

    // The review record the requirement calls for. Opened before the 409 is
    // raised, so the record exists even though the request fails — a
    // blocked duplicate that left no trace would be invisible to the fraud
    // team, which is the entire point of recording it.
    const reviewReference = await this.openDuplicateReview(row, invoice, existing, ctx);

    this.logger.warn(
      `Duplicate fingerprint on transaction ${row.id}: collides with ${existing.transaction_id}. ` +
        `Review ${reviewReference} opened.`,
    );

    throw AppException.conflict(
      ErrorCode.DUPLICATE_INVOICE,
      'This invoice has already been submitted to the platform. It has been referred for review.',
      {
        reviewReference,
        // Deliberately NOT the other supplier's identity or reference
        // number: the submitter must not learn who else financed this
        // invoice, which would tell a fraudster exactly which of their
        // attempts landed first.
        fingerprintMatched: true,
      },
    );
  }

  private async openDuplicateReview(
    row: TransactionRow,
    invoice: InvoiceRow,
    existing: { transaction_id: string; supplier_org_id: string },
    ctx: ActorContext,
  ): Promise<string> {
    return this.db.transaction(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO fraud_cases (transaction_id, organization_id, status, summary, opened_by, opened_at)
         VALUES ($1, $2, 'OPEN', $3, $4, $5)
         RETURNING id`,
        [
          row.id,
          row.supplier_org_id,
          `Duplicate invoice fingerprint: invoice ${invoice.invoice_number} collides with an ` +
            `active invoice on transaction ${existing.transaction_id}.`,
          ctx.userId,
          this.time.now(),
        ],
      );
      const caseId = created.rows[0].id;

      await client.query(
        `INSERT INTO fraud_indicators (fraud_case_id, indicator_type, source_reference, details)
         VALUES ($1, 'DUPLICATE_INVOICE_FINGERPRINT', $2, $3::jsonb)`,
        [
          caseId,
          invoice.fingerprint,
          JSON.stringify({
            attemptedTransactionId: row.id,
            existingTransactionId: existing.transaction_id,
            sameSupplier: existing.supplier_org_id === row.supplier_org_id,
            invoiceNumber: invoice.invoice_number,
          }),
        ],
      );

      await this.audit.recordIn(client, {
        actionType: 'DUPLICATE_INVOICE_BLOCKED',
        targetEntityType: 'RECEIVABLE_TRANSACTION',
        targetEntityId: row.id,
        newValue: { fraudCaseId: caseId, fingerprint: invoice.fingerprint },
      });

      return caseId;
    });
  }

  /**
   * Re-query the registry when the supplier's snapshot has gone stale
   * (ZM-GOV-005).
   *
   * Activity-triggered on submission, never a scheduled sweep — ZM-GOV-006
   * forbids background re-verification in V3, and this is the same rule
   * onboarding's outage-recovery path follows.
   *
   * A failure here is swallowed deliberately: stale-but-present government
   * data is not a reason to refuse a submission, and an unavailable
   * registry must never look like an adverse finding about the supplier
   * (hard rule 7).
   */
  private async refreshStaleGovernmentData(row: TransactionRow): Promise<void> {
    const supplier = await this.db.queryOne<{ national_establishment_no: string | null }>(
      `SELECT national_establishment_no FROM organizations WHERE id = $1`,
      [row.supplier_org_id],
    );
    if (!supplier?.national_establishment_no) return;

    const fresh = await this.db.queryOne<{ valid_until: Date }>(
      `SELECT s.valid_until
         FROM government_data_snapshots s
         JOIN government_verification_requests r ON r.id = s.request_id
        WHERE r.subject_type = 'ORGANIZATION' AND r.subject_id = $1
          AND s.valid_until > $2
        ORDER BY s.valid_until DESC
        LIMIT 1`,
      [row.supplier_org_id, this.time.now()],
    );
    if (fresh) return;

    this.logger.log(
      `Government snapshot for organization ${row.supplier_org_id} is older than ` +
        `${SNAPSHOT_VALIDITY_DAYS} days — re-querying on submission (ZM-GOV-005).`,
    );
    try {
      await this.government.lookupAll(
        supplier.national_establishment_no,
        'ORGANIZATION',
        row.supplier_org_id,
      );
    } catch (err) {
      this.logger.warn(
        `Snapshot refresh failed for ${row.supplier_org_id}: ${(err as Error).message}. ` +
          'Proceeding — an unavailable registry is not an adverse finding.',
      );
    }
  }

  // ------------------------------------------------------------------
  // Verification
  // ------------------------------------------------------------------

  /**
   * Run the eight checks, record them, and route the transaction.
   *
   * Every check's result is persisted whatever the outcome (§8.5 requires
   * "recorded results"), so a reviewer sees what passed as well as what did
   * not — a run that stored only failures would make "the duplicate check
   * ran and passed" indistinguishable from "the duplicate check never ran".
   */
  async runVerification(transactionId: string, ctx: ActorContext): Promise<CheckOutcome[]> {
    const row = await this.findById(transactionId);
    if (!row) throw AppException.notFound('Transaction');

    const facts = await this.gatherFacts(row);
    const checks = runChecks(facts);
    const overall = overallResultOf(checks);
    const nextState = outcomeOf(checks);

    await this.db.transaction(async (client) => {
      const run = await client.query<{ id: string }>(
        `INSERT INTO verification_runs (transaction_id, started_at, completed_at, overall_result)
         VALUES ($1, $2, $2, $3::check_result)
         RETURNING id`,
        [transactionId, this.time.now(), overall],
      );
      const runId = run.rows[0].id;

      for (const check of checks) {
        await client.query(
          `INSERT INTO verification_checks (run_id, check_type, result, details, evaluated_at)
           VALUES ($1, $2, $3::check_result, $4::jsonb, $5)`,
          [runId, check.checkType, check.result, JSON.stringify(check.details), this.time.now()],
        );
      }

      await this.transition(client, row, nextState, ctx.userId, overall);
    });

    this.logger.log(
      `Transaction ${transactionId} verification: ${overall} → ${nextState} ` +
        `(${checks.map((c) => `${c.checkType}=${c.result}`).join(', ')})`,
    );
    return checks;
  }

  /** Assemble everything the pure check functions need. */
  private async gatherFacts(row: TransactionRow): Promise<VerificationFacts> {
    const invoice = await this.invoiceOf(row.id);
    const buyer = row.buyer_id ? await this.buyers.findById(row.buyer_id) : null;

    const supplier = await this.db.queryOne<{
      national_establishment_no: string | null;
      status: string;
      legal_name: string;
    }>(
      `SELECT national_establishment_no, status, legal_name FROM organizations WHERE id = $1`,
      [row.supplier_org_id],
    );

    const declarations = await this.db.queryOne(
      `SELECT 1 FROM invoice_declarations WHERE transaction_id = $1`,
      [row.id],
    );

    // The mandatory electronic invoice (ZM-DOC-001), and its integrity.
    const documents = await this.documents.listForSubject('TRANSACTION', row.id);
    const attached = documents.find((d) => d.document_type === 'ELECTRONIC_INVOICE') ?? null;
    // Submission is the other trigger for lazy finalization: the integrity
    // and consistency checks below need the file's hash and its extraction,
    // and a document the supplier uploaded but never opened would otherwise
    // arrive here unhashed.
    const einvoice = attached ? await this.documents.ensureFinalized(attached) : null;

    let electronicInvoiceDocument: VerificationFacts['electronicInvoiceDocument'] = null;
    let ocr: VerificationFacts['ocr'] = null;
    let qr: VerificationFacts['qr'] = null;

    if (einvoice) {
      const integrity = await this.documents.verifyStoredHash(einvoice);
      electronicInvoiceDocument = {
        id: einvoice.id,
        fileHash: einvoice.file_hash,
        storedHashMatches: integrity ? integrity.matches : null,
      };

      const extractions = await this.documents.latestExtractions(einvoice.id);
      const ocrRow = extractions.find((e) => e.extraction_kind === 'OCR');
      const qrRow = extractions.find((e) => e.extraction_kind === 'QR');
      if (ocrRow) {
        ocr = { available: ocrRow.succeeded, fields: ocrRow.extracted_fields ?? {} };
      }
      if (qrRow) {
        qr = {
          validationStatus: qrRow.succeeded ? 'VALID' : (qrRow.failure_reason ?? 'UNAVAILABLE'),
          fields: qrRow.extracted_fields ?? {},
        };
      }
    }

    const duplicateRow = invoice
      ? await this.db.queryOne<{ transaction_id: string }>(
          `SELECT transaction_id FROM invoices
            WHERE fingerprint = $1 AND is_active_fingerprint AND transaction_id <> $2
            LIMIT 1`,
          [invoice.fingerprint, row.id],
        )
      : null;

    return {
      invoice: invoice
        ? {
            invoiceNumber: invoice.invoice_number,
            einvoiceIdentifier: invoice.einvoice_identifier,
            issueDate: invoice.issue_date,
            dueDate: invoice.due_date,
            subtotalAmount: invoice.subtotal_amount,
            taxAmount: invoice.tax_amount,
            faceValue: invoice.face_value,
            paidAmount: invoice.paid_amount,
            outstandingAmount: invoice.outstanding_amount,
            currency: invoice.currency,
          }
        : null,
      buyer: buyer
        ? {
            id: buyer.id,
            nationalEstablishmentNumber: buyer.national_establishment_no,
            legalCompanyName: buyer.legal_company_name,
            registryStatus: buyer.registry_status,
          }
        : null,
      supplier: {
        organizationId: row.supplier_org_id,
        nationalEstablishmentNumber: supplier?.national_establishment_no ?? null,
        status: supplier?.status ?? 'UNKNOWN',
        legalName: supplier?.legal_name ?? '',
      },
      declarationsRecorded: declarations !== null,
      electronicInvoiceDocument,
      ocr,
      qr,
      duplicate: {
        collided: duplicateRow !== null,
        existingTransactionId: duplicateRow?.transaction_id,
      },
      now: this.time.now(),
      minTenorDays: await this.minTenorDays(),
    };
  }

  /** AS-08, read from platform_settings rather than hard-coded. */
  private async minTenorDays(): Promise<number> {
    const row = await this.db.queryOne<{ value: unknown }>(
      `SELECT value FROM platform_settings WHERE key = 'min_tenor_days'`,
    );
    const parsed = Number(row?.value ?? 7);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
  }

  /** The latest verification run, for GET …/verification. */
  async latestVerification(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    await this.requireVisible(id, ctx);

    const run = await this.db.queryOne<{ id: string; overall_result: string; started_at: Date; completed_at: Date | null }>(
      `SELECT id, overall_result, started_at, completed_at
         FROM verification_runs
        WHERE transaction_id = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [id],
    );
    if (!run) throw AppException.notFound('Verification run');

    const { rows: checks } = await this.db.query<{
      check_type: string;
      result: string;
      details: Record<string, unknown>;
    }>(
      `SELECT check_type, result, details FROM verification_checks
        WHERE run_id = $1 ORDER BY evaluated_at, check_type`,
      [run.id],
    );

    return {
      id: run.id,
      overallResult: run.overall_result,
      startedAt: run.started_at.toISOString(),
      completedAt: run.completed_at?.toISOString() ?? null,
      checks: checks.map((c) => ({
        checkType: c.check_type,
        result: c.result,
        details: c.details,
      })),
    };
  }

  // ------------------------------------------------------------------
  // The single writer of state
  // ------------------------------------------------------------------

  private async transition(
    client: PoolClient,
    row: TransactionRow,
    to: TransactionState,
    actorUserId: string,
    reason?: string,
  ): Promise<void> {
    try {
      requireTransition(row.state, to);
    } catch (err) {
      if (err instanceof InvalidTransition) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          err.message,
          HttpStatus.CONFLICT,
          { from: err.from, to: err.to },
        );
      }
      throw err;
    }

    const previous = row.state;
    await client.query(
      `UPDATE receivable_transactions SET state = $2::transaction_state, updated_at = now() WHERE id = $1`,
      [row.id, to],
    );

    // status_history is the human-readable trail alongside audit_logs. The
    // trigger from migration 0002 keeps is_active_fingerprint in step with
    // this same UPDATE, which is why a REJECTED transaction stops blocking
    // a resubmission without any further work here.
    await client.query(
      `INSERT INTO status_history (entity_type, entity_id, previous_status, new_status, reason, changed_by, changed_at)
       VALUES ('RECEIVABLE_TRANSACTION', $1, $2, $3, $4, $5, $6)`,
      [row.id, previous, to, reason ?? null, actorUserId, this.time.now()],
    );

    row.state = to;
  }
}

export interface InvoiceRow {
  id: string;
  transaction_id: string;
  invoice_number: string;
  einvoice_identifier: string;
  /**
   * Selected as `::text`, and typed as a string for that reason.
   *
   * A Postgres `date` arrives through node-postgres as a JS Date at LOCAL
   * midnight, so `toISOString().slice(0,10)` moves it to the previous day
   * in every timezone ahead of UTC — which includes Asia/Amman, the only
   * timezone this product runs in. That defect shipped briefly and showed
   * up as an OCR-vs-invoice date mismatch on a document whose dates were
   * read perfectly: the invoice said 2026-05-10 and the platform believed
   * 2026-05-09. A calendar date has no timezone, so it never becomes a
   * Date object here at all.
   */
  issue_date: string;
  due_date: string;
  currency: string;
  subtotal_amount: string;
  tax_amount: string;
  face_value: string;
  paid_amount: string;
  outstanding_amount: string;
  payment_terms: string | null;
  goods_description: string | null;
  purchase_order_number: string | null;
  delivery_note_number: string | null;
  fingerprint: string;
}
